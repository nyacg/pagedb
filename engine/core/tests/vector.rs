//! Vector search over pages: exact against a brute-force oracle (same quantized scores), recall
//! against exact cosine, one fault round with the pinned pages resident, filters, and the overlay
//! (new vectors found at once, deleted ones gone).

use pagedb_core::codec::{encode_row, Value};
use pagedb_core::overlay::{Entry, Overlay, View};
use pagedb_core::page::PageId;
use pagedb_core::query::Roots;
use pagedb_core::tree::{Ctx, Miss, PageStore, TreeBuilder, VecSink};
use pagedb_core::vector::{self, b64encode, AnnQuery, Centroids, VecIndex};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;

const DIMS: usize = 64;
const KINDS: [&str; 3] = ["story", "ask", "show"];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn gauss(&mut self) -> f32 {
        let (u, v) = (self.unit().max(1e-7), self.unit());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f32::consts::PI * v).cos()
    }
}

/// Clustered unit vectors: `groups` random directions, each point a noisy copy of one.
fn data(n: usize, groups: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut r = Rng(seed);
    let centers: Vec<Vec<f32>> = (0..groups)
        .map(|_| {
            let mut c: Vec<f32> = (0..DIMS).map(|_| r.gauss()).collect();
            vector::normalize(&mut c);
            c
        })
        .collect();
    (0..n)
        .map(|_| {
            let c = &centers[(r.next() % groups as u64) as usize];
            let mut v: Vec<f32> = c.iter().map(|x| x + 0.12 * r.gauss()).collect();
            vector::normalize(&mut v);
            v
        })
        .collect()
}

struct Built {
    pages: Vec<Rc<[u8]>>,
    roots: Roots,
    vecs: Vec<Vec<f32>>,
    rows: Vec<Vec<Value>>,
    cents: Centroids,
    /// Leaf pages of the vector tree (everything else is "pinned").
    leaves: HashSet<PageId>,
}

const SCHEMA: &str = r#"{"name":"t","tables":[{"name":"doc","columns":["id","title",{"name":"time","type":"number"},"kind"]}],
  "indexes":[{"tree":1,"name":"doc_by_id","table":"doc","key":["id"],"primary":true}]}"#;

fn build(n: usize, nlist: usize) -> Built {
    build_with(n, nlist, "sq8")
}

fn build_with(n: usize, nlist: usize, codec: &str) -> Built {
    let levels = if codec == "sq4" { 7.0 } else { 127.0 };
    let vecs = data(n, 40, 7);
    let rows: Vec<Vec<Value>> = (0..n).map(|i| vec![Value::from(format!("d{i}")), Value::from(format!("title {i}")), Value::Num(i as f64), Value::from(KINDS[i % 3])]).collect();
    // Centroids: a few Lloyd iterations from a strided sample.
    let mut cents: Vec<Vec<f32>> = (0..nlist).map(|i| vecs[i * (n / nlist)].clone()).collect();
    for _ in 0..4 {
        let mut sum = vec![vec![0f32; DIMS]; nlist];
        for v in &vecs {
            let best = (0..nlist).max_by(|&a, &b| dot(v, &cents[a]).total_cmp(&dot(v, &cents[b]))).unwrap();
            sum[best].iter_mut().zip(v).for_each(|(s, x)| *s += x);
        }
        for (c, s) in cents.iter_mut().zip(sum) {
            if s.iter().any(|x| *x != 0.0) {
                *c = s;
                vector::normalize(c);
            }
        }
    }
    let ids: Vec<u32> = (0..nlist as u32).map(|i| (i / 10) << 16 | (i % 10)).collect();
    let cq = Centroids::from_f32(DIMS, ids, &cents.concat());
    // Residual steps: the 99.9th percentile of |residual| per dimension.
    let mut res: Vec<Vec<f32>> = vec![Vec::with_capacity(n); DIMS];
    for v in &vecs {
        let c = cq.decode(cq.nearest(v));
        for d in 0..DIMS {
            res[d].push((v[d] - c[d]).abs());
        }
    }
    let steps: Vec<f32> = res
        .iter_mut()
        .map(|r| {
            r.sort_by(f32::total_cmp);
            r[(r.len() as f64 * if codec == "sq4" { 0.99 } else { 0.999 }) as usize].max(1e-6) / levels
        })
        .collect();
    let vj = serde_json::json!({"name":"doc_vec","table":"doc","dims":DIMS,"cols":["id","title","time","kind"],"tree":20,"byId":21,"centroids":22,
        "steps":steps,"nprobe":8,"maxPages":256,"codec":codec});
    let schema = pagedb_core::catalog::Schema::parse(SCHEMA).unwrap();
    let vi = VecIndex::from_json(schema, &vj).unwrap();

    let mut sink = VecSink::default();
    let mut entries = BTreeMap::new();
    let mut by_id = BTreeMap::new();
    for (v, row) in vecs.iter().zip(&rows) {
        let (cid, k, val) = vector::encode_entry(&vi, &cq, v, &vi.project(row));
        by_id.insert(pagedb_core::codec::encode_key(&[row[0].clone()], &[false]), cid.to_be_bytes().to_vec());
        entries.insert(k, val);
    }
    let mut trees = Vec::new();
    let mut tb = TreeBuilder::new(20);
    for (k, v) in &entries {
        tb.push(&mut sink, k, v);
    }
    let leaf_end = {
        let p = tb.finish_leaves(&mut sink);
        let end = sink.pages.len() as PageId;
        trees.push(p.finish_branches(&mut sink));
        end
    };
    let leaves: HashSet<PageId> = (0..leaf_end).collect();
    let mut tb = TreeBuilder::new(21);
    for (k, v) in &by_id {
        tb.push(&mut sink, k, v);
    }
    trees.push(tb.finish(&mut sink));
    let mut tb = TreeBuilder::new(22);
    for i in 0..cq.len() {
        tb.push(&mut sink, &cq.ids[i].to_be_bytes(), &cq.value(i));
    }
    trees.push(tb.finish(&mut sink));
    let mut prim: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
    for row in &rows {
        prim.insert(pagedb_core::codec::encode_key(&[row[0].clone()], &[false]), encode_row(row));
    }
    let mut tb = TreeBuilder::new(1);
    for (k, v) in &prim {
        tb.push(&mut sink, k, v);
    }
    trees.push(tb.finish(&mut sink));
    let manifest = serde_json::json!({
        "schema": serde_json::from_str::<serde_json::Value>(SCHEMA).unwrap(),
        "trees": trees.iter().map(|t| serde_json::json!({"tree":t.tree,"root":t.root,"height":t.height,"rows":t.rows,"leafPages":t.leaves})).collect::<Vec<_>>(),
        "vectors": [vj],
    });
    let roots = Roots::from_manifest(&manifest).unwrap();
    Built { pages: sink.pages, roots, vecs, rows, cents: cq, leaves }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

struct Store<'a> {
    pages: &'a [Rc<[u8]>],
    resident: RefCell<HashSet<PageId>>,
}
impl PageStore for Store<'_> {
    fn get(&self, id: PageId) -> Option<Rc<[u8]>> {
        self.resident.borrow().contains(&id).then(|| self.pages[id as usize].clone())
    }
}

/// Run until no page is missing; returns (result, fault rounds).
fn run<T>(store: &Store, ov: &Overlay, mut f: impl FnMut(&Ctx) -> Result<T, Miss>) -> (T, usize) {
    let mut rounds = 0;
    loop {
        let view = View::new(ov);
        let ctx = Ctx::with_view(store, &view);
        match f(&ctx) {
            Ok(v) => return (v, rounds),
            Err(Miss) => {
                rounds += 1;
                assert!(rounds < 16);
                store.resident.borrow_mut().extend(ctx.take_want());
            }
        }
    }
}

fn query(b: &Built, q: &[f32], k: usize, nprobe: usize, filters: serde_json::Value) -> AnnQuery {
    let bytes: Vec<u8> = q.iter().flat_map(|x| x.to_le_bytes()).collect();
    let mut ast = serde_json::json!({"table":"doc","ann":{"index":"doc_vec","vec":b64encode(&bytes),"k":k,"nprobe":nprobe,"maxPages":512}});
    if !filters.is_null() {
        ast["where"] = filters;
    }
    vector::compile(&b.roots, &ast).unwrap()
}

/// Every entry scored with the search's own formula (the oracle for nprobe = nlist).
fn brute_quantized(b: &Built, q: &[f32], keep: impl Fn(usize) -> bool) -> Vec<(String, f32)> {
    let vi = &b.roots.vectors[0];
    let scorer = vector::Scorer::new(vi, q);
    let mut out = Vec::new();
    for (i, (v, row)) in b.vecs.iter().zip(&b.rows).enumerate() {
        if !keep(i) {
            continue;
        }
        let (_, _, val) = vector::encode_entry(vi, &b.cents, v, &vi.project(row));
        let ci = b.cents.nearest(v);
        let qc = pagedb_core::vector::kernels::dot_f32_i8(q, b.cents.code(ci)) * b.cents.scale[ci];
        let (code, _) = vi.split(&val);
        out.push((row[0].as_str().unwrap().to_string(), scorer.score(qc, code)));
    }
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| vector::key(0, &a.0).cmp(&vector::key(0, &b.0))));
    out
}

#[test]
fn exhaustive_probe_equals_brute_force() {
    let b = build(6000, 60);
    let store = Store { pages: &b.pages, resident: RefCell::new((0..b.pages.len() as PageId).collect()) };
    let ov = Overlay::default();
    for qi in [3usize, 777, 4242] {
        let q = &b.vecs[qi];
        let aq = query(&b, q, 20, 60, serde_json::Value::Null);
        let ((hits, stats), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
        assert_eq!(stats.clusters, 60);
        assert_eq!(stats.scanned, 6000);
        let want = brute_quantized(&b, q, |_| true);
        let got: Vec<&str> = hits.iter().map(|h| h.pk.as_str()).collect();
        let want_ids: Vec<&str> = want.iter().take(20).map(|(p, _)| p.as_str()).collect();
        assert_eq!(got, want_ids);
        for (h, (_, s)) in hits.iter().zip(&want) {
            assert!((h.score - s).abs() < 1e-5);
        }
        // The query point itself is the best match, with a cosine close to 1.
        assert_eq!(hits[0].pk, format!("d{qi}"));
        assert!(hits[0].score > 0.97, "self score {}", hits[0].score);
    }
}

#[test]
fn sq4_exhaustive_probe_equals_brute_force() {
    let b = build_with(6000, 60, "sq4");
    assert_eq!(b.roots.vectors[0].code_len(), DIMS / 2);
    let store = Store { pages: &b.pages, resident: RefCell::new((0..b.pages.len() as PageId).collect()) };
    let ov = Overlay::default();
    let q = &b.vecs[99];
    let aq = query(&b, q, 20, 60, serde_json::Value::Null);
    let ((hits, _), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
    let want: Vec<String> = brute_quantized(&b, q, |_| true).into_iter().take(20).map(|(p, _)| p).collect();
    assert_eq!(hits.iter().map(|h| h.pk.clone()).collect::<Vec<_>>(), want);
    assert_eq!(hits[0].pk, "d99");
    assert!(recall(&b, 12) >= 0.8, "sq4 recall");
}

/// recall@10 against exact cosine, over 50 queries near the data.
fn recall(b: &Built, nprobe: usize) -> f64 {
    let store = Store { pages: &b.pages, resident: RefCell::new((0..b.pages.len() as PageId).collect()) };
    let ov = Overlay::default();
    let mut r = Rng(99);
    let (mut found, mut total) = (0, 0);
    for _ in 0..50 {
        let base = &b.vecs[(r.next() % b.vecs.len() as u64) as usize];
        let mut q: Vec<f32> = base.iter().map(|x| x + 0.05 * r.gauss()).collect();
        vector::normalize(&mut q);
        let aq = query(b, &q, 10, nprobe, serde_json::Value::Null);
        let ((hits, _), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
        let mut exact: Vec<(f32, usize)> = b.vecs.iter().enumerate().map(|(i, v)| (dot(&q, v), i)).collect();
        exact.sort_by(|a, b| b.0.total_cmp(&a.0));
        let want: HashSet<String> = exact.iter().take(10).map(|(_, i)| format!("d{i}")).collect();
        found += hits.iter().filter(|h| want.contains(&h.pk)).count();
        total += 10;
    }
    found as f64 / total as f64
}

#[test]
fn recall_against_exact_cosine() {
    let b = build(20_000, 100);
    let store = Store { pages: &b.pages, resident: RefCell::new((0..b.pages.len() as PageId).collect()) };
    let ov = Overlay::default();
    let mut r = Rng(99);
    let (mut found, mut total) = (0, 0);
    for _ in 0..50 {
        // Queries near the data but not on it.
        let base = &b.vecs[(r.next() % 20_000) as usize];
        let mut q: Vec<f32> = base.iter().map(|x| x + 0.05 * r.gauss()).collect();
        vector::normalize(&mut q);
        let aq = query(&b, &q, 10, 12, serde_json::Value::Null);
        let ((hits, _), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
        let mut exact: Vec<(f32, usize)> = b.vecs.iter().enumerate().map(|(i, v)| (dot(&q, v), i)).collect();
        exact.sort_by(|a, b| b.0.total_cmp(&a.0));
        let want: HashSet<String> = exact.iter().take(10).map(|(_, i)| format!("d{i}")).collect();
        found += hits.iter().filter(|h| want.contains(&h.pk)).count();
        total += 10;
    }
    let recall = found as f64 / total as f64;
    assert!(recall >= 0.9, "recall@10 {recall}");
}

#[test]
fn one_fault_round_with_pinned_pages_resident() {
    let b = build(20_000, 100);
    // Everything but the vector tree's leaves (centroids, branch pages, other trees) resident.
    let pinned: HashSet<PageId> = (0..b.pages.len() as PageId).filter(|p| !b.leaves.contains(p)).collect();
    let ov = Overlay::default();
    for qi in [1usize, 500, 9999, 15000] {
        let store = Store { pages: &b.pages, resident: RefCell::new(pinned.clone()) };
        let aq = query(&b, &b.vecs[qi], 10, 16, serde_json::Value::Null);
        let ((hits, stats), rounds) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
        assert_eq!(rounds, 1, "query {qi}");
        assert!(stats.pages <= 512 && stats.pages > 0);
        assert_eq!(hits[0].pk, format!("d{qi}"));
    }
    // A page budget caps the round (but at least one cluster is always read).
    let store = Store { pages: &b.pages, resident: RefCell::new(pinned.clone()) };
    let mut aq = query(&b, &b.vecs[1], 10, 100, serde_json::Value::Null);
    aq.max_pages = 3;
    let ((_, stats), rounds) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
    assert_eq!(rounds, 1);
    assert!(stats.clusters >= 1 && (stats.pages <= 3 || stats.clusters == 1), "{stats:?}");
}

#[test]
fn filters_apply_to_carried_columns() {
    let b = build(6000, 60);
    let store = Store { pages: &b.pages, resident: RefCell::new((0..b.pages.len() as PageId).collect()) };
    let ov = Overlay::default();
    let q = &b.vecs[10];
    let w = serde_json::json!({"type":"and","conditions":[
        {"type":"simple","op":"=","left":{"type":"column","name":"kind"},"right":{"type":"literal","value":"ask"}},
        {"type":"simple","op":">=","left":{"type":"column","name":"time"},"right":{"type":"literal","value":3000}}]});
    let aq = query(&b, q, 15, 60, w);
    let ((hits, _), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
    let want: Vec<String> = brute_quantized(&b, q, |i| i % 3 == 1 && i >= 3000).into_iter().take(15).map(|(p, _)| p).collect();
    assert_eq!(hits.iter().map(|h| h.pk.clone()).collect::<Vec<_>>(), want);
    assert!(hits.iter().all(|h| h.json.contains("\"kind\":\"ask\"")));
    let bad = serde_json::json!({"type":"simple","op":"ILIKE","left":{"type":"column","name":"title"},"right":{"type":"literal","value":"%x%"}});
    let bytes: Vec<u8> = q.iter().flat_map(|x| x.to_le_bytes()).collect();
    assert!(vector::compile(&b.roots, &serde_json::json!({"table":"doc","ann":{"index":"doc_vec","vec":b64encode(&bytes)},"where":bad})).is_err());
}

#[test]
fn overlay_puts_and_deletes_are_seen_at_once() {
    let b = build(6000, 60);
    let store = Store { pages: &b.pages, resident: RefCell::new((0..b.pages.len() as PageId).collect()) };
    let vi = &b.roots.vectors[0];
    let q = b.vecs[42].clone();
    let aq = query(&b, &q, 5, 8, serde_json::Value::Null);
    let base_top = {
        let ov = Overlay::default();
        let ((hits, _), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
        hits
    };
    assert_eq!(base_top[0].pk, "d42");

    // A new document with (almost) the query's vector, and the old best match deleted: its
    // vector entry tombstoned and its row gone.
    let mut ov = Overlay::default();
    let mut v = q.clone();
    v[0] += 0.001;
    vector::normalize(&mut v);
    let row = vec![Value::from("new1"), Value::from("fresh"), Value::Num(1e9), Value::from("show")];
    let (_, k, val) = vector::encode_entry(vi, &b.cents, &v, &vi.project(&row));
    let pk42 = pagedb_core::codec::encode_key(&[Value::from("d42")], &[false]);
    ov.apply(&[
        ((20, k), Some(Entry { val: Some(val), delta: 1 })),
        ((20, base_top[0].key.clone()), Some(Entry { val: None, delta: -1 })),
        ((1, pk42), Some(Entry { val: None, delta: -1 })),
    ]);
    let ((hits, stats), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
    assert_eq!(hits[0].pk, "new1");
    assert!(hits[0].json.contains("\"title\":\"fresh\""));
    assert!(!hits.iter().any(|h| h.pk == "d42"));
    assert_eq!(stats.overlay, 1);

    // A row updated since the base renders as it is now (the vector is unchanged).
    let mut ov = Overlay::default();
    let row1 = vec![Value::from(base_top[1].pk.as_str()), Value::from("edited title"), Value::Num(5.0), Value::from("story")];
    ov.apply(&[((1, pagedb_core::codec::encode_key(&[row1[0].clone()], &[false])), Some(Entry { val: Some(encode_row(&row1)), delta: 0 }))]);
    let ((hits, _), _) = run(&store, &ov, |ctx| vector::search(ctx, &b.roots, &aq));
    let h = hits.iter().find(|h| h.pk == base_top[1].pk).unwrap();
    assert!(h.json.contains("edited title"), "{}", h.json);
}
