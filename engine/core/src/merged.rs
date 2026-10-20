//! Reads over base ⊕ overlay. Same contract as `tree`: never block, record misses.

use crate::tree::{self, Ctx, Miss, Range, TreeRoot};

/// Scan [lo, hi) merging overlay entries (puts replace or add, tombstones hide).
pub fn scan(ctx: &Ctx, root: &TreeRoot, range: &Range, reverse: bool, hint: usize, f: &mut dyn FnMut(&[u8], &[u8]) -> bool) -> Result<(), Miss> {
    let view = match ctx.view {
        Some(v) if !v.is_empty_for(root.tree) => v,
        _ => return tree::scan(ctx, root, range, reverse, hint, f),
    };
    let mut ov = view.range(root.tree, range.lo, range.hi);
    if reverse {
        ov.reverse();
    }
    let tombstones = ov.iter().filter(|(_, e)| e.val.is_none()).count();
    let mut i = 0;
    let mut stopped = false;
    let before = |a: &[u8], b: &[u8]| if reverse { a > b } else { a < b };
    tree::scan(ctx, root, range, reverse, hint + tombstones, &mut |k, v| {
        while i < ov.len() && before(&ov[i].0, k) {
            if let Some(val) = &ov[i].1.val {
                if !f(&ov[i].0, val) {
                    stopped = true;
                    return false;
                }
            }
            i += 1;
        }
        if i < ov.len() && ov[i].0.as_slice() == k {
            let e = &ov[i].1;
            i += 1;
            return match &e.val {
                Some(val) => {
                    let go = f(k, val);
                    stopped = !go;
                    go
                }
                None => true,
            };
        }
        let go = f(k, v);
        stopped = !go;
        go
    })?;
    if !stopped {
        while i < ov.len() {
            if let Some(val) = &ov[i].1.val {
                if !f(&ov[i].0, val) {
                    break;
                }
            }
            i += 1;
        }
    }
    Ok(())
}

pub fn get(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<Option<Vec<u8>>, Miss> {
    if let Some(v) = ctx.view {
        if let Some(e) = v.get(root.tree, key) {
            return Ok(e.val);
        }
    }
    tree::get(ctx, root, key)
}

/// Whether the *base* holds `key` (ignores the overlay). Used to compute rank deltas.
pub fn base_has(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<bool, Miss> {
    tree::get(ctx, root, key).map(|v| v.is_some())
}

pub fn count(ctx: &Ctx, root: &TreeRoot, range: &Range) -> Result<u64, Miss> {
    let base = tree::count(ctx, root, range)?;
    let delta: i64 = match ctx.view {
        Some(v) => v.range(root.tree, range.lo, range.hi).iter().map(|(_, e)| e.delta as i64).sum(),
        None => 0,
    };
    Ok((base as i64 + delta).max(0) as u64)
}

/// Key at position `n` of [range.lo, range.hi) in base ⊕ overlay. The base's position is
/// corrected by the overlay's count deltas before it (a few rounds; the overlay is small).
pub fn nth(ctx: &Ctx, root: &TreeRoot, range: &Range, n: u64) -> Result<Option<Vec<u8>>, Miss> {
    let base_lo = tree::rank(ctx, root, range.lo)?;
    let mut adj: i64 = 0;
    let mut key = None;
    for _ in 0..8 {
        let at = base_lo as i64 + n as i64 - adj;
        if at < 0 {
            return Ok(None);
        }
        key = tree::nth(ctx, root, at as u64)?;
        let Some(k) = &key else { break };
        let next: i64 = match ctx.view {
            Some(v) => v.range(root.tree, range.lo, k).iter().map(|(_, e)| e.delta as i64).sum(),
            None => 0,
        };
        if next == adj {
            break;
        }
        adj = next;
    }
    Ok(key.filter(|k| range.hi.is_empty() || k.as_slice() < range.hi))
}
