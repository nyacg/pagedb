//! Vector indexes (see pagedb_core::vector for the format and the search).
//!
//!   pagedb-builder vec-synth --n 2000000 [--dims 512] [--groups 3000] --out DIR
//!       a standalone base: synthetic clustered vectors in a `doc` table (benchmarks)
//!   pagedb-builder vec-build --schema schema.json --config vectors.json --shards LIST \
//!       --first-page F --out DIR
//!       a segment for an existing base: PVEC shards (paths or URLs, one per line in LIST)
//!   pagedb-builder vec-merge --base manifest.json --segment DIR/manifest.json --segbase ID [--segdb DB] --out FILE
//!       the base's manifest with the segment's trees and vector indexes attached
//!
//! Clusters come from a sample: k-means for `supers` coarse centroids, then k-means inside each
//! super for its share of the fine clusters (~`clusterSize` vectors each). Fine clusters are
//! numbered super << 16 | position, with positions along a nearest-neighbour chain, so clusters
//! a query probes together tend to sit in neighbouring pages (one ranged GET instead of several).
//! Every vector then goes to its nearest fine centroid, stored as a residual code.

use crate::ingest::{parse_row, Sorter};
use crate::shard;
use crate::sink::{build_tree, Built, PartSink};
use pagedb_core::catalog::{Schema, TableId};
use pagedb_core::codec::{encode_key, Value};
use pagedb_core::page::{PAGES_PER_PART, PAGE_SIZE};
use pagedb_core::vector::{self, kernels::dot_f32, Centroids};
use serde_json::{json, Value as J};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub struct Cfg {
    pub json: J,
    pub name: String,
    pub table: TableId,
    pub dims: usize,
    pub cols: Vec<usize>,
    pub tree: u16,
    pub by_id: u16,
    pub centroids: u16,
    pub cluster_size: usize,
    pub supers: usize,
    pub sample: usize,
    /// Strings carried in entries are cut to this many characters.
    pub truncate: usize,
    pub codec: String,
}

impl Cfg {
    pub fn from_json(schema: &Schema, j: &J) -> Cfg {
        let name = j["name"].as_str().expect("config needs a name").to_string();
        let table = schema.table_named(j["table"].as_str().expect("config needs a table")).expect("unknown table");
        let tdef = schema.table(table);
        let cols = j["cols"].as_array().expect("config needs cols").iter().map(|c| tdef.col(c.as_str().unwrap()).unwrap_or_else(|| panic!("unknown column {c}"))).collect();
        let u = |k: &str, d: u64| j.get(k).and_then(J::as_u64).unwrap_or(d);
        Cfg {
            json: j.clone(),
            name,
            table,
            dims: u("dims", 512) as usize,
            cols,
            tree: u("tree", 20) as u16,
            by_id: u("byId", 21) as u16,
            centroids: u("centroids", 22) as u16,
            cluster_size: u("clusterSize", 800) as usize,
            supers: u("supers", 64) as usize,
            sample: u("sample", 400_000) as usize,
            truncate: u("truncate", 300) as usize,
            codec: j.get("codec").and_then(J::as_str).unwrap_or("sq8").to_string(),
        }
    }

    /// The row an entry carries.
    fn project(&self, row: &[Value]) -> Vec<Value> {
        self.cols
            .iter()
            .map(|&c| match &row[c] {
                Value::Str(s) if s.chars().count() > self.truncate => Value::Str(s.chars().take(self.truncate).collect()),
                v => v.clone(),
            })
            .collect()
    }
}

/// Where vectors come from: every `every`-th item as (vector at any dims ≥ the index's, any
/// norm; full table row), in batches.
pub trait Source: Sync {
    fn pass(&self, every: usize, f: &mut dyn FnMut(Vec<(Vec<f32>, Vec<Value>)>));
}

fn prep(v: &[f32], dims: usize) -> Option<Vec<f32>> {
    let mut x = v[..dims.min(v.len())].to_vec();
    (x.len() == dims && vector::normalize(&mut x)).then_some(x)
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

// ------------------------------------------------------------------ k-means

/// Spherical k-means (dot product, normalized means). Returns (centroids k×d, assignment of
/// each point at the last iteration).
pub fn kmeans(data: &[f32], d: usize, k: usize, iters: usize, seed: u64) -> (Vec<f32>, Vec<u32>) {
    let n = data.len() / d;
    let k = k.min(n).max(1);
    let mut rng = Rng(seed | 1);
    // Init: k points spread through the data.
    let off = (rng.next() % n as u64) as usize;
    let mut cents: Vec<f32> = (0..k).flat_map(|i| data[((off + i * n / k) % n) * d..][..d].to_vec()).collect();
    let mut assign = vec![u32::MAX; n];
    let t = threads();
    let chunk = n.div_ceil(t).max(1);
    for it in 0..iters {
        // Each thread: nearest centroid for its points, and their sums per centroid.
        let parts: Vec<(Vec<f32>, Vec<u32>, usize)> = std::thread::scope(|sc| {
            let hs: Vec<_> = assign
                .chunks_mut(chunk)
                .enumerate()
                .map(|(p, a)| {
                    let cents = &cents;
                    sc.spawn(move || {
                        let mut sums = vec![0f32; k * d];
                        let mut counts = vec![0u32; k];
                        let mut moved = 0;
                        for (j, slot) in a.iter_mut().enumerate() {
                            let v = &data[(p * chunk + j) * d..][..d];
                            let mut best = (f32::MIN, 0usize);
                            for c in 0..k {
                                let s = dot_f32(v, &cents[c * d..(c + 1) * d]);
                                if s > best.0 {
                                    best = (s, c);
                                }
                            }
                            if *slot != best.1 as u32 {
                                moved += 1;
                                *slot = best.1 as u32;
                            }
                            counts[best.1] += 1;
                            sums[best.1 * d..(best.1 + 1) * d].iter_mut().zip(v).for_each(|(s, x)| *s += x);
                        }
                        (sums, counts, moved)
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut sums = vec![0f32; k * d];
        let mut counts = vec![0u32; k];
        let mut moved = 0;
        for (s, c, m) in parts {
            sums.iter_mut().zip(s).for_each(|(a, b)| *a += b);
            counts.iter_mut().zip(c).for_each(|(a, b)| *a += b);
            moved += m;
        }
        for c in 0..k {
            let sl = &mut sums[c * d..(c + 1) * d];
            if counts[c] == 0 || !vector::normalize(sl) {
                // Empty cluster: restart it at a random point.
                let i = (rng.next() % n as u64) as usize;
                sl.copy_from_slice(&data[i * d..(i + 1) * d]);
            }
        }
        cents = sums;
        if it > 2 && (moved as f64) < 0.002 * n as f64 {
            break;
        }
    }
    (cents, assign)
}

// ------------------------------------------------------------------ model

/// Trained clusters: coarse supers, fine centroids (quantized, canonical), and the steps.
pub struct Model {
    pub d: usize,
    pub supers: Vec<f32>,
    pub fine: Centroids,
    /// Dequantized fine centroids (the residual reference), f32.
    pub fine_f32: Vec<f32>,
    /// Fine centroid indexes belonging to each super: [start, end).
    pub ranges: Vec<(usize, usize)>,
    pub steps: Vec<f32>,
}

impl Model {
    pub fn train(sample: &[f32], d: usize, nlist: usize, n_supers: usize) -> Model {
        let n = sample.len() / d;
        let t0 = Instant::now();
        let s = n_supers.min(nlist).max(1);
        let (supers, sa) = kmeans(sample, d, s, 15, 0x5eed);
        eprintln!("   {s} supers over {n} sampled vectors in {:.1}s", t0.elapsed().as_secs_f64());
        let mut fine_all: Vec<f32> = Vec::new();
        let mut ids: Vec<u32> = Vec::new();
        let mut ranges = Vec::with_capacity(s);
        for si in 0..s {
            let members: Vec<usize> = (0..n).filter(|&i| sa[i] as usize == si).collect();
            let start = ids.len();
            if members.is_empty() {
                ranges.push((start, start));
                continue;
            }
            let pts: Vec<f32> = members.iter().flat_map(|&i| sample[i * d..(i + 1) * d].iter().copied()).collect();
            let k = ((members.len() as f64 / n as f64) * nlist as f64).round().max(1.0) as usize;
            let (mut fc, fa) = kmeans(&pts, d, k, 12, 0xf1e + si as u64);
            // Split clusters far bigger than their share (a dense topic, near-duplicate titles):
            // a probe of one would spend a query's page budget on it alone.
            let target = members.len() as f64 / (fc.len() / d) as f64;
            let mut split: Vec<f32> = Vec::new();
            for c in 0..fc.len() / d {
                let own: Vec<usize> = (0..members.len()).filter(|&j| fa[j] as usize == c).collect();
                if (own.len() as f64) > 2.5 * target && own.len() >= 4 {
                    let sub: Vec<f32> = own.iter().flat_map(|&j| pts[j * d..(j + 1) * d].iter().copied()).collect();
                    let parts = (own.len() as f64 / target).ceil() as usize;
                    let (sc, _) = kmeans(&sub, d, parts, 10, 0x5911 + c as u64);
                    split.extend(sc);
                } else {
                    split.extend_from_slice(&fc[c * d..(c + 1) * d]);
                }
            }
            fc = split;
            let k = fc.len() / d;
            // Chain: start nearest the super's centroid, then always the nearest unvisited.
            let sup = &supers[si * d..(si + 1) * d];
            let mut left: Vec<usize> = (0..k).collect();
            let mut cur = *left.iter().max_by(|&&a, &&b| dot_f32(sup, &fc[a * d..][..d]).total_cmp(&dot_f32(sup, &fc[b * d..][..d]))).unwrap();
            let mut order = Vec::with_capacity(k);
            while !left.is_empty() {
                left.retain(|&x| x != cur);
                order.push(cur);
                if let Some(&nx) = left.iter().max_by(|&&a, &&b| dot_f32(&fc[cur * d..][..d], &fc[a * d..][..d]).total_cmp(&dot_f32(&fc[cur * d..][..d], &fc[b * d..][..d]))) {
                    cur = nx;
                }
            }
            for (pos, &c) in order.iter().enumerate() {
                ids.push((si as u32) << 16 | pos as u32);
                fine_all.extend_from_slice(&fc[c * d..(c + 1) * d]);
            }
            ranges.push((start, ids.len()));
        }
        let fine = Centroids::from_f32(d, ids, &fine_all);
        let fine_f32: Vec<f32> = (0..fine.len()).flat_map(|i| fine.decode(i)).collect();
        eprintln!("   {} fine clusters in {:.1}s", fine.len(), t0.elapsed().as_secs_f64());
        let mut m = Model { d, supers, fine, fine_f32, ranges, steps: vec![1.0; d] };
        m.steps = m.steps_at(sample, 0.999, 127.0);
        m
    }

    /// Residual steps: the `pct` percentile of |residual| per dimension (over `sample`), split
    /// into `levels` steps.
    pub fn steps_at(&self, sample: &[f32], pct: f64, levels: f32) -> Vec<f32> {
        let d = self.d;
        let n = sample.len() / d;
        let mut res: Vec<Vec<f32>> = vec![Vec::with_capacity(n); d];
        for i in 0..n {
            let v = &sample[i * d..(i + 1) * d];
            let c = &self.fine_f32[self.assign(v) * d..][..d];
            for j in 0..d {
                res[j].push((v[j] - c[j]).abs());
            }
        }
        res.iter_mut()
            .map(|r| {
                r.sort_unstable_by(f32::total_cmp);
                r[((r.len() as f64 * pct) as usize).min(r.len() - 1)].max(1e-6) / levels
            })
            .collect()
    }

    /// Nearest fine centroid, looking inside the 3 best supers.
    pub fn assign(&self, v: &[f32]) -> usize {
        let d = self.d;
        let s = self.ranges.len();
        let mut top = [(f32::MIN, 0usize); 3];
        for si in 0..s {
            let sc = dot_f32(v, &self.supers[si * d..(si + 1) * d]);
            if sc > top[2].0 {
                top[2] = (sc, si);
                top.sort_by(|a, b| b.0.total_cmp(&a.0));
            }
        }
        let mut best = (f32::MIN, 0usize);
        for &(sc, si) in &top {
            if sc == f32::MIN {
                continue;
            }
            let (a, b) = self.ranges[si];
            for c in a..b {
                let x = dot_f32(v, &self.fine_f32[c * d..(c + 1) * d]);
                if x > best.0 {
                    best = (x, c);
                }
            }
        }
        best.1
    }
}

// ------------------------------------------------------------------ build

/// Build the index trees from `src` into `out`'s parts, page ids from `first_page`.
/// `primary`: also build the table's primary tree from the rows (standalone bases).
pub fn build(cfg: &Cfg, schema: &'static Schema, src: &dyn Source, n_est: usize, first_page: u64, out: &Path, primary: bool, mem_mb: usize) -> J {
    let started = Instant::now();
    let d = cfg.dims;
    let every = (n_est / cfg.sample.max(1)).max(1);
    let mut sample: Vec<f32> = Vec::new();
    src.pass(every, &mut |batch| {
        for (v, _) in batch {
            if let Some(x) = prep(&v, d) {
                sample.extend(x);
            }
        }
    });
    let ns = sample.len() / d;
    let nlist = (n_est / cfg.cluster_size).max(1);
    eprintln!("{}: {ns} sampled (every {every}), {nlist} clusters for ~{n_est} vectors", cfg.name);
    let mut m = Model::train(&sample, d, nlist, cfg.supers);
    if cfg.codec == "sq4" {
        // 4-bit codes: clip at the 99th percentile (fewer levels: spend them on the bulk).
        m.steps = m.steps_at(&sample, 0.99, 7.0);
    }
    drop(sample);
    let mut vj = cfg.json.clone();
    for k in ["clusterSize", "supers", "sample", "truncate"] {
        vj.as_object_mut().unwrap().remove(k);
    }
    vj["steps"] = json!(m.steps);
    vj["nlist"] = json!(m.fine.len());
    let vi = pagedb_core::vector::VecIndex::from_json(schema, &vj).unwrap();

    let tmp = out.join("tmp");
    let mut entries = Sorter::new(&tmp.join("vec"), mem_mb * (1 << 20) / 2);
    let mut by_id = Sorter::new(&tmp.join("byid"), mem_mb * (1 << 20) / 8);
    let mut prim = primary.then(|| Sorter::new(&tmp.join("prim"), mem_mb * (1 << 20) / 4));
    let pidx = schema.primary_of(cfg.table);
    let mut counts = vec![0u32; m.fine.len()];
    let (mut n, mut skipped) = (0u64, 0u64);
    let t1 = Instant::now();
    src.pass(1, &mut |batch| {
        // Assign and encode in parallel; push in order.
        let t = threads();
        let chunk = batch.len().div_ceil(t).max(1);
        let enc: Vec<Option<(usize, Vec<u8>)>> = std::thread::scope(|sc| {
            let hs: Vec<_> = batch
                .chunks(chunk)
                .map(|part| {
                    let m = &m;
                    let vi = &vi;
                    sc.spawn(move || {
                        part.iter()
                            .map(|(v, _)| {
                                let x = prep(v, d)?;
                                let c = m.assign(&x);
                                Some((c, vi.encode_code(&x, &m.fine_f32[c * d..(c + 1) * d])))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        for ((_, row), e) in batch.iter().zip(enc) {
            let Some((c, code)) = e else {
                skipped += 1;
                continue;
            };
            let pk = row[0].as_str().unwrap_or_default();
            let cid = m.fine.ids[c];
            let val = vector::entry_value(&code, &cfg.project(row));
            if val.len() + 32 > pagedb_core::page::MAX_CELL {
                skipped += 1;
                continue;
            }
            entries.push(&vector::key(cid, pk), &val);
            by_id.push(&encode_key(&[Value::from(pk)], &[false]), &cid.to_be_bytes());
            if let Some(p) = prim.as_mut() {
                let ents = pagedb_core::catalog::index_entries(pidx, row);
                for (k, v) in ents {
                    p.push(&k, &v);
                }
            }
            counts[c] += 1;
            n += 1;
            if n % 1_000_000 == 0 {
                eprintln!("   {n} vectors assigned ({:.0}s)", t1.elapsed().as_secs_f64());
            }
        }
    });
    let mut sizes = counts.clone();
    sizes.sort_unstable();
    eprintln!(
        "   {n} vectors ({skipped} skipped) in {:.1}s; cluster sizes min {} median {} p99 {} max {}",
        t1.elapsed().as_secs_f64(),
        sizes[0],
        sizes[sizes.len() / 2],
        sizes[(sizes.len() * 99) / 100],
        sizes[sizes.len() - 1]
    );

    if out.join("parts").exists() {
        fs::remove_dir_all(out.join("parts")).unwrap();
    }
    let mut sink = PartSink::starting_at(out, first_page);
    let mut built: Vec<Built> = Vec::new();
    built.push(build_tree(&mut sink, cfg.tree, &cfg.name, &mut |f| {
        std::mem::replace(&mut entries, Sorter::new(&tmp, 1 << 20)).drain(&mut |k, v| f(k, v));
    }));
    built.push(build_tree(&mut sink, cfg.by_id, &format!("{}_by_id", cfg.name), &mut |f| {
        std::mem::replace(&mut by_id, Sorter::new(&tmp, 1 << 20)).drain(&mut |k, v| f(k, v));
    }));
    if let Some(p) = prim.take() {
        let mut p = Some(p);
        built.push(build_tree(&mut sink, pidx.tree, &pidx.name, &mut |f| {
            p.take().unwrap().drain(&mut |k, v| f(k, v));
        }));
    }
    // Pinned region: the centroids, then every tree's branch pages.
    let pinned_from = sink.next;
    built.push(build_tree(&mut sink, cfg.centroids, &format!("{}_centroids", cfg.name), &mut |f| {
        for i in 0..m.fine.len() {
            f(&m.fine.ids[i].to_be_bytes(), &m.fine.value(i));
        }
    }));
    for b in built.iter_mut() {
        let first = sink.next;
        b.root = b.pending.take().unwrap().finish_branches(&mut sink);
        b.pages += sink.next - first;
    }
    let (pages, crcs) = sink.finish();
    let _ = fs::remove_dir_all(&tmp);
    let trees: Vec<J> = built
        .iter()
        .map(|b| {
            eprintln!("{:>3} {:<28} rows {:>10}  pages {:>7} ({:>7.1} MB)  height {}", b.root.tree, b.name, b.root.rows, b.pages, b.pages as f64 * PAGE_SIZE as f64 / 1e6, b.root.height);
            json!({"tree": b.root.tree, "name": b.name, "root": if b.root.height == 0 { J::Null } else { J::from(b.root.root) }, "height": b.root.height,
                "rows": b.root.rows, "firstPage": b.first_page, "pages": b.pages, "leafPages": b.root.leaves})
        })
        .collect();
    vj["rows"] = json!(n);
    eprintln!("{} pages from {first_page} ({:.2} GB) in {:.1}s", pages - first_page, (pages - first_page) as f64 * PAGE_SIZE as f64 / 1e9, started.elapsed().as_secs_f64());
    // Vector pages are read a cluster (a few pages) at a time: cache and fetch them in 256 KiB
    // chunks, not 1 MiB.
    json!({"version": 1, "pageSize": PAGE_SIZE, "pagesPerPart": PAGES_PER_PART, "firstPage": first_page, "pages": pages, "pinnedFrom": pinned_from,
        "chunkPages": 4, "parts": crcs.len(), "trees": trees, "vectors": [vj], "partCrcs": crcs})
}

// ------------------------------------------------------------------ sources

/// Clustered synthetic vectors: `groups` topics, each with sub-topics; a point is a noisy copy
/// of a sub-topic direction. Deterministic per item, so passes agree.
pub struct Synth {
    pub n: usize,
    pub dims: usize,
    centers: Vec<f32>,
    subs: usize,
}

const KINDS: [&str; 4] = ["story", "ask", "show", "job"];

impl Synth {
    pub fn new(n: usize, dims: usize, groups: usize) -> Synth {
        let subs = 8;
        let mut r = Rng(0xabcdef);
        let topics: Vec<Vec<f32>> = (0..groups).map(|_| unit(&mut r, dims)).collect();
        let mut centers = Vec::with_capacity(groups * subs * dims);
        for t in &topics {
            for _ in 0..subs {
                let s = unit(&mut r, dims);
                let mut c: Vec<f32> = t.iter().zip(&s).map(|(a, b)| a + 0.7 * b).collect();
                vector::normalize(&mut c);
                centers.extend(c);
            }
        }
        Synth { n, dims, centers, subs: groups * subs }
    }

    fn item(&self, i: usize) -> (Vec<f32>, Vec<Value>) {
        let mut r = Rng(0x9e37_79b9_7f4a_7c15 ^ (i as u64).wrapping_mul(0x2545_f491_4f6c_dd1d));
        let g = (r.next() % self.subs as u64) as usize;
        let c = &self.centers[g * self.dims..(g + 1) * self.dims];
        let sigma = (0.6 / self.dims as f32).sqrt();
        let v: Vec<f32> = c.iter().map(|x| x + sigma * r.gauss()).collect();
        let row = vec![Value::from(format!("d{i}")), Value::from(format!("Document {i} about topic {} ({})", g / 8, g % 8)), Value::Num(i as f64), Value::from(KINDS[i % 4])];
        (v, row)
    }
}

impl Source for Synth {
    fn pass(&self, every: usize, f: &mut dyn FnMut(Vec<(Vec<f32>, Vec<Value>)>)) {
        let ids: Vec<usize> = (0..self.n).step_by(every).collect();
        for chunk in ids.chunks(32_768) {
            let t = threads();
            let per = chunk.len().div_ceil(t).max(1);
            let batch: Vec<(Vec<f32>, Vec<Value>)> = std::thread::scope(|sc| {
                let hs: Vec<_> = chunk.chunks(per).map(|p| sc.spawn(move || p.iter().map(|&i| self.item(i)).collect::<Vec<_>>())).collect();
                hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
            });
            f(batch);
        }
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn gauss(&mut self) -> f32 {
        let u = ((self.next() >> 40) as f32 / (1u64 << 24) as f32).max(1e-7);
        let v = (self.next() >> 40) as f32 / (1u64 << 24) as f32;
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f32::consts::PI * v).cos()
    }
}

fn unit(r: &mut Rng, d: usize) -> Vec<f32> {
    let mut v: Vec<f32> = (0..d).map(|_| r.gauss()).collect();
    vector::normalize(&mut v);
    v
}

/// PVEC shards, read from paths or http(s) URLs (`SHARD_TOKEN` is sent as a bearer token).
pub struct Shards {
    pub list: Vec<String>,
    pub schema: &'static Schema,
    pub table: TableId,
}

impl Shards {
    fn read(&self, s: &str) -> Vec<u8> {
        if s.starts_with("http://") || s.starts_with("https://") {
            let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(300)).build();
            for attempt in 0..6 {
                let mut req = agent.get(s);
                if let Ok(t) = std::env::var("SHARD_TOKEN") {
                    req = req.set("authorization", &format!("Bearer {t}"));
                }
                match req.call() {
                    Ok(r) => {
                        let mut b = Vec::new();
                        if std::io::Read::read_to_end(&mut r.into_reader(), &mut b).is_ok() {
                            return b;
                        }
                    }
                    Err(e) if attempt == 5 => panic!("{s}: {e}"),
                    Err(_) => {}
                }
                std::thread::sleep(std::time::Duration::from_millis(500 << attempt));
            }
            unreachable!()
        } else {
            fs::read(s).unwrap_or_else(|e| panic!("{s}: {e}"))
        }
    }
}

impl Source for Shards {
    fn pass(&self, every: usize, f: &mut dyn FnMut(Vec<(Vec<f32>, Vec<Value>)>)) {
        // Sampling takes whole shards (every `every`-th), so a sample costs a fraction of a pass.
        for (i, s) in self.list.iter().enumerate() {
            if i % every != 0 {
                continue;
            }
            let (_, items) = shard::decode(&self.read(s)).unwrap_or_else(|e| panic!("{s}: {e}"));
            let batch: Vec<(Vec<f32>, Vec<Value>)> = items.into_iter().filter_map(|(j, v)| parse_row(self.schema, self.table, &j).ok().map(|r| (v, r))).collect();
            f(batch);
        }
    }
}

// ------------------------------------------------------------------ commands

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).map(|i| args[i + 1].clone())
}

pub const SYNTH_SCHEMA: &str = r#"{"name":"vecsynth","tables":[{"name":"doc","columns":["id","title",{"name":"time","type":"number"},"kind"]}],
 "indexes":[{"tree":1,"name":"doc_by_id","table":"doc","key":["id"],"primary":true}]}"#;

pub fn synth(args: &[String]) {
    let n: usize = arg(args, "--n").map(|v| v.parse().unwrap()).unwrap_or(1_000_000);
    let dims: usize = arg(args, "--dims").map(|v| v.parse().unwrap()).unwrap_or(512);
    let groups: usize = arg(args, "--groups").map(|v| v.parse().unwrap()).unwrap_or(3000);
    let out = PathBuf::from(arg(args, "--out").expect("--out DIR"));
    let schema_json: J = serde_json::from_str(SYNTH_SCHEMA).unwrap();
    let schema = Schema::from_json(&schema_json).unwrap().leak();
    let cfg_json = json!({"name":"doc_vec","table":"doc","dims":dims,"cols":["id","title","time","kind"],"tree":20,"byId":21,"centroids":22,
        "clusterSize": arg(args, "--cluster").map(|v| v.parse::<u64>().unwrap()).unwrap_or(800), "supers": 64, "nprobe": 32, "maxPages": 256, "model": "synthetic",
        "codec": arg(args, "--codec").unwrap_or("sq8".into())});
    let cfg = Cfg::from_json(schema, &cfg_json);
    let src = Synth::new(n, dims, groups);
    let mut m = build(&cfg, schema, &src, n, 0, &out, true, arg(args, "--mem").map(|v| v.parse().unwrap()).unwrap_or(4000));
    m["schema"] = schema_json;
    m["rows"] = json!({"doc": n});
    m["bytes"] = json!(m["pages"].as_u64().unwrap() * PAGE_SIZE as u64);
    fs::write(out.join("manifest.json"), serde_json::to_string(&m).unwrap()).unwrap();
    // Ground truth for vec-eval: queries near (not on) random items, exact top 100 by cosine.
    let nq: usize = arg(args, "--gt").map(|v| v.parse().unwrap()).unwrap_or(200);
    if nq > 0 {
        let mut r = Rng(0x51ab);
        let qs: Vec<Vec<f32>> = (0..nq)
            .map(|_| {
                let (v, _) = src.item((r.next() % n as u64) as usize);
                let sigma = (0.3 / dims as f32).sqrt();
                let mut q: Vec<f32> = v.iter().map(|x| x + sigma * r.gauss()).collect();
                vector::normalize(&mut q);
                q
            })
            .collect();
        let gt = exact_top(&qs, &src, dims, 100);
        let rows: Vec<J> = qs.iter().zip(gt).map(|(q, ids)| json!({"q": q, "ids": ids})).collect();
        fs::write(out.join("gt.json"), serde_json::to_string(&rows).unwrap()).unwrap();
    }
}

/// Exact top-`k` primary keys by cosine for each query, over every item of `src`.
pub fn exact_top(qs: &[Vec<f32>], src: &dyn Source, dims: usize, k: usize) -> Vec<Vec<String>> {
    use std::collections::BinaryHeap;
    let t0 = Instant::now();
    let mut heaps: Vec<BinaryHeap<std::cmp::Reverse<(u32, String)>>> = qs.iter().map(|_| BinaryHeap::new()).collect();
    // Scores as order-preserving u32 (f32 bits flipped for negatives) so the heap is total.
    let key = |s: f32| {
        let b = s.to_bits();
        if b >> 31 == 1 { !b } else { b | 0x8000_0000 }
    };
    src.pass(1, &mut |batch| {
        let prepped: Vec<(Vec<f32>, String)> = batch.iter().filter_map(|(v, row)| Some((prep(v, dims)?, row[0].as_str()?.to_string()))).collect();
        let t = threads();
        let per = qs.len().div_ceil(t).max(1);
        std::thread::scope(|sc| {
            for (hs, qc) in heaps.chunks_mut(per).zip(qs.chunks(per)) {
                let prepped = &prepped;
                sc.spawn(move || {
                    for (h, q) in hs.iter_mut().zip(qc) {
                        for (v, pk) in prepped {
                            let s = key(dot_f32(q, v));
                            if h.len() < k {
                                h.push(std::cmp::Reverse((s, pk.clone())));
                            } else if h.peek().is_some_and(|m| s > m.0 .0) {
                                h.pop();
                                h.push(std::cmp::Reverse((s, pk.clone())));
                            }
                        }
                    }
                });
            }
        });
    });
    eprintln!("   exact top-{k} for {} queries in {:.1}s", qs.len(), t0.elapsed().as_secs_f64());
    heaps
        .into_iter()
        .map(|h| {
            let mut v: Vec<(u32, String)> = h.into_iter().map(|r| r.0).collect();
            v.sort_by(|a, b| b.0.cmp(&a.0));
            v.into_iter().map(|(_, p)| p).collect()
        })
        .collect()
}

// ------------------------------------------------------------------ ground truth

/// Ground truth for vec-eval on real embeddings: queries embedded the way the Worker embeds
/// them (with the instruction), then the exact top 100 over every shard's vectors, at the
/// index's dims and at the model's full dims (what truncation costs).
///   pagedb-builder vec-gt --schema S --config C --shards LIST --queries FILE [--titles 200] --out gt.json
pub fn gt(args: &[String]) {
    let schema = Schema::parse(&fs::read_to_string(arg(args, "--schema").expect("--schema FILE")).unwrap()).unwrap();
    let cfg_json: J = serde_json::from_str(&fs::read_to_string(arg(args, "--config").expect("--config FILE")).unwrap()).unwrap();
    let cfg = Cfg::from_json(schema, &cfg_json);
    let list: Vec<String> = fs::read_to_string(arg(args, "--shards").expect("--shards LIST")).unwrap().lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
    let src = Shards { list: list.clone(), schema, table: cfg.table };
    let mut texts: Vec<String> = fs::read_to_string(arg(args, "--queries").expect("--queries FILE")).unwrap().lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
    // Titles as queries: one story from each of `titles` shards spread through the list.
    let titles: usize = arg(args, "--titles").map(|v| v.parse().unwrap()).unwrap_or(200);
    for i in 0..titles.min(list.len()) {
        let s = &list[i * list.len() / titles.min(list.len())];
        let (_, items) = shard::decode(&src.read(s)).unwrap();
        if let Some((j, _)) = items.get(items.len() / 2) {
            if let Some(t) = serde_json::from_str::<J>(j).ok().and_then(|r| r["title"].as_str().map(String::from)).filter(|t| t.len() > 8) {
                texts.push(t);
            }
        }
    }
    let e = crate::embed::from_env();
    let bucket = crate::embed::Bucket::per_minute(600);
    let mut qs: Vec<Vec<f32>> = Vec::new();
    for chunk in texts.chunks(50) {
        let prompts: Vec<String> = chunk.iter().map(|t| crate::embed::query_text(t)).collect();
        qs.extend(crate::embed::embed_retry(e.as_ref(), &bucket, &prompts));
    }
    let full = qs[0].len();
    eprintln!("{} queries embedded ({full} dims)", qs.len());
    let prep_all = |d: usize| -> Vec<Vec<f32>> { qs.iter().map(|q| prep(q, d).unwrap()).collect() };
    let ids = exact_top(&prep_all(cfg.dims), &src, cfg.dims, 100);
    let ids_full = if full != cfg.dims { Some(exact_top(&prep_all(full), &src, full, 100)) } else { None };
    let rows: Vec<J> = (0..qs.len())
        .map(|i| {
            let mut r = json!({"text": texts[i], "q": qs[i], "ids": ids[i]});
            if let Some(f) = &ids_full {
                r["idsFull"] = json!(f[i]);
            }
            r
        })
        .collect();
    fs::write(arg(args, "--out").expect("--out FILE"), serde_json::to_string(&rows).unwrap()).unwrap();
}

// ------------------------------------------------------------------ eval

/// Pages of a local base (parts on disk), read on demand.
struct FileStore {
    dirs: Vec<(u64, PathBuf)>,
    cache: std::cell::RefCell<std::collections::HashMap<u64, std::rc::Rc<[u8]>>>,
}

impl pagedb_core::tree::PageStore for FileStore {
    fn get(&self, id: u64) -> Option<std::rc::Rc<[u8]>> {
        if let Some(p) = self.cache.borrow().get(&id) {
            return Some(p.clone());
        }
        use std::io::{Read, Seek, SeekFrom};
        let dir = &self.dirs.iter().rev().find(|(first, _)| id >= *first)?.1;
        let mut f = fs::File::open(dir.join("parts").join(format!("part-{:06}", id / PAGES_PER_PART))).ok()?;
        f.seek(SeekFrom::Start((id % PAGES_PER_PART) * PAGE_SIZE as u64)).ok()?;
        let mut b = vec![0u8; PAGE_SIZE];
        f.read_exact(&mut b).ok()?;
        let p: std::rc::Rc<[u8]> = b.into();
        self.cache.borrow_mut().insert(id, p.clone());
        Some(p)
    }
}

/// Recall and cost of vector search on a local base, for a grid of probe settings.
///   pagedb-builder vec-eval --manifest M [--schema S] --dir DIR[@FIRSTPAGE] … --gt gt.json [--nprobe 8,16,32] [--pages 128,256]
pub fn eval(args: &[String]) {
    use pagedb_core::tree::Ctx;
    let mut manifest: J = serde_json::from_str(&fs::read_to_string(arg(args, "--manifest").expect("--manifest FILE")).unwrap()).unwrap();
    // A segment's manifest has no schema: take the base's (--schema).
    if manifest.get("schema").is_none() {
        if let Some(p) = arg(args, "--schema") {
            manifest["schema"] = serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap();
        }
    }
    let roots = pagedb_core::query::Roots::from_manifest(&manifest).unwrap();
    let dirs: Vec<(u64, PathBuf)> = args
        .windows(2)
        .filter(|w| w[0] == "--dir")
        .map(|w| match w[1].split_once('@') {
            Some((d, f)) => (f.parse().unwrap(), PathBuf::from(d)),
            None => (0, PathBuf::from(&w[1])),
        })
        .collect();
    let store = FileStore { dirs, cache: Default::default() };
    let gt: Vec<J> = serde_json::from_str(&fs::read_to_string(arg(args, "--gt").expect("--gt FILE")).unwrap()).unwrap();
    let list = |name: &str, d: &str| -> Vec<usize> { arg(args, name).unwrap_or(d.to_string()).split(',').map(|v| v.parse().unwrap()).collect() };
    let k = 10;
    let index = arg(args, "--index").unwrap_or_else(|| roots.vectors[0].name.clone());
    let has_full = gt.first().is_some_and(|g| g.get("idsFull").is_some());
    println!("| nprobe | max pages | recall@{k} | recall@{k} (in top 100) |{} clusters | pages | 1 MiB chunks | GETs (runs) | scanned | ms (native) |", if has_full { " recall@10 vs full dims |" } else { "" });
    println!("|---|---|---|---|{}---|---|---|---|---|---|", if has_full { "---|" } else { "" });
    for &nprobe in &list("--nprobe", "8,16,32,64") {
        for &max_pages in &list("--pages", "256") {
            let (mut hit, mut hit100, mut hit_full, mut tot) = (0usize, 0usize, 0usize, 0usize);
            let (mut clusters, mut pages, mut chunks, mut runs, mut scanned, mut ms) = (0usize, 0usize, 0usize, 0usize, 0usize, 0f64);
            for g in &gt {
                let q: Vec<f64> = g["q"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
                let ids: Vec<&str> = g["ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
                let ast = json!({"ann": {"index": index, "vec": q, "k": k, "nprobe": nprobe, "maxPages": max_pages}});
                let aq = vector::compile(&roots, &ast).unwrap();
                let ctx = Ctx::new(&store);
                let t0 = Instant::now();
                let (hits, st) = vector::search(&ctx, &roots, &aq).expect("all pages are local");
                ms += t0.elapsed().as_secs_f64() * 1e3;
                let want: std::collections::HashSet<&str> = ids.iter().take(k).copied().collect();
                let want100: std::collections::HashSet<&str> = ids.iter().copied().collect();
                hit += hits.iter().filter(|h| want.contains(h.pk.as_str())).count();
                hit100 += hits.iter().filter(|h| want100.contains(h.pk.as_str())).count();
                if let Some(f) = g.get("idsFull").and_then(J::as_array) {
                    let wf: std::collections::HashSet<&str> = f.iter().take(k).filter_map(|x| x.as_str()).collect();
                    hit_full += hits.iter().filter(|h| wf.contains(h.pk.as_str())).count();
                }
                tot += k;
                clusters += st.clusters;
                pages += st.pages;
                scanned += st.scanned;
                // What the object would fetch: distinct 1 MiB chunks, merged into runs within a part.
                let leaves = vector_leaves(&ctx, &roots, &aq);
                let mut cs: Vec<u64> = leaves.iter().map(|p| p / 16).collect();
                cs.sort_unstable();
                cs.dedup();
                chunks += cs.len();
                runs += cs.iter().enumerate().filter(|(i, &c)| *i == 0 || cs[i - 1] + 1 != c || (c * 16) % PAGES_PER_PART == 0).count();
            }
            let n = gt.len() as f64;
            println!(
                "| {nprobe} | {max_pages} | {:.3} | {:.3} |{} {:.1} | {:.1} | {:.1} | {:.1} | {:.0} | {:.2} |",
                hit as f64 / tot as f64,
                hit100 as f64 / tot as f64,
                if has_full { format!(" {:.3} |", hit_full as f64 / tot as f64) } else { String::new() },
                clusters as f64 / n,
                pages as f64 / n,
                chunks as f64 / n,
                runs as f64 / n,
                scanned as f64 / n,
                ms / n
            );
        }
    }
}

/// The leaf pages a query reads (the same walk as the search).
fn vector_leaves(ctx: &pagedb_core::tree::Ctx, roots: &pagedb_core::query::Roots, aq: &vector::AnnQuery) -> Vec<u64> {
    let vi = &roots.vectors[aq.index];
    let cents = vi.centroids(ctx, roots).unwrap();
    let root = roots.get(vi.tree);
    let mut leaves: Vec<u64> = Vec::new();
    let mut n_clusters = 0;
    for i in vector::probe_order(&cents, &aq.q, aq.nprobe) {
        let cid = cents.ids[i];
        let mut ls = Vec::new();
        pagedb_core::tree::leaves_in(ctx, &root, &pagedb_core::tree::Range { lo: &cid.to_be_bytes(), hi: &(cid + 1).to_be_bytes() }, &mut ls).unwrap();
        let new: Vec<u64> = ls.into_iter().filter(|p| !leaves.contains(p)).collect();
        if n_clusters > 0 && leaves.len() + new.len() > aq.max_pages {
            break;
        }
        n_clusters += 1;
        leaves.extend(new);
    }
    leaves
}

pub fn build_cmd(args: &[String]) {
    let schema_text = fs::read_to_string(arg(args, "--schema").expect("--schema FILE")).unwrap();
    let schema = Schema::parse(&schema_text).unwrap();
    let cfg_json: J = serde_json::from_str(&fs::read_to_string(arg(args, "--config").expect("--config FILE")).unwrap()).unwrap();
    let cfg = Cfg::from_json(schema, &cfg_json);
    let list: Vec<String> = fs::read_to_string(arg(args, "--shards").expect("--shards LIST")).unwrap().lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
    let first_page: u64 = arg(args, "--first-page").expect("--first-page F").parse().unwrap();
    assert_eq!(first_page % PAGES_PER_PART, 0, "--first-page must start a part");
    let out = PathBuf::from(arg(args, "--out").expect("--out DIR"));
    let n_est = arg(args, "--rows").map(|v| v.parse().unwrap()).unwrap_or(list.len() * 16_384);
    let src = Shards { list, schema, table: cfg.table };
    let m = build(&cfg, schema, &src, n_est, first_page, &out, false, arg(args, "--mem").map(|v| v.parse().unwrap()).unwrap_or(4000));
    fs::write(out.join("manifest.json"), serde_json::to_string(&m).unwrap()).unwrap();
}

/// Attach a segment (its trees, vector indexes, and where its pages live) to a base manifest.
pub fn merge(args: &[String]) {
    let mut base: J = serde_json::from_str(&fs::read_to_string(arg(args, "--base").expect("--base FILE")).unwrap()).unwrap();
    let seg: J = serde_json::from_str(&fs::read_to_string(arg(args, "--segment").expect("--segment FILE")).unwrap()).unwrap();
    let segbase = arg(args, "--segbase").expect("--segbase ID");
    let first = seg["firstPage"].as_u64().unwrap();
    assert!(first >= base["pages"].as_u64().unwrap(), "the segment overlaps the base");
    let new_trees: Vec<u64> = seg["trees"].as_array().unwrap().iter().map(|t| t["tree"].as_u64().unwrap()).collect();
    let trees = base["trees"].as_array_mut().unwrap();
    trees.retain(|t| !new_trees.contains(&t["tree"].as_u64().unwrap()));
    trees.extend(seg["trees"].as_array().unwrap().iter().cloned());
    let names: Vec<String> = seg["vectors"].as_array().unwrap().iter().map(|v| v["name"].as_str().unwrap().to_string()).collect();
    let mut vectors: Vec<J> = base.get("vectors").and_then(J::as_array).cloned().unwrap_or_default();
    vectors.retain(|v| !names.iter().any(|n| v["name"] == *n));
    vectors.extend(seg["vectors"].as_array().unwrap().iter().cloned());
    base["vectors"] = J::from(vectors);
    let mut segs: Vec<J> = base.get("segments").and_then(J::as_array).cloned().unwrap_or_default();
    segs.retain(|s| s["firstPage"] != seg["firstPage"]);
    let mut entry = json!({"base": segbase, "firstPage": first, "pages": seg["pages"], "pinnedFrom": seg["pinnedFrom"], "chunkPages": seg["chunkPages"], "partCrcs": seg["partCrcs"]});
    if let Some(db) = arg(args, "--segdb") {
        entry["db"] = J::from(db);
    }
    segs.push(entry);
    base["segments"] = J::from(segs);
    fs::write(arg(args, "--out").expect("--out FILE"), serde_json::to_string(&base).unwrap()).unwrap();
}
