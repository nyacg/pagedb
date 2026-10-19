//! Schemas: tables, indexes and relations, declared as data. One schema drives the builder
//! (base pages), the write path (overlay entries, maintained columns) and query planning, so
//! they can't disagree about key layouts. A base carries its schema in `manifest.json`; bases
//! built before schemas existed get the issue tracker's (`tracker()`).
//!
//! ```json
//! {"tables":[{"name":"issue","columns":["id",{"name":"createdAt","type":"number"},{"name":"tags","type":"list"}]}],
//!  "indexes":[{"tree":3,"name":"issue_by_id","table":"issue","key":["id"],"primary":true},
//!             {"tree":4,"name":"issue_by_created","table":"issue","key":["-createdAt","id"]}],
//!  "relations":[{"parent":"issue","child":"comment","fk":"issueId","count":"commentCount",
//!                "touch":{"updatedAt":"createdAt"},"copy":{"issueTitle":"title"},"onDelete":"cascade"}]}
//! ```
//!
//! - Column 0 is the primary key (a string). Types: `string` (default), `number`, `bool`,
//!   `list` (a list of strings, stored as a JSON array; a `multi` index has one entry per element).
//! - Index keys are column names, `-name` for descending. Every key must include the primary key,
//!   so a key identifies one row (the write path relies on it). Values: the whole row (default),
//!   the row with long strings truncated (`"truncate":{"body":200}`), or a pointer
//!   (`"cols":[…],"rowIndex":"…"`: a primary index whose full rows live in another index).
//! - Relations (parent → child by `fk`) are maintained by the engine: a count of children, a
//!   timestamp touched by new children, columns copied from the parent (kept in sync when the
//!   parent changes), and cascading deletes. Their columns can't be written directly.

use crate::codec::{encode_key, encode_row, Value};
use serde_json::Value as J;
use std::sync::OnceLock;

pub type TreeId = u16;
pub type TableId = usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColType {
    Str,
    Num,
    Bool,
    List,
}

#[derive(Clone, Debug)]
pub struct Column {
    pub name: String,
    pub ty: ColType,
    /// Can't be changed by an update (set for keys, relation columns and declared `immutable`).
    pub immutable: bool,
}

#[derive(Clone, Debug)]
pub struct TableDef {
    pub id: TableId,
    pub name: String,
    pub columns: Vec<Column>,
    pub read_only: bool,
}

impl TableDef {
    pub fn col(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c.name == name)
    }
    pub fn column_names(&self) -> impl Iterator<Item = &str> {
        self.columns.iter().map(|c| c.name.as_str())
    }
}

#[derive(Clone, Debug)]
pub enum IndexValue {
    /// The full row.
    Row,
    /// The full row with string columns truncated to n characters (feed previews).
    RowTruncated(Vec<(usize, usize)>),
    /// Only these columns: a pointer to the row in `Index::row_index`.
    Cols(Vec<usize>),
}

#[derive(Clone, Debug)]
pub struct Index {
    pub tree: TreeId,
    pub name: String,
    pub table: TableId,
    /// (column, descending)
    pub key: Vec<(usize, bool)>,
    /// List column whose elements replace it in the key (one entry per element).
    pub multi: Option<usize>,
    pub value: IndexValue,
    /// Primary index of its table (exactly one per table, keyed by the primary key alone).
    pub primary: bool,
    /// For a pointer primary: the covering index holding the full rows.
    pub row_index: Option<TreeId>,
    /// Partial index: only rows where this column isn't null (`"where":{"notNull":"col"}`).
    /// The planner uses it only for queries that require the column (`IS NOT NULL`).
    pub not_null: Option<usize>,
    /// The builder keeps only the first n keys in the base (`"baseLimit"`, e.g. a feed's newest).
    pub base_limit: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct Relation {
    pub parent: TableId,
    pub child: TableId,
    /// Child column holding the parent's primary key (may be null: no parent).
    pub fk: usize,
    /// Parent column counting its children.
    pub count: Option<usize>,
    /// (parent column, child column): the parent's column is raised to a new child's value.
    pub touch: Option<(usize, usize)>,
    /// (child column, parent column) copied onto children, and kept in sync.
    pub copy: Vec<(usize, usize)>,
    pub cascade: bool,
    /// A covering child index leading with `fk`: how a parent's children are found.
    pub children: Option<TreeId>,
}

#[derive(Clone, Debug)]
pub struct Schema {
    pub name: String,
    pub tables: Vec<TableDef>,
    pub indexes: Vec<Index>,
    pub relations: Vec<Relation>,
    /// The JSON this was parsed from (written into manifests).
    pub json: J,
}

fn col_spec(c: &J) -> Result<(String, ColType, bool), String> {
    if let Some(name) = c.as_str() {
        return Ok((name.to_string(), ColType::Str, false));
    }
    let name = c.get("name").and_then(J::as_str).ok_or("column needs a name")?.to_string();
    let ty = match c.get("type").and_then(J::as_str).unwrap_or("string") {
        "string" => ColType::Str,
        "number" => ColType::Num,
        "bool" => ColType::Bool,
        "list" => ColType::List,
        t => return Err(format!("{name}: unknown type {t}")),
    };
    Ok((name, ty, c.get("immutable").and_then(J::as_bool).unwrap_or(false)))
}

impl Schema {
    pub fn from_json(j: &J) -> Result<Schema, String> {
        let mut tables = Vec::new();
        for (id, t) in j.get("tables").and_then(J::as_array).ok_or("schema needs tables")?.iter().enumerate() {
            let name = t.get("name").and_then(J::as_str).ok_or("table needs a name")?.to_string();
            let mut columns = Vec::new();
            for c in t.get("columns").and_then(J::as_array).ok_or_else(|| format!("{name}: no columns"))? {
                let (cname, ty, immutable) = col_spec(c)?;
                columns.push(Column { name: cname, ty, immutable: immutable || columns.is_empty() });
            }
            if columns.is_empty() || columns[0].ty != ColType::Str {
                return Err(format!("{name}: column 0 must be a string primary key"));
            }
            tables.push(TableDef { id, name, columns, read_only: t.get("readOnly").and_then(J::as_bool).unwrap_or(false) });
        }
        let table_of = |n: &str| tables.iter().position(|t| t.name == n).ok_or_else(|| format!("unknown table {n}"));
        let col_of = |t: TableId, n: &str| tables[t].col(n).ok_or_else(|| format!("unknown column {}.{n}", tables[t].name));

        let mut indexes: Vec<Index> = Vec::new();
        let mut row_index_names: Vec<(usize, String)> = Vec::new();
        for ix in j.get("indexes").and_then(J::as_array).ok_or("schema needs indexes")? {
            let name = ix.get("name").and_then(J::as_str).ok_or("index needs a name")?.to_string();
            let tree = ix.get("tree").and_then(J::as_u64).ok_or_else(|| format!("{name}: needs a tree id"))? as TreeId;
            let table = table_of(ix.get("table").and_then(J::as_str).ok_or_else(|| format!("{name}: needs a table"))?)?;
            let mut key = Vec::new();
            for k in ix.get("key").and_then(J::as_array).ok_or_else(|| format!("{name}: needs a key"))? {
                let k = k.as_str().ok_or_else(|| format!("{name}: key entries are column names"))?;
                let (desc, c) = match k.strip_prefix('-') {
                    Some(c) => (true, c),
                    None => (false, k),
                };
                key.push((col_of(table, c)?, desc));
            }
            let multi = match ix.get("multi").and_then(J::as_str) {
                Some(c) => {
                    let c = col_of(table, c)?;
                    if tables[table].columns[c].ty != ColType::List || !key.iter().any(|(k, _)| *k == c) {
                        return Err(format!("{name}: multi must be a list column in the key"));
                    }
                    Some(c)
                }
                None => None,
            };
            let value = if let Some(cols) = ix.get("cols").and_then(J::as_array) {
                let cols = cols.iter().map(|c| col_of(table, c.as_str().unwrap_or(""))).collect::<Result<Vec<_>, _>>()?;
                row_index_names.push((indexes.len(), ix.get("rowIndex").and_then(J::as_str).ok_or_else(|| format!("{name}: cols needs rowIndex"))?.to_string()));
                IndexValue::Cols(cols)
            } else if let Some(t) = ix.get("truncate").and_then(J::as_object) {
                IndexValue::RowTruncated(t.iter().map(|(c, n)| Ok((col_of(table, c)?, n.as_u64().unwrap_or(200) as usize))).collect::<Result<Vec<_>, String>>()?)
            } else {
                IndexValue::Row
            };
            let primary = ix.get("primary").and_then(J::as_bool).unwrap_or(false);
            let not_null = ix.get("where").and_then(|w| w.get("notNull")).and_then(J::as_str).map(|c| col_of(table, c)).transpose()?;
            let base_limit = ix.get("baseLimit").and_then(J::as_u64).map(|n| n as usize);
            if primary && (not_null.is_some() || base_limit.is_some()) {
                return Err(format!("{name}: a primary index holds every row"));
            }
            if primary && key != [(0, false)] {
                return Err(format!("{name}: a primary index is keyed by the primary key alone"));
            }
            if !key.iter().any(|(c, _)| *c == 0) {
                return Err(format!("{name}: every index key must include the primary key"));
            }
            if indexes.iter().any(|i| i.tree == tree || i.name == name) {
                return Err(format!("{name}: duplicate tree id or name"));
            }
            indexes.push(Index { tree, name, table, key, multi, value, primary, row_index: None, not_null, base_limit });
        }
        for (i, target) in row_index_names {
            let t = indexes.iter().find(|x| x.name == target).ok_or_else(|| format!("unknown rowIndex {target}"))?;
            let IndexValue::Cols(cols) = &indexes[i].value else { unreachable!() };
            if t.table != indexes[i].table || !matches!(t.value, IndexValue::Row) || t.multi.is_some() || !t.key.iter().all(|(c, _)| cols.contains(c)) {
                return Err(format!("{}: rowIndex must be a covering index of the same table whose key columns are in cols", indexes[i].name));
            }
            indexes[i].row_index = Some(t.tree);
        }
        for t in &tables {
            if indexes.iter().filter(|i| i.table == t.id && i.primary).count() != 1 {
                return Err(format!("{}: needs exactly one primary index", t.name));
            }
        }

        let mut relations = Vec::new();
        for r in j.get("relations").and_then(J::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            let parent = table_of(r.get("parent").and_then(J::as_str).ok_or("relation needs a parent")?)?;
            let child = table_of(r.get("child").and_then(J::as_str).ok_or("relation needs a child")?)?;
            let fk = col_of(child, r.get("fk").and_then(J::as_str).ok_or("relation needs fk")?)?;
            let count = r.get("count").and_then(J::as_str).map(|c| col_of(parent, c)).transpose()?;
            let touch = match r.get("touch").and_then(J::as_object).and_then(|o| o.iter().next()) {
                Some((p, c)) => Some((col_of(parent, p)?, col_of(child, c.as_str().unwrap_or(""))?)),
                None => None,
            };
            let mut copy = Vec::new();
            for (c, p) in r.get("copy").and_then(J::as_object).into_iter().flatten() {
                copy.push((col_of(child, c)?, col_of(parent, p.as_str().unwrap_or(""))?));
            }
            let cascade = r.get("onDelete").and_then(J::as_str) == Some("cascade");
            let children = indexes.iter().find(|i| i.table == child && i.key[0].0 == fk && i.multi.is_none() && matches!(i.value, IndexValue::Row)).map(|i| i.tree);
            if children.is_none() && (cascade || !copy.is_empty()) {
                return Err(format!("{} → {}: cascade and copy need a covering child index leading with the fk", tables[parent].name, tables[child].name));
            }
            relations.push(Relation { parent, child, fk, count, touch, copy, cascade, children });
        }
        // Columns the engine maintains can't be written directly.
        for r in &relations {
            tables[r.child].columns[r.fk].immutable = true;
            for &(c, _) in &r.copy {
                tables[r.child].columns[c].immutable = true;
            }
            if let Some(c) = r.count {
                tables[r.parent].columns[c].immutable = true;
            }
        }
        let name = j.get("name").and_then(J::as_str).unwrap_or("db").to_string();
        Ok(Schema { name, tables, indexes, relations, json: j.clone() })
    }

    /// Plans and partitions hold `&'static` references into their schema; a schema lives for
    /// the whole process (one per engine instance, a few in tests).
    pub fn leak(self) -> &'static Schema {
        Box::leak(Box::new(self))
    }

    pub fn parse(text: &str) -> Result<&'static Schema, String> {
        let j: J = serde_json::from_str(text).map_err(|e| format!("bad schema JSON: {e}"))?;
        Ok(Schema::from_json(&j)?.leak())
    }

    pub fn table(&self, id: TableId) -> &TableDef {
        &self.tables[id]
    }

    pub fn table_named(&self, name: &str) -> Option<TableId> {
        self.tables.iter().position(|t| t.name == name)
    }

    pub fn index(&self, tree: TreeId) -> &Index {
        self.indexes.iter().find(|i| i.tree == tree).expect("unknown tree")
    }

    pub fn index_named(&self, name: &str) -> Option<&Index> {
        self.indexes.iter().find(|i| i.name == name)
    }

    pub fn indexes_of(&self, table: TableId) -> impl Iterator<Item = &Index> {
        self.indexes.iter().filter(move |i| i.table == table)
    }

    pub fn primary_of(&self, table: TableId) -> &Index {
        self.indexes_of(table).find(|i| i.primary).unwrap()
    }

    /// Key of a table's primary index for a primary-key value.
    pub fn pk_key(&self, _table: TableId, id: &str) -> Vec<u8> {
        encode_key(&[Value::from(id)], &[false])
    }

    /// The relation whose children are `child` rows pointing at `parent` through `fk`.
    pub fn relation(&self, parent: TableId, child: TableId, fk: usize) -> Option<&Relation> {
        self.relations.iter().find(|r| r.parent == parent && r.child == child && r.fk == fk)
    }
}

/// Parse a list column (JSON array of strings). Tolerant: elements never contain quotes.
pub fn parse_list(v: &Value) -> Vec<String> {
    let s = match v {
        Value::Str(s) => s.as_str(),
        _ => return Vec::new(),
    };
    s.trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|t| t.trim().trim_matches('"').to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

pub fn list_json(items: &[String]) -> String {
    let parts: Vec<String> = items.iter().map(|t| format!("\"{}\"", t.replace(['"', '\\'], ""))).collect();
    format!("[{}]", parts.join(","))
}

/// Key for `row` in `ix` (with `multi` element substituted when the index is multi-valued).
pub fn index_key(ix: &Index, row: &[Value], multi_elem: Option<&str>) -> Vec<u8> {
    let mut vals = Vec::with_capacity(ix.key.len());
    let mut desc = Vec::with_capacity(ix.key.len());
    for &(col, d) in &ix.key {
        if Some(col) == ix.multi {
            vals.push(Value::Str(multi_elem.unwrap_or_default().to_string()));
        } else {
            vals.push(row[col].clone());
        }
        desc.push(d);
    }
    encode_key(&vals, &desc)
}

pub fn index_value(ix: &Index, row: &[Value]) -> Vec<u8> {
    match &ix.value {
        IndexValue::Row => encode_row(row),
        IndexValue::RowTruncated(cols) => {
            let mut r = row.to_vec();
            for &(col, n) in cols {
                if let Value::Str(s) = &r[col] {
                    if s.chars().count() > n {
                        r[col] = Value::Str(s.chars().take(n).collect());
                    }
                }
            }
            encode_row(&r)
        }
        IndexValue::Cols(cols) => encode_row(&cols.iter().map(|&c| row[c].clone()).collect::<Vec<_>>()),
    }
}

/// Every (key, value) a row contributes to an index (one per element for multi-valued indexes,
/// in sorted, de-duplicated element order).
pub fn index_entries(ix: &Index, row: &[Value]) -> Vec<(Vec<u8>, Vec<u8>)> {
    if ix.not_null.is_some_and(|c| row[c] == Value::Null) {
        return Vec::new();
    }
    match ix.multi {
        None => vec![(index_key(ix, row, None), index_value(ix, row))],
        Some(col) => {
            let mut items = parse_list(&row[col]);
            items.sort();
            items.dedup();
            let val = index_value(ix, row);
            items.iter().map(|t| (index_key(ix, row, Some(t)), val.clone())).collect()
        }
    }
}

// ------------------------------------------------------------------ the issue tracker

/// The issue tracker's schema (the demo, and every base built before manifests carried one).
pub const TRACKER_JSON: &str = r#"{
  "name": "tracker",
  "tables": [
    {"name": "project", "readOnly": true, "columns": ["id", "name", "key"]},
    {"name": "user", "readOnly": true, "columns": ["id", "name"]},
    {"name": "issue", "columns": ["id", {"name": "projectId", "immutable": true}, "title", "status", "priority", "ownerId",
      {"name": "createdAt", "type": "number"}, {"name": "updatedAt", "type": "number"},
      {"name": "commentCount", "type": "number"}, {"name": "tags", "type": "list"}]},
    {"name": "comment", "columns": ["id", "issueId", "authorId", "body", {"name": "createdAt", "type": "number"}, "projectId", "issueTitle"]}
  ],
  "indexes": [
    {"tree": 1, "name": "project_by_id", "table": "project", "key": ["id"], "primary": true},
    {"tree": 2, "name": "user_by_id", "table": "user", "key": ["id"], "primary": true},
    {"tree": 3, "name": "issue_by_id", "table": "issue", "key": ["id"], "primary": true},
    {"tree": 4, "name": "issue_by_project_created", "table": "issue", "key": ["projectId", "-createdAt", "id"]},
    {"tree": 5, "name": "issue_by_project_status_created", "table": "issue", "key": ["projectId", "status", "-createdAt", "id"]},
    {"tree": 6, "name": "issue_by_tag", "table": "issue", "key": ["tags", "projectId", "-createdAt", "id"], "multi": "tags"},
    {"tree": 7, "name": "comment_by_issue", "table": "comment", "key": ["issueId", "createdAt", "id"]},
    {"tree": 8, "name": "comment_by_created", "table": "comment", "key": ["-createdAt", "id"], "truncate": {"body": 200}, "baseLimit": 500000},
    {"tree": 9, "name": "comment_by_id", "table": "comment", "key": ["id"], "primary": true, "cols": ["id", "issueId", "createdAt"], "rowIndex": "comment_by_issue"}
  ],
  "relations": [
    {"parent": "issue", "child": "comment", "fk": "issueId", "count": "commentCount",
     "touch": {"updatedAt": "createdAt"}, "copy": {"projectId": "projectId", "issueTitle": "title"}, "onDelete": "cascade"}
  ]
}"#;

pub fn tracker() -> &'static Schema {
    static S: OnceLock<&'static Schema> = OnceLock::new();
    S.get_or_init(|| Schema::parse(TRACKER_JSON).expect("tracker schema"))
}

/// Tracker table ids and column positions (generator, builder and tests).
pub mod t {
    pub const PROJECT: usize = 0;
    pub const USER: usize = 1;
    pub const ISSUE: usize = 2;
    pub const COMMENT: usize = 3;
}
pub mod issue {
    pub const ID: usize = 0;
    pub const PROJECT: usize = 1;
    pub const TITLE: usize = 2;
    pub const STATUS: usize = 3;
    pub const PRIORITY: usize = 4;
    pub const OWNER: usize = 5;
    pub const CREATED: usize = 6;
    pub const UPDATED: usize = 7;
    pub const COMMENTS: usize = 8;
    pub const TAGS: usize = 9;
}
pub mod comment {
    pub const ID: usize = 0;
    pub const ISSUE: usize = 1;
    pub const AUTHOR: usize = 2;
    pub const BODY: usize = 3;
    pub const CREATED: usize = 4;
    pub const PROJECT: usize = 5;
    pub const ISSUE_TITLE: usize = 6;
}

pub const STATUSES: [&str; 5] = ["backlog", "todo", "in-progress", "review", "done"];
pub const PRIORITIES: [&str; 4] = ["urgent", "high", "medium", "low"];
/// Feed rows carry a body preview, not the whole comment.
pub const FEED_BODY_CHARS: usize = 200;

// Older names, used by the generator and tests.
pub use list_json as tags_json;
pub use parse_list as parse_tags;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_schema_and_multi_index() {
        let s = tracker();
        let tags = vec!["api".to_string(), "bug".to_string()];
        let row = vec![
            Value::from("i1"),
            Value::from("p1"),
            Value::from("t"),
            Value::from("todo"),
            Value::from("low"),
            Value::from("u1"),
            Value::Num(5.0),
            Value::Num(6.0),
            Value::Num(0.0),
            Value::from(tags_json(&tags)),
        ];
        assert_eq!(parse_tags(&row[issue::TAGS]), tags);
        assert_eq!(index_entries(s.index_named("issue_by_tag").unwrap(), &row).len(), 2);
        assert_eq!(index_entries(s.index_named("issue_by_id").unwrap(), &row).len(), 1);
        assert_eq!(s.table(t::ISSUE).col("tags"), Some(issue::TAGS));
        assert_eq!(s.table(t::COMMENT).col("issueTitle"), Some(comment::ISSUE_TITLE));
        assert_eq!(s.primary_of(t::COMMENT).row_index, Some(7));
        let r = &s.relations[0];
        assert_eq!((r.parent, r.child, r.fk, r.count, r.children), (t::ISSUE, t::COMMENT, comment::ISSUE, Some(issue::COMMENTS), Some(7)));
        // Maintained and key columns are read-only to updates.
        let imm = |t: usize, c: usize| s.table(t).columns[c].immutable;
        assert!(imm(t::ISSUE, issue::ID) && imm(t::ISSUE, issue::PROJECT) && imm(t::ISSUE, issue::COMMENTS));
        assert!(imm(t::COMMENT, comment::ISSUE) && imm(t::COMMENT, comment::ISSUE_TITLE) && !imm(t::COMMENT, comment::BODY));
        assert!(!imm(t::ISSUE, issue::TITLE));
    }

    #[test]
    fn rejects_bad_schemas() {
        let bad = |s: &str| Schema::from_json(&serde_json::from_str(s).unwrap()).is_err();
        // Index without the primary key; a table without a primary index; a multi on a non-list.
        assert!(bad(r#"{"tables":[{"name":"a","columns":["id","x"]}],"indexes":[{"tree":1,"name":"a","table":"a","key":["id"],"primary":true},{"tree":2,"name":"b","table":"a","key":["x"]}]}"#));
        assert!(bad(r#"{"tables":[{"name":"a","columns":["id","x"]}],"indexes":[{"tree":2,"name":"b","table":"a","key":["x","id"]}]}"#));
        assert!(bad(r#"{"tables":[{"name":"a","columns":["id","x"]}],"indexes":[{"tree":1,"name":"a","table":"a","key":["id"],"primary":true},{"tree":2,"name":"b","table":"a","key":["x","id"],"multi":"x"}]}"#));
    }
}
