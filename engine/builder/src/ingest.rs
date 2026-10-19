//! Generic ingest: any schema, rows from newline-delimited JSON (one input per table) → every
//! index → 4 MiB parts + manifest.json, in the same format as the tracker builder.
//!
//!   pagedb-builder ingest --schema schema.json --input story=stories.ndjson --input comment=- \
//!       [--mem 6000] [--tmp DIR] --out DIR
//!
//! `--input comment=PATH@comment_by_story,comment_by_id` builds only those indexes from that
//! input: a big table can be read in several passes, so its spill runs never all sit on disk.
//!
//! Each input line is a JSON object keyed by column name (missing columns are null; lists are
//! JSON arrays of strings). Maintained columns (relation counts, copies) must already be right
//! in the input: the base is taken as given.
//!
//! Every index of a table is sorted externally: entries go into an in-memory arena, spill as
//! sorted LZ4 runs, and merge back in key order straight into the tree builder. A table's trees
//! are built as soon as its input ends, so only one table's runs are on disk at a time. Tables
//! marked `"pinned": true` (small, always-hot tables) are built last, next to every tree's
//! branch pages, in the pinned region an object loads when it starts.

use crate::sink::{build_tree, Built, PartSink};
use pagedb_core::catalog::{index_entries, list_json, ColType, Index, Schema, TableId};
use pagedb_core::codec::Value;
use pagedb_core::page::{PAGES_PER_PART, PAGE_SIZE};
use serde_json::Value as J;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// One JSON object → a row, by the table's column types.
pub fn parse_row(schema: &Schema, table: TableId, line: &str) -> Result<Vec<Value>, String> {
    let obj: serde_json::Map<String, J> = serde_json::from_str(line).map_err(|e| format!("bad JSON: {e}"))?;
    let t = schema.table(table);
    let mut row = Vec::with_capacity(t.columns.len());
    for c in &t.columns {
        let v = obj.get(&c.name).unwrap_or(&J::Null);
        row.push(match (c.ty, v) {
            (ColType::List, J::Array(a)) => {
                let mut items: Vec<String> = a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
                items.sort();
                items.dedup();
                Value::from(list_json(&items))
            }
            (ColType::List, _) => Value::from("[]"),
            (_, J::Null) => Value::Null,
            (ColType::Num, J::Number(n)) => Value::Num(n.as_f64().unwrap_or(0.0)),
            (ColType::Num, J::String(s)) => s.parse::<f64>().map(Value::Num).unwrap_or(Value::Null),
            (ColType::Bool, J::Bool(b)) => Value::Bool(*b),
            (ColType::Bool, J::Number(n)) => Value::Bool(n.as_f64().unwrap_or(0.0) != 0.0),
            (ColType::Str, J::String(s)) => Value::Str(s.clone()),
            (ColType::Str, J::Number(n)) => Value::Str(n.to_string()),
            (_, other) => return Err(format!("{}.{}: unexpected {other}", t.name, c.name)),
        });
    }
    if row[0].as_str().map_or(true, str::is_empty) {
        return Err(format!("{}: row without an id", t.name));
    }
    Ok(row)
}

// ------------------------------------------------------------------ external sort

/// Sorts (key, value) entries with bounded memory: an arena of entries, spilled as sorted LZ4
/// runs when it outgrows its budget, then merged. Equal keys keep the first one pushed.
pub struct Sorter {
    arena: Vec<u8>,
    items: Vec<(u64, u32, u32)>,
    budget: usize,
    runs: Vec<PathBuf>,
    tmp: PathBuf,
    pub pushed: u64,
}

impl Sorter {
    pub fn new(tmp: &Path, budget: usize) -> Sorter {
        Sorter { arena: Vec::new(), items: Vec::new(), budget: budget.max(1 << 20), runs: Vec::new(), tmp: tmp.to_path_buf(), pushed: 0 }
    }

    pub fn push(&mut self, k: &[u8], v: &[u8]) {
        self.items.push((self.arena.len() as u64, k.len() as u32, v.len() as u32));
        self.arena.extend_from_slice(k);
        self.arena.extend_from_slice(v);
        self.pushed += 1;
        if self.arena.len() + self.items.len() * 16 > self.budget {
            self.spill();
        }
    }

    fn sorted(&mut self) {
        let a = &self.arena;
        // Stable: equal keys stay in push order, so "first wins" is well defined.
        self.items.sort_by(|x, y| a[x.0 as usize..x.0 as usize + x.1 as usize].cmp(&a[y.0 as usize..y.0 as usize + y.1 as usize]));
    }

    fn spill(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.sorted();
        fs::create_dir_all(&self.tmp).unwrap();
        let path = self.tmp.join(format!("run-{}-{}", std::process::id(), RUN_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let mut w = lz4_flex::frame::FrameEncoder::new(BufWriter::with_capacity(1 << 20, File::create(&path).unwrap()));
        for &(off, kl, vl) in &self.items {
            let o = off as usize;
            w.write_all(&kl.to_le_bytes()).unwrap();
            w.write_all(&vl.to_le_bytes()).unwrap();
            w.write_all(&self.arena[o..o + kl as usize + vl as usize]).unwrap();
        }
        w.finish().unwrap().flush().unwrap();
        self.runs.push(path);
        self.items.clear();
        self.arena.clear();
        self.arena.shrink_to(self.budget / 4);
    }

    /// Every entry in key order (duplicates dropped). Returns how many were dropped.
    pub fn drain(mut self, f: &mut dyn FnMut(&[u8], &[u8])) -> u64 {
        let mut dropped = 0;
        if self.runs.is_empty() {
            self.sorted();
            let mut last: Option<&[u8]> = None;
            for &(off, kl, vl) in &self.items {
                let o = off as usize;
                let k = &self.arena[o..o + kl as usize];
                if last == Some(k) {
                    dropped += 1;
                    continue;
                }
                f(k, &self.arena[o + kl as usize..o + kl as usize + vl as usize]);
                last = Some(k);
            }
            return dropped;
        }
        self.spill();
        let mut readers: Vec<Run> = self.runs.iter().map(|p| Run::open(p)).collect();
        let mut heap = BinaryHeap::new();
        for (i, r) in readers.iter_mut().enumerate() {
            if let Some((k, v)) = r.next() {
                heap.push(Reverse((k, i, v)));
            }
        }
        let mut last: Option<Vec<u8>> = None;
        while let Some(Reverse((k, i, v))) = heap.pop() {
            if last.as_deref() == Some(&k[..]) {
                dropped += 1;
            } else {
                f(&k, &v);
            }
            if let Some((k2, v2)) = readers[i].next() {
                heap.push(Reverse((k2, i, v2)));
            }
            last = Some(k);
        }
        for p in &self.runs {
            let _ = fs::remove_file(p);
        }
        dropped
    }
}

static RUN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Run(lz4_flex::frame::FrameDecoder<BufReader<File>>);

impl Run {
    fn open(p: &Path) -> Run {
        Run(lz4_flex::frame::FrameDecoder::new(BufReader::with_capacity(1 << 20, File::open(p).unwrap())))
    }
    fn next(&mut self) -> Option<(Vec<u8>, Vec<u8>)> {
        let mut len = [0u8; 8];
        self.0.read_exact(&mut len).ok()?;
        let kl = u32::from_le_bytes(len[..4].try_into().unwrap()) as usize;
        let vl = u32::from_le_bytes(len[4..].try_into().unwrap()) as usize;
        let mut k = vec![0u8; kl];
        let mut v = vec![0u8; vl];
        self.0.read_exact(&mut k).unwrap();
        self.0.read_exact(&mut v).unwrap();
        Some((k, v))
    }
}

// ------------------------------------------------------------------ driver

fn open_input(path: &str) -> Box<dyn BufRead> {
    if path == "-" {
        Box::new(BufReader::with_capacity(1 << 20, std::io::stdin()))
    } else {
        Box::new(BufReader::with_capacity(1 << 20, File::open(path).unwrap_or_else(|e| panic!("{path}: {e}"))))
    }
}

/// Build one index's tree from its sorter (keeping only `base_limit` keys if set).
fn build_index(sink: &mut PartSink, ix: &Index, sorter: Sorter) -> Built {
    let limit = ix.base_limit.unwrap_or(usize::MAX);
    let mut sorter = Some(sorter);
    let mut dropped = 0;
    let b = build_tree(sink, ix.tree, &ix.name, &mut |f| {
        let mut n = 0usize;
        dropped = sorter.take().unwrap().drain(&mut |k, v| {
            if n < limit {
                f(k, v);
                n += 1;
            }
        });
    });
    if dropped > 0 {
        eprintln!("   {}: dropped {dropped} duplicate keys", ix.name);
    }
    b
}

pub fn run(args: &[String]) {
    let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let schema_text = fs::read_to_string(arg("--schema").expect("--schema FILE")).expect("schema file");
    let schema_json: J = serde_json::from_str(&schema_text).expect("schema JSON");
    let schema = Schema::from_json(&schema_json).unwrap_or_else(|e| panic!("schema: {e}")).leak();
    let out = PathBuf::from(arg("--out").expect("--out DIR"));
    let tmp = arg("--tmp").map(PathBuf::from).unwrap_or_else(|| out.join("tmp"));
    let mem_mb: usize = arg("--mem").map(|v| v.parse().unwrap()).unwrap_or(4000);
    let inputs: Vec<(TableId, String, Option<Vec<String>>)> = args
        .windows(2)
        .filter(|w| w[0] == "--input")
        .map(|w| {
            let (t, p) = w[1].split_once('=').expect("--input table=PATH[@index,…]");
            let (p, only) = match p.rsplit_once('@') {
                Some((p, ix)) => (p, Some(ix.split(',').map(str::to_string).collect())),
                None => (p, None),
            };
            (schema.table_named(t).unwrap_or_else(|| panic!("unknown table {t}")), p.to_string(), only)
        })
        .collect();
    let pinned: Vec<bool> = schema_json["tables"].as_array().unwrap().iter().map(|t| t.get("pinned").and_then(J::as_bool).unwrap_or(false)).collect();
    if out.join("parts").exists() {
        fs::remove_dir_all(out.join("parts")).unwrap();
    }
    let started = Instant::now();
    let mut sink = PartSink::new(&out);
    let mut built: Vec<Built> = Vec::new();
    let mut rows_per_table = vec![0u64; schema.tables.len()];
    let mut deferred: Vec<(&Index, Sorter)> = Vec::new();

    for (table, path, only) in &inputs {
        let t0 = Instant::now();
        let ixs: Vec<&Index> = schema.indexes_of(*table).filter(|ix| only.as_ref().map_or(true, |o| o.contains(&ix.name))).collect();
        rows_per_table[*table] = 0;
        let budget = mem_mb * (1 << 20) / ixs.len().max(1);
        let mut sorters: Vec<Sorter> = ixs.iter().map(|ix| Sorter::new(&tmp.join(&ix.name), budget)).collect();
        let mut bad = 0u64;
        for line in open_input(path).lines() {
            let line = line.expect("read input");
            if line.trim().is_empty() {
                continue;
            }
            let row = match parse_row(schema, *table, &line) {
                Ok(r) => r,
                Err(e) => {
                    bad += 1;
                    if bad <= 5 {
                        eprintln!("   skipped a row: {e}");
                    }
                    continue;
                }
            };
            rows_per_table[*table] += 1;
            if rows_per_table[*table] % 5_000_000 == 0 {
                eprintln!("   {} rows of {} ({:.0}s)", rows_per_table[*table], schema.table(*table).name, t0.elapsed().as_secs_f64());
            }
            for (ix, s) in ixs.iter().zip(sorters.iter_mut()) {
                for (k, v) in index_entries(ix, &row) {
                    s.push(&k, &v);
                }
            }
        }
        eprintln!("{}: {} rows read in {:.1}s ({bad} skipped)", schema.table(*table).name, rows_per_table[*table], t0.elapsed().as_secs_f64());
        for (ix, s) in ixs.into_iter().zip(sorters) {
            if pinned[*table] {
                deferred.push((ix, s));
            } else {
                built.push(build_index(&mut sink, ix, s));
            }
        }
    }
    // Pinned region: the pinned tables' leaves, then every tree's branch pages. Contiguous at
    // the end of the base, so an object loads it with a few ranged GETs when it starts.
    let pinned_from = sink.next;
    for (ix, s) in deferred {
        built.push(build_index(&mut sink, ix, s));
    }
    for b in built.iter_mut() {
        let first = sink.next;
        b.root = b.pending.take().unwrap().finish_branches(&mut sink);
        b.pages += sink.next - first;
    }
    // Indexes with no input still need (empty) roots.
    for ix in &schema.indexes {
        if !built.iter().any(|b| b.root.tree == ix.tree) {
            let mut b = build_index(&mut sink, ix, Sorter::new(&tmp, 1 << 20));
            b.root = b.pending.take().unwrap().finish_branches(&mut sink);
            built.push(b);
        }
    }
    built.sort_by_key(|b| b.root.tree);
    let (pages, crcs) = sink.finish();
    let _ = fs::remove_dir_all(&tmp);
    let trees: Vec<J> = built
        .iter()
        .map(|b| {
            eprintln!(
                "{:>3} {:<34} rows {:>11}  pages {:>8} ({:>8.1} MB)  height {}  {:>6.1}s",
                b.root.tree,
                b.name,
                b.root.rows,
                b.pages,
                b.pages as f64 * PAGE_SIZE as f64 / 1e6,
                b.root.height,
                b.secs
            );
            serde_json::json!({"tree": b.root.tree, "name": b.name, "root": if b.root.height == 0 { J::Null } else { J::from(b.root.root) }, "height": b.root.height, "rows": b.root.rows,
                "firstPage": b.first_page, "pages": b.pages, "leafPages": b.root.leaves})
        })
        .collect();
    let rows: serde_json::Map<String, J> = schema.tables.iter().map(|t| (t.name.clone(), J::from(rows_per_table[t.id]))).collect();
    let manifest = serde_json::json!({
        "version": 1, "pageSize": PAGE_SIZE, "pagesPerPart": PAGES_PER_PART, "pages": pages, "pinnedFrom": pinned_from,
        "parts": crcs.len(), "bytes": pages * PAGE_SIZE as u64, "rows": rows, "schema": schema_json, "trees": trees, "partCrcs": crcs,
    });
    fs::write(out.join("manifest.json"), serde_json::to_string(&manifest).unwrap()).unwrap();
    eprintln!("{} pages, {} parts, {:.2} GB in {:.1}s", pages, crcs.len(), pages as f64 * PAGE_SIZE as f64 / 1e9, started.elapsed().as_secs_f64());
}
