//! The write overlay: index entries written since the base was published, keyed (tree, key).
//! `None` is a tombstone hiding a base entry. `delta` is the entry's effect on the tree's row
//! count relative to the base (+1 new key, −1 deleted base key, 0 replaced value), which keeps
//! counts O(height): base count from counted branch pages + the sum of deltas in the range.
//!
//! Reads go through `View`: the committed overlay, optionally with a batch's staged writes on
//! top, so a write batch reads its own writes and nothing is committed until it all succeeds.
//!
//! Under the overlay there may be a **layer**: earlier writes, folded into B+trees in R2 (see
//! `fold`). The overlay is then relative to base ⊕ layer: its deltas say how an entry changes the
//! count of base ⊕ layer, and dropping an entry returns a key to its base ⊕ layer state.

use crate::tree::TreeRoot;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Bound;
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub val: Option<Vec<u8>>,
    pub delta: i8,
}

pub type Key = (u16, Vec<u8>);

/// One index's folded writes. `d` maps each changed key to its entry (`fold::encode_entry`:
/// value or tombstone, with its count delta against the base). `plus` and `minus` hold just the
/// keys whose delta is +1 / −1, so their counted branch pages give the layer's count change over
/// any range in O(height).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerTrees {
    pub d: TreeRoot,
    pub plus: TreeRoot,
    pub minus: TreeRoot,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Layer {
    pub trees: HashMap<u16, LayerTrees>,
}

#[derive(Default, Clone)]
pub struct Overlay {
    pub map: BTreeMap<Key, Entry>,
    pub version: u64,
    pub bytes: usize,
    /// Folded writes under the overlay.
    pub layer: Option<Rc<Layer>>,
    /// While a fold is in flight: keys written since it read the overlay (they must be rebased
    /// onto the new layer when it commits; every other entry is in the new layer already).
    pub dirty: Option<BTreeSet<Key>>,
}

impl Overlay {
    pub fn apply(&mut self, writes: &[(Key, Option<Entry>)]) {
        if let Some(d) = self.dirty.as_mut() {
            d.extend(writes.iter().map(|(k, _)| k.clone()));
        }
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

    /// Every entry of `tree` (committed, with `staged` — this view's staged map, borrowed by
    /// the caller — on top), by reference: no copies, for scans over many overlay entries.
    pub fn visit<'s>(&'s self, tree: u16, staged: &'s BTreeMap<Key, Option<Entry>>, f: &mut dyn FnMut(&'s [u8], &'s Entry)) {
        let lo: Key = (tree, Vec::new());
        let hi: Key = (tree + 1, Vec::new());
        for ((_, k), e) in self.base.map.range(lo.clone()..hi.clone()) {
            if staged.is_empty() || !staged.contains_key(&(tree, k.clone())) {
                f(k, e);
            }
        }
        for ((_, k), e) in staged.range(lo..hi) {
            if let Some(e) = e {
                f(k, e);
            }
        }
    }

    /// The folded layer's trees for `tree`, if any.
    pub fn layer(&self, tree: u16) -> Option<&'a LayerTrees> {
        self.base.layer.as_deref()?.trees.get(&tree)
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
