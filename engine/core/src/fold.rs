//! Folding the overlay into a layer: writes leave memory for B+trees in R2.
//!
//! The layer holds every change since the base, per index tree, as `d` (key → value or
//! tombstone, with its count delta against the base) and `plus`/`minus` (the keys whose delta is
//! +1 / −1, for O(height) counts). A fold rewrites the whole layer: one streaming merge of the
//! old layer with the overlay, never reading the base.
//!
//! 1. `touch` faults in every page of the old layer (one round per level).
//! 2. `build` merges old layer ⊕ overlay into new trees, pages out through a `PageSink`, and
//!    starts recording which keys are written from then on (`Overlay::dirty`).
//! 3. The shell uploads the new pages, then `rebase` swaps the layer in: entries the new layer
//!    already holds leave the overlay; keys written during the upload are re-expressed against
//!    the new layer. The merged view is the same before and after, so live queries carry on.

use crate::overlay::{Entry, Key, Layer, LayerTrees, Overlay};
use crate::page::{Page, LEAF};
use crate::query::Roots;
use crate::tree::{self, Ctx, Miss, PageSink, Range, TreeBuilder, TreeRoot};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

/// Rows a fold's scans plan ahead (a cap on leaves held at once, not on what's read).
const SCAN_PLAN: usize = 4096;

/// A layer entry as stored in `d`: u8 kind (1 value, 0 tombstone) | i8 delta | value.
pub fn encode_entry(val: Option<&[u8]>, delta: i8) -> Vec<u8> {
    let mut v = Vec::with_capacity(2 + val.map_or(0, <[u8]>::len));
    v.push(val.is_some() as u8);
    v.push(delta as u8);
    if let Some(x) = val {
        v.extend_from_slice(x);
    }
    v
}

/// Ask for every page of `root` without holding them: Ok once all are resident.
pub fn touch_tree(ctx: &Ctx, root: &TreeRoot) -> Result<(), Miss> {
    if root.height == 0 {
        return Ok(());
    }
    let mut level = vec![root.root];
    loop {
        let mut next = Vec::new();
        let mut missed = false;
        for id in level {
            match ctx.get(id) {
                Ok(bytes) => {
                    let p = Page(&bytes);
                    if p.kind() != LEAF {
                        next.extend((0..p.count()).map(|i| p.child(i).1));
                    }
                }
                Err(Miss) => missed = true,
            }
        }
        if missed {
            return Err(Miss);
        }
        if next.is_empty() {
            return Ok(());
        }
        level = next;
    }
}

/// Step 1: every page of the current layer resident.
pub fn touch(ctx: &Ctx, overlay: &Overlay) -> Result<(), Miss> {
    let Some(layer) = overlay.layer.as_deref() else { return Ok(()) };
    let mut missed = false;
    for l in layer.trees.values() {
        for t in [&l.d, &l.plus, &l.minus] {
            if touch_tree(ctx, t).is_err() {
                missed = true;
            }
        }
    }
    if missed {
        Err(Miss)
    } else {
        Ok(())
    }
}

struct Out {
    d: TreeBuilder,
    plus: TreeBuilder,
    minus: TreeBuilder,
}

impl Out {
    fn new(tree: u16) -> Self {
        Out { d: TreeBuilder::new(tree), plus: TreeBuilder::new(tree), minus: TreeBuilder::new(tree) }
    }
    fn push(&mut self, sink: &mut dyn PageSink, key: &[u8], val: Option<&[u8]>, delta: i8) {
        self.d.push(sink, key, &encode_entry(val, delta));
        match delta {
            1 => self.plus.push(sink, key, &[]),
            -1 => self.minus.push(sink, key, &[]),
            _ => {}
        }
    }
    fn finish(self, sink: &mut dyn PageSink) -> LayerTrees {
        LayerTrees { d: self.d.finish(sink), plus: self.plus.finish(sink), minus: self.minus.finish(sink) }
    }
}

/// Step 2: the new layer = old layer ⊕ overlay. Pages go to `sink` as they fill. Doesn't touch
/// the overlay (the caller starts dirty tracking once this succeeds).
pub fn build(ctx: &Ctx, roots: &Roots, overlay: &Overlay, sink: &mut dyn PageSink) -> Result<Layer, Miss> {
    let old = overlay.layer.as_deref();
    let mut trees: BTreeSet<u16> = roots.trees.keys().copied().collect();
    trees.extend(overlay.map.keys().map(|(t, _)| *t));
    let mut out = Layer { trees: HashMap::new() };
    for tree in trees {
        let lo: Key = (tree, Vec::new());
        let hi: Key = (tree + 1, Vec::new());
        let mut ov = overlay.map.range(lo..hi).map(|((_, k), e)| (k, e)).peekable();
        let old_d = old.and_then(|l| l.trees.get(&tree)).map(|l| l.d).filter(|d| d.height > 0);
        if old_d.is_none() && ov.peek().is_none() {
            continue;
        }
        let mut o = Out::new(tree);
        if let Some(d) = old_d {
            tree::scan(ctx, &d, &Range { lo: &[], hi: &[] }, false, SCAN_PLAN, &mut |k, v| {
                while let Some((ok, e)) = ov.peek() {
                    if ok.as_slice() >= k {
                        break;
                    }
                    emit_ov(&mut o, sink, ok, e, None);
                    ov.next();
                }
                let (val, delta) = crate::merged::decode_entry(v);
                match ov.peek() {
                    Some((ok, e)) if ok.as_slice() == k => {
                        emit_ov(&mut o, sink, k, e, Some((val.is_some(), delta)));
                        ov.next();
                    }
                    _ => o.push(sink, k, val, delta),
                }
                true
            })?;
        }
        for (k, e) in ov {
            emit_ov(&mut o, sink, k, e, None);
        }
        out.trees.insert(tree, o.finish(sink));
    }
    Ok(out)
}

/// An overlay entry into the new layer. The entry is relative to base ⊕ old layer; the new
/// layer's delta is against the base alone. Neither needs a base read:
///   present after       = the entry has a value
///   present in b ⊕ old  = the old layer entry's kind, or (none) present after − overlay delta
///   present in base     = present in b ⊕ old − old delta (no old entry: the same)
fn emit_ov(o: &mut Out, sink: &mut dyn PageSink, k: &[u8], e: &Entry, old: Option<(bool, i8)>) {
    let after = e.val.is_some() as i8;
    let in_base = match old {
        Some((present, delta)) => present as i8 - delta,
        None => after - e.delta,
    };
    // A tombstone over a key that was never there (and had no old entry): nothing to keep.
    if old.is_none() && e.val.is_none() && after - in_base == 0 {
        return;
    }
    o.push(sink, k, e.val.as_deref(), after - in_base);
}

/// Step 3: the overlay over the new layer. Entries not written since `build` are in the layer;
/// the rest are re-expressed against base ⊕ new layer (reading the new layer's `d` for them).
/// Pure: on a miss nothing has changed.
pub fn rebase(ctx: &Ctx, overlay: &Overlay, layer: &Layer) -> Result<BTreeMap<Key, Entry>, Miss> {
    let mut out = BTreeMap::new();
    let mut missed = false;
    for k in overlay.dirty.iter().flatten() {
        let in_new = match layer.trees.get(&k.0).filter(|l| l.d.height > 0) {
            Some(l) => match tree::get(ctx, &l.d, &k.1) {
                Ok(Some(v)) => Some(crate::merged::decode_entry(&v).0.is_some()),
                Ok(None) => None,
                Err(Miss) => {
                    missed = true;
                    continue;
                }
            },
            None => None,
        };
        let Some(e) = overlay.map.get(k) else {
            // The entry was dropped since the fold read the overlay: a write only drops a key
            // base ⊕ old layer doesn't hold, so it must stay absent. The new layer may have it.
            if in_new == Some(true) {
                out.insert(k.clone(), Entry { val: None, delta: -1 });
            }
            continue;
        };
        let after = e.val.is_some() as i8;
        // No entry in the new layer: neither the old layer nor the folded overlay had the key,
        // so base ⊕ new layer = base ⊕ old layer there, and the entry's delta stands.
        let present = match in_new {
            Some(p) => p as i8,
            None => after - e.delta,
        };
        if e.val.is_none() && present == 0 {
            continue; // a tombstone over nothing
        }
        out.insert(k.clone(), Entry { val: e.val.clone(), delta: after - present });
    }
    if missed {
        Err(Miss)
    } else {
        Ok(out)
    }
}

/// Swap in a rebased overlay and its layer.
pub fn commit(overlay: &mut Overlay, map: BTreeMap<Key, Entry>, layer: Rc<Layer>) {
    overlay.bytes = map.iter().map(|((_, k), e)| k.len() + e.val.as_ref().map_or(0, Vec::len)).sum();
    overlay.map = map;
    overlay.layer = Some(layer);
    overlay.dirty = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gen::Rng;
    use crate::merged;
    use crate::overlay::View;
    use crate::page::PageId;
    use crate::tree::{PageStore, VecSink};
    use std::cell::RefCell;
    use std::collections::HashSet;

    /// Pages fault until asked for (then they stay), so every read path runs its fault retries.
    struct Store {
        pages: RefCell<Vec<Rc<[u8]>>>,
        resident: RefCell<HashSet<PageId>>,
    }
    impl PageStore for Store {
        fn get(&self, id: PageId) -> Option<Rc<[u8]>> {
            if !self.resident.borrow().contains(&id) {
                return None;
            }
            self.pages.borrow().get(id as usize).cloned()
        }
    }
    struct Sink<'a>(&'a Store);
    impl PageSink for Sink<'_> {
        fn write(&mut self, page: Vec<u8>) -> PageId {
            let mut p = self.0.pages.borrow_mut();
            p.push(page.into());
            (p.len() - 1) as PageId
        }
    }

    fn retry<T>(store: &Store, overlay: &Overlay, mut f: impl FnMut(&Ctx) -> Result<T, Miss>) -> T {
        for _ in 0..64 {
            let view = View::new(overlay);
            let ctx = Ctx::with_view(store, &view);
            match f(&ctx) {
                Ok(v) => return v,
                Err(Miss) => store.resident.borrow_mut().extend(ctx.take_want()),
            }
        }
        panic!("too many fault rounds");
    }

    const T: u16 = 5;

    fn key(i: u64) -> Vec<u8> {
        format!("k{i:07}").into_bytes()
    }

    /// Put or delete a key the way `write::stage_change` does: entries are relative to
    /// base ⊕ layer, and deleting a key only the overlay added drops its entry.
    fn stage(store: &Store, overlay: &mut Overlay, root: &TreeRoot, k: Vec<u8>, v: Option<Vec<u8>>) {
        let in_bd = retry(store, overlay, |ctx| merged::base_has(ctx, root, &k));
        let e = match v {
            Some(v) => Some(Entry { val: Some(v), delta: 1 - in_bd as i8 }),
            None if !in_bd => None,
            None => Some(Entry { val: None, delta: -1 }),
        };
        overlay.apply(&[((T, k), e)]);
    }

    fn check(store: &Store, overlay: &Overlay, root: &TreeRoot, model: &BTreeMap<Vec<u8>, Vec<u8>>, r: &mut Rng) {
        let keys: Vec<&Vec<u8>> = model.keys().collect();
        let all = |lo: &[u8], hi: &[u8]| model.range(lo.to_vec()..).take_while(|(k, _)| hi.is_empty() || k.as_slice() < hi).map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
        for _ in 0..12 {
            let lo = key(r.below(30_000));
            let hi = if r.below(4) == 0 { Vec::new() } else { key(r.below(30_000)) };
            if !hi.is_empty() && hi < lo {
                continue;
            }
            let range = Range { lo: &lo, hi: &hi };
            let limit = 1 + r.below(3000) as usize;
            for reverse in [false, true] {
                store.resident.borrow_mut().clear();
                let got = retry(store, overlay, |ctx| {
                    let mut got = Vec::new();
                    merged::scan(ctx, root, &range, reverse, limit, &mut |k, v| {
                        got.push((k.to_vec(), v.to_vec()));
                        got.len() < limit
                    })?;
                    Ok(got)
                });
                let mut want = all(&lo, &hi);
                if reverse {
                    want.reverse();
                }
                want.truncate(limit);
                assert_eq!(got.len(), want.len(), "scan {reverse} {:?}..{:?}", String::from_utf8_lossy(&lo), String::from_utf8_lossy(&hi));
                assert!(got == want, "scan contents differ");
            }
            let n = retry(store, overlay, |ctx| merged::count(ctx, root, &range));
            assert_eq!(n as usize, all(&lo, &hi).len(), "count");
            let total = all(&lo, &hi);
            for at in [0, r.below(total.len() as u64 + 3), total.len() as u64 / 2] {
                let got = retry(store, overlay, |ctx| merged::nth(ctx, root, &range, at));
                assert_eq!(got.as_ref(), total.get(at as usize).map(|(k, _)| k), "nth {at} of {}", total.len());
            }
        }
        for _ in 0..40 {
            let k = if r.below(2) == 0 && !keys.is_empty() { keys[r.below(keys.len() as u64) as usize].clone() } else { key(r.below(30_000)) };
            let got = retry(store, overlay, |ctx| merged::get(ctx, root, &k));
            assert_eq!(got.as_ref(), model.get(&k));
        }
    }

    #[test]
    fn big_layers_match_a_plain_map() {
        let mut r = Rng::new(&[42]);
        // Base: every third key of 30,000.
        let mut model = BTreeMap::new();
        let mut sink = VecSink::default();
        let mut b = TreeBuilder::new(T);
        for i in (0..30_000).step_by(3) {
            let v = vec![(i % 251) as u8; 40 + (i % 90) as usize];
            b.push(&mut sink, &key(i), &v);
            model.insert(key(i), v);
        }
        let root = b.finish(&mut sink);
        let store = Store { pages: RefCell::new(sink.pages), resident: RefCell::new(HashSet::new()) };
        let schema = crate::catalog::tracker();
        let roots = Roots::new(schema, [(T, root)].into_iter().collect());
        let mut overlay = Overlay::default();
        let mut rounds = 0;
        for round in 0..6 {
            // A burst of writes, clustered and scattered, with big values so the layer spans
            // many pages and levels.
            for _ in 0..2500 {
                let i = if r.below(3) == 0 { 12_000 + r.below(900) } else { r.below(30_000) };
                let k = key(i);
                if r.below(4) == 0 {
                    stage(&store, &mut overlay, &root, k.clone(), None);
                    model.remove(&k);
                } else {
                    let v = vec![(round * 31 + i % 7) as u8; 20 + r.below(400) as usize];
                    stage(&store, &mut overlay, &root, k.clone(), Some(v.clone()));
                    model.insert(k, v);
                }
            }
            check(&store, &overlay, &root, &model, &mut r);
            // Fold, with writes landing between the build and the commit.
            let layer = retry(&store, &overlay, |ctx| {
                touch(ctx, &overlay)?;
                build(ctx, &roots, &overlay, &mut Sink(&store))
            });
            overlay.dirty = Some(BTreeSet::new());
            for _ in 0..300 {
                let k = key(if r.below(2) == 0 { 12_000 + r.below(900) } else { r.below(30_000) });
                if r.below(3) == 0 {
                    stage(&store, &mut overlay, &root, k.clone(), None);
                    model.remove(&k);
                } else {
                    let v = vec![7u8; 1 + r.below(50) as usize];
                    stage(&store, &mut overlay, &root, k.clone(), Some(v.clone()));
                    model.insert(k, v);
                }
            }
            check(&store, &overlay, &root, &model, &mut r);
            let layer = Rc::new(layer);
            let map = retry(&store, &overlay, |ctx| rebase(ctx, &overlay, &layer));
            commit(&mut overlay, map, layer.clone());
            assert!(overlay.map.len() <= 300);
            check(&store, &overlay, &root, &model, &mut r);
            let d = layer.trees[&T].d;
            assert!(round == 0 || d.height >= 2, "want a multi-level layer, got height {}", d.height);
            rounds += 1;
        }
        assert_eq!(rounds, 6);
    }
}
