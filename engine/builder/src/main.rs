//! pagedb builder: generates the issue-tracker dataset and writes the immutable base as 4 MiB
//! parts of 64 KiB pages, plus manifest.json.
//!
//!   pagedb-builder build --projects 27 --out ../data/db1g
//!
//! Every tree is streamed in key order, so memory stays flat as the dataset grows:
//! per-project trees are generated project by project; the multi-valued tag index goes through
//! one temp file per tag (appending projects in order keeps each file sorted); the feed index
//! keeps the newest `feed_base` comments with a heap.

use pagedb_core::catalog::{self, index_entries, tracker};
use pagedb_core::codec::Value;
use pagedb_core::gen::{self, Config};
use pagedb_core::page::{PAGES_PER_PART, PAGE_SIZE};
use std::collections::BinaryHeap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::time::Instant;

mod ingest;
mod sink;
use sink::{build_tree, Built, PartSink};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("oracle") {
        // Expected results for a project, straight from the generator (spot-checks a deployed base).
        let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
        let mut cfg = Config::with_projects(arg("--projects").unwrap().parse().unwrap());
        cfg.comments_per_issue = arg("--comments").map(|v| v.parse().unwrap()).unwrap_or(5.0);
        let p: u32 = arg("--project").unwrap().parse().unwrap();
        let n = gen::issue_count(&cfg, p);
        let newest: Vec<String> = (0..5).map(|k| gen::issue_id(p, n - 1 - k)).collect();
        let first = gen::issue(&cfg, p, n - 1);
        println!(r#"{{"count":{n},"newest":{:?},"title":{:?},"comments":{}}}"#, newest, first.row[pagedb_core::catalog::issue::TITLE].as_str().unwrap(), first.comments);
        return;
    }
    if args.get(1).map(String::as_str) == Some("fetch-hn") {
        fetch_hn(&args[2..]);
        return;
    }
    if args.get(1).map(String::as_str) == Some("export") {
        // The generated tracker as JSON lines per table (to check `ingest` against `build`).
        let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
        let mut cfg = Config::with_projects(arg("--projects").map(|v| v.parse().unwrap()).unwrap_or(2));
        if let Some(v) = arg("--issues") {
            cfg.issues_per_project = v.parse().unwrap();
        }
        let out = PathBuf::from(arg("--out").expect("--out DIR"));
        fs::create_dir_all(&out).unwrap();
        let s = tracker();
        let all = pagedb_core::build::rows(&cfg);
        for (t, rows) in [(0, &all.projects), (1, &all.users), (2, &all.issues), (3, &all.comments)] {
            let mut w = BufWriter::new(File::create(out.join(format!("{}.ndjson", s.table(t).name))).unwrap());
            for row in rows {
                let mut o = serde_json::Map::new();
                for (c, v) in s.table(t).columns.iter().zip(row) {
                    let j = match (c.ty, v) {
                        (catalog::ColType::List, _) => serde_json::Value::from(catalog::parse_list(v)),
                        (_, Value::Null) => serde_json::Value::Null,
                        (_, Value::Num(n)) => serde_json::json!(n),
                        (_, Value::Bool(b)) => serde_json::Value::Bool(*b),
                        (_, Value::Str(x)) => serde_json::Value::from(x.as_str()),
                    };
                    o.insert(c.name.clone(), j);
                }
                writeln!(w, "{}", serde_json::Value::Object(o)).unwrap();
            }
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("ingest") {
        ingest::run(&args[2..]);
        return;
    }
    if args.get(1).map(String::as_str) != Some("build") {
        eprintln!("usage: pagedb-builder build --projects N [--issues 10000] [--comments 5.0] [--feed 500000] --out DIR\n       pagedb-builder ingest --schema schema.json --input table=rows.ndjson … --out DIR");
        std::process::exit(2);
    }
    let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let mut cfg = Config::with_projects(arg("--projects").map(|v| v.parse().unwrap()).unwrap_or(27));
    if let Some(v) = arg("--issues") {
        cfg.issues_per_project = v.parse().unwrap();
    }
    if let Some(v) = arg("--comments") {
        cfg.comments_per_issue = v.parse().unwrap();
    }
    if let Some(v) = arg("--feed") {
        cfg.feed_base = v.parse().unwrap();
    }
    if let Some(v) = arg("--users") {
        cfg.users = v.parse().unwrap();
    }
    let out = PathBuf::from(arg("--out").expect("--out DIR"));
    if out.join("parts").exists() {
        fs::remove_dir_all(out.join("parts")).unwrap();
    }
    let started = Instant::now();
    let mut sink = PartSink::new(&out);
    let mut built: Vec<Built> = Vec::new();
    let ix = |name: &str| tracker().index_named(name).unwrap();
    let emit_row = |ix_: &catalog::Index, row: &[Value], f: &mut dyn FnMut(&[u8], &[u8])| {
        for (k, v) in index_entries(ix_, row) {
            f(&k, &v);
        }
    };

    // 3: issue_by_id — ids sort by (project, seq).
    built.push(build_tree(&mut sink, 3, &tracker().index(3).name, &mut |f| {
        for p in 0..cfg.projects {
            for s in 0..gen::issue_count(&cfg, p) {
                emit_row(ix("issue_by_id"), &gen::issue(&cfg, p, s).row, f);
            }
        }
    }));
    // 4: (projectId, createdAt desc, id) — newest first within each project.
    built.push(build_tree(&mut sink, 4, &tracker().index(4).name, &mut |f| {
        for p in 0..cfg.projects {
            for s in (0..gen::issue_count(&cfg, p)).rev() {
                emit_row(ix("issue_by_project_created"), &gen::issue(&cfg, p, s).row, f);
            }
        }
    }));
    // 5: (projectId, status, createdAt desc, id) — sort one project at a time.
    // 6 (tags) is fed from the same pass via per-tag temp files.
    let tag_dir = out.join("tmp-tags");
    fs::create_dir_all(&tag_dir).unwrap();
    let vocab = gen::tag_vocab();
    let mut tag_files: Vec<BufWriter<File>> =
        vocab.iter().map(|t| BufWriter::with_capacity(1 << 20, File::create(tag_dir.join(t)).unwrap())).collect();
    built.push(build_tree(&mut sink, 5, &tracker().index(5).name, &mut |f| {
        let by_status = ix("issue_by_project_status_created");
        let by_tag = ix("issue_by_tag");
        for p in 0..cfg.projects {
            let n = gen::issue_count(&cfg, p);
            let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(n as usize);
            for s in (0..n).rev() {
                let row = gen::issue(&cfg, p, s).row;
                entries.extend(index_entries(by_status, &row));
                // index_entries emits one entry per tag, in sorted, de-duplicated tag order.
                let mut tags = catalog::parse_tags(&row[catalog::issue::TAGS]);
                tags.sort();
                tags.dedup();
                for ((k, v), t) in index_entries(by_tag, &row).into_iter().zip(tags) {
                    let i = vocab.binary_search(&t).unwrap();
                    let w = &mut tag_files[i];
                    w.write_all(&(k.len() as u32).to_le_bytes()).unwrap();
                    w.write_all(&k).unwrap();
                    w.write_all(&(v.len() as u32).to_le_bytes()).unwrap();
                    w.write_all(&v).unwrap();
                }
            }
            entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
            for (k, v) in &entries {
                f(k, v);
            }
        }
    }));
    for w in &mut tag_files {
        w.flush().unwrap();
    }
    drop(tag_files);
    built.push(build_tree(&mut sink, 6, &tracker().index(6).name, &mut |f| {
        for t in &vocab {
            let mut r = BufReader::with_capacity(1 << 20, File::open(tag_dir.join(t)).unwrap());
            let mut len = [0u8; 4];
            while r.read_exact(&mut len).is_ok() {
                let mut k = vec![0u8; u32::from_le_bytes(len) as usize];
                r.read_exact(&mut k).unwrap();
                r.read_exact(&mut len).unwrap();
                let mut v = vec![0u8; u32::from_le_bytes(len) as usize];
                r.read_exact(&mut v).unwrap();
                f(&k, &v);
            }
        }
    }));
    fs::remove_dir_all(&tag_dir).unwrap();
    // 7: comment_by_issue, and 9: comment_by_id share the (project, issue, j) order.
    // Feed candidates are collected on the way (newest feed_base comments by createdAt).
    let mut feed: BinaryHeap<std::cmp::Reverse<(u64, u32, u32, u32)>> = BinaryHeap::new();
    built.push(build_tree(&mut sink, 7, &tracker().index(7).name, &mut |f| {
        let by_issue = ix("comment_by_issue");
        for p in 0..cfg.projects {
            for s in 0..gen::issue_count(&cfg, p) {
                let is = gen::issue(&cfg, p, s);
                for j in 0..is.comments {
                    let c = gen::comment(&cfg, p, s, j, &is.row);
                    let t = c[catalog::comment::CREATED].as_num().unwrap() as u64;
                    if feed.len() < cfg.feed_base {
                        feed.push(std::cmp::Reverse((t, p, s, j)));
                    } else if feed.peek().map(|m| m.0 .0 < t).unwrap_or(false) {
                        feed.pop();
                        feed.push(std::cmp::Reverse((t, p, s, j)));
                    }
                    emit_row(by_issue, &c, f);
                }
            }
        }
    }));
    // 8: comment_by_created (newest first), from the heap.
    let mut newest: Vec<(u64, u32, u32, u32)> = feed.into_iter().map(|r| r.0).collect();
    built.push(build_tree(&mut sink, 8, &tracker().index(8).name, &mut |f| {
        let by_created = ix("comment_by_created");
        let mut entries: Vec<(Vec<u8>, Vec<u8>)> = newest
            .drain(..)
            .map(|(_, p, s, j)| {
                let is = gen::issue(&cfg, p, s);
                index_entries(by_created, &gen::comment(&cfg, p, s, j, &is.row)).pop().unwrap()
            })
            .collect();
        entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        for (k, v) in &entries {
            f(k, v);
        }
    }));
    built.push(build_tree(&mut sink, 9, &tracker().index(9).name, &mut |f| {
        let by_id = ix("comment_by_id");
        for p in 0..cfg.projects {
            for s in 0..gen::issue_count(&cfg, p) {
                let is = gen::issue(&cfg, p, s);
                for j in 0..is.comments {
                    emit_row(by_id, &gen::comment(&cfg, p, s, j, &is.row), f);
                }
            }
        }
    }));

    // Pinned region (loaded whole when an object starts): the small tables, then the interior
    // (branch) pages of every tree. Contiguous, so it costs one or two ranged GETs.
    let pinned_from = sink.next;
    // 1, 2: small tables.
    built.push(build_tree(&mut sink, 1, &tracker().index(1).name, &mut |f| {
        for p in 0..cfg.projects {
            emit_row(ix("project_by_id"), &gen::project_row(&cfg, p), f);
        }
    }));
    built.push(build_tree(&mut sink, 2, &tracker().index(2).name, &mut |f| {
        for u in 0..cfg.users {
            emit_row(ix("user_by_id"), &gen::user_row(&cfg, u), f);
        }
    }));
    for b in built.iter_mut() {
        let first = sink.next;
        b.root = b.pending.take().unwrap().finish_branches(&mut sink);
        b.pages += sink.next - first;
    }
    built.sort_by_key(|b| b.root.tree);
    let (pages, crcs) = sink.finish();
    let issues: u64 = (0..cfg.projects).map(|p| gen::issue_count(&cfg, p) as u64).sum();
    let mut trees = String::new();
    for (i, b) in built.iter().enumerate() {
        if i > 0 {
            trees.push(',');
        }
        trees.push_str(&format!(
            r#"{{"tree":{},"name":"{}","root":{},"height":{},"rows":{},"firstPage":{},"pages":{},"leafPages":{}}}"#,
            b.root.tree, b.name, b.root.root, b.root.height, b.root.rows, b.first_page, b.pages, b.root.leaves
        ));
        eprintln!(
            "{:>2} {:<32} rows {:>11}  pages {:>8} ({:>8.1} MB)  height {}  {:>6.1}s",
            b.root.tree,
            b.name,
            b.root.rows,
            b.pages,
            b.pages as f64 * PAGE_SIZE as f64 / 1e6,
            b.root.height,
            b.secs
        );
    }
    let parts = crcs.len();
    let crc_list: Vec<String> = crcs.iter().map(|c| c.to_string()).collect();
    let manifest = format!(
        r#"{{"version":1,"pageSize":{PAGE_SIZE},"pagesPerPart":{PAGES_PER_PART},"pages":{pages},"pinnedFrom":{pinned_from},"parts":{parts},"bytes":{},"issues":{issues},"gen":{{"seed":{},"projects":{},"issuesPerProject":{},"users":{},"commentsPerIssue":{},"feedBase":{}}},"tables":{{"project":1,"user":2,"issue":3,"comment":9}},"schema":{},"trees":[{trees}],"partCrcs":[{}]}}"#,
        pages * PAGE_SIZE as u64,
        cfg.seed,
        cfg.projects,
        cfg.issues_per_project,
        cfg.users,
        cfg.comments_per_issue,
        cfg.feed_base,
        tracker().json,
        crc_list.join(",")
    );
    fs::write(out.join("manifest.json"), manifest).unwrap();
    eprintln!(
        "{} issues, {} pages, {} parts, {:.2} GB in {:.1}s",
        issues,
        pages,
        parts,
        pages as f64 * PAGE_SIZE as f64 / 1e9,
        started.elapsed().as_secs_f64()
    );
}

/// Hacker News items [from, to] from the official API as JSON lines on stdout (null/missing
/// items skipped). `--threads` requests in flight; each item is retried a few times.
fn fetch_hn(args: &[String]) {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let from: u64 = arg("--from").expect("--from ID").parse().unwrap();
    let to: u64 = arg("--to").expect("--to ID").parse().unwrap();
    let threads: usize = arg("--threads").map(|v| v.parse().unwrap()).unwrap_or(64);
    let next = AtomicU64::new(from);
    let done = AtomicU64::new(0);
    let out = Mutex::new(BufWriter::with_capacity(1 << 20, std::io::stdout()));
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(20)).build();
    let t0 = Instant::now();
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let id = next.fetch_add(1, Ordering::Relaxed);
                if id > to {
                    break;
                }
                let url = format!("https://hacker-news.firebaseio.com/v0/item/{id}.json");
                for attempt in 0..5 {
                    match agent.get(&url).call().and_then(|r| Ok(r.into_string()?)) {
                        Ok(body) => {
                            let body = body.trim();
                            if body != "null" && !body.is_empty() {
                                let mut w = out.lock().unwrap();
                                w.write_all(body.as_bytes()).unwrap();
                                w.write_all(b"\n").unwrap();
                            }
                            break;
                        }
                        Err(e) if attempt == 4 => eprintln!("item {id}: {e}"),
                        Err(_) => std::thread::sleep(std::time::Duration::from_millis(200 << attempt)),
                    }
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 20_000 == 0 {
                    eprintln!("fetched {n} of {} ({:.0}/s)", to - from + 1, n as f64 / t0.elapsed().as_secs_f64());
                }
            });
        }
    });
    out.lock().unwrap().flush().unwrap();
}
