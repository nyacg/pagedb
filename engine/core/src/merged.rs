//! Reads over base ⊕ layer ⊕ overlay. Same contract as `tree`: never block, record misses.
//!
//! Two merges, one inside the other. The base and the folded layer (`fold`) merge into what the
//! overlay treats as "the base" (`bd_*`); the overlay merges on top of that, exactly as it did
//! over the base alone. Counts stay O(height): the base's counted branch pages, plus the layer's
//! `plus`/`minus` key trees, plus the overlay's deltas.

use crate::overlay::LayerTrees;
use crate::tree::{self, Ctx, Miss, Range, TreeRoot};

fn layer<'a>(ctx: &'a Ctx, tree: u16) -> Option<&'a LayerTrees> {
    ctx.view.and_then(|v| v.layer(tree)).filter(|l| l.d.height > 0)
}

/// A layer entry's value: `Some(row value)` or `None` (tombstone), and its count delta.
pub fn decode_entry(v: &[u8]) -> (Option<&[u8]>, i8) {
    ((v[0] == 1).then(|| &v[2..]), v[1] as i8)
}

/// Both lookups are attempted before failing, so their misses share a round.
fn both<A, B>(a: Result<A, Miss>, b: Result<B, Miss>) -> Result<(A, B), Miss> {
    Ok((a?, b?))
}

/// The smallest key after `k` (keys are byte strings).
fn after(k: &[u8]) -> Vec<u8> {
    let mut v = k.to_vec();
    v.push(0);
    v
}

/// Merge `ov` (in scan order; `None` = tombstone) into a base scan. Returns Ok(true) if `f`
/// asked to stop.
fn merge_scan(
    base: &mut dyn FnMut(usize, &mut dyn FnMut(&[u8], &[u8]) -> bool) -> Result<(), Miss>,
    ov: &[(Vec<u8>, Option<&[u8]>)],
    reverse: bool,
    hint: usize,
    f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
) -> Result<bool, Miss> {
    let tombstones = ov.iter().filter(|(_, v)| v.is_none()).count();
    let mut i = 0;
    let mut stopped = false;
    let before = |a: &[u8], b: &[u8]| if reverse { a > b } else { a < b };
    base(hint + tombstones, &mut |k, v| {
        while i < ov.len() && before(&ov[i].0, k) {
            if let Some(val) = ov[i].1 {
                if !f(&ov[i].0, val) {
                    stopped = true;
                    return false;
                }
            }
            i += 1;
        }
        if i < ov.len() && ov[i].0.as_slice() == k {
            let e = ov[i].1;
            i += 1;
            return match e {
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
            if let Some(val) = ov[i].1 {
                if !f(&ov[i].0, val) {
                    return Ok(true);
                }
            }
            i += 1;
        }
    }
    Ok(stopped)
}

// ------------------------------------------------------------------ base ⊕ layer

/// Scan base ⊕ layer. The layer is read in chunks (in scan order); each chunk is merged with the
/// base over the stretch of keys it covers, so a long scan never holds the whole layer.
fn bd_scan(ctx: &Ctx, root: &TreeRoot, range: &Range, reverse: bool, hint: usize, f: &mut dyn FnMut(&[u8], &[u8]) -> bool) -> Result<(), Miss> {
    let Some(l) = layer(ctx, root.tree) else { return tree::scan(ctx, root, range, reverse, hint, f) };
    // Unit tests use tiny chunks so every scan crosses chunk boundaries.
    let chunk = if cfg!(test) { 3 + hint % 11 } else { (hint + 64).max(256) };
    let (mut lo, mut hi) = (range.lo.to_vec(), range.hi.to_vec());
    loop {
        let mut raw: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        tree::scan(ctx, &l.d, &Range { lo: &lo, hi: &hi }, reverse, chunk, &mut |k, v| {
            raw.push((k.to_vec(), v.to_vec()));
            raw.len() < chunk
        })?;
        let more = raw.len() == chunk;
        let ds: Vec<(Vec<u8>, Option<&[u8]>)> = raw.iter().map(|(k, v)| (k.clone(), decode_entry(v).0)).collect();
        // The keys this chunk covers: up to and including its last key, or the rest of the range.
        let (slo, shi) = match (more, reverse) {
            (false, _) => (lo.clone(), hi.clone()),
            (true, false) => (lo.clone(), after(&ds.last().unwrap().0)),
            (true, true) => (ds.last().unwrap().0.clone(), hi.clone()),
        };
        let stopped = merge_scan(&mut |h, g| tree::scan(ctx, root, &Range { lo: &slo, hi: &shi }, reverse, h, g), &ds, reverse, hint, f)?;
        if stopped || !more {
            return Ok(());
        }
        let last = &ds.last().unwrap().0;
        if reverse {
            hi = last.clone();
        } else {
            lo = after(last);
        }
    }
}

fn bd_get(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<Option<Vec<u8>>, Miss> {
    let Some(l) = layer(ctx, root.tree) else { return tree::get(ctx, root, key) };
    let d = tree::get(ctx, &l.d, key);
    let b = tree::get(ctx, root, key);
    match d? {
        Some(v) => Ok(decode_entry(&v).0.map(<[u8]>::to_vec)),
        None => b,
    }
}

/// Entries of base ⊕ layer with key < `key`.
fn bd_rank(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<u64, Miss> {
    let b = tree::rank(ctx, root, key);
    let Some(l) = layer(ctx, root.tree) else { return b };
    let (p, m) = both(tree::rank(ctx, &l.plus, key), tree::rank(ctx, &l.minus, key))?;
    Ok((b? + p).saturating_sub(m))
}

fn bd_count(ctx: &Ctx, root: &TreeRoot, range: &Range) -> Result<u64, Miss> {
    let b = tree::count(ctx, root, range);
    let Some(l) = layer(ctx, root.tree) else { return b };
    let (p, m) = both(tree::count(ctx, &l.plus, range), tree::count(ctx, &l.minus, range))?;
    Ok((b? + p).saturating_sub(m))
}

// ------------------------------------------------------------------ ⊕ overlay

fn ov_delta(ctx: &Ctx, tree: u16, lo: &[u8], hi: &[u8]) -> i64 {
    match ctx.view {
        Some(v) => v.range(tree, lo, hi).iter().map(|(_, e)| e.delta as i64).sum(),
        None => 0,
    }
}

/// Scan [lo, hi) merging overlay entries (puts replace or add, tombstones hide).
pub fn scan(ctx: &Ctx, root: &TreeRoot, range: &Range, reverse: bool, hint: usize, f: &mut dyn FnMut(&[u8], &[u8]) -> bool) -> Result<(), Miss> {
    let view = match ctx.view {
        Some(v) if !v.is_empty_for(root.tree) => v,
        _ => return bd_scan(ctx, root, range, reverse, hint, f),
    };
    let mut ov = view.range(root.tree, range.lo, range.hi);
    if reverse {
        ov.reverse();
    }
    let ov: Vec<(Vec<u8>, Option<&[u8]>)> = ov.iter().map(|(k, e)| (k.clone(), e.val.as_deref())).collect();
    merge_scan(&mut |h, g| bd_scan(ctx, root, range, reverse, h, g), &ov, reverse, hint, f).map(|_| ())
}

pub fn get(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<Option<Vec<u8>>, Miss> {
    if let Some(v) = ctx.view {
        if let Some(e) = v.get(root.tree, key) {
            return Ok(e.val);
        }
    }
    bd_get(ctx, root, key)
}

/// Whether base ⊕ layer holds `key` (ignores the overlay): what overlay deltas are relative to.
pub fn base_has(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<bool, Miss> {
    bd_get(ctx, root, key).map(|v| v.is_some())
}

pub fn count(ctx: &Ctx, root: &TreeRoot, range: &Range) -> Result<u64, Miss> {
    let base = bd_count(ctx, root, range)?;
    Ok((base as i64 + ov_delta(ctx, root.tree, range.lo, range.hi)).max(0) as u64)
}

/// Entries of the merged view with key < `key`.
fn rank(ctx: &Ctx, root: &TreeRoot, key: &[u8]) -> Result<i64, Miss> {
    Ok(bd_rank(ctx, root, key)? as i64 + ov_delta(ctx, root.tree, &[], key))
}

/// Key at position `n` of [range.lo, range.hi) in the merged view.
///
/// The base's counted pages find a nearby base key in a few steps (each corrected by the layer's
/// and overlay's count changes before it); a short scan of the merged view from there lands
/// exactly, wherever added or deleted keys cluster.
pub fn nth(ctx: &Ctx, root: &TreeRoot, range: &Range, n: u64) -> Result<Option<Vec<u8>>, Miss> {
    let target = rank(ctx, root, range.lo)? + n as i64;
    let b_lo = tree::rank(ctx, root, range.lo)?;
    let b_hi = if range.hi.is_empty() { root.rows } else { tree::rank(ctx, root, range.hi)? };
    let mut near: Option<(Vec<u8>, i64)> = None;
    if b_lo < b_hi {
        let mut at = (b_lo as i64 + n as i64).clamp(b_lo as i64, b_hi as i64 - 1);
        for _ in 0..8 {
            let Some(k) = tree::nth(ctx, root, at as u64)? else { break };
            let r = rank(ctx, root, &k)?;
            let next = (at + target - r).clamp(b_lo as i64, b_hi as i64 - 1);
            near = Some((k, r));
            if r == target || next == at {
                break;
            }
            at = next;
        }
    }
    // From `k` (merged rank r: r entries before it), step the remaining distance through the
    // merged view itself.
    let (from, r) = near.unwrap_or_else(|| (range.lo.to_vec(), target - n as i64));
    let diff = target - r;
    let mut found = None;
    if diff >= 0 {
        let mut i = 0i64;
        scan(ctx, root, &Range { lo: &from, hi: range.hi }, false, diff as usize + 1, &mut |k, _| {
            if i == diff {
                found = Some(k.to_vec());
                return false;
            }
            i += 1;
            true
        })?;
    } else {
        let mut i = 0i64;
        scan(ctx, root, &Range { lo: range.lo, hi: &from }, true, (-diff) as usize, &mut |k, _| {
            i += 1;
            if i == -diff {
                found = Some(k.to_vec());
                return false;
            }
            true
        })?;
    }
    Ok(found)
}
