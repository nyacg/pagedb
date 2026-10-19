//! The write overlay: index entries written since the base was published, keyed (tree, key).
//! `None` is a tombstone hiding a base entry. `delta` is the entry's effect on the tree's row
//! count relative to the base (+1 new key, −1 deleted base key, 0 replaced value), which keeps
//! counts O(height): base count from counted branch pages + the sum of deltas in the range.
//!
//! Reads go through `View`: the committed overlay, optionally with a batch's staged writes on
//! top, so a write batch reads its own writes and nothing is committed until it all succeeds.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ops::Bound;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub val: Option<Vec<u8>>,
    pub delta: i8,
}

pub type Key = (u16, Vec<u8>);

#[derive(Default, Clone)]
pub struct Overlay {
    pub map: BTreeMap<Key, Entry>,
    pub version: u64,
    pub bytes: usize,
}

impl Overlay {
    pub fn apply(&mut self, writes: &[(Key, Option<Entry>)]) {
        for (k, e) in writes {
            if let Some(old) = self.map.get(k) {
                self.bytes -= k.1.len() + old.val.as_ref().map_or(0, |v| v.len());
            }
            match e {
                Some(e) => {
                    self.bytes += k.1.len() + e.val.as_ref().map_or(0, |v| v.len());
                    self.map.insert(k.clone(), e.clone());
                }
                None => {
                    self.map.remove(k);
                }
            }
        }
    }
}

/// Committed overlay + staged writes (later writes win). `None` in `staged` = entry removed
/// from the overlay entirely (the key is back to its base state).
pub struct View<'a> {
    pub base: &'a Overlay,
    pub staged: RefCell<BTreeMap<Key, Option<Entry>>>,
}

impl<'a> View<'a> {
    pub fn new(base: &'a Overlay) -> Self {
        View { base, staged: RefCell::new(BTreeMap::new()) }
    }

    pub fn get(&self, tree: u16, key: &[u8]) -> Option<Entry> {
        let k = (tree, key.to_vec());
        match self.staged.borrow().get(&k) {
            Some(s) => s.clone(),
            None => self.base.map.get(&k).cloned(),
        }
    }

    /// Overlay entries of `tree` in [lo, hi) (hi empty = unbounded), in key order, merged.
    pub fn range(&self, tree: u16, lo: &[u8], hi: &[u8]) -> Vec<(Vec<u8>, Entry)> {
        let start: Bound<Key> = Bound::Included((tree, lo.to_vec()));
        let end: Bound<Key> = if hi.is_empty() { Bound::Excluded((tree + 1, Vec::new())) } else { Bound::Excluded((tree, hi.to_vec())) };
        let mut out: BTreeMap<Vec<u8>, Option<Entry>> = BTreeMap::new();
        for ((_, k), e) in self.base.map.range((start.clone(), end.clone())) {
            out.insert(k.clone(), Some(e.clone()));
        }
        for ((_, k), e) in self.staged.borrow().range((start, end)) {
            out.insert(k.clone(), e.clone());
        }
        out.into_iter().filter_map(|(k, e)| e.map(|e| (k, e))).collect()
    }

    pub fn is_empty_for(&self, tree: u16) -> bool {
        let lo: Key = (tree, Vec::new());
        let hi: Key = (tree + 1, Vec::new());
        self.base.map.range(lo.clone()..hi.clone()).next().is_none() && self.staged.borrow().range(lo..hi).next().is_none()
    }

    pub fn stage(&self, tree: u16, key: Vec<u8>, e: Option<Entry>) {
        self.staged.borrow_mut().insert((tree, key), e);
    }

    pub fn into_writes(self) -> Vec<(Key, Option<Entry>)> {
        self.staged.into_inner().into_iter().collect()
    }
}
