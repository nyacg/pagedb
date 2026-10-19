//! Schema and indexes. One definition drives the builder (base pages), the write path
//! (overlay entries) and query planning, so they can't disagree about key layouts.
//!
//! Choices made for read speed (each costs a little write amplification):
//! - Issue indexes are covering (value = the full row): a list never needs a second lookup.
//! - Tags are a column on the issue (a JSON array of names) with a multi-valued index, so a
//!   list row already carries its tags.
//! - `issue.commentCount` is maintained by the engine, so counting comments never touches the
//!   (large) comment pages.
//! - Comments carry `projectId` and `issueTitle`, so the activity feed is one index scan.

use crate::codec::{encode_key, encode_row, Value};

pub type TreeId = u16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Table {
    Project,
    User,
    Issue,
    Comment,
}

impl Table {
    pub fn name(self) -> &'static str {
        match self {
            Table::Project => "project",
            Table::User => "user",
            Table::Issue => "issue",
            Table::Comment => "comment",
        }
    }
    pub fn from_name(s: &str) -> Option<Table> {
        Some(match s {
            "project" => Table::Project,
            "user" => Table::User,
            "issue" => Table::Issue,
            "comment" => Table::Comment,
            _ => return None,
        })
    }
    pub fn columns(self) -> &'static [&'static str] {
        match self {
            Table::Project => &["id", "name", "key"],
            Table::User => &["id", "name"],
            Table::Issue => &["id", "projectId", "title", "status", "priority", "ownerId", "createdAt", "updatedAt", "commentCount", "tags"],
            Table::Comment => &["id", "issueId", "authorId", "body", "createdAt", "projectId", "issueTitle"],
        }
    }
    pub fn col(self, name: &str) -> Option<usize> {
        self.columns().iter().position(|c| *c == name)
    }
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

#[derive(Clone, Copy, Debug)]
pub enum IndexValue {
    /// The full row.
    Row,
    /// The full row with one string column truncated (feed previews).
    RowTruncated(usize, usize),
    /// Only these columns (pointer-like indexes).
    Cols(&'static [usize]),
}

#[derive(Clone, Copy, Debug)]
pub struct Index {
    pub tree: TreeId,
    pub name: &'static str,
    pub table: Table,
    /// (column, descending)
    pub key: &'static [(usize, bool)],
    /// Column holding a JSON array; one entry per element, the element replaces this column
    /// in the key (multi-valued index).
    pub multi: Option<usize>,
    pub value: IndexValue,
    /// Primary index of its table (exactly one per table).
    pub primary: bool,
}

pub const INDEXES: &[Index] = &[
    Index { tree: 1, name: "project_by_id", table: Table::Project, key: &[(0, false)], multi: None, value: IndexValue::Row, primary: true },
    Index { tree: 2, name: "user_by_id", table: Table::User, key: &[(0, false)], multi: None, value: IndexValue::Row, primary: true },
    Index { tree: 3, name: "issue_by_id", table: Table::Issue, key: &[(issue::ID, false)], multi: None, value: IndexValue::Row, primary: true },
    Index {
        tree: 4,
        name: "issue_by_project_created",
        table: Table::Issue,
        key: &[(issue::PROJECT, false), (issue::CREATED, true), (issue::ID, false)],
        multi: None,
        value: IndexValue::Row,
        primary: false,
    },
    Index {
        tree: 5,
        name: "issue_by_project_status_created",
        table: Table::Issue,
        key: &[(issue::PROJECT, false), (issue::STATUS, false), (issue::CREATED, true), (issue::ID, false)],
        multi: None,
        value: IndexValue::Row,
        primary: false,
    },
    Index {
        tree: 6,
        name: "issue_by_tag",
        table: Table::Issue,
        key: &[(issue::TAGS, false), (issue::PROJECT, false), (issue::CREATED, true), (issue::ID, false)],
        multi: Some(issue::TAGS),
        value: IndexValue::Row,
        primary: false,
    },
    Index {
        tree: 7,
        name: "comment_by_issue",
        table: Table::Comment,
        key: &[(comment::ISSUE, false), (comment::CREATED, false), (comment::ID, false)],
        multi: None,
        value: IndexValue::Row,
        primary: false,
    },
    Index {
        tree: 8,
        name: "comment_by_created",
        table: Table::Comment,
        key: &[(comment::CREATED, true), (comment::ID, false)],
        multi: None,
        value: IndexValue::RowTruncated(comment::BODY, FEED_BODY_CHARS),
        primary: false,
    },
    Index {
        tree: 9,
        name: "comment_by_id",
        table: Table::Comment,
        key: &[(comment::ID, false)],
        multi: None,
        value: IndexValue::Cols(&[comment::ID, comment::ISSUE, comment::CREATED]),
        primary: true,
    },
];

pub fn index(tree: TreeId) -> &'static Index {
    INDEXES.iter().find(|i| i.tree == tree).expect("unknown tree")
}

pub fn index_named(name: &str) -> Option<&'static Index> {
    INDEXES.iter().find(|i| i.name == name)
}

pub fn indexes_of(table: Table) -> impl Iterator<Item = &'static Index> {
    INDEXES.iter().filter(move |i| i.table == table)
}

pub fn primary_of(table: Table) -> &'static Index {
    indexes_of(table).find(|i| i.primary).unwrap()
}

/// Parse a tags column (JSON array of strings). Tolerant: tags never contain quotes.
pub fn parse_tags(v: &Value) -> Vec<String> {
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

pub fn tags_json(tags: &[String]) -> String {
    let parts: Vec<String> = tags.iter().map(|t| format!("\"{t}\"")).collect();
    format!("[{}]", parts.join(","))
}

/// Key for `row` in `ix` (with `multi` element substituted when the index is multi-valued).
pub fn index_key(ix: &Index, row: &[Value], multi_elem: Option<&str>) -> Vec<u8> {
    let mut vals = Vec::with_capacity(ix.key.len());
    let mut desc = Vec::with_capacity(ix.key.len());
    for &(col, d) in ix.key {
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
    match ix.value {
        IndexValue::Row => encode_row(row),
        IndexValue::RowTruncated(col, n) => {
            let mut r = row.to_vec();
            if let Value::Str(s) = &r[col] {
                if s.chars().count() > n {
                    r[col] = Value::Str(s.chars().take(n).collect());
                }
            }
            encode_row(&r)
        }
        IndexValue::Cols(cols) => encode_row(&cols.iter().map(|&c| row[c].clone()).collect::<Vec<_>>()),
    }
}

/// Every (key, value) a row contributes to an index (several for multi-valued indexes).
pub fn index_entries(ix: &Index, row: &[Value]) -> Vec<(Vec<u8>, Vec<u8>)> {
    match ix.multi {
        None => vec![(index_key(ix, row, None), index_value(ix, row))],
        Some(col) => {
            let mut tags = parse_tags(&row[col]);
            tags.sort();
            tags.dedup();
            let val = index_value(ix, row);
            tags.iter().map(|t| (index_key(ix, row, Some(t)), val.clone())).collect()
        }
    }
}

/// Key of a table's primary index for a primary-key value.
pub fn pk_key(table: Table, id: &str) -> Vec<u8> {
    let ix = primary_of(table);
    debug_assert_eq!(ix.key.len(), 1);
    encode_key(&[Value::from(id)], &[false])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_roundtrip_and_multi_index() {
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
        let ix = index_named("issue_by_tag").unwrap();
        assert_eq!(index_entries(ix, &row).len(), 2);
        assert_eq!(index_entries(index_named("issue_by_id").unwrap(), &row).len(), 1);
        assert!(INDEXES.iter().all(|i| INDEXES.iter().filter(|j| j.tree == i.tree).count() == 1));
        for t in [Table::Project, Table::User, Table::Issue, Table::Comment] {
            assert_eq!(indexes_of(t).filter(|i| i.primary).count(), 1, "{t:?}");
        }
    }
}
