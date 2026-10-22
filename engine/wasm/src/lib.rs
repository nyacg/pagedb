//! WASM boundary for the Durable Object shell. Raw exports/imports, no bindgen.
//! (Only built for wasm32: natively, its exported `write` would clash with libc's.)
#![cfg(target_arch = "wasm32")]
//!
//! Calls never block. Each call returns a status; the payload is left in the output buffer
//! (`out_ptr`/`out_len`):
//!   0 OK      payload = result bytes (JSON for now)
//!   1 FAULT   payload = u64 little-endian page ids to fetch, then call again
//!   2 ERROR   payload = UTF-8 message
//! The shell supplies pages in two ways: `page_put` after a fetch (into the RAM tier), and
//! the synchronous `host_page_get` import, which the engine calls on a RAM miss to read the
//! DO's SQLite page cache.

use pagedb_core::codec::{json_cell, json_str, RowRef};
use pagedb_core::page::{Page, PageId, PAGE_SIZE};
use pagedb_core::tree::{self, Ctx, Miss, PageStore, Range, TreeRoot};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[link(wasm_import_module = "host")]
extern "C" {
    /// Copy page `id` into `dst` (PAGE_SIZE bytes) if the host's synchronous tier has it.
    fn host_page_get(id_lo: u32, id_hi: u32, dst: *mut u8) -> u32;
    /// A fold wrote page `id` (PAGE_SIZE bytes at `src`): the host stores it synchronously.
    fn host_page_out(id_lo: u32, id_hi: u32, src: *const u8);
}

// ------------------------------------------------------------------ RAM tier

struct Ram {
    pages: HashMap<PageId, (Rc<[u8]>, u64)>,
    tick: u64,
    budget: usize,
    hits: u64,
    host_hits: u64,
}

impl Ram {
    fn insert(&mut self, id: PageId, page: Rc<[u8]>) {
        self.tick += 1;
        self.pages.insert(id, (page, self.tick));
        if self.pages.len() > self.budget {
            // Evict the least recently used eighth in one pass (amortized; budget is small).
            let mut ages: Vec<(u64, PageId)> = self.pages.iter().map(|(id, (_, t))| (*t, *id)).collect();
            ages.sort_unstable();
            for (_, id) in ages.into_iter().take(self.budget / 8 + 1) {
                self.pages.remove(&id);
            }
        }
    }
}

struct Db {
    roots: pagedb_core::query::Roots,
    plans: HashMap<String, Rc<pagedb_core::query::Plan>>,
    overlay: pagedb_core::overlay::Overlay,
    parts: HashMap<u32, Live>,
    by_ast: HashMap<String, u32>,
    next_pid: u32,
    /// A fold's new layer, built and uploading, not yet swapped in.
    pending: Option<Rc<pagedb_core::overlay::Layer>>,
}

/// A live partition and how many subscriptions share it.
struct Live {
    part: pagedb_core::ivm::Partition,
    refs: u32,
    ast: String,
}

thread_local! {
    static DB: RefCell<Option<Db>> = RefCell::new(None);
    static RAM: RefCell<Ram> = RefCell::new(Ram { pages: HashMap::new(), tick: 0, budget: 512, hits: 0, host_hits: 0 });
    static OUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

struct Tiers;

impl PageStore for Tiers {
    fn get(&self, id: PageId) -> Option<Rc<[u8]>> {
        let hit = RAM.with(|r| {
            let mut r = r.borrow_mut();
            r.tick += 1;
            let t = r.tick;
            let found = r.pages.get_mut(&id).map(|e| {
                e.1 = t;
                e.0.clone()
            });
            if found.is_some() {
                r.hits += 1;
            }
            found
        });
        if hit.is_some() {
            return hit;
        }
        let mut buf = vec![0u8; PAGE_SIZE];
        let ok = unsafe { host_page_get(id as u32, (id >> 32) as u32, buf.as_mut_ptr()) };
        if ok == 0 {
            return None;
        }
        let page: Rc<[u8]> = buf.into();
        RAM.with(|r| {
            let mut r = r.borrow_mut();
            r.host_hits += 1;
            r.insert(id, page.clone())
        });
        Some(page)
    }
}

// ------------------------------------------------------------------ exports

fn set_out(bytes: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = bytes);
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> u32 {
    OUT.with(|o| o.borrow().len() as u32)
}

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    drop(Vec::from_raw_parts(ptr, 0, len as usize));
}

/// Give the RAM tier a page (after the shell fetched it). Returns 0 if the checksum fails.
#[no_mangle]
pub unsafe extern "C" fn page_put(id_lo: u32, id_hi: u32, ptr: *const u8) -> u32 {
    let bytes = std::slice::from_raw_parts(ptr, PAGE_SIZE);
    if Page::check(bytes).is_err() {
        return 0;
    }
    let id = (id_hi as u64) << 32 | id_lo as u64;
    RAM.with(|r| r.borrow_mut().insert(id, bytes.to_vec().into()));
    1
}

#[no_mangle]
pub extern "C" fn set_ram_budget(pages: u32) {
    RAM.with(|r| r.borrow_mut().budget = pages.max(8) as usize);
}

/// Stats: [ram pages, ram hits, host hits] as u64 LE in the output buffer.
#[no_mangle]
pub extern "C" fn stats() -> u32 {
    let s = RAM.with(|r| {
        let r = r.borrow();
        [r.pages.len() as u64, r.hits, r.host_hits]
    });
    set_out(s.iter().flat_map(|v| v.to_le_bytes()).collect());
    0
}

fn finish<T>(ctx: &Ctx, r: Result<T, Miss>, ok: impl FnOnce(T) -> Vec<u8>) -> u32 {
    match r {
        Ok(v) => {
            set_out(ok(v));
            0
        }
        Err(Miss) => {
            set_out(ctx.take_want().iter().flat_map(|id| id.to_le_bytes()).collect());
            1
        }
    }
}

unsafe fn slice<'a>(ptr: *const u8, len: u32) -> &'a [u8] {
    std::slice::from_raw_parts(ptr, len as usize)
}

fn root_of(root_lo: u32, root_hi: u32, height: u32, rows: f64) -> TreeRoot {
    TreeRoot { tree: 0, leaves: 0, root: (root_hi as u64) << 32 | root_lo as u64, height: height as u8, rows: rows as u64 }
}

/// Point lookup; OK payload = the value bytes (empty if absent).
#[no_mangle]
pub unsafe extern "C" fn tree_get(root_lo: u32, root_hi: u32, height: u32, key: *const u8, key_len: u32) -> u32 {
    let store = Tiers;
    let ctx = Ctx::new(&store);
    let root = root_of(root_lo, root_hi, height, 0.0);
    let r = tree::get(&ctx, &root, slice(key, key_len));
    finish(&ctx, r, |v| v.unwrap_or_default())
}

/// Range scan rendered as a JSON array of row arrays (the shape a poke will carry).
#[no_mangle]
pub unsafe extern "C" fn tree_scan_json(
    root_lo: u32,
    root_hi: u32,
    height: u32,
    lo: *const u8,
    lo_len: u32,
    hi: *const u8,
    hi_len: u32,
    limit: u32,
    reverse: u32,
) -> u32 {
    let store = Tiers;
    let ctx = Ctx::new(&store);
    let root = root_of(root_lo, root_hi, height, 0.0);
    let (lo, hi) = (slice(lo, lo_len), slice(hi, hi_len));
    let mut out = String::with_capacity(limit as usize * 128);
    let mut n = 0u32;
    out.push('[');
    let r = tree::scan(&ctx, &root, &Range { lo, hi }, reverse != 0, limit as usize, &mut |_, v| {
        if n > 0 {
            out.push(',');
        }
        out.push('[');
        for (i, c) in RowRef(v).cells().enumerate() {
            if i > 0 {
                out.push(',');
            }
            json_cell(&mut out, c);
        }
        out.push(']');
        n += 1;
        n < limit
    });
    out.push(']');
    finish(&ctx, r, |_| out.into_bytes())
}

/// Count entries in [lo, hi); OK payload = u64 LE.
#[no_mangle]
pub unsafe extern "C" fn tree_count(root_lo: u32, root_hi: u32, height: u32, rows: f64, lo: *const u8, lo_len: u32, hi: *const u8, hi_len: u32) -> u32 {
    let store = Tiers;
    let ctx = Ctx::new(&store);
    let root = root_of(root_lo, root_hi, height, rows);
    let r = tree::count(&ctx, &root, &Range { lo: slice(lo, lo_len), hi: slice(hi, hi_len) });
    finish(&ctx, r, |n| n.to_le_bytes().to_vec())
}

#[allow(dead_code)]
fn _keep(s: &mut String) {
    json_str(s, "");
}

fn error(msg: impl Into<String>) -> u32 {
    set_out(msg.into().into_bytes());
    2
}

/// Load the manifest (JSON). Must be called before `query`.
#[no_mangle]
pub unsafe extern "C" fn init(ptr: *const u8, len: u32) -> u32 {
    let m: serde_json::Value = match serde_json::from_slice(slice(ptr, len)) {
        Ok(v) => v,
        Err(e) => return error(format!("bad manifest: {e}")),
    };
    match pagedb_core::query::Roots::from_manifest(&m) {
        Ok(roots) => {
            DB.with(|d| {
                *d.borrow_mut() = Some(Db {
                    roots,
                    plans: HashMap::new(),
                    overlay: Default::default(),
                    parts: HashMap::new(),
                    by_ast: HashMap::new(),
                    next_pid: 1,
                    pending: None,
                })
            });
            set_out(Vec::new());
            0
        }
        Err(e) => error(e),
    }
}

/// Run a query AST (JSON). OK payload: {"rows":[…],"complete":bool,"keys":[hex…]} or {"count":n}.
#[no_mangle]
pub unsafe extern "C" fn query(ptr: *const u8, len: u32) -> u32 {
    use pagedb_core::query::{compile, execute, Output};
    let text = match std::str::from_utf8(slice(ptr, len)) {
        Ok(t) => t,
        Err(_) => return error("query is not UTF-8"),
    };
    let plan = DB.with(|d| {
        let mut d = d.borrow_mut();
        let db = d.as_mut()?;
        if let Some(p) = db.plans.get(text) {
            return Some(Ok(p.clone()));
        }
        let ast: serde_json::Value = match serde_json::from_str(text) {
            Ok(a) => a,
            Err(e) => return Some(Err(format!("bad query JSON: {e}"))),
        };
        Some(compile(db.roots.schema, &ast).map(|p| {
            let p = Rc::new(p);
            if db.plans.len() > 4096 {
                db.plans.clear();
            }
            db.plans.insert(text.to_string(), p.clone());
            p
        }))
    });
    let plan = match plan {
        None => return error("engine not initialized"),
        Some(Err(e)) => return error(e),
        Some(Ok(p)) => p,
    };
    let store = Tiers;
    let guard = DB.with(|d| d.as_ptr());
    let db = unsafe { (*guard).as_ref().unwrap() };
    let view = pagedb_core::overlay::View::new(&db.overlay);
    let ctx = Ctx::with_view(&store, &view);
    let r = execute(&ctx, &db.roots, &plan);
    finish(&ctx, r, |o| match o {
        Output::Count(n) => format!("{{\"count\":{n}}}").into_bytes(),
        Output::Rows { hits, complete } => {
            let mut s = String::with_capacity(hits.iter().map(|h| h.json.len() + 1).sum::<usize>() + 32);
            s.push_str("{\"rows\":[");
            for (i, h) in hits.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&h.json);
            }
            s.push_str("],\"complete\":");
            s.push_str(if complete { "true" } else { "false" });
            s.push('}');
            s.into_bytes()
        }
    })
}

// ------------------------------------------------------------------ live queries and writes

fn plan_for(db: &mut Db, text: &str) -> Result<Rc<pagedb_core::query::Plan>, String> {
    if let Some(p) = db.plans.get(text) {
        return Ok(p.clone());
    }
    let ast: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("bad query JSON: {e}"))?;
    let p = Rc::new(pagedb_core::query::compile(db.roots.schema, &ast)?);
    db.plans.insert(text.to_string(), p.clone());
    Ok(p)
}

fn rows_json(out: &pagedb_core::query::Output) -> String {
    use pagedb_core::query::Output;
    match out {
        Output::Count(n) => format!("\"count\":{n}"),
        Output::Rows { hits, complete } => {
            let mut s = String::from("\"rows\":[");
            for (i, h) in hits.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&h.json);
            }
            s.push_str("],\"complete\":");
            s.push_str(if *complete { "true" } else { "false" });
            s
        }
    }
}

/// Subscribe to a query. OK payload: {"pid":n,"rows":[…],"complete":b} or {"pid":n,"count":c}.
/// Identical queries share one partition (ref-counted).
#[no_mangle]
pub unsafe extern "C" fn subscribe(ptr: *const u8, len: u32) -> u32 {
    let text = match std::str::from_utf8(slice(ptr, len)) {
        Ok(t) => t.to_string(),
        Err(_) => return error("query is not UTF-8"),
    };
    let guard = DB.with(|d| d.as_ptr());
    let db = match (*guard).as_mut() {
        Some(db) => db,
        None => return error("engine not initialized"),
    };
    let plan = match plan_for(db, &text) {
        Ok(p) => p,
        Err(e) => return error(e),
    };
    let store = Tiers;
    let view = pagedb_core::overlay::View::new(&db.overlay);
    let ctx = Ctx::with_view(&store, &view);
    if let Some(&pid) = db.by_ast.get(&text) {
        let r = pagedb_core::query::execute(&ctx, &db.roots, &plan);
        let status = finish(&ctx, r, |o| format!("{{\"pid\":{pid},{}}}", rows_json(&o)).into_bytes());
        if status == 0 {
            db.parts.get_mut(&pid).unwrap().refs += 1;
        }
        return status;
    }
    let r = pagedb_core::ivm::hydrate(&ctx, &db.roots, plan);
    match r {
        Ok((part, out)) => {
            let pid = db.next_pid;
            db.next_pid += 1;
            db.parts.insert(pid, Live { part, refs: 1, ast: text.clone() });
            db.by_ast.insert(text, pid);
            set_out(format!("{{\"pid\":{pid},{}}}", rows_json(&out)).into_bytes());
            0
        }
        Err(Miss) => {
            set_out(ctx.take_want().iter().flat_map(|id| id.to_le_bytes()).collect());
            1
        }
    }
}

#[no_mangle]
pub extern "C" fn unsubscribe(pid: u32) -> u32 {
    DB.with(|d| {
        if let Some(db) = d.borrow_mut().as_mut() {
            let drop_it = match db.parts.get_mut(&pid) {
                Some(l) => {
                    l.refs = l.refs.saturating_sub(1);
                    l.refs == 0
                }
                None => false,
            };
            if drop_it {
                let l = db.parts.remove(&pid).unwrap();
                db.by_ast.remove(&l.ast);
            }
        }
    });
    0
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Overlay record: u16 tree | u32 klen | key | u8 kind (0 drop entry, 1 entry) | i8 delta |
/// u8 has_val | u32 vlen | val
fn encode_writes(writes: &[(pagedb_core::overlay::Key, Option<pagedb_core::overlay::Entry>)], out: &mut Vec<u8>) {
    for ((tree, key), e) in writes {
        out.extend_from_slice(&tree.to_le_bytes());
        put_u32(out, key.len() as u32);
        out.extend_from_slice(key);
        match e {
            None => out.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0]),
            Some(e) => {
                out.push(1);
                out.push(e.delta as u8);
                match &e.val {
                    None => out.extend_from_slice(&[0, 0, 0, 0, 0]),
                    Some(v) => {
                        out.push(1);
                        put_u32(out, v.len() as u32);
                        out.extend_from_slice(v);
                    }
                }
            }
        }
    }
}

/// Load persisted overlay records (same encoding as write's) and the version.
#[no_mangle]
pub unsafe extern "C" fn ovl_load(ptr: *const u8, len: u32, version: f64) -> u32 {
    let b = slice(ptr, len);
    let mut writes = Vec::new();
    let mut p = 0;
    let u32_at = |p: usize| u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) as usize;
    while p < b.len() {
        let tree = u16::from_le_bytes([b[p], b[p + 1]]);
        let klen = u32_at(p + 2);
        let key = b[p + 6..p + 6 + klen].to_vec();
        p += 6 + klen;
        let kind = b[p];
        let delta = b[p + 1] as i8;
        let has = b[p + 2];
        p += 3;
        let vlen = u32_at(p);
        p += 4;
        let val = if has == 1 { Some(b[p..p + vlen].to_vec()) } else { None };
        p += vlen;
        writes.push(((tree, key), if kind == 1 { Some(pagedb_core::overlay::Entry { val, delta }) } else { None }));
    }
    DB.with(|d| {
        if let Some(db) = d.borrow_mut().as_mut() {
            db.overlay.apply(&writes);
            db.overlay.version = version as u64;
        }
    });
    set_out(Vec::new());
    0
}

/// Apply a write batch. OK payload: u32 json_len | json | overlay records, where json =
/// {"version":v,"changes":n,"pokes":{"<pid>":[["a",pk,row],["r",pk],["e",pk,row],["c",n]]}}.
/// FAULT: fetch pages and call again (nothing was applied). ERROR: invalid batch.
#[no_mangle]
pub unsafe extern "C" fn write(ptr: *const u8, len: u32) -> u32 {
    use pagedb_core::ivm::{compute, DeltaOp};
    use pagedb_core::write::{parse_ops, plan_write, WriteError};
    let ops_json: serde_json::Value = match serde_json::from_slice(slice(ptr, len)) {
        Ok(v) => v,
        Err(e) => return error(format!("bad ops JSON: {e}")),
    };
    let guard = DB.with(|d| d.as_ptr());
    let db = match (*guard).as_mut() {
        Some(db) => db,
        None => return error("engine not initialized"),
    };
    let ops = match parse_ops(db.roots.schema, &ops_json) {
        Ok(o) => o,
        Err(e) => return error(e),
    };
    let store = Tiers;
    let (writes, results, changes) = {
        let view = pagedb_core::overlay::View::new(&db.overlay);
        let ctx = Ctx::with_view(&store, &view);
        let changes = match plan_write(&ctx, &db.roots, &view, &ops) {
            Ok(c) => c,
            Err(WriteError::Miss) => {
                set_out(ctx.take_want().iter().flat_map(|id| id.to_le_bytes()).collect());
                return 1;
            }
            Err(WriteError::Invalid(e)) => return error(e),
        };
        let mut results = Vec::new();
        let mut missed = false;
        for (pid, live) in db.parts.iter() {
            match compute(&ctx, &db.roots, &live.part, &changes) {
                Ok(r) => results.push((*pid, r)),
                Err(Miss) => missed = true,
            }
        }
        if missed {
            set_out(ctx.take_want().iter().flat_map(|id| id.to_le_bytes()).collect());
            return 1;
        }
        (view.into_writes(), results, changes.len())
    };
    // Commit.
    db.overlay.apply(&writes);
    db.overlay.version += 1;
    let mut json = format!("{{\"version\":{},\"changes\":{changes},\"pokes\":{{", db.overlay.version);
    let mut first = true;
    for (pid, (state, ops)) in results {
        db.parts.get_mut(&pid).unwrap().part.state = state;
        if ops.is_empty() {
            continue;
        }
        if !first {
            json.push(',');
        }
        first = false;
        json.push_str(&format!("\"{pid}\":["));
        for (i, op) in ops.iter().enumerate() {
            if i > 0 {
                json.push(',');
            }
            match op {
                DeltaOp::Add { pk, json: row } => {
                    json.push_str("[\"a\",");
                    json_str(&mut json, pk);
                    json.push(',');
                    json.push_str(row);
                    json.push(']');
                }
                DeltaOp::Edit { pk, json: row } => {
                    json.push_str("[\"e\",");
                    json_str(&mut json, pk);
                    json.push(',');
                    json.push_str(row);
                    json.push(']');
                }
                DeltaOp::Remove { pk } => {
                    json.push_str("[\"r\",");
                    json_str(&mut json, pk);
                    json.push(']');
                }
                DeltaOp::Count(n) => json.push_str(&format!("[\"c\",{n}]")),
            }
        }
        json.push(']');
    }
    json.push_str("}}");
    let mut out = Vec::with_capacity(json.len() + 64);
    put_u32(&mut out, json.len() as u32);
    out.extend_from_slice(json.as_bytes());
    encode_writes(&writes, &mut out);
    set_out(out);
    0
}

/// The whole committed overlay as records (every entry kind 1), for compacting the log into
/// one snapshot without replaying it.
#[no_mangle]
pub extern "C" fn ovl_export() -> u32 {
    let mut out = Vec::new();
    DB.with(|d| {
        if let Some(db) = d.borrow().as_ref() {
            for ((tree, key), e) in &db.overlay.map {
                out.extend_from_slice(&tree.to_le_bytes());
                put_u32(&mut out, key.len() as u32);
                out.extend_from_slice(key);
                out.push(1);
                out.push(e.delta as u8);
                match &e.val {
                    None => out.extend_from_slice(&[0, 0, 0, 0, 0]),
                    Some(v) => {
                        out.push(1);
                        put_u32(&mut out, v.len() as u32);
                        out.extend_from_slice(v);
                    }
                }
            }
        }
    });
    set_out(out);
    0
}

#[no_mangle]
pub extern "C" fn overlay_stats() -> u32 {
    let s = DB.with(|d| d.borrow().as_ref().map(|db| [db.overlay.map.len() as u64, db.overlay.bytes as u64, db.overlay.version, db.parts.len() as u64]).unwrap_or_default());
    set_out(s.iter().flat_map(|v| v.to_le_bytes()).collect());
    0
}

// ------------------------------------------------------------------ folding (see core::fold)

fn root_json(r: &TreeRoot) -> serde_json::Value {
    // An empty tree has no root page: null (JSON readers mangle u64::MAX).
    if r.height == 0 {
        serde_json::json!([null, 0, 0])
    } else {
        serde_json::json!([r.root, r.height, r.rows])
    }
}

fn root_from(tree: u16, j: &serde_json::Value) -> Result<TreeRoot, String> {
    let a = j.as_array().ok_or("layer root")?;
    let height = a.get(1).and_then(|v| v.as_u64()).ok_or("layer height")? as u8;
    if height == 0 {
        return Ok(TreeRoot::empty(tree));
    }
    Ok(TreeRoot { tree, leaves: 0, root: a[0].as_u64().ok_or("layer root id")?, height, rows: a.get(2).and_then(|v| v.as_u64()).unwrap_or(0) })
}

fn layer_json(l: &pagedb_core::overlay::Layer) -> String {
    let mut trees: Vec<_> = l.trees.iter().collect();
    trees.sort_by_key(|(t, _)| **t);
    let trees: Vec<serde_json::Value> =
        trees.into_iter().map(|(t, x)| serde_json::json!({"tree": t, "d": root_json(&x.d), "plus": root_json(&x.plus), "minus": root_json(&x.minus)})).collect();
    serde_json::json!({ "trees": trees }).to_string()
}

/// Set the folded layer under the overlay (JSON as `fold_build` returns it). Call before
/// `ovl_load`: the persisted overlay is relative to base ⊕ this layer.
#[no_mangle]
pub unsafe extern "C" fn layer_set(ptr: *const u8, len: u32) -> u32 {
    let j: serde_json::Value = match serde_json::from_slice(slice(ptr, len)) {
        Ok(v) => v,
        Err(e) => return error(format!("bad layer: {e}")),
    };
    let mut layer = pagedb_core::overlay::Layer::default();
    for t in j.get("trees").and_then(|v| v.as_array()).into_iter().flatten() {
        let tree = match t.get("tree").and_then(|v| v.as_u64()) {
            Some(x) => x as u16,
            None => return error("layer tree id"),
        };
        let x = (|| -> Result<_, String> {
            Ok(pagedb_core::overlay::LayerTrees { d: root_from(tree, &t["d"])?, plus: root_from(tree, &t["plus"])?, minus: root_from(tree, &t["minus"])? })
        })();
        match x {
            Ok(x) => layer.trees.insert(tree, x),
            Err(e) => return error(e),
        };
    }
    DB.with(|d| {
        if let Some(db) = d.borrow_mut().as_mut() {
            db.overlay.layer = Some(Rc::new(layer));
        }
    });
    set_out(Vec::new());
    0
}

/// Fold step 1: fault in every page of the current layer.
#[no_mangle]
pub extern "C" fn fold_touch() -> u32 {
    let guard = DB.with(|d| d.as_ptr());
    let Some(db) = (unsafe { (*guard).as_ref() }) else { return error("engine not initialized") };
    let store = Tiers;
    let view = pagedb_core::overlay::View::new(&db.overlay);
    let ctx = Ctx::with_view(&store, &view);
    let r = pagedb_core::fold::touch(&ctx, &db.overlay);
    finish(&ctx, r, |_| Vec::new())
}

/// Pages a fold writes, numbered from `next`; each goes straight to the host.
struct HostSink {
    next: PageId,
}

impl tree::PageSink for HostSink {
    fn write(&mut self, page: Vec<u8>) -> PageId {
        let id = self.next;
        self.next += 1;
        unsafe { host_page_out(id as u32, (id >> 32) as u32, page.as_ptr()) };
        id
    }
}

/// Fold step 2: build the new layer (old layer ⊕ overlay) into pages numbered from `first`.
/// OK payload: {"pages": n, "layer": {...}}. From here until `fold_commit` or `fold_abort`,
/// written keys are tracked so the commit can rebase them.
#[no_mangle]
pub extern "C" fn fold_build(first: f64) -> u32 {
    let guard = DB.with(|d| d.as_ptr());
    let Some(db) = (unsafe { (*guard).as_mut() }) else { return error("engine not initialized") };
    let store = Tiers;
    let first = first as PageId;
    let mut sink = HostSink { next: first };
    let built = {
        let view = pagedb_core::overlay::View::new(&db.overlay);
        let ctx = Ctx::with_view(&store, &view);
        match pagedb_core::fold::build(&ctx, &db.roots, &db.overlay, &mut sink) {
            Ok(l) => l,
            Err(Miss) => {
                set_out(ctx.take_want().iter().flat_map(|id| id.to_le_bytes()).collect());
                return 1;
            }
        }
    };
    let json = format!("{{\"pages\":{},\"layer\":{}}}", sink.next - first, layer_json(&built));
    db.pending = Some(Rc::new(built));
    db.overlay.dirty = Some(Default::default());
    set_out(json.into_bytes());
    0
}

/// Fold step 3 (after the upload): swap the new layer in under a rebased overlay. FAULT: fetch
/// (the new layer's pages) and call again; nothing changed.
#[no_mangle]
pub extern "C" fn fold_commit() -> u32 {
    let guard = DB.with(|d| d.as_ptr());
    let Some(db) = (unsafe { (*guard).as_mut() }) else { return error("engine not initialized") };
    let Some(layer) = db.pending.clone() else { return error("no fold in progress") };
    let store = Tiers;
    let map = {
        let view = pagedb_core::overlay::View::new(&db.overlay);
        let ctx = Ctx::with_view(&store, &view);
        match pagedb_core::fold::rebase(&ctx, &db.overlay, &layer) {
            Ok(m) => m,
            Err(Miss) => {
                set_out(ctx.take_want().iter().flat_map(|id| id.to_le_bytes()).collect());
                return 1;
            }
        }
    };
    pagedb_core::fold::commit(&mut db.overlay, map, layer);
    db.pending = None;
    set_out(Vec::new());
    0
}

/// Give up on a fold (the upload failed): the overlay carries on over the old layer.
#[no_mangle]
pub extern "C" fn fold_abort() -> u32 {
    DB.with(|d| {
        if let Some(db) = d.borrow_mut().as_mut() {
            db.pending = None;
            db.overlay.dirty = None;
        }
    });
    set_out(Vec::new());
    0
}
