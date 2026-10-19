//! Deterministic issue-tracker data. Every row is a pure function of (config, project, issue,
//! comment), so the builder can produce any slice independently (and in parallel), and tests
//! can regenerate a project as an oracle without storing the dataset.
//!
//! Shape follows the r2db demo: ~10k issues per project with ±50 % skew, ~5k users, statuses
//! skewed to done for older issues, 0–3 tags from a fixed vocabulary, and comments whose first
//! entry is the issue's description.

use crate::catalog::{tags_json, PRIORITIES, STATUSES};
use crate::codec::Value;

#[derive(Clone, Debug)]
pub struct Config {
    pub seed: u64,
    pub projects: u32,
    pub issues_per_project: u32,
    pub users: u32,
    /// Mean comments per issue, including the description.
    pub comments_per_issue: f64,
    /// Newest comments kept in the base feed index (comment_by_created).
    pub feed_base: usize,
}

impl Config {
    pub fn with_projects(projects: u32) -> Self {
        Config { seed: 7, projects, issues_per_project: 10_000, users: 5_000, comments_per_issue: 5.0, feed_base: 500_000 }
    }
}

/// "Now" for the generated history (2026-10-15); the newest issues are a few hours older.
pub const NOW: f64 = 1_792_000_000_000.0;
const SPAN: f64 = 3.0 * 365.0 * 86_400_000.0;

pub struct Rng(u64);

impl Rng {
    pub fn new(parts: &[u64]) -> Self {
        let mut s = 0x243F_6A88_85A3_08D3u64;
        for &p in parts {
            s = mix(s ^ p.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        }
        Rng(s)
    }
    #[inline]
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix(self.0)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Skewed pick in [0, n): small indexes are much more likely (zipf-ish).
    pub fn skewed(&mut self, n: u64) -> u64 {
        let u = self.unit();
        ((u * u * u) * n as f64) as u64 % n.max(1)
    }
}

#[inline]
fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

const WORDS: &[&str] = &[
    "sync", "cursor", "page", "fault", "query", "board", "issue", "latency", "object", "durable", "cache", "socket",
    "render", "filter", "index", "merge", "replica", "lease", "overlay", "branch", "leaf", "tier", "edge", "worker",
    "token", "session", "upload", "export", "import", "search", "toast", "modal", "sidebar", "header", "billing",
    "invoice", "webhook", "retry", "timeout", "crash", "spinner", "avatar", "theme", "dark", "mode", "offline",
    "keyboard", "shortcut", "scroll", "jank", "flicker", "drag", "drop", "column", "card", "label", "comment",
    "mention", "notification", "email", "digest", "permission", "role", "admin", "invite", "onboarding", "settings",
];
const VERBS: &[&str] = &[
    "breaks", "freezes", "drops", "duplicates", "ignores", "loses", "misses", "reorders", "flickers on", "times out on",
    "double-counts", "hides", "leaks", "stalls on", "rejects", "mangles",
];
const TAGS: &[&str] = &[
    "api", "auth", "backend", "billing", "bug", "chore", "cli", "data", "design", "docs", "editor", "feature",
    "frontend", "good-first-issue", "infra", "ios", "android", "web", "perf", "regression", "search", "security",
    "sync", "ux", "a11y", "i18n", "mobile", "desktop", "storage", "network", "flaky-test", "ci", "deps", "release",
    "triage", "needs-repro", "wontfix", "blocked", "customer", "p0",
];
const FIRST: &[&str] = &[
    "Ada", "Ben", "Chen", "Dana", "Eli", "Fatima", "Gus", "Hana", "Ivan", "Jia", "Kofi", "Lena", "Mateo", "Nia", "Omar",
    "Priya", "Quinn", "Rosa", "Sven", "Tara", "Uma", "Viktor", "Wen", "Ximena", "Yusuf", "Zoe",
];
const LAST: &[&str] = &[
    "Adams", "Baker", "Castillo", "Diaz", "Eriksen", "Fischer", "Garcia", "Hughes", "Ito", "Jensen", "Kowalski",
    "Lopez", "Moreau", "Nakamura", "Okafor", "Patel", "Quist", "Rossi", "Silva", "Tanaka", "Ueda", "Varga", "Weber",
    "Xu", "Yilmaz", "Zhou",
];

pub fn tag_vocab() -> Vec<String> {
    let mut t: Vec<String> = TAGS.iter().map(|s| s.to_string()).collect();
    t.sort();
    t
}

fn words(r: &mut Rng, n: usize) -> String {
    let mut out = String::new();
    for i in 0..n {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(WORDS[r.below(WORDS.len() as u64) as usize]);
    }
    out
}

fn sentence(r: &mut Rng, min_chars: usize, max_chars: usize) -> String {
    let target = min_chars + r.below((max_chars - min_chars) as u64 + 1) as usize;
    let mut s = String::with_capacity(target + 16);
    while s.len() < target {
        if !s.is_empty() {
            s.push_str(". ");
        }
        let n = 4 + r.below(8) as usize;
        let w = words(r, n);
        let mut c = w.chars();
        if let Some(f) = c.next() {
            s.extend(f.to_uppercase());
            s.push_str(c.as_str());
        }
    }
    s.push('.');
    s
}

pub fn project_id(p: u32) -> String {
    format!("p{p:04}")
}
pub fn user_id(u: u32) -> String {
    format!("u{u:05}")
}
pub fn issue_id(p: u32, s: u32) -> String {
    format!("i{p:04}{s:05}")
}
pub fn comment_id(p: u32, s: u32, j: u32) -> String {
    format!("c{p:04}{s:05}{j:03}")
}

pub fn project_row(cfg: &Config, p: u32) -> Vec<Value> {
    let mut r = Rng::new(&[cfg.seed, 1, p as u64]);
    let name = format!("{} {}", capitalize(WORDS[r.below(WORDS.len() as u64) as usize]), capitalize(WORDS[r.below(WORDS.len() as u64) as usize]));
    let key: String = (0..3).map(|_| (b'A' + r.below(26) as u8) as char).collect();
    vec![Value::from(project_id(p)), Value::from(name), Value::from(key)]
}

pub fn user_row(cfg: &Config, u: u32) -> Vec<Value> {
    let mut r = Rng::new(&[cfg.seed, 2, u as u64]);
    let name = format!("{} {}", FIRST[r.below(FIRST.len() as u64) as usize], LAST[r.below(LAST.len() as u64) as usize]);
    vec![Value::from(user_id(u)), Value::from(name)]
}

fn capitalize(w: &str) -> String {
    let mut c = w.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Issues in project `p` (skewed ±50 % around the configured mean).
pub fn issue_count(cfg: &Config, p: u32) -> u32 {
    let mut r = Rng::new(&[cfg.seed, 3, p as u64]);
    let f = 0.5 + r.unit();
    ((cfg.issues_per_project as f64) * f).round().max(1.0) as u32
}

fn created_at(cfg: &Config, p: u32, s: u32, n: u32) -> f64 {
    // Evenly spread over SPAN, ending a project-specific few hours before NOW; ms resolution,
    // strictly increasing with s.
    let mut r = Rng::new(&[cfg.seed, 4, p as u64]);
    let end = NOW - (r.below(12) as f64 + 1.0) * 3_600_000.0;
    let step = (SPAN / n as f64).floor().max(1.0);
    end - (n - 1 - s) as f64 * step
}

pub struct GenIssue {
    pub row: Vec<Value>,
    pub comments: u32,
}

/// Issue `s` of project `p` (its commentCount and updatedAt reflect its generated comments).
pub fn issue(cfg: &Config, p: u32, s: u32) -> GenIssue {
    let n = issue_count(cfg, p);
    let mut r = Rng::new(&[cfg.seed, 5, p as u64, s as u64]);
    let created = created_at(cfg, p, s, n);
    let age = (n - s) as f64 / n as f64; // 1 = oldest
    let status = if r.unit() < age * 0.8 { "done" } else { STATUSES[r.below(4) as usize] };
    let priority = PRIORITIES[r.skewed(4) as usize % 4];
    let owner = user_id(r.skewed(cfg.users as u64) as u32);
    let title = {
        let subject = WORDS[r.below(WORDS.len() as u64) as usize];
        let verb = VERBS[r.below(VERBS.len() as u64) as usize];
        let n = 2 + r.below(4) as usize;
        format!("{} {} {}", capitalize(subject), verb, words(&mut r, n))
    };
    let mut tags: Vec<String> = (0..r.below(4)).map(|_| TAGS[r.skewed(TAGS.len() as u64) as usize].to_string()).collect();
    tags.sort();
    tags.dedup();
    let comments = comment_count(cfg, p, s);
    let updated = if comments > 1 { comment_time(cfg, p, s, comments - 1, created) } else { created };
    GenIssue {
        row: vec![
            Value::from(issue_id(p, s)),
            Value::from(project_id(p)),
            Value::from(title),
            Value::from(status),
            Value::from(priority),
            Value::from(owner),
            Value::Num(created),
            Value::Num(updated),
            Value::Num(comments as f64),
            Value::from(tags_json(&tags)),
        ],
        comments,
    }
}

pub fn comment_count(cfg: &Config, p: u32, s: u32) -> u32 {
    let mut r = Rng::new(&[cfg.seed, 6, p as u64, s as u64]);
    // 1 (description) + geometric with the remaining mean.
    let extra_mean = (cfg.comments_per_issue - 1.0).max(0.0);
    let q = extra_mean / (1.0 + extra_mean);
    let mut k = 1;
    while k < 200 && r.unit() < q {
        k += 1;
    }
    k
}

fn comment_time(cfg: &Config, p: u32, s: u32, j: u32, created: f64) -> f64 {
    if j == 0 {
        return created;
    }
    let mut r = Rng::new(&[cfg.seed, 7, p as u64, s as u64]);
    let mut t = created;
    for _ in 0..j {
        t += 60_000.0 + (r.unit() * r.unit() * 5.0 * 86_400_000.0).floor();
    }
    t.min(NOW - 60_000.0 + j as f64) // stays in the past, still strictly increasing
}

/// Comment `j` of issue `s` in project `p` (j = 0 is the description).
pub fn comment(cfg: &Config, p: u32, s: u32, j: u32, issue_row: &[Value]) -> Vec<Value> {
    let mut r = Rng::new(&[cfg.seed, 8, p as u64, s as u64, j as u64]);
    let created = comment_time(cfg, p, s, j, issue_row[crate::catalog::issue::CREATED].as_num().unwrap());
    let body = if j == 0 { sentence(&mut r, 120, 520) } else { sentence(&mut r, 30, 300) };
    let author = if j == 0 { issue_row[crate::catalog::issue::OWNER].clone() } else { Value::from(user_id(r.skewed(cfg.users as u64) as u32)) };
    vec![
        Value::from(comment_id(p, s, j)),
        Value::from(issue_id(p, s)),
        author,
        Value::from(body),
        Value::Num(created),
        Value::from(project_id(p)),
        issue_row[crate::catalog::issue::TITLE].clone(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_ordered() {
        let cfg = Config::with_projects(3);
        let a = issue(&cfg, 1, 42).row;
        let b = issue(&cfg, 1, 42).row;
        assert_eq!(a, b);
        let n = issue_count(&cfg, 1);
        let mut last = 0.0;
        for s in 0..n {
            let c = issue(&cfg, 1, s).row[crate::catalog::issue::CREATED].as_num().unwrap();
            assert!(c > last, "createdAt must increase with s");
            last = c;
        }
        assert!(last < NOW);
        let is = issue(&cfg, 2, 7);
        let mut prev = 0.0;
        for j in 0..is.comments {
            let c = comment(&cfg, 2, 7, j, &is.row);
            let t = c[crate::catalog::comment::CREATED].as_num().unwrap();
            assert!(t >= prev);
            prev = t;
        }
    }

    #[test]
    fn mean_comments_close_to_config() {
        let cfg = Config::with_projects(1);
        let n = 20_000;
        let total: u32 = (0..n).map(|s| comment_count(&cfg, 0, s)).sum();
        let mean = total as f64 / n as f64;
        assert!((mean - cfg.comments_per_issue).abs() < 0.2, "mean {mean}");
    }
}
