//! In-memory base builder (tests, small fixtures). The streaming builder for real datasets is
//! the `pagedb-builder` binary; both produce the same trees from the same rows.

use crate::catalog::{self, index_entries, Index, Schema};
use crate::codec::Value;
use crate::gen::{self, Config};
use crate::query::Roots;
use crate::tree::{TreeBuilder, VecSink};
use std::collections::HashMap;
use std::rc::Rc;

pub struct MemDb {
    pub pages: Vec<Rc<[u8]>>,
    pub roots: Roots,
}

/// All rows of every tracker table, for oracles.
pub struct Rows {
    pub projects: Vec<Vec<Value>>,
    pub users: Vec<Vec<Value>>,
    pub issues: Vec<Vec<Value>>,
    pub comments: Vec<Vec<Value>>,
}

pub fn rows(cfg: &Config) -> Rows {
    let mut r = Rows { projects: vec![], users: vec![], issues: vec![], comments: vec![] };
    for p in 0..cfg.projects {
        r.projects.push(gen::project_row(cfg, p));
        for s in 0..gen::issue_count(cfg, p) {
            let is = gen::issue(cfg, p, s);
            for j in 0..is.comments {
                r.comments.push(gen::comment(cfg, p, s, j, &is.row));
            }
            r.issues.push(is.row);
        }
    }
    for u in 0..cfg.users {
        r.users.push(gen::user_row(cfg, u));
    }
    r
}

/// Build every index of `schema` from rows per table (indexed by table id). `limit` keeps only
/// the first n keys of an index in the base (e.g. a feed of the newest comments).
pub fn build_tables(schema: &'static Schema, tables: &[&[Vec<Value>]], limit: &dyn Fn(&Index) -> Option<usize>) -> MemDb {
    let mut sink = VecSink::default();
    let mut roots = HashMap::new();
    for ix in &schema.indexes {
        let mut entries: Vec<(Vec<u8>, Vec<u8>)> = tables[ix.table].iter().flat_map(|row| index_entries(ix, row)).collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        if let Some(n) = limit(ix).or(ix.base_limit) {
            entries.truncate(n);
        }
        let mut b = TreeBuilder::new(ix.tree);
        for (k, v) in &entries {
            b.push(&mut sink, k, v);
        }
        roots.insert(ix.tree, b.finish(&mut sink));
    }
    MemDb { pages: sink.pages, roots: Roots::new(schema, roots) }
}

/// The issue tracker, generated from `cfg`.
pub fn build(cfg: &Config) -> (MemDb, Rows) {
    let all = rows(cfg);
    let db = build_tables(
        catalog::tracker(),
        &[&all.projects, &all.users, &all.issues, &all.comments],
        &|ix| (ix.name == "comment_by_created").then_some(cfg.feed_base),
    );
    (db, all)
}
