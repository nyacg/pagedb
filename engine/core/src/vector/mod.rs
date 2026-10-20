//! Vector search: an IVF index kept as ordinary B+trees in the base, so it shares the page
//! tiers, the one-fault-round reads, the pinned region and the overlay with everything else.
//!
//! An index (`"vectors"` in the manifest) has three trees:
//! - `tree`:      cluster u32 BE ‖ encode_key([pk]) → code ‖ encode_row(cols)
//! - `byId`:      encode_key([pk]) → cluster u32 BE (finds an entry to replace or delete)
//! - `centroids`: cluster u32 BE → f32 scale ‖ i8[dims] (pinned, decoded once per engine)
//!
//! Vectors are L2-normalized and truncated to `dims` (Matryoshka models keep most of their
//! quality at 512 of 1024). A vector v in cluster c is stored as its residual r = v − c,
//! quantized per dimension with a global step: r̂[d] = code[d] · steps[d]. Its cosine score for
//! a query q is
//!
//!   q·v ≈ q·c + Σ (q ⊙ steps)[d] · code[d] ≈ q·c + α · Σ q8[d] · code[d]
//!
//! with q·c computed once per probed cluster and the sum as one i8 dot product (SIMD in the
//! object). Codes are 8 bits per dimension (`sq8`, |code| ≤ 127) or 4 (`sq4`, |code| ≤ 7, two
//! per byte: half the pages per query, for some recall). Each entry also carries the columns a result shows (`cols`, starting with the
//! primary key), so a search needs no second round to render.
//!
//! A search scores every centroid, takes the `nprobe` best, finds their leaves through the
//! (pinned) branch pages and asks for all of them at once: one fault round, at most `maxPages`
//! pages. Writes since the base live in the overlay under the same keys: tombstones hide base
//! entries and new entries are scored alongside (read-your-writes).

pub mod kernels;

use crate::codec::{encode_key, encode_row, json_cell, json_str, Cell, RowRef, Value};
use crate::page::{Page, PageId};
use crate::query::{json_to_value, Roots};
use crate::tree::{self, Ctx, Miss, Range};
use crate::catalog::{ColType, IndexValue, Schema, TableId, TreeId};
use kernels::{dot_f32_i8, dot_i8, dot_i8_u4, pack_u4};
use serde_json::Value as J;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::{Arc, OnceLock};

pub const MAX_K: usize = 200;
pub const MAX_NPROBE: usize = 1024;
/// Pages one search may read (they must all fit the object's RAM tier at once).
pub const MAX_PAGES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Sq8,
    Sq4,
}

impl Codec {
    /// The largest code magnitude.
    pub fn levels(self) -> f32 {
        match self {
            Codec::Sq8 => 127.0,
            Codec::Sq4 => 7.0,
        }
    }
}

/// One vector index, from the manifest.
#[derive(Clone, Debug)]
pub struct VecIndex {
    pub name: String,
    pub table: TableId,
    pub dims: usize,
    pub codec: Codec,
    /// Table columns stored in each entry, in order; `cols[0]` is the primary key.
    pub cols: Vec<usize>,
    pub tree: TreeId,
    pub by_id: TreeId,
    pub centroids: TreeId,
    /// Per-dimension residual quantization steps.
    pub steps: Vec<f32>,
    pub nprobe: usize,
    pub max_pages: usize,
    pub model: String,
    pub json: J,
    cache: Arc<OnceLock<Arc<Centroids>>>,
}

impl VecIndex {
    pub fn from_json(schema: &Schema, j: &J) -> Result<VecIndex, String> {
        let name = j.get("name").and_then(J::as_str).ok_or("vector index needs a name")?.to_string();
        let tname = j.get("table").and_then(J::as_str).ok_or_else(|| format!("{name}: needs a table"))?;
        let table = schema.table_named(tname).ok_or_else(|| format!("{name}: unknown table {tname}"))?;
        let dims = j.get("dims").and_then(J::as_u64).ok_or_else(|| format!("{name}: needs dims"))? as usize;
        let tdef = schema.table(table);
        let cols = j
            .get("cols")
            .and_then(J::as_array)
            .ok_or_else(|| format!("{name}: needs cols"))?
            .iter()
            .map(|c| c.as_str().and_then(|c| tdef.col(c)).ok_or_else(|| format!("{name}: unknown column {c}")))
            .collect::<Result<Vec<usize>, String>>()?;
        if cols.first() != Some(&0) {
            return Err(format!("{name}: cols must start with the primary key"));
        }
        let tree_of = |k: &str| j.get(k).and_then(J::as_u64).map(|t| t as TreeId).ok_or_else(|| format!("{name}: needs {k}"));
        let steps: Vec<f32> = j.get("steps").and_then(J::as_array).ok_or_else(|| format!("{name}: needs steps"))?.iter().map(|s| s.as_f64().unwrap_or(0.0) as f32).collect();
        if steps.len() != dims || dims == 0 {
            return Err(format!("{name}: steps must have dims ({dims}) entries"));
        }
        let codec = match j.get("codec").and_then(J::as_str).unwrap_or("sq8") {
            "sq8" => Codec::Sq8,
            "sq4" if dims % 32 == 0 => Codec::Sq4,
            "sq4" => return Err(format!("{name}: sq4 needs dims divisible by 32")),
            c => return Err(format!("{name}: unknown codec {c}")),
        };
        let (tree, by_id, centroids) = (tree_of("tree")?, tree_of("byId")?, tree_of("centroids")?);
        Ok(VecIndex {
            name,
            table,
            dims,
            codec,
            cols,
            tree,
            by_id,
            centroids,
            steps,
            nprobe: j.get("nprobe").and_then(J::as_u64).unwrap_or(32) as usize,
            max_pages: j.get("maxPages").and_then(J::as_u64).unwrap_or(256) as usize,
            model: j.get("model").and_then(J::as_str).unwrap_or("").to_string(),
            json: j.clone(),
            cache: Arc::new(OnceLock::new()),
        })
    }

    /// The centroids, decoded from their (pinned) tree once per engine.
    pub fn centroids(&self, ctx: &Ctx, roots: &Roots) -> Result<Arc<Centroids>, Miss> {
        if let Some(c) = self.cache.get() {
            return Ok(c.clone());
        }
        let root = roots.get(self.centroids);
        let mut c = Centroids { dims: self.dims, ids: Vec::new(), scale: Vec::new(), codes: Vec::new() };
        tree::scan(ctx, &root, &Range { lo: &[], hi: &[] }, false, usize::MAX, &mut |k, v| {
            c.ids.push(u32::from_be_bytes(k[..4].try_into().unwrap()));
            c.scale.push(f32::from_le_bytes(v[..4].try_into().unwrap()));
            c.codes.extend(v[4..4 + self.dims].iter().map(|&b| b as i8));
            true
        })?;
        let c = Arc::new(c);
        let _ = self.cache.set(c.clone());
        Ok(c)
    }

    /// The row an entry carries: `cols` of a full table row.
    pub fn project(&self, row: &[Value]) -> Vec<Value> {
        self.cols.iter().map(|&c| row.get(c).cloned().unwrap_or(Value::Null)).collect()
    }

    pub fn code_len(&self) -> usize {
        match self.codec {
            Codec::Sq8 => self.dims,
            Codec::Sq4 => self.dims / 2,
        }
    }

    /// Code of normalized `v`'s residual against the (dequantized) centroid `c`.
    pub fn encode_code(&self, v: &[f32], c: &[f32]) -> Vec<u8> {
        let l = self.codec.levels();
        let q = v.iter().zip(c).zip(&self.steps).map(|((v, c), s)| ((v - c) / s).round().clamp(-l, l));
        match self.codec {
            Codec::Sq8 => q.map(|x| x as i8 as u8).collect(),
            Codec::Sq4 => pack_u4(&q.map(|x| (x as i8 + 8) as u8).collect::<Vec<u8>>()),
        }
    }

    /// An entry's code and row.
    #[inline]
    pub fn split<'a>(&self, v: &'a [u8]) -> (&'a [u8], RowRef<'a>) {
        let n = self.code_len();
        (&v[..n], RowRef(&v[n..]))
    }
}

/// Every index in a manifest's `"vectors"` (none for bases without vectors).
pub fn from_manifest(schema: &Schema, m: &J) -> Result<Vec<VecIndex>, String> {
    m.get("vectors").and_then(J::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().map(|v| VecIndex::from_json(schema, v)).collect()
}

/// Cluster centroids, i8 with one scale each (the dequantized form is the canonical centroid:
/// residuals are taken against it).
#[derive(Clone, Debug, Default)]
pub struct Centroids {
    pub dims: usize,
    pub ids: Vec<u32>,
    pub scale: Vec<f32>,
    pub codes: Vec<i8>,
}

impl Centroids {
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn code(&self, i: usize) -> &[i8] {
        &self.codes[i * self.dims..(i + 1) * self.dims]
    }

    pub fn decode(&self, i: usize) -> Vec<f32> {
        self.code(i).iter().map(|&c| c as f32 * self.scale[i]).collect()
    }

    /// Build from f32 centroids (quantizing each).
    pub fn from_f32(dims: usize, ids: Vec<u32>, cents: &[f32]) -> Centroids {
        let mut c = Centroids { dims, ids, scale: Vec::new(), codes: Vec::new() };
        for v in cents.chunks(dims) {
            let (code, s) = quantize(v);
            c.scale.push(s);
            c.codes.extend(code);
        }
        c
    }

    /// The tree value for centroid `i`.
    pub fn value(&self, i: usize) -> Vec<u8> {
        let mut v = self.scale[i].to_le_bytes().to_vec();
        v.extend(self.code(i).iter().map(|&b| b as u8));
        v
    }

    /// Index of the centroid nearest (highest dot product) to a normalized vector.
    pub fn nearest(&self, v: &[f32]) -> usize {
        let mut best = (f32::MIN, 0);
        for i in 0..self.len() {
            let s = dot_f32_i8(v, self.code(i)) * self.scale[i];
            if s > best.0 {
                best = (s, i);
            }
        }
        best.1
    }
}

// ------------------------------------------------------------------ codec

pub fn normalize(v: &mut [f32]) -> bool {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !(n > 0.0) || !n.is_finite() {
        return false;
    }
    v.iter_mut().for_each(|x| *x /= n);
    true
}

/// Symmetric i8 quantization with one scale: x ≈ code · scale, |code| ≤ 127.
pub fn quantize(x: &[f32]) -> (Vec<i8>, f32) {
    let m = x.iter().fold(0f32, |m, v| m.max(v.abs()));
    if m == 0.0 {
        return (vec![0; x.len()], 1.0);
    }
    let s = m / 127.0;
    (x.iter().map(|v| (v / s).round().clamp(-127.0, 127.0) as i8).collect(), s)
}

/// Residual code (sq8) of normalized `v` against centroid `c`.
pub fn encode_residual(v: &[f32], c: &[f32], steps: &[f32]) -> Vec<i8> {
    v.iter().zip(c).zip(steps).map(|((v, c), s)| ((v - c) / s).round().clamp(-127.0, 127.0) as i8).collect()
}

pub fn key(cluster: u32, pk: &str) -> Vec<u8> {
    let mut k = cluster.to_be_bytes().to_vec();
    k.extend(encode_key(&[Value::from(pk)], &[false]));
    k
}

pub fn cluster_of(key: &[u8]) -> u32 {
    u32::from_be_bytes(key[..4].try_into().unwrap())
}

pub fn entry_value(code: &[u8], row: &[Value]) -> Vec<u8> {
    let mut v = code.to_vec();
    v.extend(encode_row(row));
    v
}

/// Everything an index needs to file one vector: its cluster, key and entry.
pub fn encode_entry(vi: &VecIndex, cents: &Centroids, v: &[f32], row: &[Value]) -> (u32, Vec<u8>, Vec<u8>) {
    let i = cents.nearest(v);
    let code = vi.encode_code(v, &cents.decode(i));
    let cid = cents.ids[i];
    let pk = row.first().and_then(Value::as_str).unwrap_or_default();
    (cid, key(cid, pk), entry_value(&code, row))
}

// ------------------------------------------------------------------ queries

#[derive(Clone, Debug, PartialEq)]
pub enum VFilter {
    Eq(usize, Value),
    In(usize, Vec<Value>),
    /// Numeric comparison: op is one of < <= > >=.
    Cmp(usize, &'static str, f64),
}

impl VFilter {
    fn matches(&self, row: RowRef) -> bool {
        match self {
            VFilter::Eq(c, v) => row.get(*c).eq_value(v),
            VFilter::In(c, vs) => {
                let cell = row.get(*c);
                vs.iter().any(|v| cell.eq_value(v))
            }
            VFilter::Cmp(c, op, x) => match row.get(*c) {
                Cell::Num(n) => match *op {
                    "<" => n < *x,
                    "<=" => n <= *x,
                    ">" => n > *x,
                    _ => n >= *x,
                },
                _ => false,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct AnnQuery {
    /// Position in `Roots::vectors`.
    pub index: usize,
    pub q: Vec<f32>,
    pub k: usize,
    pub nprobe: usize,
    pub max_pages: usize,
    pub filters: Vec<VFilter>,
}

/// `{"table":"story","ann":{"index":"story_vec","vec":"<base64 f32 LE>"|[…],"k":30,"nprobe":32,
///  "maxPages":256},"where":{…}}`. The vector may be longer than the index's dims (it is
/// truncated, then normalized). Conditions (`=`, `IN`, `<`, `<=`, `>`, `>=`, joined by `and`)
/// apply to the columns the entries carry.
pub fn compile(roots: &Roots, ast: &J) -> Result<AnnQuery, String> {
    let ann = ast.get("ann").ok_or("not a vector query")?;
    let name = ann.get("index").and_then(J::as_str).ok_or("ann needs an index")?;
    let index = roots.vectors.iter().position(|v| v.name == name).ok_or_else(|| format!("unknown vector index {name}"))?;
    let vi = &roots.vectors[index];
    let raw: Vec<f32> = match ann.get("vec") {
        Some(J::String(s)) => {
            let b = b64decode(s).ok_or("vec is not base64")?;
            b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()
        }
        Some(J::Array(a)) => a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect(),
        _ => return Err("ann needs vec".into()),
    };
    if raw.len() < vi.dims {
        return Err(format!("vec has {} dims; {name} needs at least {}", raw.len(), vi.dims));
    }
    let mut q = raw[..vi.dims].to_vec();
    if !normalize(&mut q) {
        return Err("vec is zero".into());
    }
    let int = |k: &str, d: usize, max: usize| ann.get(k).and_then(J::as_u64).map_or(d, |v| v as usize).clamp(1, max);
    let mut filters = Vec::new();
    if let Some(w) = ast.get("where") {
        let mut conds = Vec::new();
        flatten(w, &mut conds)?;
        let tdef = roots.schema.table(vi.table);
        for c in conds {
            let op = c.get("op").and_then(J::as_str).ok_or("condition without op")?;
            let cname = c.get("left").and_then(|l| l.get("name")).and_then(J::as_str).ok_or("left must be a column")?;
            let lit = c.get("right").and_then(|r| r.get("value")).ok_or("right must be a literal")?;
            let pos = vi.cols.iter().position(|&x| tdef.columns[x].name == cname).ok_or_else(|| format!("{name} doesn't carry {cname}"))?;
            filters.push(match op {
                "=" => VFilter::Eq(pos, json_to_value(lit)),
                "IN" => VFilter::In(pos, lit.as_array().ok_or("IN needs an array")?.iter().map(json_to_value).collect()),
                "<" | "<=" | ">" | ">=" => {
                    let op: &'static str = match op {
                        "<" => "<",
                        "<=" => "<=",
                        ">" => ">",
                        _ => ">=",
                    };
                    VFilter::Cmp(pos, op, lit.as_f64().ok_or("comparisons need a number")?)
                }
                other => return Err(format!("unsupported operator {other} in a vector query")),
            });
        }
    }
    Ok(AnnQuery { index, q, k: int("k", 10, MAX_K), nprobe: int("nprobe", vi.nprobe, MAX_NPROBE), max_pages: int("maxPages", vi.max_pages, MAX_PAGES), filters })
}

fn flatten<'a>(w: &'a J, out: &mut Vec<&'a J>) -> Result<(), String> {
    match w.get("type").and_then(J::as_str) {
        Some("and") => {
            for c in w.get("conditions").and_then(J::as_array).ok_or("and without conditions")? {
                flatten(c, out)?;
            }
            Ok(())
        }
        Some("simple") => {
            out.push(w);
            Ok(())
        }
        _ => Err("vector queries take simple conditions joined by and".into()),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnnHit {
    pub key: Vec<u8>,
    pub pk: String,
    pub score: f32,
    pub json: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnnStats {
    pub clusters: usize,
    pub pages: usize,
    pub scanned: usize,
    pub overlay: usize,
}

/// Total order on scores for heaps.
#[derive(Clone, Copy, PartialEq)]
struct Score(f32);
impl Eq for Score {}
impl PartialOrd for Score {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Score {
    fn cmp(&self, o: &Self) -> Ordering {
        self.0.total_cmp(&o.0)
    }
}

/// The query side of the score formula.
pub struct Scorer {
    codec: Codec,
    q8: Vec<i8>,
    /// Σ q8 (sq4 codes are stored offset by 8).
    q8_sum: i32,
    alpha: f32,
    /// q · centroid for the probed clusters.
    qc: HashMap<u32, f32>,
}

impl Scorer {
    pub fn new(vi: &VecIndex, q: &[f32]) -> Scorer {
        let qs: Vec<f32> = q.iter().zip(&vi.steps).map(|(a, b)| a * b).collect();
        let (q8, alpha) = quantize(&qs);
        let q8_sum = q8.iter().map(|&x| x as i32).sum();
        Scorer { codec: vi.codec, q8, q8_sum, alpha, qc: HashMap::new() }
    }

    #[inline]
    pub fn score(&self, qc: f32, code: &[u8]) -> f32 {
        let dot = match self.codec {
            // SAFETY: i8 and u8 have the same layout.
            Codec::Sq8 => dot_i8(&self.q8, unsafe { std::slice::from_raw_parts(code.as_ptr() as *const i8, code.len()) }),
            Codec::Sq4 => dot_i8_u4(&self.q8, code) - 8 * self.q8_sum,
        };
        qc + self.alpha * dot as f32
    }
}

/// Exact q · centroid for centroid `i`.
fn q_dot_centroid(cents: &Centroids, i: usize, q: &[f32]) -> f32 {
    dot_f32_i8(q, cents.code(i)) * cents.scale[i]
}

/// The `nprobe` clusters whose centroids score highest for `q` (indexes into `cents`), best
/// first. Scores use i8 codes for both sides (cheap; only the ranking matters here).
pub fn probe_order(cents: &Centroids, q: &[f32], nprobe: usize) -> Vec<usize> {
    let (q8, qa) = quantize(q);
    let mut s: Vec<(Score, usize)> = (0..cents.len()).map(|i| (Score(dot_i8(&q8, cents.code(i)) as f32 * qa * cents.scale[i]), i)).collect();
    let n = nprobe.min(s.len());
    if n == 0 {
        return Vec::new();
    }
    if n < s.len() {
        s.select_nth_unstable_by(n - 1, |a, b| b.0.cmp(&a.0));
        s.truncate(n);
    }
    s.sort_by(|a, b| b.0.cmp(&a.0));
    s.into_iter().map(|(_, i)| i).collect()
}

/// Run a vector query. One fault round when the centroid and branch pages are resident (they
/// are pinned), with at most `max_pages` leaf pages requested.
pub fn search(ctx: &Ctx, roots: &Roots, aq: &AnnQuery) -> Result<(Vec<AnnHit>, AnnStats), Miss> {
    let vi = &roots.vectors[aq.index];
    let cents = vi.centroids(ctx, roots)?;
    let root = roots.get(vi.tree);
    let mut stats = AnnStats::default();
    let mut scorer = Scorer::new(vi, &aq.q);

    // Clusters, best first, until the page budget is spent (at least one).
    let mut leaves: Vec<PageId> = Vec::new();
    let mut seen: HashSet<PageId> = HashSet::new();
    let mut branch_missed = false;
    for i in probe_order(&cents, &aq.q, aq.nprobe) {
        let cid = cents.ids[i];
        let (lo, hi) = (cid.to_be_bytes(), (cid + 1).to_be_bytes());
        let mut ls = Vec::new();
        if tree::leaves_in(ctx, &root, &Range { lo: &lo, hi: &hi }, &mut ls).is_err() {
            branch_missed = true;
            continue;
        }
        let new: Vec<PageId> = ls.into_iter().filter(|p| !seen.contains(p)).collect();
        if !scorer.qc.is_empty() && leaves.len() + new.len() > aq.max_pages {
            break;
        }
        scorer.qc.insert(cid, q_dot_centroid(&cents, i, &aq.q));
        for p in new {
            seen.insert(p);
            leaves.push(p);
        }
    }
    if branch_missed {
        return Err(Miss);
    }
    let pages = ctx.get_all(&leaves)?;
    stats.clusters = scorer.qc.len();
    stats.pages = pages.len();

    // Overlay: its entries for this index (new vectors, and tombstones hiding base ones).
    let view = ctx.view.filter(|v| !v.is_empty_for(vi.tree));
    let ov = view.map(|v| v.range(vi.tree, &[], &[])).unwrap_or_default();
    let shadow: HashSet<&[u8]> = ov.iter().map(|(k, _)| k.as_slice()).collect();

    // Top candidates (2k: room for rows the overlay has since deleted).
    let keep = aq.k * 2 + 8;
    let mut heap: BinaryHeap<std::cmp::Reverse<(Score, Vec<u8>, Vec<u8>)>> = BinaryHeap::new();
    let offer = |s: f32, k: &[u8], v: &[u8], heap: &mut BinaryHeap<std::cmp::Reverse<(Score, Vec<u8>, Vec<u8>)>>| {
        if heap.len() < keep {
            heap.push(std::cmp::Reverse((Score(s), k.to_vec(), v.to_vec())));
        } else if heap.peek().is_some_and(|m| Score(s) > m.0 .0) {
            heap.pop();
            heap.push(std::cmp::Reverse((Score(s), k.to_vec(), v.to_vec())));
        }
    };
    for p in &pages {
        let page = Page(p);
        let mut cur = (u32::MAX, None::<f32>);
        for i in 0..page.count() {
            let (k, v) = page.entry(i);
            let cid = cluster_of(k);
            if cid != cur.0 {
                cur = (cid, scorer.qc.get(&cid).copied());
            }
            let Some(qc) = cur.1 else { continue };
            stats.scanned += 1;
            let (code, row) = vi.split(v);
            if !aq.filters.iter().all(|f| f.matches(row)) || (!shadow.is_empty() && shadow.contains(k)) {
                continue;
            }
            offer(scorer.score(qc, code), k, v, &mut heap);
        }
    }
    // New vectors in the overlay: scored exactly like base entries (any cluster).
    let pos: HashMap<u32, usize> = if ov.is_empty() { HashMap::new() } else { cents.ids.iter().enumerate().map(|(i, &c)| (c, i)).collect() };
    for (k, e) in &ov {
        let Some(v) = &e.val else { continue };
        let cid = cluster_of(k);
        let qc = match scorer.qc.get(&cid) {
            Some(&qc) => qc,
            None => match pos.get(&cid) {
                Some(&i) => q_dot_centroid(&cents, i, &aq.q),
                None => continue,
            },
        };
        stats.overlay += 1;
        let (code, row) = vi.split(v);
        if aq.filters.iter().all(|f| f.matches(row)) {
            offer(scorer.score(qc, code), k, v, &mut heap);
        }
    }

    // Best first; rows changed since the base render as they are now, deleted ones drop out.
    let mut cands: Vec<(Score, Vec<u8>, Vec<u8>)> = heap.into_iter().map(|r| r.0).collect();
    cands.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let primary = roots.schema.primary_of(vi.table);
    let mut hits = Vec::with_capacity(aq.k);
    for (s, k, v) in cands {
        if hits.len() == aq.k {
            break;
        }
        let (_, row) = vi.split(&v);
        let pk = row.get(0).str().to_string();
        let mut json = String::with_capacity(v.len());
        let current = ctx.view.and_then(|view| view.get(primary.tree, &roots.schema.pk_key(vi.table, &pk)));
        match current {
            Some(e) if e.val.is_none() => continue,
            Some(e) if matches!(primary.value, IndexValue::Row) => {
                let full = RowRef(e.val.as_deref().unwrap()).to_values();
                render(&mut json, roots.schema, vi, RowRef(&encode_row(&vi.project(&full))), s.0)
            }
            _ => render(&mut json, roots.schema, vi, row, s.0),
        }
        hits.push(AnnHit { key: k, pk, score: s.0, json });
    }
    Ok((hits, stats))
}

fn render(out: &mut String, schema: &Schema, vi: &VecIndex, row: RowRef, score: f32) {
    let tdef = schema.table(vi.table);
    out.push('{');
    for (i, (&col, cell)) in vi.cols.iter().zip(row.cells()).enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_str(out, &tdef.columns[col].name);
        out.push(':');
        if tdef.columns[col].ty == ColType::List {
            out.push_str(match cell {
                Cell::Str(s) if s.starts_with('[') => s,
                _ => "[]",
            });
        } else {
            json_cell(out, cell);
        }
    }
    out.push_str(",\"_score\":");
    out.push_str(&format!("{:.4}", score));
    out.push('}');
}

/// The JSON a search answers with: {"rows":[…],"complete":true,"ann":{stats}}.
pub fn output_json(hits: &[AnnHit], stats: &AnnStats) -> String {
    let mut s = String::with_capacity(hits.iter().map(|h| h.json.len() + 1).sum::<usize>() + 96);
    s.push_str("{\"rows\":[");
    for (i, h) in hits.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&h.json);
    }
    s.push_str(&format!(
        "],\"complete\":true,\"ann\":{{\"clusters\":{},\"pages\":{},\"scanned\":{},\"overlay\":{}}}}}",
        stats.clusters, stats.pages, stats.scanned, stats.overlay
    ));
    s
}

// ------------------------------------------------------------------ base64

pub fn b64decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=' && !c.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= val(c)? << (18 - 6 * i);
        }
        let n = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return None,
        };
        out.extend_from_slice(&acc.to_be_bytes()[1..1 + n]);
    }
    Some(out)
}

pub fn b64encode(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}
