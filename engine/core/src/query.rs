//! Queries: a Zero-shaped AST compiled to an index plan, executed against the page store.
//!
//! ```json
//! {"table":"issue",
//!  "where":{"type":"and","conditions":[
//!     {"type":"simple","op":"=","left":{"type":"column","name":"projectId"},"right":{"type":"literal","value":"p0007"}},
//!     {"type":"simple","op":"IN","left":{"type":"column","name":"status"},"right":{"type":"literal","value":["todo","review"]}}]},
//!  "orderBy":[["createdAt","desc"],["id","asc"]], "limit":50,
//!  "related":[{"alias":"owner","correlation":{"parentField":["ownerId"],"childField":["id"]},"subquery":{"table":"user"}}]}
//! ```
//! Operators: `=`, `IN`, `ILIKE` (substring, `%v%`), `HAS` (tag membership), and on issues
//! `EXISTS` over its comments with body `ILIKE` (comment search):
//!     {"type":"correlatedSubquery","op":"EXISTS","related":{"correlation":{"parentField":["id"],"childField":["issueId"]},
//!      "subquery":{"table":"comment","where":{"type":"simple","op":"ILIKE","left":{"type":"column","name":"body"},"right":{"type":"literal","value":"%flaky%"}}}}}
//! `aggregate:"count"`
//! at the top level counts; on a related comment subquery it reads the maintained
//! `commentCount` column. Equalities on an index's leading columns become the scan prefix
//! (the query family's parameters); the remaining key columns must give the requested order.
//! Anything without a supporting index is refused, so no query can scan the whole database.

use crate::catalog::{ColType, Index, IndexValue, Schema, TableId, TreeId};
use crate::codec::{encode_key_part, json_cell, json_str, prefix_end, Cell, RowRef, Value};
use crate::merged;
use crate::tree::{Ctx, Miss, Range, TreeRoot};
use serde_json::Value as J;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Filter {
    Eq(usize, Value),
    NotNull(usize),
    In(usize, Vec<Value>),
    /// Lowercased needle; matches if the column contains it, case-insensitively.
    ILike(usize, String),
    /// List column contains this element.
    HasItem(usize, String),
    /// The row has a child (through a relation) whose column contains this (lowercased) needle:
    /// `children` is the child index leading with the fk. Needs page reads, so it's checked
    /// after the row's own filters (see `children_match`).
    ChildILike { children: TreeId, col: usize, needle: String },
}

#[derive(Clone, Debug)]
pub enum RelKind {
    /// Child row whose primary key = parent[col].
    One { table: TableId, parent_col: usize },
    /// Child rows of `plan` whose first key column = parent[col].
    Many { plan: Box<Plan>, parent_col: usize },
    /// A maintained count column on the parent.
    CountColumn(usize),
}

#[derive(Clone, Debug)]
pub struct Related {
    pub alias: String,
    pub kind: RelKind,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub schema: &'static Schema,
    pub table: TableId,
    pub index: &'static Index,
    /// Values of the index's leading key columns (the family parameters).
    pub prefix: Vec<Value>,
    pub reverse: bool,
    pub filters: Vec<Filter>,
    pub limit: usize,
    pub one: bool,
    pub count: bool,
    pub related: Vec<Related>,
    /// Keyset bounds in scan order, as encodings of the key columns after the prefix:
    /// rows strictly after `start`, up to and including `end` (infinite scroll pages).
    pub start: Option<Vec<u8>>,
    pub end: Option<Vec<u8>>,
    /// Skip this many rows (jump to row N): resolved once into a `start` bound, using the
    /// branch pages' row counts. Only for unfiltered plans.
    pub offset: u64,
}

impl Plan {
    /// The key range this plan scans: its prefix, narrowed by its bounds.
    pub fn scan_range(&self) -> (Vec<u8>, Vec<u8>) {
        let lo_p = prefix_key(self.index, &self.prefix);
        let hi_p = if lo_p.is_empty() { Vec::new() } else { prefix_end(&lo_p) };
        let at = |suffix: &Vec<u8>, extra: bool| {
            let mut k = lo_p.clone();
            k.extend_from_slice(suffix);
            if extra {
                k.push(0); // just past this key (index keys are prefix-free)
            }
            k
        };
        if !self.reverse {
            (self.start.as_ref().map_or(lo_p.clone(), |s| at(s, true)), self.end.as_ref().map_or(hi_p, |e| at(e, true)))
        } else {
            (self.end.as_ref().map_or(lo_p.clone(), |e| at(e, false)), self.start.as_ref().map_or(hi_p, |s| at(s, false)))
        }
    }

    pub fn in_range(&self, key: &[u8]) -> bool {
        let (lo, hi) = self.scan_range();
        key >= lo.as_slice() && (hi.is_empty() || key < hi.as_slice())
    }
}

pub const MAX_LIMIT: usize = 1000;
/// Rows a filtered scan may examine in one go (≈ one project).
pub const SCAN_BUDGET: usize = 20_000;
/// Comment search: at most this many issues' comments are fetched in one fault round (≈ 20 MB
/// at the demo's density, read as a few large ranged GETs).
pub const COMMENT_BATCH: usize = 8192;

// ------------------------------------------------------------------ compile

fn col_name(e: &J) -> Option<&str> {
    if e.get("type")?.as_str()? == "column" {
        e.get("name")?.as_str()
    } else {
        None
    }
}

fn literal(e: &J) -> Option<&J> {
    if e.get("type")?.as_str()? == "literal" {
        e.get("value")
    } else {
        None
    }
}

pub fn json_to_value(v: &J) -> Value {
    match v {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Num(n.as_f64().unwrap_or(0.0)),
        J::String(s) => Value::Str(s.clone()),
        other => Value::Str(other.to_string()),
    }
}

fn flatten<'a>(w: &'a J, out: &mut Vec<&'a J>) -> Result<(), String> {
    match w.get("type").and_then(J::as_str) {
        Some("and") => {
            for c in w.get("conditions").and_then(J::as_array).ok_or("and without conditions")? {
                flatten(c, out)?;
            }
            Ok(())
        }
        Some("simple") | Some("correlatedSubquery") => {
            out.push(w);
            Ok(())
        }
        Some(t) => Err(format!("unsupported condition type {t}")),
        None => Err("condition without type".into()),
    }
}

pub fn compile(schema: &'static Schema, ast: &J) -> Result<Plan, String> {
    let tname = ast.get("table").and_then(J::as_str).ok_or("missing table")?;
    let table = schema.table_named(tname).ok_or_else(|| format!("unknown table {tname}"))?;
    let tdef = schema.table(table);
    let col = |name: &str| tdef.col(name).ok_or_else(|| format!("unknown column {tname}.{name}"));

    // Conditions.
    let mut conds = Vec::new();
    if let Some(w) = ast.get("where") {
        flatten(w, &mut conds)?;
    }
    let mut eqs: Vec<(usize, Value)> = Vec::new();
    let mut tags: Vec<(usize, String)> = Vec::new();
    let mut filters: Vec<Filter> = Vec::new();
    for c in conds {
        if c.get("type").and_then(J::as_str) == Some("correlatedSubquery") {
            filters.extend(child_exists(schema, table, c)?);
            continue;
        }
        let op = c.get("op").and_then(J::as_str).ok_or("condition without op")?;
        let name = col_name(c.get("left").ok_or("no left")?).ok_or("left must be a column")?;
        let lit = literal(c.get("right").ok_or("no right")?).ok_or("right must be a literal")?;
        let ci = col(name)?;
        match op {
            "=" => eqs.push((ci, json_to_value(lit))),
            "IS NOT" if lit.is_null() => filters.push(Filter::NotNull(ci)),
            "IN" => filters.push(Filter::In(ci, lit.as_array().ok_or("IN needs an array")?.iter().map(json_to_value).collect())),
            "ILIKE" => {
                let s = lit.as_str().ok_or("ILIKE needs a string")?;
                filters.push(Filter::ILike(ci, s.trim_matches('%').to_lowercase()));
            }
            "HAS" => {
                if tdef.columns[ci].ty != ColType::List {
                    return Err(format!("HAS needs a list column ({name} isn't one)"));
                }
                tags.push((ci, lit.as_str().ok_or("HAS needs a string")?.to_string()));
            }
            other => return Err(format!("unsupported operator {other}")),
        }
    }

    // Requested order (default: primary key ascending).
    let mut order: Vec<(usize, bool)> = Vec::new();
    if let Some(ob) = ast.get("orderBy").and_then(J::as_array) {
        for o in ob {
            let pair = o.as_array().ok_or("orderBy entries are [column, dir]")?;
            let c = col(pair.first().and_then(J::as_str).ok_or("orderBy column")?)?;
            let desc = pair.get(1).and_then(J::as_str) == Some("desc");
            order.push((c, desc));
        }
    }

    // Index choice: most equality columns as prefix, then the rest must give `order`.
    let mut best: Option<(usize, &'static Index, bool)> = None;
    for ix in schema.indexes_of(table) {
        // Covering indexes, and a pointer primary for lookups by primary key (rows are read
        // through the pointer).
        // Pointer indexes (rows read through the primary): a primary only for pk lookups.
        let pointer_ok = ix.row_index.is_some() && (!ix.primary || eqs.iter().any(|(e, _)| *e == 0));
        if !matches!(ix.value, IndexValue::Row | IndexValue::RowTruncated(..)) && !pointer_ok {
            continue;
        }
        // A partial index serves only queries that exclude the rows it leaves out.
        if let Some(c) = ix.not_null {
            let required = filters.iter().any(|f| matches!(f, Filter::NotNull(n) if *n == c)) || eqs.iter().any(|(e, v)| *e == c && *v != Value::Null);
            if !required {
                continue;
            }
        }
        let mut p = 0;
        for &(c, _) in &ix.key {
            let usable = if Some(c) == ix.multi { tags.iter().any(|(tc, _)| *tc == c) } else { eqs.iter().any(|(e, _)| *e == c) };
            if !usable {
                break;
            }
            p += 1;
        }
        if ix.multi.is_some() && p == 0 {
            continue; // a multi-valued index is only usable with its element fixed
        }
        let rest = &ix.key[p..];
        let order_rest: Vec<(usize, bool)> = order.iter().copied().filter(|(c, _)| !eqs.iter().any(|(e, _)| e == c)).collect();
        if order_rest.len() > rest.len() {
            continue;
        }
        let mut reverse = None;
        let mut ok = true;
        for (i, &(c, d)) in order_rest.iter().enumerate() {
            if rest[i].0 != c {
                ok = false;
                break;
            }
            let flip = rest[i].1 != d;
            match reverse {
                None => reverse = Some(flip),
                Some(r) if r != flip => ok = false,
                _ => {}
            }
        }
        if !ok {
            continue;
        }
        let covering = |i: &Index| matches!(i.value, IndexValue::Row | IndexValue::RowTruncated(..));
        let better = match best {
            None => true,
            Some((bp, bix, _)) => p > bp || (p == bp && (covering(ix), std::cmp::Reverse(ix.key.len())) > (covering(bix), std::cmp::Reverse(bix.key.len()))),
        };
        if better {
            best = Some((p, ix, reverse.unwrap_or(false)));
        }
    }
    let (p, index, reverse) = best.ok_or_else(|| format!("no index on {tname} supports this filter and order"))?;

    let mut prefix = Vec::with_capacity(p);
    let mut used_tag = None;
    for &(c, _) in &index.key[..p] {
        if Some(c) == index.multi {
            let i = tags.iter().position(|(tc, _)| *tc == c).unwrap();
            prefix.push(Value::Str(tags[i].1.clone()));
            used_tag = Some(i);
        } else {
            let (_, v) = eqs.iter().find(|(e, _)| *e == c).unwrap();
            prefix.push(v.clone());
        }
    }
    for (c, v) in &eqs {
        if !index.key[..p].iter().any(|(k, _)| k == c) {
            filters.push(Filter::Eq(*c, v.clone()));
        }
    }
    for (i, (c, t)) in tags.iter().enumerate() {
        if used_tag != Some(i) {
            filters.push(Filter::HasItem(*c, t.clone()));
        }
    }

    let one = ast.get("one").and_then(J::as_bool).unwrap_or(false);
    let limit = if one { 1 } else { ast.get("limit").and_then(J::as_u64).unwrap_or(100).min(MAX_LIMIT as u64) as usize };
    let count = ast.get("aggregate").and_then(J::as_str) == Some("count");
    if count && filters.iter().any(|f| matches!(f, Filter::ChildILike { .. })) {
        return Err("a search over related rows can't be counted".into());
    }

    let mut related = Vec::new();
    for r in ast.get("related").and_then(J::as_array).map(|v| v.as_slice()).unwrap_or(&[]) {
        related.push(compile_related(schema, table, r)?);
    }
    // Keyset bounds: {"start":{"row":{…}}} (exclusive), {"end":{"row":{…}}} (inclusive). The row
    // gives the values of the index columns after the prefix (the order columns + primary key).
    let bound = |name: &str| -> Result<Option<Vec<u8>>, String> {
        let Some(b) = ast.get(name) else { return Ok(None) };
        let row = b.get("row").and_then(J::as_object).ok_or_else(|| format!("{name} needs a row"))?;
        let mut k = Vec::new();
        for &(c, desc) in &index.key[p..] {
            let col = tdef.columns[c].name.as_str();
            let v = row.get(col).ok_or_else(|| format!("{name}.row needs {col}"))?;
            encode_key_part(&mut k, &json_to_value(v), desc);
        }
        Ok(Some(k))
    };
    let (start, end) = (bound("start")?, bound("end")?);
    let offset = ast.get("offset").and_then(J::as_u64).unwrap_or(0);
    if offset > 0 && (!filters.is_empty() || count) {
        return Err("offset needs an unfiltered list".into());
    }
    Ok(Plan { schema, table, index, prefix, reverse, filters, limit, one, count, related, start, end, offset })
}

/// `EXISTS (child row through a relation whose text column ILIKE …)`, e.g. issues with a
/// comment mentioning a word. The correlation must be a declared relation (parent pk → fk).
fn child_exists(schema: &'static Schema, table: TableId, c: &J) -> Result<Vec<Filter>, String> {
    let bad = || "EXISTS needs a relation (parent id → child fk) and ILIKE conditions on the child".to_string();
    let rel = c.get("related").ok_or_else(bad)?;
    let corr = rel.get("correlation").ok_or_else(bad)?;
    let field = |k: &str| corr.get(k).and_then(J::as_array).and_then(|a| a.first()).and_then(J::as_str);
    let sub = rel.get("subquery").ok_or_else(bad)?;
    let child = schema.table_named(sub.get("table").and_then(J::as_str).ok_or_else(bad)?).ok_or_else(bad)?;
    let fk = schema.table(child).col(field("childField").ok_or_else(bad)?).ok_or_else(bad)?;
    if c.get("op").and_then(J::as_str) != Some("EXISTS") || schema.table(table).col(field("parentField").unwrap_or("")) != Some(0) {
        return Err(bad());
    }
    let children = schema.relation(table, child, fk).and_then(|r| r.children).ok_or_else(bad)?;
    let mut conds = Vec::new();
    flatten(sub.get("where").ok_or_else(bad)?, &mut conds)?;
    conds
        .into_iter()
        .map(|w| {
            let col = w.get("left").and_then(col_name).and_then(|n| schema.table(child).col(n)).filter(|_| w.get("op").and_then(J::as_str) == Some("ILIKE"));
            let lit = w.get("right").and_then(literal).and_then(J::as_str);
            match (col, lit) {
                (Some(col), Some(lit)) => Ok(Filter::ChildILike { children, col, needle: lit.trim_matches('%').to_lowercase() }),
                _ => Err(bad()),
            }
        })
        .collect()
}

fn compile_related(schema: &'static Schema, parent: TableId, r: &J) -> Result<Related, String> {
    let alias = r.get("alias").or_else(|| r.get("subquery").and_then(|s| s.get("alias"))).and_then(J::as_str).ok_or("related needs an alias")?.to_string();
    let corr = r.get("correlation").ok_or("related needs a correlation")?;
    let pf = corr.get("parentField").and_then(J::as_array).and_then(|a| a.first()).and_then(J::as_str).ok_or("parentField")?;
    let cf = corr.get("childField").and_then(J::as_array).and_then(|a| a.first()).and_then(J::as_str).ok_or("childField")?;
    let sub = r.get("subquery").ok_or("related needs a subquery")?;
    let cname = sub.get("table").and_then(J::as_str).ok_or("subquery table")?;
    let child = schema.table_named(cname).ok_or_else(|| format!("unknown table {cname}"))?;
    let pdef = schema.table(parent);
    let parent_col = pdef.col(pf).ok_or_else(|| format!("unknown column {}.{pf}", pdef.name))?;
    let child_col = schema.table(child).col(cf).ok_or_else(|| format!("unknown column {cname}.{cf}"))?;
    if sub.get("aggregate").and_then(J::as_str) == Some("count") {
        // Only maintained counts: a relation's count column on the parent.
        return match schema.relation(parent, child, child_col).and_then(|rel| rel.count).filter(|_| parent_col == 0) {
            Some(c) => Ok(Related { alias, kind: RelKind::CountColumn(c) }),
            None => Err(format!("no maintained count of {cname} per {}", pdef.name)),
        };
    }
    if child_col == 0 {
        return Ok(Related { alias, kind: RelKind::One { table: child, parent_col } });
    }
    // Many: compile the subquery with the correlation as an equality.
    let mut sub2 = sub.clone();
    let eq = serde_json::json!({"type":"simple","op":"=","left":{"type":"column","name":cf},"right":{"type":"literal","value":null}});
    let w = match sub.get("where") {
        Some(w) => serde_json::json!({"type":"and","conditions":[eq, w]}),
        None => eq,
    };
    sub2["where"] = w;
    let plan = compile(schema, &sub2)?;
    if plan.prefix.is_empty() || plan.index.key[0].0 != child_col {
        return Err(format!("no index on {cname} leads with {cf}"));
    }
    Ok(Related { alias, kind: RelKind::Many { plan: Box::new(plan), parent_col } })
}

// ------------------------------------------------------------------ execute

/// A base: its schema and the roots of its trees, from the manifest.
#[derive(Clone)]
pub struct Roots {
    pub trees: HashMap<u16, TreeRoot>,
    pub schema: &'static Schema,
}

impl Roots {
    pub fn new(schema: &'static Schema, trees: HashMap<u16, TreeRoot>) -> Roots {
        Roots { trees, schema }
    }

    pub fn get(&self, tree: u16) -> TreeRoot {
        self.trees.get(&tree).copied().unwrap_or(TreeRoot::empty(tree))
    }

    /// Bases built before manifests carried a schema are issue trackers.
    pub fn from_manifest(m: &J) -> Result<Roots, String> {
        let schema = match m.get("schema") {
            Some(j) => Schema::from_json(j)?.leak(),
            None => crate::catalog::tracker(),
        };
        let mut out = HashMap::new();
        for t in m.get("trees").and_then(J::as_array).ok_or("manifest without trees")? {
            let tree = t.get("tree").and_then(J::as_u64).ok_or("tree id")? as u16;
            // An empty tree has no root page (written as null: JSON readers mangle u64::MAX).
            if t.get("height").and_then(J::as_u64).unwrap_or(0) == 0 {
                out.insert(tree, TreeRoot::empty(tree));
                continue;
            }
            out.insert(
                tree,
                TreeRoot {
                    tree,
                    leaves: t.get("leafPages").and_then(J::as_u64).unwrap_or(0),
                    root: t.get("root").and_then(J::as_u64).ok_or("root")?,
                    height: t.get("height").and_then(J::as_u64).ok_or("height")? as u8,
                    rows: t.get("rows").and_then(J::as_u64).unwrap_or(0),
                },
            );
        }
        Ok(Roots { trees: out, schema })
    }
}

/// One result row: its index key (window position), primary key, and rendered JSON.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub key: Vec<u8>,
    pub pk: String,
    pub json: String,
}

#[derive(Debug, PartialEq)]
pub enum Output {
    Rows { hits: Vec<Hit>, complete: bool },
    Count(u64),
}

pub fn prefix_key(ix: &Index, prefix: &[Value]) -> Vec<u8> {
    let mut k = Vec::new();
    for (i, v) in prefix.iter().enumerate() {
        encode_key_part(&mut k, v, ix.key[i].1);
    }
    k
}

pub fn row_matches(plan: &Plan, row: RowRef) -> bool {
    plan.filters.iter().all(|f| filter_matches(f, row))
}

fn filter_matches(f: &Filter, row: RowRef) -> bool {
    match f {
        Filter::Eq(c, v) => row.get(*c).eq_value(v),
        Filter::NotNull(c) => !matches!(row.get(*c), crate::codec::Cell::Null),
        Filter::In(c, vs) => {
            let cell = row.get(*c);
            vs.iter().any(|v| cell.eq_value(v))
        }
        Filter::ILike(c, needle) => contains_ci(row.get(*c).str(), needle),
        Filter::HasItem(c, t) => row.get(*c).str().contains(&format!("\"{t}\"")),
        Filter::ChildILike { .. } => true, // checked by children_match
    }
}

pub fn has_child_filter(plan: &Plan) -> bool {
    plan.filters.iter().any(|f| matches!(f, Filter::ChildILike { .. }))
}

/// Searches over a row's children (e.g. issues by comment text): every needle must occur in
/// some child of the row, through its relation's child index.
pub fn children_match(ctx: &Ctx, roots: &Roots, plan: &Plan, row: RowRef) -> Result<bool, Miss> {
    let mut by_index: Vec<(TreeId, Vec<(usize, &str)>)> = Vec::new();
    for f in &plan.filters {
        if let Filter::ChildILike { children, col, needle } = f {
            match by_index.iter_mut().find(|(t, _)| t == children) {
                Some((_, v)) => v.push((*col, needle.as_str())),
                None => by_index.push((*children, vec![(*col, needle.as_str())])),
            }
        }
    }
    for (tree, needles) in by_index {
        let ix = plan.schema.index(tree);
        let lo = prefix_key(ix, &[Value::from(row.get(0).str())]);
        let hi = prefix_end(&lo);
        let mut found = vec![false; needles.len()];
        merged::scan(ctx, &roots.get(tree), &Range { lo: &lo, hi: &hi }, false, 256, &mut |_, v| {
            for (i, (col, n)) in needles.iter().enumerate() {
                found[i] = found[i] || contains_ci(RowRef(v).get(*col).str(), n);
            }
            !found.iter().all(|f| *f)
        })?;
        if !found.iter().all(|f| *f) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Current row by primary key (through the overlay), following a pointer primary index to
/// the covering index that holds the full row.
pub fn read_row(ctx: &Ctx, roots: &Roots, table: TableId, id: &str) -> Result<Option<Vec<Value>>, Miss> {
    let s = roots.schema;
    let p = s.primary_of(table);
    let Some(v) = merged::get(ctx, &roots.get(p.tree), &s.pk_key(table, id))? else { return Ok(None) };
    match (&p.value, p.row_index) {
        (IndexValue::Cols(cols), Some(ri)) => {
            let ptr = RowRef(&v).to_values();
            let mut row = vec![Value::Null; s.table(table).columns.len()];
            for (i, &c) in cols.iter().enumerate() {
                row[c] = ptr[i].clone();
            }
            let ix = s.index(ri);
            Ok(merged::get(ctx, &roots.get(ri), &crate::catalog::index_key(ix, &row, None))?.map(|v| RowRef(&v).to_values()))
        }
        _ => Ok(Some(RowRef(&v).to_values())),
    }
}

/// Matching rows of `plan` in [lo, hi), in scan order: up to `need`, plus whether more exist.
/// Comment search reads each candidate's comments; candidates whose comment pages aren't
/// resident are collected and fetched together, then the scan reruns. Batches grow: the first
/// covers ~4× the rows still needed (enough for a common word, ~0.5 MB), each next one ~8× what's
/// been checked so far, up to COMMENT_BATCH, so a word in no comment of a 10k-issue project
/// costs ~3 rounds.
pub fn collect(ctx: &Ctx, roots: &Roots, plan: &Plan, lo: &[u8], hi: &[u8], need: usize) -> Result<(Vec<(Vec<u8>, Vec<u8>)>, bool), Miss> {
    let deep = has_child_filter(plan);
    let pointer = plan.index.row_index.is_some();
    let hint = if plan.filters.is_empty() { need + 1 } else { SCAN_BUDGET };
    let mut rows: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    let (mut more, mut unknown, mut known) = (false, 0usize, 0usize);
    merged::scan(ctx, &roots.get(plan.index.tree), &Range { lo, hi }, plan.reverse, hint, &mut |k, v| {
        let full;
        let v: &[u8] = if pointer {
            match read_row(ctx, roots, plan.table, RowRef(v).get(0).str()) {
                Ok(Some(r)) => {
                    full = crate::codec::encode_row(&r);
                    &full
                }
                Ok(None) => return true,
                Err(Miss) => {
                    unknown += 1;
                    return true;
                }
            }
        } else {
            v
        };
        if !row_matches(plan, RowRef(v)) {
            return true;
        }
        if deep {
            match children_match(ctx, roots, plan, RowRef(v)) {
                Ok(m) => {
                    known += 1;
                    if !m {
                        return true;
                    }
                }
                Err(Miss) => {
                    unknown += 1;
                    return unknown < (4 * (need.saturating_sub(rows.len()) + 1) + 8 * known).min(COMMENT_BATCH);
                }
            }
        }
        if rows.len() == need {
            more = true;
            return false;
        }
        rows.push((k.to_vec(), v.to_vec()));
        true
    })?;
    if unknown > 0 {
        return Err(Miss);
    }
    Ok((rows, more))
}

fn contains_ci(hay: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if hay.is_ascii() && needle_lower.is_ascii() {
        let (h, n) = (hay.as_bytes(), needle_lower.as_bytes());
        return h.windows(n.len()).any(|w| w.iter().zip(n).all(|(a, b)| a.to_ascii_lowercase() == *b));
    }
    hay.to_lowercase().contains(needle_lower)
}

/// Does this row belong to the plan's family partition (prefix) and pass its filters?
pub fn row_in_partition(plan: &Plan, row: RowRef, multi_elem: Option<&str>) -> bool {
    for (i, v) in plan.prefix.iter().enumerate() {
        let c = plan.index.key[i].0;
        let ok = if Some(c) == plan.index.multi { multi_elem.map(|t| Value::Str(t.into()) == *v).unwrap_or(false) } else { row.get(c).eq_value(v) };
        if !ok {
            return false;
        }
    }
    row_matches(plan, row)
}

/// A plan with its `offset` turned into a keyset `start` (the key just before row N).
pub fn resolve_offset(ctx: &Ctx, roots: &Roots, plan: &Plan) -> Result<Option<Plan>, Miss> {
    if plan.offset == 0 {
        return Ok(None);
    }
    let (lo, hi) = plan.scan_range();
    let root = roots.get(plan.index.tree);
    // Forward: the row before N is at N-1. Reverse: count from the high end.
    let total = merged::count(ctx, &root, &Range { lo: &lo, hi: &hi })?;
    let mut p = plan.clone();
    p.offset = 0;
    if plan.offset >= total {
        p.limit = 0;
        return Ok(Some(p));
    }
    let at = if plan.reverse { total - plan.offset } else { plan.offset - 1 };
    let Some(k) = merged::nth(ctx, &root, &Range { lo: &lo, hi: &hi }, at)? else { return Ok(Some(p)) };
    let plen = prefix_key(plan.index, &plan.prefix).len();
    // Forward, start is exclusive: rows after the (N-1)th. Reverse, start is the Nth from the
    // top's key, also exclusive in scan order.
    p.start = Some(k[plen..].to_vec());
    Ok(Some(p))
}

pub fn execute(ctx: &Ctx, roots: &Roots, plan: &Plan) -> Result<Output, Miss> {
    if let Some(p) = resolve_offset(ctx, roots, plan)? {
        return execute(ctx, roots, &p);
    }
    // A lookup by primary key whose related rows hang off that key (issue → comments): the
    // child prefix is known before the parent is read, so fault both in the same round.
    let mut speculative_miss = false;
    if plan.index.primary && !plan.prefix.is_empty() {
        for r in &plan.related {
            if let RelKind::Many { plan: child, parent_col: 0 } = &r.kind {
                let mut c = (**child).clone();
                c.prefix[0] = plan.prefix[0].clone();
                if execute(ctx, roots, &c).is_err() {
                    speculative_miss = true;
                }
            }
        }
    }
    let r = execute_plan(ctx, roots, plan);
    if speculative_miss && r.is_ok() {
        return Err(Miss); // the child pages are on their way; render once they're resident
    }
    r
}

fn execute_plan(ctx: &Ctx, roots: &Roots, plan: &Plan) -> Result<Output, Miss> {
    let root = roots.get(plan.index.tree);
    let (lo, hi) = plan.scan_range();
    let range = Range { lo: &lo, hi: &hi };
    if plan.count {
        if plan.filters.is_empty() {
            return merged::count(ctx, &root, &range).map(Output::Count);
        }
        let mut n = 0u64;
        merged::scan(ctx, &root, &range, false, SCAN_BUDGET, &mut |_, v| {
            if row_matches(plan, RowRef(v)) {
                n += 1;
            }
            true
        })?;
        return Ok(Output::Count(n));
    }
    let (rows, seen_more) = collect(ctx, roots, plan, &lo, &hi, plan.limit)?;
    let mut hits = Vec::with_capacity(rows.len());
    let mut missed = false;
    for (k, v) in rows {
        match render(ctx, roots, plan, RowRef(&v)) {
            Ok(json) => hits.push(Hit { key: k, pk: RowRef(&v).get(0).str().to_string(), json }),
            Err(Miss) => missed = true, // keep going: every row's lookups share this round
        }
    }
    if missed {
        return Err(Miss);
    }
    Ok(Output::Rows { hits, complete: !seen_more })
}

/// Render a row (plus its related data) as a JSON object.
pub fn render(ctx: &Ctx, roots: &Roots, plan: &Plan, row: RowRef) -> Result<String, Miss> {
    let mut out = String::with_capacity(256);
    render_into(&mut out, ctx, roots, plan.table, &plan.related, row)?;
    Ok(out)
}

fn render_into(out: &mut String, ctx: &Ctx, roots: &Roots, table: TableId, related: &[Related], row: RowRef) -> Result<(), Miss> {
    let tdef = roots.schema.table(table);
    out.push('{');
    for (i, (col, cell)) in tdef.columns.iter().zip(row.cells()).enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_str(out, &col.name);
        out.push(':');
        if col.ty == ColType::List {
            out.push_str(match cell {
                Cell::Str(s) if s.starts_with('[') => s,
                _ => "[]",
            });
        } else {
            json_cell(out, cell);
        }
    }
    let mut missed = false;
    for r in related {
        out.push(',');
        json_str(out, &r.alias);
        out.push(':');
        match &r.kind {
            RelKind::CountColumn(c) => json_cell(out, row.get(*c)),
            RelKind::One { table: child, parent_col } => {
                match read_row(ctx, roots, *child, row.get(*parent_col).str()) {
                    Ok(Some(vals)) => render_into(out, ctx, roots, *child, &[], RowRef(&crate::codec::encode_row(&vals)))?,
                    Ok(None) => out.push_str("null"),
                    Err(Miss) => {
                        missed = true;
                        out.push_str("null");
                    }
                }
            }
            RelKind::Many { plan, parent_col } => {
                let mut p = (**plan).clone();
                p.prefix[0] = row.get(*parent_col).to_value();
                match execute(ctx, roots, &p) {
                    Ok(Output::Rows { hits, .. }) => {
                        out.push('[');
                        for (i, h) in hits.iter().enumerate() {
                            if i > 0 {
                                out.push(',');
                            }
                            out.push_str(&h.json);
                        }
                        out.push(']');
                    }
                    Ok(Output::Count(n)) => out.push_str(&n.to_string()),
                    Err(Miss) => {
                        missed = true;
                        out.push_str("[]");
                    }
                }
            }
        }
    }
    out.push('}');
    if missed {
        Err(Miss)
    } else {
        Ok(())
    }
}
