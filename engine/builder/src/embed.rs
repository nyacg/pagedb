//! Embeddings for a table's rows, as PVEC shards in R2.
//!
//!   pagedb-builder embed --text story --prefix vec/<model>/stories [--batch 100] [--threads 32]
//!       [--rpm 2800] [--shard 16384] [--limit N] < rows.ndjson
//!
//! Rows (JSON lines, in a stable order) are cut into shards of `--shard` rows. Each shard is
//! embedded in batches, `--threads` requests in flight under a requests-per-minute budget, and
//! PUT to `$R2_PUT/<prefix>/shard-NNNNNN.bin` (the builder container's R2 route). Shards already
//! there are skipped, so a rerun resumes. The model is behind one of:
//!   - Workers AI REST: AI_ACCOUNT + AI_TOKEN (+ EMBED_MODEL, default @cf/qwen/qwen3-embedding-0.6b)
//!   - any OpenAI-compatible /embeddings endpoint (e.g. EmbeddingGemma behind AI Gateway):
//!     EMBED_URL (+ EMBED_KEY, EMBED_MODEL)
//! A document's text is `story_text` (the TS side has the same function for writes; a fixture
//! test pins them together).

use crate::shard;
use serde_json::{json, Value as J};
use std::io::BufRead;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_MODEL: &str = "@cf/qwen/qwen3-embedding-0.6b";
/// Queries carry a task instruction (Qwen3 embeddings are asymmetric); same as src/embed.ts.
pub const QUERY_INSTRUCTION: &str = "Instruct: Given a search query, retrieve relevant Hacker News stories\nQuery: ";

/// A search query as the Worker embeds it.
pub fn query_text(q: &str) -> String {
    format!("{QUERY_INSTRUCTION}{}", q.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// The text embedded for an HN story: its title, the site it links to, and the start of its
/// text (Ask HN bodies), with HTML removed.
pub fn story_text(row: &J) -> String {
    let mut s = row["title"].as_str().unwrap_or("").trim().to_string();
    if let Some(d) = row["domain"].as_str().filter(|d| !d.is_empty()) {
        s.push_str(" (");
        s.push_str(d);
        s.push(')');
    }
    if let Some(t) = row["text"].as_str() {
        let t = strip_html(t);
        let t = t.trim();
        if !t.is_empty() {
            s.push('\n');
            s.extend(t.chars().take(2000));
        }
    }
    s
}

/// Tags removed (paragraph breaks kept as newlines), common entities decoded.
pub fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' => {
                let mut tag = String::new();
                for t in chars.by_ref() {
                    if t == '>' {
                        break;
                    }
                    tag.push(t);
                }
                let t = tag.trim_start_matches('/').to_ascii_lowercase();
                if t.starts_with('p') || t.starts_with("br") || t.starts_with("pre") {
                    out.push('\n');
                }
            }
            '&' => {
                let mut ent = String::new();
                while let Some(&t) = chars.peek() {
                    if t == ';' || ent.len() > 8 {
                        break;
                    }
                    ent.push(t);
                    chars.next();
                }
                let semi = chars.peek() == Some(&';');
                if semi {
                    chars.next();
                }
                match (ent.as_str(), semi) {
                    ("amp", true) => out.push('&'),
                    ("lt", true) => out.push('<'),
                    ("gt", true) => out.push('>'),
                    ("quot", true) => out.push('"'),
                    ("apos", true) => out.push('\''),
                    ("nbsp", true) => out.push(' '),
                    (e, true) if e.starts_with("#x") || e.starts_with("#X") => out.extend(u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32)),
                    (e, true) if e.starts_with('#') => out.extend(e[1..].parse::<u32>().ok().and_then(char::from_u32)),
                    (e, _) => {
                        out.push('&');
                        out.push_str(e);
                        if semi {
                            out.push(';');
                        }
                    }
                }
            }
            c => out.push(c),
        }
    }
    out
}

pub trait Embedder: Sync {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;
    fn model(&self) -> String;
}

pub struct WorkersAi {
    pub account: String,
    pub token: String,
    pub model: String,
    agent: ureq::Agent,
}

pub struct OpenAiCompat {
    pub url: String,
    pub key: Option<String>,
    pub model: String,
    agent: ureq::Agent,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build()
}

impl Embedder for WorkersAi {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let url = format!("https://api.cloudflare.com/client/v4/accounts/{}/ai/run/{}", self.account, self.model);
        let r = self.agent.post(&url).set("authorization", &format!("Bearer {}", self.token)).set("content-type", "application/json").send_string(&json!({ "text": texts }).to_string());
        let body: J = match r {
            Ok(r) => serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(code, r)) => return Err(format!("{code}: {}", r.into_string().unwrap_or_default().chars().take(300).collect::<String>())),
            Err(e) => return Err(e.to_string()),
        };
        vectors(&body["result"]["data"], texts.len())
    }
    fn model(&self) -> String {
        self.model.clone()
    }
}

impl Embedder for OpenAiCompat {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let mut req = self.agent.post(&self.url);
        if let Some(k) = &self.key {
            req = req.set("authorization", &format!("Bearer {k}"));
        }
        let body: J = match req.set("content-type", "application/json").send_string(&json!({ "model": self.model, "input": texts }).to_string()) {
            Ok(r) => serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(code, r)) => return Err(format!("{code}: {}", r.into_string().unwrap_or_default().chars().take(300).collect::<String>())),
            Err(e) => return Err(e.to_string()),
        };
        let data: Vec<J> = body["data"].as_array().ok_or("no data")?.iter().map(|d| d["embedding"].clone()).collect();
        vectors(&J::from(data), texts.len())
    }
    fn model(&self) -> String {
        self.model.clone()
    }
}

fn vectors(data: &J, n: usize) -> Result<Vec<Vec<f32>>, String> {
    let rows = data.as_array().ok_or("no vectors in the response")?;
    if rows.len() != n {
        return Err(format!("{} vectors for {n} texts", rows.len()));
    }
    Ok(rows.iter().map(|v| v.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default()).collect())
}

/// The embedder configured by the environment.
pub fn from_env() -> Box<dyn Embedder> {
    let model = std::env::var("EMBED_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
    if let Ok(url) = std::env::var("EMBED_URL") {
        return Box::new(OpenAiCompat { url, key: std::env::var("EMBED_KEY").ok(), model, agent: agent() });
    }
    Box::new(WorkersAi {
        account: std::env::var("AI_ACCOUNT").expect("AI_ACCOUNT (or EMBED_URL)"),
        token: std::env::var("AI_TOKEN").expect("AI_TOKEN"),
        model,
        agent: agent(),
    })
}

/// A requests-per-minute budget shared by every thread.
pub struct Bucket {
    next: Mutex<Instant>,
    gap: Duration,
}

impl Bucket {
    pub fn per_minute(rpm: u64) -> Bucket {
        Bucket { next: Mutex::new(Instant::now()), gap: Duration::from_micros(60_000_000 / rpm.max(1)) }
    }

    fn take(&self) {
        let wait = {
            let mut n = self.next.lock().unwrap();
            let now = Instant::now();
            let at = (*n).max(now);
            *n = at + self.gap;
            at - now
        };
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
    }
}

/// Embed with retries; a batch the model rejects outright is split, and a single text it
/// still rejects is embedded as its first 300 characters.
pub fn embed_retry(e: &dyn Embedder, bucket: &Bucket, texts: &[String]) -> Vec<Vec<f32>> {
    for attempt in 0..8 {
        bucket.take();
        match e.embed(texts) {
            Ok(v) => return v,
            Err(msg) if msg.starts_with("400") || msg.starts_with("413") => {
                if texts.len() > 1 {
                    let (a, b) = texts.split_at(texts.len() / 2);
                    let mut v = embed_retry(e, bucket, a);
                    v.extend(embed_retry(e, bucket, b));
                    return v;
                }
                let short: String = texts[0].chars().take(300).collect();
                if short.len() < texts[0].len() {
                    return embed_retry(e, bucket, &[short]);
                }
                panic!("the model rejects {:?}: {msg}", texts[0]);
            }
            Err(msg) => {
                if attempt >= 3 {
                    eprintln!("   retry {attempt}: {msg}");
                }
                std::thread::sleep(Duration::from_millis(500 << attempt.min(6)));
            }
        }
    }
    panic!("embedding failed after retries");
}

fn r2_url(key: &str) -> String {
    format!("{}/{}", std::env::var("R2_PUT").unwrap_or_else(|_| "http://r2.internal/put".into()), key)
}

/// R2_PUT_TOKEN: a bearer token for the route (outside the container, e.g. the Worker's admin route).
fn authed(r: ureq::Request) -> ureq::Request {
    match std::env::var("R2_PUT_TOKEN") {
        Ok(t) => r.set("authorization", &format!("Bearer {t}")),
        Err(_) => r,
    }
}

fn exists(key: &str) -> bool {
    authed(agent().head(&r2_url(key))).call().is_ok()
}

fn put(key: &str, body: &[u8]) {
    for attempt in 0..8 {
        match authed(agent().put(&r2_url(key))).send_bytes(body) {
            Ok(_) => return,
            Err(e) if attempt == 7 => panic!("PUT {key}: {e}"),
            Err(_) => std::thread::sleep(Duration::from_millis(500 << attempt)),
        }
    }
}

pub fn run(args: &[String]) {
    let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let prefix = arg("--prefix").expect("--prefix vec/<model>/<corpus>");
    let batch: usize = arg("--batch").map(|v| v.parse().unwrap()).unwrap_or(100);
    let threads: usize = arg("--threads").map(|v| v.parse().unwrap()).unwrap_or(32);
    let rpm: u64 = arg("--rpm").map(|v| v.parse().unwrap()).unwrap_or(2800);
    let shard_rows: usize = arg("--shard").map(|v| v.parse().unwrap()).unwrap_or(16_384);
    let limit: u64 = arg("--limit").map(|v| v.parse().unwrap()).unwrap_or(u64::MAX);
    assert_eq!(arg("--text").as_deref().unwrap_or("story"), "story", "only story text is defined");
    let e = from_env();
    let bucket = Bucket { next: Mutex::new(Instant::now()), gap: Duration::from_micros(60_000_000 / rpm.max(1)) };
    let t0 = Instant::now();
    let (done, skipped, tokens) = (AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0));
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut n_shard = 0usize;
    let mut total = 0u64;
    loop {
        // One shard's rows.
        let mut rows: Vec<String> = Vec::with_capacity(shard_rows);
        while rows.len() < shard_rows && total < limit {
            match lines.next() {
                Some(Ok(l)) if !l.trim().is_empty() => {
                    rows.push(l);
                    total += 1;
                }
                Some(Ok(_)) => continue,
                Some(Err(err)) => panic!("read: {err}"),
                None => break,
            }
        }
        if rows.is_empty() {
            break;
        }
        let key = format!("{prefix}/shard-{n_shard:06}.bin");
        n_shard += 1;
        if exists(&key) {
            skipped.fetch_add(rows.len() as u64, Ordering::Relaxed);
            continue;
        }
        let texts: Vec<String> = rows.iter().map(|l| story_text(&serde_json::from_str::<J>(l).unwrap_or(J::Null))).map(|t| if t.trim().is_empty() { "(untitled)".to_string() } else { t }).collect();
        tokens.fetch_add(texts.iter().map(|t| t.len() as u64 / 4 + 1).sum(), Ordering::Relaxed);
        let batches: Vec<&[String]> = texts.chunks(batch).collect();
        let out: Vec<Mutex<Option<Vec<Vec<f32>>>>> = batches.iter().map(|_| Mutex::new(None)).collect();
        let next = AtomicU64::new(0);
        std::thread::scope(|sc| {
            for _ in 0..threads.min(batches.len()) {
                sc.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed) as usize;
                    if i >= batches.len() {
                        break;
                    }
                    let v = embed_retry(e.as_ref(), &bucket, batches[i]);
                    *out[i].lock().unwrap() = Some(v);
                });
            }
        });
        let vecs: Vec<Vec<f32>> = out.into_iter().flat_map(|m| m.into_inner().unwrap().unwrap()).collect();
        let dims = vecs[0].len();
        let items: Vec<(String, Vec<f32>)> = rows.into_iter().zip(vecs).map(|(r, v)| (r, if v.len() == dims { v } else { vec![0.0; dims] })).collect();
        put(&key, &shard::encode(dims, &items));
        let d = done.fetch_add(items.len() as u64, Ordering::Relaxed) + items.len() as u64;
        let secs = t0.elapsed().as_secs_f64();
        eprintln!(
            "embedded {d} rows in {n_shard} shards ({} skipped) {:.0}/s, ~{:.1}M tokens, {secs:.0}s [{}]",
            skipped.load(Ordering::Relaxed),
            d as f64 / secs,
            tokens.load(Ordering::Relaxed) as f64 / 1e6,
            e.model()
        );
    }
    let summary = json!({"prefix": prefix, "shards": n_shard, "rows": total, "embedded": done.load(Ordering::Relaxed), "skipped": skipped.load(Ordering::Relaxed), "model": e.model(), "secs": t0.elapsed().as_secs_f64()});
    put(&format!("{prefix}/index.json"), summary.to_string().as_bytes());
    println!("{summary}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn story_text_fixture() {
        // The same fixture is checked against the TS storyText (src/embed.ts).
        let fx: J = serde_json::from_str(include_str!("../../../datasets/hn/embed-fixture.json")).unwrap();
        for case in fx.as_array().unwrap() {
            assert_eq!(story_text(&case["row"]), case["text"].as_str().unwrap(), "{}", case["row"]);
        }
    }
}
