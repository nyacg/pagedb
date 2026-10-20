//! Immutable B+trees over pages: a streaming bulk builder and a fault-aware reader.
//!
//! Reads never block. Every page access goes through `Ctx::get`, which returns `Err(Miss)` and
//! records the page id when no synchronous tier has it. The caller (the engine entry point)
//! turns the recorded ids into one batch fetch and calls again. Range scans plan ahead: at the
//! parent of the leaves they use the per-child row counts to request every leaf the scan will
//! need at once, so a scan costs one fault round however many leaves it spans.

use crate::page::{Page, PageBuilder, PageId, BRANCH, LEAF, PAGE_SIZE};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

pub const NO_PAGE: PageId = u64::MAX;

/// Where a built tree lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TreeRoot {
    pub tree: u16,
    /// Leaf pages (written first and contiguously; branch pages follow).
    pub leaves: u64,
    pub root: PageId,
    /// Levels including the leaves (1 = the root is a leaf). 0 = empty tree.
    pub height: u8,
    pub rows: u64,
}

impl TreeRoot {
    pub fn empty(tree: u16) -> Self {
        Self { tree, leaves: 0, root: NO_PAGE, height: 0, rows: 0 }
    }
}

// ------------------------------------------------------------------ building

/// Receives finished pages and assigns them ids (sequential within the store's page space).
pub trait PageSink {
    fn write(&mut self, page: Vec<u8>) -> PageId;
}

/// In-memory sink for tests and small builds.
#[derive(Default)]
pub struct VecSink {
    pub pages: Vec<Rc<[u8]>>,
}

impl PageSink for VecSink {
    fn write(&mut self, page: Vec<u8>) -> PageId {
        self.pages.push(page.into());
        (self.pages.len() - 1) as PageId
    }
}

/// Streams strictly increasing (key, value) pairs into leaves; branch levels are built at the
/// end so a tree's leaves are contiguous in the page space (adjacent leaves → one ranged GET).
pub struct TreeBuilder {
    tree: u16,
    leaf: PageBuilder,
    last_key: Vec<u8>,
    prev_leaf_last: Option<Vec<u8>>,
    /// (separator, child id, rows) for the level above the leaves.
    entries: Vec<(Vec<u8>, PageId, u64)>,
    rows: u64,
    leaves: u64,
}

impl TreeBuilder {
    pub fn new(tree: u16) -> Self {
        Self { tree, leaf: PageBuilder::new(LEAF, 0, tree), last_key: Vec::new(), prev_leaf_last: None, entries: Vec::new(), rows: 0, leaves: 0 }
    }

    pub fn push(&mut self, sink: &mut dyn PageSink, key: &[u8], val: &[u8]) {
        assert!(self.rows == 0 || key > self.last_key.as_slice(), "keys must be strictly increasing");
        let len = PageBuilder::leaf_cell_len(key, val);
        assert!(len <= crate::page::MAX_CELL, "cell of {len} bytes is too large");
        if !self.leaf.fits(len) {
            self.flush_leaf(sink);
        }
        self.leaf.push_leaf(key, val);
        self.last_key.clear();
        self.last_key.extend_from_slice(key);
        self.rows += 1;
    }

    fn flush_leaf(&mut self, sink: &mut dyn PageSink) {
        if self.leaf.is_empty() {
            return;
        }
        let sep = match &self.prev_leaf_last {
            None => Vec::new(),
            Some(prev) => separator(prev, self.leaf.first_key()),
        };
        let rows = self.leaf.rows();
        let id = sink.write(self.leaf.finish());
        self.leaves += 1;
        self.entries.push((sep, id, rows));
        self.prev_leaf_last = Some(self.last_key.clone());
        self.leaf = PageBuilder::new(LEAF, 0, self.tree);
    }

    pub fn finish(self, sink: &mut dyn PageSink) -> TreeRoot {
        self.finish_leaves(sink).finish_branches(sink)
    }

    /// Write the last leaf; branch levels can be written later (so all interior pages of all
    /// trees can share one contiguous, pinned region at the end of the base).
    pub fn finish_leaves(mut self, sink: &mut dyn PageSink) -> PendingTree {
        self.flush_leaf(sink);
        PendingTree(self)
    }
}

/// A tree whose leaves are written and whose branch levels are not yet.
pub struct PendingTree(TreeBuilder);

impl PendingTree {
    pub fn finish_branches(self, sink: &mut dyn PageSink) -> TreeRoot {
        let this = self.0;
        if this.entries.is_empty() {
            return TreeRoot::empty(this.tree);
        }
        this.build_levels(sink)
    }
}

impl TreeBuilder {
    fn build_levels(mut self, sink: &mut dyn PageSink) -> TreeRoot {
        let mut level = 0u8;
        let mut entries = std::mem::take(&mut self.entries);
        while entries.len() > 1 {
            level += 1;
            let mut next: Vec<(Vec<u8>, PageId, u64)> = Vec::new();
            let mut page = PageBuilder::new(BRANCH, level, self.tree);
            let mut first_sep: Option<Vec<u8>> = None;
            for (sep, child, rows) in entries {
                // The first entry of each branch page keeps an empty key: it covers everything
                // below its second separator. The page's own separator is passed up instead.
                let key: &[u8] = if page.is_empty() { &[] } else { &sep };
                if !page.fits(PageBuilder::branch_cell_len(key)) {
                    let rows_total = page.rows();
                    let id = sink.write(page.finish());
                    next.push((first_sep.take().unwrap_or_default(), id, rows_total));
                    page = PageBuilder::new(BRANCH, level, self.tree);
                }
                if page.is_empty() {
                    first_sep = Some(sep.clone());
                    page.push_branch(&[], child, rows);
                } else {
                    page.push_branch(&sep, child, rows);
                }
            }
            let rows_total = page.rows();
            let id = sink.write(page.finish());
            next.push((first_sep.unwrap_or_default(), id, rows_total));
            entries = next;
        }
        let (_, root, rows) = entries.pop().unwrap();
        TreeRoot { tree: self.tree, leaves: self.leaves, root, height: level + 1, rows }
    }
}

/// Shortest key K with prev < K <= next (suffix truncation keeps branch pages dense).
pub fn separator(prev: &[u8], next: &[u8]) -> Vec<u8> {
    let common = prev.iter().zip(next).take_while(|(a, b)| a == b).count();
    next[..(common + 1).min(next.len())].to_vec()
}

// ------------------------------------------------------------------ reading

/// A synchronous page tier (RAM, DO SQLite). `None` = not resident here.
pub trait PageStore {
    fn get(&self, id: PageId) -> Option<Rc<[u8]>>;
}

/// The page we needed isn't resident; its id has been recorded in `Ctx::want`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Miss;

pub struct Ctx<'a> {
    pub store: &'a dyn PageStore,
    pub want: RefCell<BTreeSet<PageId>>,
    pub reads: std::cell::Cell<u64>,
    /// Writes not yet in the base (committed overlay + a batch's staged writes).
    pub view: Option<&'a crate::overlay::View<'a>>,
}

impl<'a> Ctx<'a> {
    pub fn new(store: &'a dyn PageStore) -> Self {
        Self { store, want: RefCell::new(BTreeSet::new()), reads: std::cell::Cell::new(0), view: None }
    }

    pub fn with_view(store: &'a dyn PageStore, view: &'a crate::overlay::View<'a>) -> Self {
        Self { store, want: RefCell::new(BTreeSet::new()), reads: std::cell::Cell::new(0), view: Some(view) }
    }

    #[inline]
    pub fn get(&self, id: PageId) -> Result<Rc<[u8]>, Miss> {
        self.reads.set(self.reads.get() + 1);
        match self.store.get(id) {
            Some(p) => Ok(p),
            None => {
                self.want.borrow_mut().insert(id);
                Err(Miss)
            }
        }
    }

    /// Ask for all of `ids`; Ok only if every one is resident (misses are all recorded).
    pub fn get_all(&self, ids: &[PageId]) -> Result<Vec<Rc<[u8]>>, Miss> {
        let mut out = Vec::with_capacity(ids.len());
        let mut missed = false;
        for &id in ids {
            match self.get(id) {
                Ok(p) => out.push(p),
                Err(Miss) => missed = true,
            }
        }
        if missed {
            Err(Miss)
        } else {
            Ok(out)
        }
    }

    pub fn take_want(&self) -> Vec<PageId> {
        std::mem::take(&mut *self.want.borrow_mut()).into_iter().collect()
    }
}

/// Key range [lo, hi). `hi` empty = unbounded.
#[derive(Clone, Debug)]
pub struct Range<'k> {
    pub lo: &'k [u8],
    pub hi: &'k [u8],
}

impl<'k> Range<'k> {
    #[inline]
    fn below_hi(&self, k: &[u8]) -> bool {
        self.hi.is_empty() || k < self.hi
    }
}

/// Visit entries of `range` in order (or reverse), calling `f(key, value)`; `f` returns false
/// to stop. `hint` = how many entries the caller expects to consume (drives leaf read-ahead).
pub fn scan(
    ctx: &Ctx,
    root: &TreeRoot,
    range: &Range,
    reverse: bool,
    hint: usize,
    f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
) -> Result<(), Miss> {
    if root.height == 0 {
        return Ok(());
    }
    let mut budget = hint.max(1);
    visit(ctx, root.root, range, reverse, &mut budget, f).map(|_| ())
}

/// Returns Ok(false) when `f` asked to stop.
fn visit(
    ctx: &Ctx,
    id: PageId,
    range: &Range,
    reverse: bool,
    budget: &mut usize,
    f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
) -> Result<bool, Miss> {
    let bytes = ctx.get(id)?;
    let page = Page(&bytes);
    if page.kind() == LEAF {
        return Ok(scan_leaf(page, range, reverse, budget, f));
    }
    let (first, last) = child_span(page, range);
    if first > last {
        return Ok(true);
    }
    let order: Vec<usize> = if reverse { (first..=last).rev().collect() } else { (first..=last).collect() };
    if page.level() == 1 {
        // Children are leaves: plan the ones this scan will need and fetch them as one batch.
        let mut planned = Vec::new();
        let mut rows = 0u64;
        for (n, &i) in order.iter().enumerate() {
            let (_, child, child_rows) = page.child(i);
            planned.push(child);
            // The boundary leaf may contribute few rows, so count from the second leaf on,
            // and read one leaf past the estimate.
            if n > 0 {
                rows += child_rows;
            }
            if rows as usize > *budget {
                break;
            }
        }
        let leaves = ctx.get_all(&planned)?;
        for leaf in &leaves {
            if !scan_leaf(Page(leaf), range, reverse, budget, f) {
                return Ok(false);
            }
        }
        if planned.len() == order.len() {
            return Ok(true);
        }
        // Consumed everything planned without being told to stop: continue past the plan.
        for &i in &order[planned.len()..] {
            if !visit(ctx, page.child(i).1, range, reverse, budget, f)? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    for &i in &order {
        if !visit(ctx, page.child(i).1, range, reverse, budget, f)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Children of a branch page that can hold keys in `range`.
fn child_span(page: Page, range: &Range) -> (usize, usize) {
    let first = page.child_for(range.lo);
    let last = if range.hi.is_empty() {
        page.count() - 1
    } else {
        // Last child whose separator is < hi.
        let i = page.lower_bound(range.hi);
        if i == 0 {
            return (1, 0);
        }
        i - 1
    };
    (first, last.max(first).min(page.count() - 1))
}

fn scan_leaf(page: Page, range: &Range, reverse: bool, budget: &mut usize, f: &mut dyn FnMut(&[u8], &[u8]) -> bool) -> bool {
    let start = page.lower_bound(range.lo);
    let end = if range.hi.is_empty() { page.count() } else { page.lower_bound(range.hi) };
    if start >= end {
        return true;
    }
    let mut emit = |i: usize| -> bool {
        let (k, v) = page.entry(i);
        *budget = budget.saturating_sub(1);
        f(k, v)
    };
    if reverse {
        for i in (start..end).rev() {
            if !emit(i) {
                return false;
            }
        }
    } else {
        for i in start..end {
            if !emit(i) {
                return false;
            }
        }
    }
    true
}

/// Point lookup.
pub fn get(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<Option<Vec<u8>>, Miss> {
    if root.height == 0 {
        return Ok(None);
    }
    let mut id = root.root;
    loop {
        let bytes = ctx.get(id)?;
        let page = Page(&bytes);
        if page.kind() == LEAF {
            let i = page.lower_bound(key);
            if i < page.count() {
                let (k, v) = page.entry(i);
                if k == key {
                    return Ok(Some(v.to_vec()));
                }
            }
            return Ok(None);
        }
        id = page.child(page.child_for(key)).1;
    }
}

/// Key of the entry at position `n` (0-based), in O(height) pages using the branch row counts.
pub fn nth(ctx: &Ctx, root: &TreeRoot, mut n: u64) -> Result<Option<Vec<u8>>, Miss> {
    if root.height == 0 || n >= root.rows {
        return Ok(None);
    }
    let mut id = root.root;
    loop {
        let bytes = ctx.get(id)?;
        let page = Page(&bytes);
        if page.kind() == LEAF {
            return Ok((n < page.count() as u64).then(|| page.key(n as usize).to_vec()));
        }
        let mut next = None;
        for i in 0..page.count() {
            let (_, child, rows) = page.child(i);
            if n < rows {
                next = Some(child);
                break;
            }
            n -= rows;
        }
        match next {
            Some(c) => id = c,
            None => return Ok(None),
        }
    }
}

/// Number of entries with key < `key`, in O(height) pages using the branch row counts.
pub fn rank(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<u64, Miss> {
    if root.height == 0 {
        return Ok(0);
    }
    let mut id = root.root;
    let mut below = 0u64;
    loop {
        let bytes = ctx.get(id)?;
        let page = Page(&bytes);
        if page.kind() == LEAF {
            return Ok(below + page.lower_bound(key) as u64);
        }
        let c = page.child_for(key);
        for i in 0..c {
            below += page.child(i).2;
        }
        id = page.child(c).1;
    }
}

/// Entries in [lo, hi): both boundary descents are attempted, so their misses share a round.
pub fn count(ctx: &Ctx, root: &TreeRoot, range: &Range) -> Result<u64, Miss> {
    let a = rank(ctx, root, range.lo);
    let b = if range.hi.is_empty() { Ok(root.rows) } else { rank(ctx, root, range.hi) };
    Ok(b? - a?)
}

/// Size check used by builders: pages are always exactly PAGE_SIZE.
pub const fn page_bytes() -> usize {
    PAGE_SIZE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{encode_key, Value};
    use proptest::prelude::*;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashSet};

    /// A page store where only some pages are "resident"; resolving a miss makes it resident.
    struct Faulty<'a> {
        pages: &'a [Rc<[u8]>],
        resident: RefCell<HashSet<PageId>>,
    }
    impl<'a> PageStore for Faulty<'a> {
        fn get(&self, id: PageId) -> Option<Rc<[u8]>> {
            if self.resident.borrow().contains(&id) {
                Some(self.pages[id as usize].clone())
            } else {
                None
            }
        }
    }

    /// Run `op` against a cold store until it stops missing; returns (result, rounds).
    fn with_faults<T>(pages: &[Rc<[u8]>], mut op: impl FnMut(&Ctx) -> Result<T, Miss>) -> (T, usize) {
        let store = Faulty { pages, resident: RefCell::new(HashSet::new()) };
        let mut rounds = 0;
        loop {
            let ctx = Ctx::new(&store);
            match op(&ctx) {
                Ok(v) => return (v, rounds),
                Err(Miss) => {
                    rounds += 1;
                    assert!(rounds < 64, "too many fault rounds");
                    store.resident.borrow_mut().extend(ctx.take_want());
                }
            }
        }
    }

    fn build(n: usize, val_len: usize) -> (Vec<Rc<[u8]>>, TreeRoot, BTreeMap<Vec<u8>, Vec<u8>>) {
        let mut sink = VecSink::default();
        let mut b = TreeBuilder::new(3);
        let mut reference = BTreeMap::new();
        for i in 0..n {
            let key = encode_key(&[Value::from(format!("p{:03}", i % 37)), Value::Num(-(i as f64))], &[false, true]);
            let val = vec![(i % 251) as u8; val_len + (i % 7)];
            reference.insert(key, val);
        }
        for (k, v) in &reference {
            b.push(&mut sink, k, v);
        }
        let root = b.finish(&mut sink);
        (sink.pages, root, reference)
    }

    #[test]
    fn scans_match_reference_with_cold_cache() {
        let (pages, root, reference) = build(40_000, 120);
        assert!(root.height >= 2, "want a multi-level tree, got {}", root.height);
        assert_eq!(root.rows, reference.len() as u64);
        let keys: Vec<&Vec<u8>> = reference.keys().collect();
        for (lo_i, hi_i, limit, reverse) in [(0, 40_000, 50, false), (1000, 30_000, 500, true), (39_990, 40_000, 50, false), (5, 6, 10, false)] {
            let lo = keys[lo_i].clone();
            let hi = if hi_i >= keys.len() { Vec::new() } else { keys[hi_i].clone() };
            let range = Range { lo: &lo, hi: &hi };
            let ((got, reads), rounds) = with_faults(&pages, |ctx| {
                let mut got = Vec::new();
                scan(ctx, &root, &range, reverse, limit, &mut |k, v| {
                    got.push((k.to_vec(), v.to_vec()));
                    got.len() < limit
                })?;
                Ok((got, ctx.reads.get()))
            });
            let mut want: Vec<(Vec<u8>, Vec<u8>)> =
                reference.range(lo.clone()..).take_while(|(k, _)| hi.is_empty() || **k < hi).map(|(k, v)| (k.clone(), v.clone())).collect();
            if reverse {
                want.reverse();
            }
            want.truncate(limit);
            assert_eq!(got, want);
            // Interior levels fault one per round; all leaves of the scan share one round.
            assert!(rounds <= root.height as usize, "rounds {rounds} > height {} (reads {reads})", root.height);
        }
    }

    #[test]
    fn nth_matches_reference() {
        let (pages, root, reference) = build(25_000, 60);
        let keys: Vec<&Vec<u8>> = reference.keys().collect();
        for n in [0usize, 1, 777, 12_345, 24_999] {
            let (k, _) = with_faults(&pages, |ctx| nth(ctx, &root, n as u64));
            assert_eq!(k.as_ref(), Some(keys[n]));
        }
        let (none, _) = with_faults(&pages, |ctx| nth(ctx, &root, 25_000));
        assert!(none.is_none());
    }

    #[test]
    fn counts_and_point_lookups() {
        let (pages, root, reference) = build(25_000, 60);
        let keys: Vec<&Vec<u8>> = reference.keys().collect();
        for (a, b) in [(0usize, 25_000usize), (17, 9_000), (12_345, 12_346), (24_000, 25_000)] {
            let lo = keys[a].clone();
            let hi = if b >= keys.len() { Vec::new() } else { keys[b].clone() };
            let (n, _) = with_faults(&pages, |ctx| count(ctx, &root, &Range { lo: &lo, hi: &hi }));
            assert_eq!(n, (b.min(keys.len()) - a) as u64);
        }
        let (v, rounds) = with_faults(&pages, |ctx| get(ctx, &root, keys[777]));
        assert_eq!(v.as_deref(), reference.get(keys[777]).map(|v| v.as_slice()));
        assert_eq!(rounds, root.height as usize);
        let (none, _) = with_faults(&pages, |ctx| get(ctx, &root, b"zzz"));
        assert!(none.is_none());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]
        #[test]
        fn random_ranges(n in 1usize..6000, val_len in 0usize..900, a in 0usize..6000, span in 0usize..6000, limit in 1usize..700, reverse: bool) {
            let (pages, root, reference) = build(n, val_len);
            let keys: Vec<&Vec<u8>> = reference.keys().collect();
            let lo = keys[a % keys.len()].clone();
            let hi_i = (a % keys.len()) + span;
            let hi = if hi_i >= keys.len() { Vec::new() } else { keys[hi_i].clone() };
            let range = Range { lo: &lo, hi: &hi };
            let (got, _) = with_faults(&pages, |ctx| {
                let mut got = Vec::new();
                scan(ctx, &root, &range, reverse, limit, &mut |k, _| { got.push(k.to_vec()); got.len() < limit })?;
                Ok(got)
            });
            let mut want: Vec<Vec<u8>> = reference.range(lo.clone()..).take_while(|(k, _)| hi.is_empty() || **k < hi).map(|(k, _)| k.clone()).collect();
            if reverse { want.reverse(); }
            want.truncate(limit);
            prop_assert_eq!(got, want);
            let (c, _) = with_faults(&pages, |ctx| count(ctx, &root, &range));
            prop_assert_eq!(c as usize, reference.range(lo.clone()..).take_while(|(k, _)| hi.is_empty() || **k < hi).count());
        }
    }
}
