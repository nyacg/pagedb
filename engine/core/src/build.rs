//! In-memory base builder (tests, small fixtures). The streaming builder for real datasets is
//! the `pagedb-builder` binary; both produce the same trees from the same generator.

use crate::catalog::{self, index_entries};
use crate::gen::{self, Config};
use crate::query::Roots;
use crate::tree::{TreeBuilder, VecSink};
use std::collections::HashMap;
use std::rc::Rc;

pub struct MemDb {
    pub pages: Vec<Rc<[u8]>>,
    pub roots: Roots,
}

/// All rows of every table, for oracles.
pub struct Rows {
    pub projects: Vec<Vec<crate::codec::Value>>,
    pub users: Vec<Vec<crate::codec::Value>>,
    pub issues: Vec<Vec<crate::codec::Value>>,
    pub comments: Vec<Vec<crate::codec::Value>>,
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

pub fn build(cfg: &Config) -> (MemDb, Rows) {
    let all = rows(cfg);
    let mut sink = VecSink::default();
    let mut roots = HashMap::new();
    for ix in catalog::INDEXES {
        let source = match ix.table {
            catalog::Table::Project => &all.projects,
            catalog::Table::User => &all.users,
            catalog::Table::Issue => &all.issues,
            catalog::Table::Comment => &all.comments,
        };
        let mut entries: Vec<(Vec<u8>, Vec<u8>)> = source.iter().flat_map(|row| index_entries(ix, row)).collect();
        if ix.name == "comment_by_created" {
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries.truncate(cfg.feed_base);
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut b = TreeBuilder::new(ix.tree);
        for (k, v) in &entries {
            b.push(&mut sink, k, v);
        }
        roots.insert(ix.tree, b.finish(&mut sink));
    }
    (MemDb { pages: sink.pages, roots: Roots(roots) }, all)
}
