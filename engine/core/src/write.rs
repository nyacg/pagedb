//! Writes: row operations → index entries in the overlay, computed purely (reads may fault;
//! nothing is committed until the whole batch succeeds).
//!
//! The engine keeps derived data consistent, as the schema declares:
//! - every index of the table (covering copies, one entry per element of a list column);
//! - relations: the parent's count of children and its touched timestamp when children come
//!   and go, columns copied from the parent onto children (kept in sync when the parent
//!   changes), and cascading deletes.

use crate::catalog::{index_entries, list_json, ColType, Relation, Schema, TableId};
use crate::codec::{RowRef, Value};
use crate::merged;
use crate::overlay::{Entry, View};
use crate::query::{prefix_key, read_row, Roots};
use crate::tree::{Ctx, Miss, Range};
use serde_json::Value as J;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub enum Op {
    Insert { table: TableId, row: Vec<Value> },
    Update { table: TableId, id: String, set: Vec<(usize, Value)> },
    Delete { table: TableId, id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RowChange {
    pub table: TableId,
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

/// Most children a cascade or a copied column may touch in one write.
const MAX_CHILDREN: usize = 10_000;

fn col_value(schema: &Schema, table: TableId, col: usize, v: &J) -> Result<Value, String> {
    let c = &schema.table(table).columns[col];
    if v.is_null() {
        return Ok(if c.ty == ColType::List { Value::from("[]") } else { Value::Null });
    }
    let bad = || format!("{} expects a {}", c.name, match c.ty { ColType::Str => "string", ColType::Num => "number", ColType::Bool => "boolean", ColType::List => "list of strings" });
    Ok(match c.ty {
        ColType::Str => Value::Str(v.as_str().ok_or_else(bad)?.to_string()),
        ColType::Num => Value::Num(v.as_f64().ok_or_else(bad)?),
        ColType::Bool => Value::Bool(v.as_bool().ok_or_else(bad)?),
        ColType::List => {
            let mut items: Vec<String> = v.as_array().ok_or_else(bad)?.iter().map(|t| t.as_str().map(str::to_string).ok_or_else(bad)).collect::<Result<_, _>>()?;
            items.sort();
            items.dedup();
            Value::Str(list_json(&items))
        }
    })
}

/// `{"ops":[{"op":"insert","table":"issue","row":{…}}, {"op":"update","table":"issue","id":"…","set":{…}}, {"op":"delete","table":"comment","id":"…"}]}`
pub fn parse_ops(schema: &Schema, j: &J) -> Result<Vec<Op>, String> {
    let mut out = Vec::new();
    for o in j.get("ops").and_then(J::as_array).ok_or("missing ops")? {
        let tname = o.get("table").and_then(J::as_str).ok_or("op without table")?;
        let table = schema.table_named(tname).ok_or_else(|| format!("unknown table {tname}"))?;
        let tdef = schema.table(table);
        if tdef.read_only {
            return Err(format!("{tname} is read-only"));
        }
        match o.get("op").and_then(J::as_str).ok_or("op without op")? {
            "insert" => {
                let obj = o.get("row").and_then(J::as_object).ok_or("insert without row")?;
                let mut row: Vec<Value> = tdef.columns.iter().map(|c| if c.ty == ColType::List { Value::from("[]") } else { Value::Null }).collect();
                for (name, v) in obj {
                    let c = tdef.col(name).ok_or_else(|| format!("unknown column {tname}.{name}"))?;
                    row[c] = col_value(schema, table, c, v)?;
                }
                for r in schema.relations.iter().filter(|r| r.parent == table) {
                    if let Some(c) = r.count {
                        row[c] = Value::Num(0.0);
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
                    let c = tdef.col(name).ok_or_else(|| format!("unknown column {tname}.{name}"))?;
                    if tdef.columns[c].immutable {
                        return Err(format!("{name} cannot be updated"));
                    }
                    set.push((c, col_value(schema, table, c, v)?));
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

/// Stage the index entries for one row change.
fn stage_change(schema: &Schema, view: &View, ch: &RowChange) {
    for ix in schema.indexes_of(ch.table) {
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
            // Every index key includes the row's primary key (the schema checks it), so a key the
            // base holds belongs to this row's base version: it's either among the old entries or
            // tombstoned in the overlay. Anything else is new — no base read needed.
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

/// Fault in every row the batch names (and the parents of inserted children) in one round.
fn prefetch(ctx: &Ctx, roots: &Roots, ops: &[Op]) -> Result<(), Miss> {
    let mut missed = false;
    let mut look = |t: TableId, id: &str| {
        if read_row(ctx, roots, t, id).is_err() {
            missed = true;
        }
    };
    for op in ops {
        match op {
            Op::Insert { table, row } => {
                look(*table, row[0].as_str().unwrap_or(""));
                for r in roots.schema.relations.iter().filter(|r| r.child == *table) {
                    if let Some(pid) = row[r.fk].as_str() {
                        look(r.parent, pid);
                    }
                }
            }
            Op::Update { table, id, .. } | Op::Delete { table, id } => look(*table, id),
        }
    }
    if missed {
        Err(Miss)
    } else {
        Ok(())
    }
}

struct Planner<'a, 'v> {
    ctx: &'a Ctx<'v>,
    roots: &'a Roots,
    view: &'a View<'v>,
    schema: &'static Schema,
    changes: Vec<RowChange>,
    idx: HashMap<(TableId, String), usize>,
}

impl Planner<'_, '_> {
    fn read(&self, table: TableId, id: &str) -> Result<Option<Vec<Value>>, WriteError> {
        Ok(read_row(self.ctx, self.roots, table, id)?)
    }

    /// Stage a row change and record it (coalesced per row: first old → last new). Later reads
    /// in the batch see it, because they go through the view.
    fn apply(&mut self, ch: RowChange) {
        stage_change(self.schema, self.view, &ch);
        let pk = ch.new.as_ref().or(ch.old.as_ref()).unwrap()[0].as_str().unwrap_or("").to_string();
        match self.idx.get(&(ch.table, pk.clone())) {
            Some(&i) => self.changes[i].new = ch.new,
            None => {
                self.idx.insert((ch.table, pk), self.changes.len());
                self.changes.push(ch);
            }
        }
    }

    fn children(&self, rel: &Relation, parent_id: &str) -> Result<Vec<Vec<Value>>, WriteError> {
        let tree = rel.children.expect("checked by the schema");
        let ix = self.schema.index(tree);
        let lo = prefix_key(ix, &[Value::from(parent_id)]);
        let hi = crate::codec::prefix_end(&lo);
        let mut out = Vec::new();
        merged::scan(self.ctx, &self.roots.get(tree), &Range { lo: &lo, hi: &hi }, false, 256, &mut |_, v| {
            out.push(RowRef(v).to_values());
            out.len() <= MAX_CHILDREN
        })?;
        if out.len() > MAX_CHILDREN {
            return Err(WriteError::Invalid(format!("more than {MAX_CHILDREN} {} rows to update", self.schema.table(rel.child).name)));
        }
        Ok(out)
    }

    fn insert(&mut self, table: TableId, row: &[Value]) -> Result<(), WriteError> {
        let id = row[0].as_str().unwrap_or("").to_string();
        if self.read(table, &id)?.is_some() {
            return Err(WriteError::Invalid(format!("{} {id} exists", self.schema.table(table).name)));
        }
        let mut row = row.to_vec();
        let mut parents = Vec::new();
        for rel in self.schema.relations.iter().filter(|r| r.child == table) {
            let Some(pid) = row[rel.fk].as_str().filter(|p| !p.is_empty()).map(str::to_string) else { continue };
            let p = self.read(rel.parent, &pid)?.ok_or_else(|| WriteError::Invalid(format!("no {} {pid}", self.schema.table(rel.parent).name)))?;
            for &(cc, pc) in &rel.copy {
                row[cc] = p[pc].clone();
            }
            parents.push((rel, pid));
        }
        self.apply(RowChange { table, old: None, new: Some(row.clone()) });
        for (rel, pid) in parents {
            self.bump(rel, &pid, &row, 1.0)?;
        }
        Ok(())
    }

    /// A child came (+1) or went (−1): the parent's count, and its touched column.
    fn bump(&mut self, rel: &Relation, parent_id: &str, child: &[Value], delta: f64) -> Result<(), WriteError> {
        let Some(p) = self.read(rel.parent, parent_id)? else { return Ok(()) };
        let mut p2 = p.clone();
        if let Some(c) = rel.count {
            p2[c] = Value::Num((p[c].as_num().unwrap_or(0.0) + delta).max(0.0));
        }
        if let (Some((pc, cc)), true) = (rel.touch, delta > 0.0) {
            if let (Some(t), cur) = (child[cc].as_num(), p[pc].as_num()) {
                if cur.map_or(true, |u| t > u) {
                    p2[pc] = Value::Num(t);
                }
            }
        }
        if p2 != p {
            self.replace(rel.parent, p, p2)?;
        }
        Ok(())
    }

    fn update(&mut self, table: TableId, id: &str, set: &[(usize, Value)]) -> Result<(), WriteError> {
        let old = self.read(table, id)?.ok_or_else(|| WriteError::Invalid(format!("no {} {id}", self.schema.table(table).name)))?;
        let mut new = old.clone();
        for (c, v) in set {
            new[*c] = v.clone();
        }
        if new != old {
            self.replace(table, old, new)?;
        }
        Ok(())
    }

    /// Replace a row, then bring copied columns on its children up to date.
    fn replace(&mut self, table: TableId, old: Vec<Value>, new: Vec<Value>) -> Result<(), WriteError> {
        self.apply(RowChange { table, old: Some(old.clone()), new: Some(new.clone()) });
        let id = new[0].as_str().unwrap_or("").to_string();
        for rel in self.schema.relations.iter().filter(|r| r.parent == table && !r.copy.is_empty()) {
            if rel.copy.iter().all(|&(_, pc)| old[pc] == new[pc]) {
                continue;
            }
            for c in self.children(rel, &id)? {
                let mut c2 = c.clone();
                for &(cc, pc) in &rel.copy {
                    c2[cc] = new[pc].clone();
                }
                if c2 != c {
                    self.replace(rel.child, c, c2)?;
                }
            }
        }
        Ok(())
    }

    /// Delete a row: cascading relations first, then the row, then its parents' counts (except
    /// the parent whose delete cascaded here, which is going too).
    fn delete(&mut self, table: TableId, id: &str, from_parent: Option<(TableId, &str)>) -> Result<(), WriteError> {
        let Some(old) = self.read(table, id)? else { return Ok(()) };
        for rel in self.schema.relations.iter().filter(|r| r.parent == table && r.cascade) {
            for c in self.children(rel, id)? {
                let cid = c[0].as_str().unwrap_or("").to_string();
                if cid != id {
                    self.delete(rel.child, &cid, Some((table, id)))?;
                }
            }
        }
        self.apply(RowChange { table, old: Some(old.clone()), new: None });
        for rel in self.schema.relations.iter().filter(|r| r.child == table) {
            let Some(pid) = old[rel.fk].as_str().filter(|p| !p.is_empty()) else { continue };
            if from_parent == Some((rel.parent, pid)) {
                continue;
            }
            self.bump(rel, pid, &old, -1.0)?;
        }
        Ok(())
    }
}

/// Plan and stage a batch. Returns the row changes (coalesced per row: first old → last new).
pub fn plan_write(ctx: &Ctx, roots: &Roots, view: &View, ops: &[Op]) -> Result<Vec<RowChange>, WriteError> {
    prefetch(ctx, roots, ops)?;
    let mut p = Planner { ctx, roots, view, schema: roots.schema, changes: Vec::new(), idx: HashMap::new() };
    for op in ops {
        match op {
            Op::Insert { table, row } => p.insert(*table, row)?,
            Op::Update { table, id, set } => p.update(*table, id, set)?,
            Op::Delete { table, id } => p.delete(*table, id, None)?,
        }
    }
    // Drop no-op changes (e.g. a row changed and changed back).
    let mut changes = p.changes;
    changes.retain(|c| c.old != c.new);
    Ok(changes)
}

/// Current row by id (re-exported for callers of the write path).
pub use crate::query::read_row as read;
