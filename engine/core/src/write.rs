//! Writes: row operations → index entries in the overlay, computed purely (reads may fault;
//! nothing is committed until the whole batch succeeds).
//!
//! The engine keeps derived data consistent:
//! - every index of the table (covering copies, multi-valued tag entries);
//! - `issue.commentCount` and `issue.updatedAt` when comments are added or removed;
//! - `comment.projectId` / `comment.issueTitle` (copied from the issue), including when an
//!   issue's title changes or it is deleted (its comments go with it).

use crate::catalog::{self, comment, index_entries, issue, primary_of, Table};
use crate::codec::{RowRef, Value};
use crate::merged;
use crate::overlay::{Entry, View};
use crate::query::{json_to_value, prefix_key, Roots};
use crate::tree::{Ctx, Miss, Range};
use serde_json::Value as J;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub enum Op {
    Insert { table: Table, row: Vec<Value> },
    Update { table: Table, id: String, set: Vec<(usize, Value)> },
    Delete { table: Table, id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RowChange {
    pub table: Table,
    pub old: Option<Vec<Value>>,
    pub new: Option<Vec<Value>>,
}

#[derive(Debug)]
pub enum WriteError {
    Miss,
    Invalid(String),
}

impl From<Miss> for WriteError {
    fn from(_: Miss) -> Self {
        WriteError::Miss
    }
}

fn col_value(table: Table, col: usize, v: &J) -> Value {
    if table == Table::Issue && col == issue::TAGS {
        if let Some(arr) = v.as_array() {
            let mut tags: Vec<String> = arr.iter().filter_map(|t| t.as_str().map(str::to_string)).collect();
            tags.sort();
            tags.dedup();
            return Value::Str(catalog::tags_json(&tags));
        }
    }
    json_to_value(v)
}

/// `{"ops":[{"op":"insert","table":"issue","row":{…}}, {"op":"update","table":"issue","id":"…","set":{…}}, {"op":"delete","table":"comment","id":"…"}]}`
pub fn parse_ops(j: &J) -> Result<Vec<Op>, String> {
    let mut out = Vec::new();
    for o in j.get("ops").and_then(J::as_array).ok_or("missing ops")? {
        let table = Table::from_name(o.get("table").and_then(J::as_str).ok_or("op without table")?).ok_or("unknown table")?;
        if matches!(table, Table::Project | Table::User) {
            return Err("projects and users are read-only".into());
        }
        match o.get("op").and_then(J::as_str).ok_or("op without op")? {
            "insert" => {
                let obj = o.get("row").and_then(J::as_object).ok_or("insert without row")?;
                let mut row = vec![Value::Null; table.columns().len()];
                for (name, v) in obj {
                    let c = table.col(name).ok_or_else(|| format!("unknown column {name}"))?;
                    row[c] = col_value(table, c, v);
                }
                if table == Table::Issue {
                    row[issue::COMMENTS] = Value::Num(0.0);
                    if row[issue::TAGS] == Value::Null {
                        row[issue::TAGS] = Value::from("[]");
                    }
                }
                if row[0].as_str().map_or(true, str::is_empty) {
                    return Err("insert needs a string id".into());
                }
                out.push(Op::Insert { table, row });
            }
            "update" => {
                let id = o.get("id").and_then(J::as_str).ok_or("update without id")?.to_string();
                let mut set = Vec::new();
                for (name, v) in o.get("set").and_then(J::as_object).ok_or("update without set")? {
                    let c = table.col(name).ok_or_else(|| format!("unknown column {name}"))?;
                    let derived = (table == Table::Issue && matches!(c, issue::ID | issue::PROJECT | issue::COMMENTS))
                        || (table == Table::Comment && matches!(c, comment::ID | comment::ISSUE | comment::PROJECT | comment::ISSUE_TITLE));
                    if derived {
                        return Err(format!("{name} cannot be updated"));
                    }
                    set.push((c, col_value(table, c, v)));
                }
                out.push(Op::Update { table, id, set });
            }
            "delete" => out.push(Op::Delete { table, id: o.get("id").and_then(J::as_str).ok_or("delete without id")?.to_string() }),
            other => return Err(format!("unknown op {other}")),
        }
    }
    if out.len() > 100 {
        return Err("at most 100 ops per write".into());
    }
    Ok(out)
}

/// Current row by id (through the overlay).
pub fn read_row(ctx: &Ctx, roots: &Roots, table: Table, id: &str) -> Result<Option<Vec<Value>>, Miss> {
    match table {
        Table::Comment => {
            // comment_by_id holds (id, issueId, createdAt); the row lives in comment_by_issue.
            let ptr = match merged::get(ctx, &roots.get(primary_of(table).tree), &catalog::pk_key(table, id))? {
                Some(p) => RowRef(&p).to_values(),
                None => return Ok(None),
            };
            let ix = catalog::index_named("comment_by_issue").unwrap();
            let key = crate::codec::encode_key(&[ptr[1].clone(), ptr[2].clone(), ptr[0].clone()], &[false, false, false]);
            Ok(merged::get(ctx, &roots.get(ix.tree), &key)?.map(|v| RowRef(&v).to_values()))
        }
        _ => Ok(merged::get(ctx, &roots.get(primary_of(table).tree), &catalog::pk_key(table, id))?.map(|v| RowRef(&v).to_values())),
    }
}

/// Comments of an issue (through the overlay).
fn comments_of(ctx: &Ctx, roots: &Roots, issue_id: &str) -> Result<Vec<Vec<Value>>, Miss> {
    let ix = catalog::index_named("comment_by_issue").unwrap();
    let lo = prefix_key(ix, &[Value::from(issue_id)]);
    let hi = crate::codec::prefix_end(&lo);
    let mut out = Vec::new();
    merged::scan(ctx, &roots.get(ix.tree), &Range { lo: &lo, hi: &hi }, false, 256, &mut |_, v| {
        out.push(RowRef(v).to_values());
        true
    })?;
    Ok(out)
}

/// Stage the index entries for one row change.
fn stage_change(view: &View, ch: &RowChange) {
    for ix in catalog::indexes_of(ch.table) {
        let old = ch.old.as_ref().map(|r| index_entries(ix, r)).unwrap_or_default();
        let new = ch.new.as_ref().map(|r| index_entries(ix, r)).unwrap_or_default();
        for (k, _) in &old {
            if new.iter().any(|(nk, _)| nk == k) {
                continue;
            }
            // Delete k.
            match view.get(ix.tree, k) {
                Some(Entry { val: Some(_), delta: 1 }) => view.stage(ix.tree, k.clone(), None), // overlay-only key: drop it
                Some(Entry { val: Some(_), .. }) | None => view.stage(ix.tree, k.clone(), Some(Entry { val: None, delta: -1 })),
                Some(Entry { val: None, .. }) => {}
            }
        }
        for (k, v) in &new {
            if old.iter().any(|(ok, ov)| ok == k && ov == v) {
                continue;
            }
            // Every index key ends with the row's primary key (checked in catalog tests), so a
            // key the base holds belongs to this row's base version: it's either among the old
            // entries or tombstoned in the overlay. Anything else is new — no base read needed.
            let delta = match view.get(ix.tree, k) {
                Some(Entry { val: None, .. }) => 0, // a tombstoned base key is back
                Some(Entry { val: Some(_), delta }) => delta,
                None if old.iter().any(|(ok, _)| ok == k) => 0,
                None => 1,
            };
            view.stage(ix.tree, k.clone(), Some(Entry { val: Some(v.clone()), delta }));
        }
    }
}

/// Fault in every row the batch names, all in one round (the planner then mostly hits).
fn prefetch(ctx: &Ctx, roots: &Roots, ops: &[Op]) -> Result<(), Miss> {
    let mut missed = false;
    let mut look = |t: Table, id: &str| {
        if read_row(ctx, roots, t, id).is_err() {
            missed = true;
        }
    };
    for op in ops {
        match op {
            Op::Insert { table: Table::Comment, row } => {
                look(Table::Comment, row[comment::ID].as_str().unwrap_or(""));
                look(Table::Issue, row[comment::ISSUE].as_str().unwrap_or(""));
            }
            Op::Insert { table, row } => look(*table, row[0].as_str().unwrap_or("")),
            Op::Update { table, id, .. } | Op::Delete { table, id } => look(*table, id),
        }
    }
    if missed {
        Err(Miss)
    } else {
        Ok(())
    }
}

/// Plan and stage a batch. Returns the row changes (coalesced per row: first old → last new).
pub fn plan_write(ctx: &Ctx, roots: &Roots, view: &View, ops: &[Op]) -> Result<Vec<RowChange>, WriteError> {
    prefetch(ctx, roots, ops)?;
    let mut changes: Vec<RowChange> = Vec::new();
    let mut idx: HashMap<(u8, String), usize> = HashMap::new();
    let mut record = |ch: RowChange, changes: &mut Vec<RowChange>| {
        let pk = ch.new.as_ref().or(ch.old.as_ref()).unwrap()[0].as_str().unwrap_or("").to_string();
        let key = (ch.table as u8, pk);
        match idx.get(&key) {
            Some(&i) => changes[i].new = ch.new,
            None => {
                idx.insert(key, changes.len());
                changes.push(ch);
            }
        }
    };
    let apply = |ch: RowChange, changes: &mut Vec<RowChange>, record: &mut dyn FnMut(RowChange, &mut Vec<RowChange>)| -> Result<(), WriteError> {
        stage_change(view, &ch);
        record(ch, changes);
        Ok(())
    };
    for op in ops {
        match op {
            Op::Insert { table: Table::Issue, row } => {
                let id = row[issue::ID].as_str().unwrap();
                if read_row(ctx, roots, Table::Issue, id)?.is_some() {
                    return Err(WriteError::Invalid(format!("issue {id} exists")));
                }
                apply(RowChange { table: Table::Issue, old: None, new: Some(row.clone()) }, &mut changes, &mut record)?;
            }
            Op::Insert { table: Table::Comment, row } => {
                let id = row[comment::ID].as_str().unwrap();
                if read_row(ctx, roots, Table::Comment, id)?.is_some() {
                    return Err(WriteError::Invalid(format!("comment {id} exists")));
                }
                let issue_id = row[comment::ISSUE].as_str().ok_or_else(|| WriteError::Invalid("comment needs issueId".into()))?.to_string();
                let is = read_row(ctx, roots, Table::Issue, &issue_id)?.ok_or_else(|| WriteError::Invalid(format!("no issue {issue_id}")))?;
                let mut c = row.clone();
                c[comment::PROJECT] = is[issue::PROJECT].clone();
                c[comment::ISSUE_TITLE] = is[issue::TITLE].clone();
                let mut is2 = is.clone();
                is2[issue::COMMENTS] = Value::Num(is[issue::COMMENTS].as_num().unwrap_or(0.0) + 1.0);
                if let (Some(t), Some(u)) = (c[comment::CREATED].as_num(), is[issue::UPDATED].as_num()) {
                    if t > u {
                        is2[issue::UPDATED] = Value::Num(t);
                    }
                }
                apply(RowChange { table: Table::Comment, old: None, new: Some(c) }, &mut changes, &mut record)?;
                apply(RowChange { table: Table::Issue, old: Some(is), new: Some(is2) }, &mut changes, &mut record)?;
            }
            Op::Update { table, id, set } => {
                let old = read_row(ctx, roots, *table, id)?.ok_or_else(|| WriteError::Invalid(format!("no {} {id}", table.name())))?;
                let mut new = old.clone();
                for (c, v) in set {
                    new[*c] = v.clone();
                }
                if new == old {
                    continue;
                }
                let title_changed = *table == Table::Issue && new[issue::TITLE] != old[issue::TITLE];
                apply(RowChange { table: *table, old: Some(old), new: Some(new.clone()) }, &mut changes, &mut record)?;
                if title_changed {
                    for c in comments_of(ctx, roots, id)? {
                        let mut c2 = c.clone();
                        c2[comment::ISSUE_TITLE] = new[issue::TITLE].clone();
                        apply(RowChange { table: Table::Comment, old: Some(c), new: Some(c2) }, &mut changes, &mut record)?;
                    }
                }
            }
            Op::Delete { table: Table::Issue, id } => {
                let old = match read_row(ctx, roots, Table::Issue, id)? {
                    Some(r) => r,
                    None => continue,
                };
                for c in comments_of(ctx, roots, id)? {
                    apply(RowChange { table: Table::Comment, old: Some(c), new: None }, &mut changes, &mut record)?;
                }
                apply(RowChange { table: Table::Issue, old: Some(old), new: None }, &mut changes, &mut record)?;
            }
            Op::Delete { table: Table::Comment, id } => {
                let old = match read_row(ctx, roots, Table::Comment, id)? {
                    Some(r) => r,
                    None => continue,
                };
                let issue_id = old[comment::ISSUE].as_str().unwrap().to_string();
                apply(RowChange { table: Table::Comment, old: Some(old), new: None }, &mut changes, &mut record)?;
                if let Some(is) = read_row(ctx, roots, Table::Issue, &issue_id)? {
                    let mut is2 = is.clone();
                    is2[issue::COMMENTS] = Value::Num((is[issue::COMMENTS].as_num().unwrap_or(1.0) - 1.0).max(0.0));
                    apply(RowChange { table: Table::Issue, old: Some(is), new: Some(is2) }, &mut changes, &mut record)?;
                }
            }
            Op::Insert { table, .. } | Op::Delete { table, .. } => return Err(WriteError::Invalid(format!("{} is read-only", table.name()))),
        }
    }
    // Drop no-op changes (e.g. a row changed and changed back).
    changes.retain(|c| c.old != c.new);
    Ok(changes)
}
