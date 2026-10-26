//! Writes + IVM fuzz. Random mutation batches go through the pure plan/compute path with
//! fault injection (and periodic cache drops); after each commit:
//!   1. every live partition's window equals a fresh execution over base ⊕ overlay;
//!   2. a client model fed only the pushed ops (add/remove/edit) equals the fresh results;
//!   3. list/count/offset results equal an oracle that applies the same mutations to plain rows.
//!
//! The fold variant also folds the overlay into a layer every few dozen steps, keeps writing for
//! a few steps while the fold is "uploading", then commits it, checking that every query's
//! result is identical across the commit.

use pagedb_core::build::{self, MemDb};
use pagedb_core::catalog::{comment, issue, tags_json, tracker, STATUSES};
use pagedb_core::codec::Value;
use pagedb_core::gen::{Config, Rng};
use pagedb_core::ivm::{self, DeltaOp, Partition, State};
use pagedb_core::fold;
use pagedb_core::overlay::{Layer, Overlay, View};
use pagedb_core::page::PageId;
use pagedb_core::query::{compile, execute, Output, Plan};
use pagedb_core::tree::{Ctx, Miss, PageSink, PageStore};
use pagedb_core::write::{parse_ops, plan_write, RowChange, WriteError};
use serde_json::{json, Value as J};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

/// Base pages, then every layer page a fold writes (ids keep growing, as in R2). Only resident
/// pages are readable; the rest fault.
struct Cold {
    pages: RefCell<Vec<Rc<[u8]>>>,
    resident: RefCell<HashSet<PageId>>,
}
impl PageStore for Cold {
    fn get(&self, id: PageId) -> Option<Rc<[u8]>> {
        if !self.resident.borrow().contains(&id) {
            return None;
        }
        self.pages.borrow().get(id as usize).cloned()
    }
}
struct Sink<'a>(&'a Cold);
impl PageSink for Sink<'_> {
    fn write(&mut self, page: Vec<u8>) -> PageId {
        let mut p = self.0.pages.borrow_mut();
        p.push(page.into());
        (p.len() - 1) as PageId
    }
}

#[allow(dead_code)]
fn _uses(_: &MemDb) {}

fn eq(c: &str, v: J) -> J {
    json!({"type":"simple","op":"=","left":{"type":"column","name":c},"right":{"type":"literal","value":v}})
}
fn cond(op: &str, c: &str, v: J) -> J {
    json!({"type":"simple","op":op,"left":{"type":"column","name":c},"right":{"type":"literal","value":v}})
}
fn and(cs: Vec<J>) -> J {
    json!({"type":"and","conditions":cs})
}

fn has_comment(needle: &str) -> J {
    json!({"type":"correlatedSubquery","op":"EXISTS","related":{"correlation":{"parentField":["id"],"childField":["issueId"]},
        "subquery":{"table":"comment","where":cond("ILIKE","body",json!(format!("%{needle}%")))}}})
}

fn queries() -> Vec<J> {
    let order = json!([["createdAt","desc"],["id","asc"]]);
    let owner = json!({"alias":"owner","correlation":{"parentField":["ownerId"],"childField":["id"]},"subquery":{"table":"user"}});
    let cc = json!({"alias":"commentCount","correlation":{"parentField":["id"],"childField":["issueId"]},"subquery":{"table":"comment","aggregate":"count"}});
    let mut q = vec![
        json!({"table":"issue","where":eq("projectId", json!("p0000")),"orderBy":order,"limit":20,"related":[owner, cc]}),
        json!({"table":"issue","where":eq("projectId", json!("p0001")),"orderBy":order,"limit":20}),
        json!({"table":"issue","where":and(vec![eq("projectId", json!("p0000")), eq("status", json!("todo"))]),"orderBy":order,"limit":10}),
        json!({"table":"issue","where":and(vec![eq("projectId", json!("p0000")), cond("HAS","tags",json!("bug"))]),"orderBy":order,"limit":15}),
        json!({"table":"issue","where":and(vec![eq("projectId", json!("p0001")), cond("IN","priority",json!(["urgent","high"]))]),"orderBy":order,"limit":12}),
        json!({"table":"issue","where":and(vec![eq("projectId", json!("p0000")), cond("ILIKE","title",json!("%cache%"))]),"orderBy":order,"limit":8}),
        json!({"table":"issue","where":eq("projectId", json!("p0000")),"aggregate":"count"}),
        json!({"table":"issue","where":and(vec![eq("projectId", json!("p0001")), eq("status", json!("done"))]),"aggregate":"count"}),
        json!({"table":"comment","orderBy":order,"limit":10}),
        // Comment search: issues enter when a matching comment is added and leave when it's deleted.
        json!({"table":"issue","where":and(vec![eq("projectId", json!("p0000")), has_comment("blocked")]),"orderBy":order,"limit":10}),
        json!({"table":"issue","where":and(vec![eq("projectId", json!("p0001")), cond("IN","priority",json!(["urgent","high"])), has_comment("cache")]),"orderBy":order,"limit":6}),
    ];
    for id in ["i000000399", "i000000398", "i000100005"] {
        q.push(json!({"table":"issue","where":eq("id", json!(id)),"one":true,"related":[cc.clone(),
            {"alias":"comments","correlation":{"parentField":["id"],"childField":["issueId"]},"subquery":{"table":"comment","orderBy":[["createdAt","asc"],["id","asc"]],"limit":100}}]}));
    }
    q
}

/// Oracle: plain rows, same mutation semantics.
struct Model {
    issues: BTreeMap<String, Vec<Value>>,
    comments: BTreeMap<String, Vec<Value>>,
}

impl Model {
    fn apply(&mut self, ops: &J) {
        for o in ops["ops"].as_array().unwrap() {
            let table = o["table"].as_str().unwrap();
            match (o["op"].as_str().unwrap(), table) {
                ("insert", "issue") => {
                    let r = &o["row"];
                    let row = vec![
                        Value::from(r["id"].as_str().unwrap()),
                        Value::from(r["projectId"].as_str().unwrap()),
                        Value::from(r["title"].as_str().unwrap()),
                        Value::from(r["status"].as_str().unwrap()),
                        Value::from(r["priority"].as_str().unwrap()),
                        Value::from(r["ownerId"].as_str().unwrap()),
                        Value::Num(r["createdAt"].as_f64().unwrap()),
                        Value::Num(r["updatedAt"].as_f64().unwrap()),
                        Value::Num(0.0),
                        Value::from(tags_json(&sorted_tags(&r["tags"]))),
                    ];
                    self.issues.insert(r["id"].as_str().unwrap().to_string(), row);
                }
                ("update", "issue") => {
                    let id = o["id"].as_str().unwrap();
                    if let Some(row) = self.issues.get_mut(id) {
                        let mut title = None;
                        for (k, v) in o["set"].as_object().unwrap() {
                            let c = tracker().table(pagedb_core::catalog::t::ISSUE).col(k).unwrap();
                            row[c] = if c == issue::TAGS { Value::from(tags_json(&sorted_tags(v))) } else { pagedb_core::query::json_to_value(v) };
                            if c == issue::TITLE {
                                title = Some(row[c].clone());
                            }
                        }
                        if let Some(t) = title {
                            for c in self.comments.values_mut().filter(|c| c[comment::ISSUE].as_str() == Some(id)) {
                                c[comment::ISSUE_TITLE] = t.clone();
                            }
                        }
                    }
                }
                ("delete", "issue") => {
                    let id = o["id"].as_str().unwrap();
                    self.issues.remove(id);
                    self.comments.retain(|_, c| c[comment::ISSUE].as_str() != Some(id));
                }
                ("insert", "comment") => {
                    let r = &o["row"];
                    let iid = r["issueId"].as_str().unwrap();
                    let Some(is) = self.issues.get_mut(iid) else { continue };
                    let t = r["createdAt"].as_f64().unwrap();
                    is[issue::COMMENTS] = Value::Num(is[issue::COMMENTS].as_num().unwrap() + 1.0);
                    if t > is[issue::UPDATED].as_num().unwrap() {
                        is[issue::UPDATED] = Value::Num(t);
                    }
                    let row = vec![
                        Value::from(r["id"].as_str().unwrap()),
                        Value::from(iid),
                        Value::from(r["authorId"].as_str().unwrap()),
                        Value::from(r["body"].as_str().unwrap()),
                        Value::Num(t),
                        is[issue::PROJECT].clone(),
                        is[issue::TITLE].clone(),
                    ];
                    self.comments.insert(r["id"].as_str().unwrap().to_string(), row);
                }
                ("delete", "comment") => {
                    let id = o["id"].as_str().unwrap();
                    if let Some(c) = self.comments.remove(id) {
                        if let Some(is) = self.issues.get_mut(c[comment::ISSUE].as_str().unwrap()) {
                            is[issue::COMMENTS] = Value::Num((is[issue::COMMENTS].as_num().unwrap() - 1.0).max(0.0));
                        }
                    }
                }
                other => panic!("{other:?}"),
            }
        }
    }

    fn list(&self, project: &str, keep: impl Fn(&Vec<Value>) -> bool, limit: usize) -> Vec<String> {
        let mut v: Vec<&Vec<Value>> = self.issues.values().filter(|r| r[issue::PROJECT].as_str() == Some(project) && keep(r)).collect();
        v.sort_by(|a, b| b[issue::CREATED].as_num().partial_cmp(&a[issue::CREATED].as_num()).unwrap().then(a[0].as_str().cmp(&b[0].as_str())));
        v.into_iter().take(limit).map(|r| r[0].as_str().unwrap().to_string()).collect()
    }
}

fn sorted_tags(v: &J) -> Vec<String> {
    let mut t: Vec<String> = v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    t.sort();
    t.dedup();
    t
}

fn random_ops(r: &mut Rng, model: &Model, step: usize, clock: &mut f64) -> J {
    let mut ops = Vec::new();
    let n = 1 + r.below(3) as usize;
    let issue_ids: Vec<&String> = model.issues.keys().collect();
    let comment_ids: Vec<&String> = model.comments.keys().collect();
    for j in 0..n {
        *clock += 1000.0;
        let pick_issue = |r: &mut Rng| {
            // Bias towards p0000/p0001 newest issues so live windows see lots of churn.
            if r.below(3) > 0 {
                let p = r.below(2);
                format!("i{:04}{:05}", p, 399 - r.below(30))
            } else {
                issue_ids[r.below(issue_ids.len() as u64) as usize].clone()
            }
        };
        let tags = ["bug", "api", "ux", "perf"];
    const PRI: [&str; 4] = ["urgent", "high", "medium", "low"];
    const ST: [&str; 5] = STATUSES;
        ops.push(match r.below(9) {
            0 | 1 => json!({"op":"insert","table":"issue","row":{
                "id": format!("n{step:05}{j}"), "projectId": format!("p{:04}", r.below(3)), "title": if r.below(2)==0 {"Cache tier fix"} else {"Board polish"},
                "status": ST[r.below(5) as usize], "priority": PRI[r.below(4) as usize], "ownerId": format!("u{:05}", r.below(50)),
                "createdAt": if r.below(3)==0 { *clock - 9e10 } else { *clock }, "updatedAt": *clock,
                "tags": (0..r.below(3)).map(|_| tags[r.below(4) as usize]).collect::<Vec<_>>()}}),
            2 => json!({"op":"update","table":"issue","id": pick_issue(r),"set":{"status": ST[r.below(5) as usize]}}),
            3 => json!({"op":"update","table":"issue","id": pick_issue(r),"set":{"priority": PRI[r.below(4) as usize], "title": if r.below(2)==0 {"Cache warming"} else {"Something else"}}}),
            4 => json!({"op":"update","table":"issue","id": pick_issue(r),"set":{"tags": (0..r.below(3)).map(|_| tags[r.below(4) as usize]).collect::<Vec<_>>()}}),
            5 | 6 => json!({"op":"insert","table":"comment","row":{"id": format!("k{step:05}{j}"),"issueId": pick_issue(r),"authorId": format!("u{:05}", r.below(50)),"body": if r.below(3)==0 {"blocked on the cache"} else {"looks good"},"createdAt": *clock}}),
            7 => json!({"op":"delete","table":"comment","id": if comment_ids.is_empty() { "none".to_string() } else { comment_ids[r.below(comment_ids.len() as u64) as usize].clone() }}),
            _ => json!({"op":"delete","table":"issue","id": pick_issue(r)}),
        });
    }
    json!({"ops": ops})
}

#[test]
fn writes_and_live_queries_stay_consistent() {
    run(99, 0);
}

#[test]
fn folds_keep_every_query_identical() {
    for (seed, every) in [(99, 40), (7, 23), (1234, 9)] {
        run(seed, every);
    }
}

/// `fold_every` = 0: no folds.
fn run(seed: u64, fold_every: usize) {
    let mut cfg = Config::with_projects(3);
    cfg.issues_per_project = 400;
    cfg.users = 50;
    cfg.comments_per_issue = 3.0;
    cfg.feed_base = 100_000;
    let (db, rows) = build::build(&cfg);
    let store = Cold { pages: RefCell::new(db.pages.clone()), resident: RefCell::new(HashSet::new()) };
    let mut model = Model {
        issues: rows.issues.iter().map(|r| (r[0].as_str().unwrap().to_string(), r.clone())).collect(),
        comments: rows.comments.iter().map(|r| (r[0].as_str().unwrap().to_string(), r.clone())).collect(),
    };
    let mut overlay = Overlay::default();
    // Infinite-scroll pages over p0000: (10th, 30th] bounded, and an open "next 15" after the 30th.
    let mut asts = queries();
    // A lookup through the comment table's pointer primary, on a comment whose issue gets edits.
    let watched = model.comments.values().find(|c| c[comment::ISSUE].as_str() == Some("i000000399")).map(|c| c[comment::ID].as_str().unwrap().to_string()).unwrap();
    asts.push(json!({"table":"comment","where":eq("id", json!(watched)),"one":true}));
    {
        let newest = model.list("p0000", |_| true, 40);
        let key = |id: &str| { let r = &model.issues[id]; json!({"createdAt": r[issue::CREATED].as_num().unwrap(), "id": id}) };
        let order = json!([["createdAt","desc"],["id","asc"]]);
        asts.push(json!({"table":"issue","where":eq("projectId", json!("p0000")),"orderBy":order,"limit":1000,
            "start":{"row":key(&newest[9])},"end":{"row":key(&newest[29])}}));
        asts.push(json!({"table":"issue","where":eq("projectId", json!("p0000")),"orderBy":order,"limit":15,"start":{"row":key(&newest[29])}}));
    }
    // Hydrate partitions (and a client model per partition).
    let plans: Vec<Rc<Plan>> = asts.iter().map(|q| Rc::new(compile(tracker(), q).unwrap())).collect();
    let mut parts: Vec<Partition> = Vec::new();
    let mut clients: Vec<BTreeMap<String, String>> = Vec::new();
    let mut client_counts: Vec<u64> = Vec::new();
    for p in &plans {
        let (part, out) = loop {
            let view = View::new(&overlay);
            let ctx = Ctx::with_view(&store, &view);
            match ivm::hydrate(&ctx, &db.roots, p.clone()) {
                Ok(v) => break v,
                Err(Miss) => store.resident.borrow_mut().extend(ctx.take_want()),
            }
        };
        match out {
            Output::Rows { hits, .. } => {
                clients.push(hits.into_iter().map(|h| (h.pk, h.json)).collect());
                client_counts.push(0);
            }
            Output::Count(n) => {
                clients.push(BTreeMap::new());
                client_counts.push(n);
            }
        }
        parts.push(part);
    }
    let mut r = Rng::new(&[seed]);
    let mut fr = Rng::new(&[seed, 1]);
    let mut clock = pagedb_core::gen::NOW;
    let (mut faults, mut rejected, mut ops_total, mut folds) = (0, 0, 0, 0);
    // A fold read the overlay and its layer is "uploading": (layer, commit at step).
    let mut pending: Option<(Rc<Layer>, usize)> = None;
    let order = json!([["createdAt","desc"],["id","asc"]]);
    let everything = |store: &Cold, overlay: &Overlay| -> Vec<Output> {
        store.resident.borrow_mut().extend(0..store.pages.borrow().len() as PageId);
        let view = View::new(overlay);
        let ctx = Ctx::with_view(store, &view);
        let mut out: Vec<Output> = plans.iter().map(|p| execute(&ctx, &db.roots, p).unwrap()).collect();
        for n in [0u64, 7, 33, 150, 390] {
            let p = compile(tracker(), &json!({"table":"issue","where":eq("projectId", json!("p0000")),"orderBy":order,"limit":5,"offset":n})).unwrap();
            out.push(execute(&ctx, &db.roots, &p).unwrap());
        }
        out
    };
    for step in 0..400 {
        if step % 37 == 0 {
            store.resident.borrow_mut().clear(); // cache dropped: everything faults again
        }
        if fold_every > 0 {
            if let Some((layer, at)) = pending.clone() {
                if step >= at {
                    let before = everything(&store, &overlay);
                    store.resident.borrow_mut().clear();
                    let map = loop {
                        let view = View::new(&overlay);
                        let ctx = Ctx::with_view(&store, &view);
                        match fold::rebase(&ctx, &overlay, &layer) {
                            Ok(m) => break m,
                            Err(Miss) => store.resident.borrow_mut().extend(ctx.take_want()),
                        }
                    };
                    let dirty = overlay.dirty.as_ref().unwrap().len();
                    fold::commit(&mut overlay, map, layer);
                    assert!(overlay.map.len() <= dirty, "step {step}: {} entries left after a fold, {dirty} written during it", overlay.map.len());
                    store.resident.borrow_mut().clear();
                    assert_eq!(everything(&store, &overlay), before, "step {step}: a fold changed query results");
                    pending = None;
                    folds += 1;
                }
            }
            if pending.is_none() && step % fold_every == fold_every / 2 {
                let layer = loop {
                    let view = View::new(&overlay);
                    let ctx = Ctx::with_view(&store, &view);
                    let built = fold::touch(&ctx, &overlay).and_then(|_| fold::build(&ctx, &db.roots, &overlay, &mut Sink(&store)));
                    match built {
                        Ok(l) => break l,
                        Err(Miss) => store.resident.borrow_mut().extend(ctx.take_want()),
                    }
                };
                overlay.dirty = Some(BTreeSet::new());
                pending = Some((Rc::new(layer), step + fr.below(4) as usize));
            }
        }
        let ops_json = random_ops(&mut r, &model, step, &mut clock);
        let ops = parse_ops(tracker(), &ops_json).unwrap();
        ops_total += ops.len();
        // Pure: plan + every partition's compute. Retry on Miss; commit only a clean pass.
        let committed = loop {
            let view = View::new(&overlay);
            let ctx = Ctx::with_view(&store, &view);
            let changes: Vec<RowChange> = match plan_write(&ctx, &db.roots, &view, &ops) {
                Ok(c) => c,
                Err(WriteError::Miss) => {
                    faults += 1;
                    store.resident.borrow_mut().extend(ctx.take_want());
                    continue;
                }
                Err(WriteError::Invalid(_)) => break None,
            };
            let mut results = Vec::new();
            let mut missed = false;
            for part in &parts {
                match ivm::compute(&ctx, &db.roots, part, &changes) {
                    Ok(x) => results.push(x),
                    Err(Miss) => missed = true,
                }
            }
            if missed {
                faults += 1;
                store.resident.borrow_mut().extend(ctx.take_want());
                continue;
            }
            break Some((view.into_writes(), results));
        };
        let Some((writes, results)) = committed else {
            rejected += 1;
            continue;
        };
        overlay.apply(&writes);
        model.apply(&ops_json);
        for (i, (state, ops)) in results.into_iter().enumerate() {
            parts[i].state = state;
            for op in ops {
                match op {
                    DeltaOp::Add { pk, json } | DeltaOp::Edit { pk, json } => {
                        clients[i].insert(pk, json);
                    }
                    DeltaOp::Remove { pk } => {
                        clients[i].remove(&pk);
                    }
                    DeltaOp::Count(n) => client_counts[i] = n,
                }
            }
        }
        // 1 + 2: windows and clients against fresh execution.
        let view = View::new(&overlay);
        store.resident.borrow_mut().extend(0..store.pages.borrow().len() as PageId);
        let ctx = Ctx::with_view(&store, &view);
        for (i, part) in parts.iter().enumerate() {
            assert!(ivm::window_matches_fresh(&ctx, &db.roots, &part.plan, &part.state).unwrap(), "step {step}: partition {i} window drifted\n{}", asts[i]);
            match execute(&ctx, &db.roots, &part.plan).unwrap() {
                Output::Rows { hits, .. } => {
                    let fresh: BTreeMap<String, String> = hits.into_iter().map(|h| (h.pk, h.json)).collect();
                    assert_eq!(clients[i], fresh, "step {step}: client of partition {i} drifted\n{}", asts[i]);
                }
                Output::Count(n) => assert_eq!(client_counts[i], n, "step {step}: count {i}"),
            }
            if let State::Count(n) = part.state {
                assert_eq!(client_counts[i], n);
            }
        }
        // 3: oracle.
        let ids = |o: Output| match o {
            Output::Rows { hits, .. } => hits.into_iter().map(|h| h.pk).collect::<Vec<_>>(),
            _ => panic!(),
        };
        assert_eq!(ids(execute(&ctx, &db.roots, &plans[0]).unwrap()), model.list("p0000", |_| true, 20), "step {step}: list vs oracle");
        assert_eq!(
            ids(execute(&ctx, &db.roots, &plans[3]).unwrap()),
            model.list("p0000", |r| r[issue::TAGS].as_str().unwrap().contains("\"bug\""), 15),
            "step {step}: tag list vs oracle"
        );
        assert_eq!(
            execute(&ctx, &db.roots, &plans[6]).unwrap(),
            Output::Count(model.issues.values().filter(|r| r[issue::PROJECT].as_str() == Some("p0000")).count() as u64),
            "step {step}: count vs oracle"
        );
        let newest = model.list("p0000", |_| true, 400);
        for n in [0usize, 7, 33, 150, 390] {
            let p = compile(tracker(), &json!({"table":"issue","where":eq("projectId", json!("p0000")),"orderBy":order,"limit":5,"offset":n})).unwrap();
            let want: Vec<String> = newest.iter().skip(n).take(5).cloned().collect();
            assert_eq!(ids(execute(&ctx, &db.roots, &p).unwrap()), want, "step {step}: offset {n} vs oracle");
        }
        store.resident.borrow_mut().clear();
    }
    eprintln!(
        "seed {seed}: {ops_total} ops, {faults} fault retries, {rejected} rejected batches, {folds} folds, overlay {} entries / {} bytes, layer pages {}",
        overlay.map.len(),
        overlay.bytes,
        store.pages.borrow().len() - db.pages.len()
    );
    if fold_every > 0 {
        assert!(folds >= 400 / fold_every - 1, "only {folds} folds");
    }
    let _ = HashMap::<u8, u8>::new();
}
