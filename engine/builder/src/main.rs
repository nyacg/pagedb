//! pagedb builder. For now: `bench-tree <out-dir> <rows>` writes a synthetic issue-like tree as
//! pages (pages.bin) plus root.json, for the WASM microbenchmarks (spike S0c).

use pagedb_core::codec::{encode_key, encode_row, Value};
use pagedb_core::tree::{PageSink, TreeBuilder};
use std::fs::File;
use std::io::{BufWriter, Write};

struct FileSink {
    out: BufWriter<File>,
    next: u64,
}

impl PageSink for FileSink {
    fn write(&mut self, page: Vec<u8>) -> u64 {
        self.out.write_all(&page).unwrap();
        self.next += 1;
        self.next - 1
    }
}

const WORDS: &[&str] = &[
    "sync", "cursor", "page", "fault", "query", "board", "issue", "latency", "object", "durable", "cache", "socket",
    "render", "filter", "index", "merge", "replica", "lease", "overlay", "branch", "leaf", "tier", "edge", "worker",
];

fn rng(seed: u64) -> impl FnMut() -> u64 {
    let mut s = seed.wrapping_add(0x9E3779B97F4A7C15);
    move || {
        s = s.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = s;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("bench-tree") => {
            let dir = &args[2];
            let n: usize = args[3].parse().unwrap();
            std::fs::create_dir_all(dir).unwrap();
            let mut sink = FileSink { out: BufWriter::new(File::create(format!("{dir}/pages.bin")).unwrap()), next: 0 };
            let mut b = TreeBuilder::new(1);
            let mut r = rng(42);
            // issue_by_project_created: (projectId, createdAt desc, id) → full row
            let projects = (n / 10_000).max(1);
            let mut rows: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(n);
            for i in 0..n {
                let p = format!("proj-{:06}", i % projects);
                let created = 1.7e12 - (i as f64) * 61_000.0;
                let id = format!("iss-{:08}", i);
                let title: Vec<&str> = (0..6).map(|_| WORDS[(r() % WORDS.len() as u64) as usize]).collect();
                let row = vec![
                    Value::from(id.clone()),
                    Value::from(p.clone()),
                    Value::from(title.join(" ")),
                    Value::from(["backlog", "todo", "in-progress", "review", "done"][(r() % 5) as usize]),
                    Value::from(["urgent", "high", "medium", "low"][(r() % 4) as usize]),
                    Value::from(format!("user-{:05}", r() % 5000)),
                    Value::Num(created),
                    Value::Num(created + 1000.0),
                ];
                let key = encode_key(&[Value::from(p), Value::Num(created), Value::from(id)], &[false, true, false]);
                rows.push((key, encode_row(&row)));
            }
            rows.sort_by(|a, b| a.0.cmp(&b.0));
            for (k, v) in &rows {
                b.push(&mut sink, k, v);
            }
            let root = b.finish(&mut sink);
            sink.out.flush().unwrap();
            std::fs::write(
                format!("{dir}/root.json"),
                format!(
                    r#"{{"root":{},"height":{},"rows":{},"pages":{},"projects":{}}}"#,
                    root.root, root.height, root.rows, sink.next, projects
                ),
            )
            .unwrap();
            println!("{} rows → {} pages, height {}, root {}", root.rows, sink.next, root.height, root.root);
        }
        _ => eprintln!("usage: pagedb-builder bench-tree <out-dir> <rows>"),
    }
}
