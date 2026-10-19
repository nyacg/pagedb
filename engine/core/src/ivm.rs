//! Incremental view maintenance. A live query is a *partition* of a query family: a window of
//! index keys (its current result) plus whether the window holds every matching row. A write's
//! row changes are pushed through each partition to produce add / remove / edit ops; rows that
//! fall out of a full window are replaced by scanning on from the window's last key.
//!
//! `compute` is pure: it reads (through the staged overlay view, so it sees the batch's writes)
//! and returns the partition's next state and its ops, or `Miss`. Nothing is mutated until the
//! whole write — overlay and every partition — has computed without faulting. So a push can't
//! leave a half-updated window behind; the shell resolves the pages and retries the batch.

use crate::catalog::{self, index_entries, Table};
use crate::codec::{RowRef, Value};
use crate::query::{comments_match, execute, render, row_in_partition, Hit, Output, Plan, RelKind, Roots};
use crate::tree::{Ctx, Miss};
use crate::write::RowChange;
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq)]
pub enum DeltaOp {
    Add { pk: String, json: String },
    Remove { pk: String },
    Edit { pk: String, json: String },
    Count(u64),
}

#[derive(Clone, Debug)]
pub enum State {
    /// Window of (index key, pk) in scan order.
    Rows { window: Vec<(Vec<u8>, String)>, complete: bool },
    Count(u64),
}

#[derive(Clone, Debug)]
pub struct Partition {
    pub plan: Rc<Plan>,
    pub state: State,
}

/// Hydrate a partition: its state plus the rows/count to send to a new subscriber.
pub fn hydrate(ctx: &Ctx, roots: &Roots, plan: Rc<Plan>) -> Result<(Partition, Output), Miss> {
    let out = execute(ctx, roots, &plan)?;
    let state = match &out {
        Output::Count(n) => State::Count(*n),
        Output::Rows { hits, complete } => State::Rows { window: hits.iter().map(|h| (h.key.clone(), h.pk.clone())).collect(), complete: *complete },
    };
    Ok((Partition { plan, state }, out))
}

/// Does `a` come before `b` in the partition's scan order?
fn before(plan: &Plan, a: &[u8], b: &[u8]) -> bool {
    if plan.reverse {
        a > b
    } else {
        a < b
    }
}

/// The row's key in this partition's index, if the row belongs to the partition (read through
/// ctx's view, so comment search sees the batch's comments).
fn key_in(ctx: &Ctx, roots: &Roots, plan: &Plan, row: &[Value]) -> Result<Option<Vec<u8>>, Miss> {
    let enc = crate::codec::encode_row(row);
    let r = RowRef(&enc);
    let ix = plan.index;
    for (k, _) in index_entries(ix, row) {
        // For a multi-valued index, the partition's prefix fixes the element.
        let elem = ix.multi.map(|_| {
            let vals = crate::codec::decode_key(&k[..], &ix.key.iter().map(|(_, d)| *d).collect::<Vec<_>>());
            let pos = ix.key.iter().position(|(c, _)| Some(*c) == ix.multi).unwrap();
            vals[pos].as_str().unwrap_or_default().to_string()
        });
        if row_in_partition(plan, r, elem.as_deref()) && plan.in_range(&k) {
            return Ok(if comments_match(ctx, roots, plan, r)? { Some(k) } else { None });
        }
    }
    Ok(None)
}

fn render_row(ctx: &Ctx, roots: &Roots, plan: &Plan, row: &[Value]) -> Result<String, Miss> {
    let enc = crate::codec::encode_row(row);
    render(ctx, roots, plan, RowRef(&enc))
}

/// Next state and ops for one partition after `changes` (all staged in ctx's view).
pub fn compute(ctx: &Ctx, roots: &Roots, part: &Partition, changes: &[RowChange]) -> Result<(State, Vec<DeltaOp>), Miss> {
    let plan = &*part.plan;
    match &part.state {
        State::Count(n) => {
            if !changes.iter().any(|c| c.table == plan.table) {
                return Ok((part.state.clone(), vec![]));
            }
            match execute(ctx, roots, plan)? {
                Output::Count(m) if m != *n => Ok((State::Count(m), vec![DeltaOp::Count(m)])),
                _ => Ok((part.state.clone(), vec![])),
            }
        }
        State::Rows { window, complete } => {
            let mut w = window.clone();
            let mut complete = *complete;
            let mut ops: Vec<DeltaOp> = Vec::new();
            let mut missed = false;
            // Rows of this table entering, leaving or changing within the window.
            for ch in changes.iter().filter(|c| c.table == plan.table) {
                let new_k = match ch.new.as_ref().map(|r| key_in(ctx, roots, plan, r)).transpose() {
                    Ok(k) => k.flatten(),
                    Err(Miss) => {
                        missed = true;
                        continue;
                    }
                };
                let pk = ch.new.as_ref().or(ch.old.as_ref()).unwrap()[0].as_str().unwrap_or("").to_string();
                // Where the row was: by pk (a window holds a pk at most once). Re-evaluating the
                // old row would read the *new* comments, so it can't tell whether it matched.
                let pos = if ch.old.is_some() { w.iter().position(|(_, p)| *p == pk) } else { None };
                if let (Some(i), Some(nk)) = (pos, &new_k) {
                    if &w[i].0 == nk {
                        match render_row(ctx, roots, plan, ch.new.as_ref().unwrap()) {
                            Ok(json) => ops.push(DeltaOp::Edit { pk, json }),
                            Err(Miss) => missed = true,
                        }
                        continue;
                    }
                }
                if let Some(i) = pos {
                    w.remove(i);
                    ops.push(DeltaOp::Remove { pk: pk.clone() });
                }
                if let Some(nk) = new_k {
                    let fits = w.len() < plan.limit;
                    let ahead_of_last = w.last().map(|(lk, _)| before(plan, &nk, lk)).unwrap_or(true);
                    // Not full: a complete window takes any matching row; an incomplete one only
                    // rows ahead of its last key (later ones are picked up by the refill).
                    if (fits && (complete || ahead_of_last)) || (!fits && ahead_of_last) {
                        let at = w.iter().position(|(wk, _)| before(plan, &nk, wk)).unwrap_or(w.len());
                        w.insert(at, (nk, pk.clone()));
                        match render_row(ctx, roots, plan, ch.new.as_ref().unwrap()) {
                            Ok(json) => ops.push(DeltaOp::Add { pk, json }),
                            Err(Miss) => missed = true,
                        }
                        if w.len() > plan.limit {
                            let (_, evicted) = w.pop().unwrap();
                            ops.push(DeltaOp::Remove { pk: evicted });
                            complete = false;
                        }
                    }
                }
            }
            // Refill a window that lost rows.
            if w.len() < plan.limit && !complete {
                let (lo_prefix, hi_prefix) = plan.scan_range();
                // Continue strictly after the last key in scan order.
                let (lo, hi) = match (w.last(), plan.reverse) {
                    (None, _) => (lo_prefix.clone(), hi_prefix.clone()),
                    (Some((lk, _)), false) => {
                        let mut after = lk.clone();
                        after.push(0);
                        (after, hi_prefix.clone())
                    }
                    (Some((lk, _)), true) => (lo_prefix.clone(), lk.clone()),
                };
                let need = plan.limit - w.len();
                let (found, more) = crate::query::collect(ctx, roots, plan, &lo, &hi, need)?;
                complete = !more;
                for (k, v) in found {
                    let pk = RowRef(&v).get(0).str().to_string();
                    if w.iter().any(|(_, p)| *p == pk) {
                        continue;
                    }
                    match render(ctx, roots, plan, RowRef(&v)) {
                        Ok(json) => ops.push(DeltaOp::Add { pk: pk.clone(), json }),
                        Err(Miss) => missed = true,
                    }
                    w.push((k, pk));
                }
            }
            // Rows whose related data changed (e.g. a comment on an issue shown in detail).
            for r in &plan.related {
                let RelKind::Many { plan: child, parent_col: 0 } = &r.kind else { continue };
                let fk = child.index.key[0].0;
                for ch in changes.iter().filter(|c| c.table == child.table) {
                    let parents: Vec<String> =
                        [ch.old.as_ref(), ch.new.as_ref()].into_iter().flatten().filter_map(|row| row[fk].as_str().map(str::to_string)).collect();
                    for pk in parents {
                        if !w.iter().any(|(_, p)| *p == pk) || ops.iter().any(|o| matches!(o, DeltaOp::Add { pk: p, .. } | DeltaOp::Edit { pk: p, .. } if *p == pk)) {
                            continue;
                        }
                        match crate::write::read_row(ctx, roots, plan.table, &pk) {
                            Ok(Some(row)) => match render_row(ctx, roots, plan, &row) {
                                Ok(json) => ops.push(DeltaOp::Edit { pk, json }),
                                Err(Miss) => missed = true,
                            },
                            Ok(None) => {}
                            Err(Miss) => missed = true,
                        }
                    }
                }
            }
            if missed {
                return Err(Miss);
            }
            Ok((State::Rows { window: w, complete }, ops))
        }
    }
}

/// Compare a maintained window with a fresh execution (tests and debug checks).
pub fn window_matches_fresh(ctx: &Ctx, roots: &Roots, plan: &Plan, state: &State) -> Result<bool, Miss> {
    Ok(match (state, execute(ctx, roots, plan)?) {
        (State::Count(a), Output::Count(b)) => *a == b,
        (State::Rows { window, complete }, Output::Rows { hits, complete: c2 }) => {
            let fresh: Vec<&String> = hits.iter().map(|h: &Hit| &h.pk).collect();
            let mine: Vec<&String> = window.iter().map(|(_, p)| p).collect();
            mine == fresh && (*complete == c2 || hits.len() < plan.limit)
        }
        _ => false,
    })
}

#[allow(dead_code)]
fn _uses(_: Table) {
    let _ = catalog::INDEXES;
}
