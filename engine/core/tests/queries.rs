//! Every demo query against a brute-force oracle over the generated rows, starting from a
//! cold page cache (fault injection at every page read).

use pagedb_core::build::{self, MemDb, Rows};
use pagedb_core::catalog::{comment, issue};
use pagedb_core::codec::Value;
use pagedb_core::gen::Config;
use pagedb_core::page::PageId;
use pagedb_core::query::{compile, execute, Output};
use pagedb_core::tree::{Ctx, Miss, PageStore};
use serde_json::{json, Value as J};
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

struct Cold<'a> {
    db: &'a MemDb,
    resident: RefCell<HashSet<PageId>>,
}
impl PageStore for Cold<'_> {
    fn get(&self, id: PageId) -> Option<Rc<[u8]>> {
        self.resident.borrow().contains(&id).then(|| self.db.pages[id as usize].clone())
    }
}

/// (output, fault rounds, pages fetched)
fn run(db: &MemDb, ast: &J) -> (Output, usize, usize) {
    let plan = compile(ast).unwrap_or_else(|e| panic!("{e}: {ast}"));
    let store = Cold { db, resident: RefCell::new(HashSet::new()) };
    let mut rounds = 0;
    loop {
        let ctx = Ctx::new(&store);
        match execute(&ctx, &db.roots, &plan) {
            Ok(o) => return (o, rounds, store.resident.borrow().len()),
            Err(Miss) => {
                rounds += 1;
                assert!(rounds < 16);
                store.resident.borrow_mut().extend(ctx.take_want());
            }
        }
    }
}

fn eq(c: &str, v: J) -> J {
    json!({"type":"simple","op":"=","left":{"type":"column","name":c},"right":{"type":"literal","value":v}})
}
fn cond(op: &str, c: &str, v: J) -> J {
    json!({"type":"simple","op":op,"left":{"type":"column","name":c},"right":{"type":"literal","value":v}})
}
fn card_related() -> J {
    json!([
        {"alias":"project","correlation":{"parentField":["projectId"],"childField":["id"]},"subquery":{"table":"project"}},
        {"alias":"owner","correlation":{"parentField":["ownerId"],"childField":["id"]},"subquery":{"table":"user"}},
        {"alias":"commentCount","correlation":{"parentField":["id"],"childField":["issueId"]},"subquery":{"table":"comment","aggregate":"count"}}
    ])
}

fn ids(o: &Output) -> Vec<String> {
    match o {
        Output::Rows { hits, .. } => hits.iter().map(|h| h.pk.clone()).collect(),
        Output::Count(_) => panic!("rows expected"),
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}
fn n(v: &Value) -> f64 {
    v.as_num().unwrap()
}

fn oracle_issues(rows: &Rows, keep: impl Fn(&Vec<Value>) -> bool, limit: usize) -> Vec<String> {
    let mut v: Vec<&Vec<Value>> = rows.issues.iter().filter(|r| keep(r)).collect();
    v.sort_by(|a, b| n(&b[issue::CREATED]).partial_cmp(&n(&a[issue::CREATED])).unwrap().then(s(&a[issue::ID]).cmp(s(&b[issue::ID]))));
    v.into_iter().take(limit).map(|r| s(&r[issue::ID]).to_string()).collect()
}

fn setup() -> (MemDb, Rows) {
    let mut cfg = Config::with_projects(6);
    cfg.issues_per_project = 1500;
    cfg.users = 300;
    cfg.feed_base = 5000;
    build::build(&cfg)
}

#[test]
fn issue_list_board_filters_counts() {
    let (db, rows) = setup();
    let order = json!([["createdAt","desc"],["id","asc"]]);
    for p in ["p0000", "p0003", "p0005"] {
        // List: newest 50 with card relations — one fault round from a cold cache... after the
        // interior: rounds = height of the tree (no pinning in this test) + 1 for lookups.
        let ast = json!({"table":"issue","where":eq("projectId", json!(p)),"orderBy":order,"limit":50,"related":card_related()});
        let (out, rounds, pages) = run(&db, &ast);
        assert_eq!(ids(&out), oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p, 50));
        assert!(rounds <= 4, "list took {rounds} rounds");
        if let Output::Rows { hits, .. } = &out {
            let row: J = serde_json::from_str(&hits[0].json).unwrap();
            assert_eq!(row["project"]["id"], json!(p));
            assert!(row["owner"]["name"].is_string());
            assert!(row["commentCount"].as_f64().unwrap() >= 1.0);
            assert!(row["tags"].is_array());
        }
        eprintln!("list {p}: {rounds} rounds, {pages} pages");
        // Board column: status partition uses issue_by_project_status_created.
        for st in ["todo", "done"] {
            let ast = json!({"table":"issue","where":{"type":"and","conditions":[eq("projectId", json!(p)), eq("status", json!(st))]},"orderBy":order,"limit":25});
            let plan = compile(&ast).unwrap();
            assert_eq!(plan.index.name, "issue_by_project_status_created");
            let (out, _, _) = run(&db, &ast);
            assert_eq!(ids(&out), oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p && s(&r[issue::STATUS]) == st, 25));
        }
        // Filters: priority IN, owner =, title ILIKE, tag HAS.
        let ast = json!({"table":"issue","where":{"type":"and","conditions":[eq("projectId", json!(p)), cond("IN","priority",json!(["urgent","high"])), cond("ILIKE","title",json!("%cache%"))]},"orderBy":order,"limit":50});
        let (out, _, _) = run(&db, &ast);
        assert_eq!(
            ids(&out),
            oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p && ["urgent", "high"].contains(&s(&r[issue::PRIORITY])) && s(&r[issue::TITLE]).to_lowercase().contains("cache"), 50)
        );
        let ast = json!({"table":"issue","where":{"type":"and","conditions":[eq("projectId", json!(p)), cond("HAS","tags",json!("bug"))]},"orderBy":order,"limit":50});
        assert_eq!(compile(&ast).unwrap().index.name, "issue_by_tag");
        let (out, _, _) = run(&db, &ast);
        assert_eq!(ids(&out), oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p && s(&r[issue::TAGS]).contains("\"bug\""), 50));
        // Counts.
        let (out, _, _) = run(&db, &json!({"table":"issue","where":eq("projectId", json!(p)),"aggregate":"count"}));
        assert_eq!(out, Output::Count(rows.issues.iter().filter(|r| s(&r[issue::PROJECT]) == p).count() as u64));
        let (out, _, _) = run(&db, &json!({"table":"issue","where":{"type":"and","conditions":[eq("projectId", json!(p)), eq("status", json!("review"))]},"aggregate":"count"}));
        assert_eq!(out, Output::Count(rows.issues.iter().filter(|r| s(&r[issue::PROJECT]) == p && s(&r[issue::STATUS]) == "review").count() as u64));
    }
}

#[test]
fn detail_and_feed() {
    let (db, rows) = setup();
    let id = s(&rows.issues[777][issue::ID]).to_string();
    let ast = json!({"table":"issue","where":eq("id", json!(id)),"one":true,"related":[
        {"alias":"owner","correlation":{"parentField":["ownerId"],"childField":["id"]},"subquery":{"table":"user"}},
        {"alias":"comments","correlation":{"parentField":["id"],"childField":["issueId"]},"subquery":{"table":"comment","orderBy":[["createdAt","asc"],["id","asc"]],"limit":500,
            "related":[{"alias":"author","correlation":{"parentField":["authorId"],"childField":["id"]},"subquery":{"table":"user"}}]}}
    ]});
    let (out, rounds, _) = run(&db, &ast);
    let Output::Rows { hits, .. } = out else { panic!() };
    assert_eq!(hits.len(), 1);
    let row: J = serde_json::from_str(&hits[0].json).unwrap();
    let want: Vec<&Vec<Value>> = rows.comments.iter().filter(|c| s(&c[comment::ISSUE]) == id).collect();
    let got = row["comments"].as_array().unwrap();
    assert_eq!(got.len(), want.len());
    assert_eq!(row["commentCount"].as_f64().unwrap() as usize, want.len()); // the maintained column
    for (g, w) in got.iter().zip(want) {
        assert_eq!(g["id"], json!(s(&w[comment::ID])));
        assert!(g["author"]["name"].is_string());
    }
    eprintln!("detail: {rounds} rounds");
    // Feed: newest 30 comments overall.
    let ast = json!({"table":"comment","orderBy":[["createdAt","desc"],["id","asc"]],"limit":30});
    let (out, _, _) = run(&db, &ast);
    let mut all: Vec<&Vec<Value>> = rows.comments.iter().collect();
    all.sort_by(|a, b| n(&b[comment::CREATED]).partial_cmp(&n(&a[comment::CREATED])).unwrap().then(s(&a[comment::ID]).cmp(s(&b[comment::ID]))));
    let want: Vec<String> = all.iter().take(30).map(|c| s(&c[comment::ID]).to_string()).collect();
    if ids(&out) != want {
        for (g, w) in ids(&out).iter().zip(&want).take(8) {
            let t = |id: &str| rows.comments.iter().find(|c| s(&c[comment::ID]) == id).map(|c| n(&c[comment::CREATED])).unwrap();
            eprintln!("got {g} {} want {w} {}", t(g), t(w));
        }
    }
    assert_eq!(ids(&out), want);
}

#[test]
fn refuses_unindexed_queries() {
    assert!(compile(&json!({"table":"issue","orderBy":[["title","asc"]]})).is_err());
    assert!(compile(&json!({"table":"comment","where":eq("authorId", json!("u00001")),"orderBy":[["body","asc"]]})).is_err());
}

#[test]
fn keyset_pages_cover_the_list_exactly() {
    let (db, rows) = setup();
    let p = "p0002";
    for (order, filter, expected) in [
        (json!([["createdAt","desc"],["id","asc"]]), None, oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p, usize::MAX)),
        (json!([["createdAt","asc"],["id","desc"]]), None, {
            let mut v = oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p, usize::MAX);
            v.reverse();
            v
        }),
        (json!([["createdAt","desc"],["id","asc"]]), Some(cond("ILIKE","title",json!("%sync%"))), oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p && s(&r[issue::TITLE]).to_lowercase().contains("sync"), usize::MAX)),
        (json!([["createdAt","desc"],["id","asc"]]), Some(cond("HAS","tags",json!("api"))), oracle_issues(&rows, |r| s(&r[issue::PROJECT]) == p && s(&r[issue::TAGS]).contains("\"api\""), usize::MAX)),
    ] {
        let mut got: Vec<String> = Vec::new();
        let mut start: Option<J> = None;
        loop {
            let mut conds = vec![eq("projectId", json!(p))];
            if let Some(f) = &filter {
                conds.push(f.clone());
            }
            let mut ast = json!({"table":"issue","where":{"type":"and","conditions":conds},"orderBy":order,"limit":37});
            if let Some(st) = &start {
                ast["start"] = json!({"row": st});
            }
            let (out, _, _) = run(&db, &ast);
            let Output::Rows { hits, complete } = out else { panic!() };
            for h in &hits {
                got.push(h.pk.clone());
            }
            if complete || hits.is_empty() {
                break;
            }
            // The next page starts after this page's last row (its createdAt + id).
            let last: J = serde_json::from_str(&hits.last().unwrap().json).unwrap();
            start = Some(json!({"createdAt": last["createdAt"], "id": last["id"]}));
        }
        assert_eq!(got.len(), expected.len(), "order {order} filter {filter:?}");
        assert_eq!(got, expected, "order {order} filter {filter:?}");
        // A bounded page (start, end] returns exactly the rows between.
        if expected.len() > 60 {
            let row_of = |id: &str| rows.issues.iter().find(|r| s(&r[issue::ID]) == id).unwrap();
            let (a, b) = (row_of(&expected[9]), row_of(&expected[49]));
            let mut conds = vec![eq("projectId", json!(p))];
            if let Some(f) = &filter {
                conds.push(f.clone());
            }
            let ast = json!({"table":"issue","where":{"type":"and","conditions":conds},"orderBy":order,"limit":1000,
                "start":{"row":{"createdAt": n(&a[issue::CREATED]), "id": s(&a[issue::ID])}},
                "end":{"row":{"createdAt": n(&b[issue::CREATED]), "id": s(&b[issue::ID])}}});
            assert_eq!(ids(&run(&db, &ast).0), expected[10..50].to_vec());
        }
    }
}
