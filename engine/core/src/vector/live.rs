//! Live vector searches: a subscription holds its top-k window (score, pk). A write's vector
//! entries are scored against the query the way a search scores them: one that beats the k-th
//! score (or fills a short window) is added and the k-th removed; a re-filed vector moves or
//! leaves; a deleted row leaves; an updated row (e.g. its points) is re-sent in place.
//!
//! Like `ivm::compute`, `compute` is pure and may return `Miss`; nothing changes until the whole
//! write has computed. A window that loses rows isn't refilled (that would take a search): the
//! subscriber keeps fewer than k results until it searches again.

use super::{render, search, AnnHit, AnnQuery, AnnStats, Scorer};
use crate::codec::{encode_row, RowRef};
use crate::ivm::DeltaOp;
use crate::query::Roots;
use crate::tree::{Ctx, Miss};
use crate::write::{RowChange, VecChange};
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct AnnLive {
    pub q: AnnQuery,
    /// Best first.
    pub window: Vec<(f32, String)>,
}

pub fn hydrate(ctx: &Ctx, roots: &Roots, q: AnnQuery) -> Result<(AnnLive, Vec<AnnHit>, AnnStats), Miss> {
    let (hits, stats) = search(ctx, roots, &q)?;
    let window = hits.iter().map(|h| (h.score, h.pk.clone())).collect();
    Ok((AnnLive { q, window }, hits, stats))
}

pub fn compute(ctx: &Ctx, roots: &Roots, live: &AnnLive, vecs: &[VecChange], rows: &[RowChange]) -> Result<(Vec<(f32, String)>, Vec<DeltaOp>), Miss> {
    let vi = &roots.vectors[live.q.index];
    let mut w = live.window.clone();
    let mut ops = Vec::new();
    let mut touched: HashSet<String> = HashSet::new();
    let relevant: Vec<&VecChange> = vecs.iter().filter(|c| c.index == live.q.index).collect();
    if !relevant.is_empty() {
        let cents = vi.centroids(ctx, roots)?;
        let scorer = Scorer::new(vi, &live.q.q);
        for vc in relevant {
            let at = w.iter().position(|(_, p)| *p == vc.pk);
            let scored = vc.new.as_ref().and_then(|(k, val)| {
                let (code, row) = vi.split(val);
                if !live.q.filters.iter().all(|f| f.matches(row)) {
                    return None;
                }
                let cid = super::cluster_of(k);
                let i = cents.ids.binary_search(&cid).ok()?;
                let qc = super::kernels::dot_f32_i8(&live.q.q, cents.code(i)) * cents.scale[i];
                Some((scorer.score(qc, code), row))
            });
            // Full window: a row that wasn't in it must beat the k-th; a row that was stays only
            // if it still beats the rest's last (it can't know what's past the window). A short
            // window (fewer matches than k) takes every match.
            let full = w.len() >= live.q.k;
            if let Some(i) = at {
                w.remove(i);
            }
            let admit = |s: f32, w: &Vec<(f32, String)>| match at {
                Some(_) => !full || w.last().map_or(true, |(m, _)| s >= *m),
                None => w.len() < live.q.k || w.last().is_some_and(|(m, _)| s > *m),
            };
            match scored {
                Some((s, row)) if admit(s, &w) => {
                    let pos = w.iter().position(|(m, _)| s > *m).unwrap_or(w.len());
                    w.insert(pos, (s, vc.pk.clone()));
                    let mut json = String::new();
                    render(&mut json, roots.schema, vi, row, s);
                    ops.push(if at.is_some() { DeltaOp::Edit { pk: vc.pk.clone(), json } } else { DeltaOp::Add { pk: vc.pk.clone(), json } });
                    if w.len() > live.q.k {
                        let (_, out) = w.pop().unwrap();
                        ops.push(DeltaOp::Remove { pk: out });
                    }
                }
                _ if at.is_some() => ops.push(DeltaOp::Remove { pk: vc.pk.clone() }),
                _ => {}
            }
            touched.insert(vc.pk.clone());
        }
    }
    // Rows in the window that changed (points, comments) or went away.
    for ch in rows.iter().filter(|c| c.table == vi.table) {
        let row = ch.new.as_ref().or(ch.old.as_ref()).unwrap();
        let pk = row[0].as_str().unwrap_or("");
        if touched.contains(pk) {
            continue;
        }
        let Some(i) = w.iter().position(|(_, p)| p == pk) else { continue };
        match &ch.new {
            None => {
                w.remove(i);
                ops.push(DeltaOp::Remove { pk: pk.to_string() });
            }
            Some(new) => {
                let mut json = String::new();
                render(&mut json, roots.schema, vi, RowRef(&encode_row(&vi.project(new))), w[i].0);
                ops.push(DeltaOp::Edit { pk: pk.to_string(), json });
            }
        }
    }
    Ok((w, ops))
}
