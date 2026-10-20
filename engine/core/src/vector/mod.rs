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
pub mod live;
pub mod probe;

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
    /// Residuals are rotated (kernels::rotate) before quantization; queries likewise.
    pub rotate: bool,
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
    /// A probe tier (1-bit codes scanned first; `tree` then holds the rerank entries).
    pub probe: Option<Probe>,
    pub json: J,
    cache: Arc<OnceLock<Arc<Centroids>>>,
}

/// The probe tier of a two-stage index: `tree` (same keys as the index's tree) holds 1-bit codes
/// and the `cols` filters need; the best `rerank` candidates are scored again with the finer
/// codes in the index's tree, which also carries the rows results show.
#[derive(Clone, Debug)]
pub struct Probe {
    pub tree: TreeId,
    /// Table columns stored in each probe entry, in order.
    pub cols: Vec<usize>,
    pub rerank: usize,
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
        if j.get("rotate").and_then(J::as_bool) == Some(true) && !dims.is_power_of_two() {
            return Err(format!("{name}: rotate needs dims that are a power of two"));
        }
        let codec = match j.get("codec").and_then(J::as_str).unwrap_or("sq8") {
            "sq8" => Codec::Sq8,
            "sq4" if dims % 32 == 0 => Codec::Sq4,
            "sq4" => return Err(format!("{name}: sq4 needs dims divisible by 32")),
            c => return Err(format!("{name}: unknown codec {c}")),
        };
        let (tree, by_id, centroids) = (tree_of("tree")?, tree_of("byId")?, tree_of("centroids")?);
        let probe = match j.get("probe") {
            None | Some(J::Null) => None,
            Some(p) => {
                if !dims.is_power_of_two() || dims % 8 != 0 {
                    return Err(format!("{name}: a probe tier needs dims that are a power of two"));
                }
                let cols = p
                    .get("cols")
                    .and_then(J::as_array)
                    .map(|a| a.iter().map(|c| c.as_str().and_then(|c| tdef.col(c)).ok_or_else(|| format!("{name}: unknown probe column {c}"))).collect::<Result<Vec<usize>, String>>())
                    .transpose()?
                    .unwrap_or_default();
                Some(Probe {
                    tree: p.get("tree").and_then(J::as_u64).map(|t| t as TreeId).ok_or_else(|| format!("{name}: probe needs a tree"))?,
                    cols,
                    rerank: p.get("rerank").and_then(J::as_u64).unwrap_or(100) as usize,
                })
            }
        };
        Ok(VecIndex {
            name,
            table,
            dims,
            codec,
            rotate: j.get("rotate").and_then(J::as_bool).unwrap_or(false),
            cols,
            tree,
            by_id,
            centroids,
            steps,
            nprobe: j.get("nprobe").and_then(J::as_u64).unwrap_or(32) as usize,
            max_pages: j.get("maxPages").and_then(J::as_u64).unwrap_or(256) as usize,
            model: j.get("model").and_then(J::as_str).unwrap_or("").to_string(),
            probe,
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
        let r = self.residual(v, c);
        let q = r.iter().zip(&self.steps).map(|(r, s)| (r / s).round().clamp(-l, l));
        match self.codec {
            Codec::Sq8 => q.map(|x| x as i8 as u8).collect(),
            Codec::Sq4 => pack_u4(&q.map(|x| (x as i8 + 8) as u8).collect::<Vec<u8>>()),
        }
    }

    /// The probe entry's row, from an entry row (the index's `cols`).
    pub fn probe_row(&self, p: &Probe, row: &[Value]) -> Vec<Value> {
        p.cols.iter().map(|c| self.cols.iter().position(|x| x == c).and_then(|i| row.get(i).cloned()).unwrap_or(Value::Null)).collect()
    }

    /// v − c, rotated if the index rotates.
    pub fn residual(&self, v: &[f32], c: &[f32]) -> Vec<f32> {
        let mut r: Vec<f32> = v.iter().zip(c).map(|(v, c)| v - c).collect();
        if self.rotate {
            kernels::rotate(&mut r);
        }
        r
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
    let (cid, k, val, _) = encode_entries(vi, cents, v, row);
    (cid, k, val)
}

/// As `encode_entry`, plus the probe-tier entry (same key) when the index has one. `row` is the
/// entry row (the index's `cols`).
pub fn encode_entries(vi: &VecIndex, cents: &Centroids, v: &[f32], row: &[Value]) -> (u32, Vec<u8>, Vec<u8>, Option<Vec<u8>>) {
    let i = cents.nearest(v);
    let c = cents.decode(i);
    let code = vi.encode_code(v, &c);
    let cid = cents.ids[i];
    let pk = row.first().and_then(Value::as_str).unwrap_or_default();
    let probe = vi.probe.as_ref().map(|p| probe::encode(v, &c, &vi.probe_row(p, row)));
    (cid, key(cid, pk), entry_value(&code, row), probe)
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
    fn col(&self) -> usize {
        match self {
            VFilter::Eq(c, _) | VFilter::In(c, _) | VFilter::Cmp(c, _, _) => *c,
        }
    }

    fn with_col(&self, c: usize) -> VFilter {
        match self {
            VFilter::Eq(_, v) => VFilter::Eq(c, v.clone()),
            VFilter::In(_, v) => VFilter::In(c, v.clone()),
            VFilter::Cmp(_, op, x) => VFilter::Cmp(c, op, *x),
        }
    }

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
    /// Candidates reranked (two-stage indexes).
    pub rerank: usize,
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
    let rerank = int("rerank", vi.probe.as_ref().map_or(100, |p| p.rerank), 1000);
    Ok(AnnQuery { index, q, k: int("k", 10, MAX_K), nprobe: int("nprobe", vi.nprobe, MAX_NPROBE), max_pages: int("maxPages", vi.max_pages, MAX_PAGES), filters, rerank })
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
    /// Leaf pages scanned (the probe tier's, in a two-stage index).
    pub pages: usize,
    pub scanned: usize,
    pub overlay: usize,
    /// Two-stage indexes: candidates reranked, and the pages that took.
    pub reranked: usize,
    pub rerank_pages: usize,
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
}

impl Scorer {
    pub fn new(vi: &VecIndex, q: &[f32]) -> Scorer {
        // q·r = (Rq)·(Rr) for the rotation R, so a rotating index scores the rotated query.
        let mut q = q.to_vec();
        if vi.rotate {
            kernels::rotate(&mut q);
        }
        let qs: Vec<f32> = q.iter().zip(&vi.steps).map(|(a, b)| a * b).collect();
        let (q8, alpha) = quantize(&qs);
        let q8_sum = q8.iter().map(|&x| x as i32).sum();
        Scorer { codec: vi.codec, q8, q8_sum, alpha }
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

type Cand = (Score, Vec<u8>, Vec<u8>);

/// Keeps the `keep` best (score, key, value).
struct Best {
    keep: usize,
    heap: BinaryHeap<std::cmp::Reverse<Cand>>,
}

impl Best {
    fn new(keep: usize) -> Best {
        Best { keep, heap: BinaryHeap::new() }
    }

    #[inline]
    fn offer(&mut self, s: f32, k: &[u8], v: &[u8]) {
        if self.heap.len() < self.keep {
            self.heap.push(std::cmp::Reverse((Score(s), k.to_vec(), v.to_vec())));
        } else if self.heap.peek().is_some_and(|m| Score(s) > m.0 .0) {
            self.heap.pop();
            self.heap.push(std::cmp::Reverse((Score(s), k.to_vec(), v.to_vec())));
        }
    }

    /// Best first.
    fn sorted(self) -> Vec<Cand> {
        let mut c: Vec<Cand> = self.heap.into_iter().map(|r| r.0).collect();
        c.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        c
    }
}

/// Clusters to read, best first, until `max_pages` leaves of `root` (at least one cluster):
/// (cluster ids with their q·centroid, leaf pages). Misses only if a branch page is missing.
fn select_clusters(ctx: &Ctx, root: &crate::tree::TreeRoot, cents: &Centroids, aq: &AnnQuery) -> Result<(HashMap<u32, f32>, Vec<PageId>), Miss> {
    let mut qc = HashMap::new();
    let mut leaves: Vec<PageId> = Vec::new();
    let mut seen: HashSet<PageId> = HashSet::new();
    let mut branch_missed = false;
    for i in probe_order(cents, &aq.q, aq.nprobe) {
        let cid = cents.ids[i];
        let (lo, hi) = (cid.to_be_bytes(), (cid + 1).to_be_bytes());
        let mut ls = Vec::new();
        if tree::leaves_in(ctx, root, &Range { lo: &lo, hi: &hi }, &mut ls).is_err() {
            branch_missed = true;
            continue;
        }
        let new: Vec<PageId> = ls.into_iter().filter(|p| !seen.contains(p)).collect();
        if !qc.is_empty() && leaves.len() + new.len() > aq.max_pages {
            break;
        }
        qc.insert(cid, q_dot_centroid(cents, i, &aq.q));
        for p in new {
            seen.insert(p);
            leaves.push(p);
        }
    }
    if branch_missed {
        return Err(Miss);
    }
    Ok((qc, leaves))
}

/// q·centroid for a cluster: from the probed set, else computed (overlay vectors may sit in any).
fn qc_of(qc: &HashMap<u32, f32>, cents: &Centroids, q: &[f32], cid: u32) -> Option<f32> {
    qc.get(&cid).copied().or_else(|| cents.ids.binary_search(&cid).ok().map(|i| q_dot_centroid(cents, i, q)))
}

/// Run a vector query. One fault round when the centroid and branch pages are resident (they
/// are pinned), with at most `max_pages` leaf pages requested; two for a two-stage index (the
/// probe pages, then the rerank entries of the best candidates).
pub fn search(ctx: &Ctx, roots: &Roots, aq: &AnnQuery) -> Result<(Vec<AnnHit>, AnnStats), Miss> {
    let vi = &roots.vectors[aq.index];
    let cents = vi.centroids(ctx, roots)?;
    let mut stats = AnnStats::default();
    let scorer = Scorer::new(vi, &aq.q);

    // Overlay: its entries for this index (new vectors, and tombstones hiding base ones),
    // borrowed (an object's overlay can hold many vectors; queries shouldn't copy them).
    let mut ov: Vec<(&[u8], &crate::overlay::Entry)> = Vec::new();
    let staged;
    if let Some(v) = ctx.view.filter(|v| !v.is_empty_for(vi.tree)) {
        staged = v.staged.borrow();
        v.visit(vi.tree, &staged, &mut |k, e| ov.push((k, e)));
    }
    let shadow: HashSet<&[u8]> = ov.iter().map(|(k, _)| *k).collect();

    // Top candidates (2k: room for rows the overlay has since deleted).
    let mut best = Best::new(aq.k * 2 + 8);
    let qc = match &vi.probe {
        None => {
            let (qc, leaves) = select_clusters(ctx, &roots.get(vi.tree), &cents, aq)?;
            let pages = ctx.get_all(&leaves)?;
            stats.clusters = qc.len();
            stats.pages = pages.len();
            for p in &pages {
                let page = Page(p);
                let mut cur = (u32::MAX, None::<f32>);
                for i in 0..page.count() {
                    let (k, v) = page.entry(i);
                    let cid = cluster_of(k);
                    if cid != cur.0 {
                        cur = (cid, qc.get(&cid).copied());
                    }
                    let Some(c) = cur.1 else { continue };
                    stats.scanned += 1;
                    let (code, row) = vi.split(v);
                    if !aq.filters.iter().all(|f| f.matches(row)) || (!shadow.is_empty() && shadow.contains(k)) {
                        continue;
                    }
                    best.offer(scorer.score(c, code), k, v);
                }
            }
            qc
        }
        Some(probe) => {
            // Stage 1: 1-bit estimates over the probe tier; filters on the columns it carries.
            let (qc, leaves) = select_clusters(ctx, &roots.get(probe.tree), &cents, aq)?;
            let pages = ctx.get_all(&leaves)?;
            stats.clusters = qc.len();
            stats.pages = pages.len();
            let (early, late): (Vec<VFilter>, Vec<VFilter>) = {
                let (mut e, mut l) = (Vec::new(), Vec::new());
                for f in &aq.filters {
                    match probe.cols.iter().position(|&c| c == vi.cols[f.col()]) {
                        Some(pos) => e.push(f.with_col(pos)),
                        None => l.push(f.clone()),
                    }
                }
                (e, l)
            };
            let ps = probe::ProbeScorer::new(&aq.q);
            let mut cands = Best::new(aq.rerank.max(aq.k));
            for p in &pages {
                let page = Page(p);
                let mut cur = (u32::MAX, None::<f32>);
                for i in 0..page.count() {
                    let (k, v) = page.entry(i);
                    let cid = cluster_of(k);
                    if cid != cur.0 {
                        cur = (cid, qc.get(&cid).copied());
                    }
                    let Some(c) = cur.1 else { continue };
                    stats.scanned += 1;
                    let (w, bits, row) = probe::split(vi.dims, v);
                    if !early.iter().all(|f| f.matches(row)) || (!shadow.is_empty() && shadow.contains(k)) {
                        continue;
                    }
                    cands.offer(c + ps.estimate(w, bits), k, &[]);
                }
            }
            // Stage 2: the candidates' rerank entries (one more round for any not resident).
            let droot = roots.get(vi.tree);
            let cands = cands.sorted();
            let mut want: Vec<PageId> = Vec::new();
            let mut leaf_of: Vec<Option<PageId>> = Vec::with_capacity(cands.len());
            let mut missed = false;
            for (_, k, _) in &cands {
                let mut hi = k.clone();
                hi.push(0);
                let mut ls = Vec::new();
                if tree::leaves_in(ctx, &droot, &Range { lo: k, hi: &hi }, &mut ls).is_err() {
                    missed = true;
                    leaf_of.push(None);
                    continue;
                }
                leaf_of.push(ls.first().copied());
                if let Some(&l) = ls.first() {
                    if !want.contains(&l) {
                        want.push(l);
                    }
                }
            }
            if missed {
                return Err(Miss);
            }
            let got = ctx.get_all(&want)?;
            stats.rerank_pages = got.len();
            let page_of: HashMap<PageId, &std::rc::Rc<[u8]>> = want.iter().copied().zip(got.iter()).collect();
            for ((_, k, _), leaf) in cands.iter().zip(leaf_of) {
                let Some(page) = leaf.and_then(|l| page_of.get(&l)).map(|p| Page(p)) else { continue };
                let at = page.lower_bound(k);
                if at >= page.count() || page.key(at) != k.as_slice() {
                    continue;
                }
                let (_, v) = page.entry(at);
                let (code, row) = vi.split(v);
                if !late.iter().all(|f| f.matches(row)) {
                    continue;
                }
                let Some(c) = qc_of(&qc, &cents, &aq.q, cluster_of(k)) else { continue };
                stats.reranked += 1;
                best.offer(scorer.score(c, code), k, v);
            }
            qc
        }
    };

    // New vectors in the overlay: scored exactly like base entries (any cluster).
    for &(k, e) in &ov {
        let Some(v) = &e.val else { continue };
        let Some(c) = qc_of(&qc, &cents, &aq.q, cluster_of(k)) else { continue };
        stats.overlay += 1;
        let (code, row) = vi.split(v);
        if aq.filters.iter().all(|f| f.matches(row)) {
            best.offer(scorer.score(c, code), k, v);
        }
    }

    // Best first; rows changed since the base render as they are now, deleted ones drop out.
    let primary = roots.schema.primary_of(vi.table);
    let mut hits = Vec::with_capacity(aq.k);
    for (s, k, v) in best.sorted() {
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
        "],\"complete\":true,\"ann\":{{\"clusters\":{},\"pages\":{},\"scanned\":{},\"overlay\":{},\"reranked\":{},\"rerankPages\":{}}}}}",
        stats.clusters, stats.pages, stats.scanned, stats.overlay, stats.reranked, stats.rerank_pages
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
