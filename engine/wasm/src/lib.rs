//! WASM boundary for the Durable Object shell. Raw exports/imports, no bindgen.
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

thread_local! {
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
    TreeRoot { tree: 0, root: (root_hi as u64) << 32 | root_lo as u64, height: height as u8, rows: rows as u64 }
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
