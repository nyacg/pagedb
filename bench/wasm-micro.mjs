// S0c: engine.wasm microbenchmarks in V8 (node; the same engine as workerd).
// node bench/wasm-micro.mjs data/bench   (after: cargo run -p pagedb-builder -- bench-tree data/bench 1000000)
import { readFileSync } from "node:fs";
const dir = process.argv[2] ?? "data/bench";
const PAGE = 65536;
const pagesBin = readFileSync(`${dir}/pages.bin`);
const meta = JSON.parse(readFileSync(`${dir}/root.json`, "utf8"));
const wasmBytes = readFileSync(new URL("../engine/target/wasm32-unknown-unknown/release/pagedb_wasm.wasm", import.meta.url));

let mem;
const resident = new Set(); // pages the "SQLite tier" holds
let hostCalls = 0;
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  host: {
    host_page_get(lo, hi, dst) {
      const id = hi * 2 ** 32 + lo;
      if (!resident.has(id)) return 0;
      hostCalls++;
      new Uint8Array(mem.buffer, dst, PAGE).set(pagesBin.subarray(id * PAGE, (id + 1) * PAGE));
      return 1;
    },
  },
});
const e = instance.exports;
mem = e.memory;
const enc = new TextEncoder();
const dec = new TextDecoder();
function put(bytes) {
  const p = e.alloc(bytes.length || 1);
  new Uint8Array(mem.buffer, p, bytes.length).set(bytes);
  return [p, bytes.length];
}
function out() {
  return new Uint8Array(mem.buffer, e.out_ptr(), e.out_len()).slice();
}
// Keys as the builder encodes them: (projectId asc, createdAt desc, id asc).
function strPart(s) {
  const b = enc.encode(s);
  return [0x05, ...b, 0x00, 0x01];
}
function key(project) {
  return Uint8Array.from(strPart(project));
}
function prefixEnd(k) {
  const e2 = Uint8Array.from(k);
  e2[e2.length - 1]++;
  return e2;
}
function call(f) {
  // Fault loop: make wanted pages resident ("fetched from R2"), call again.
  for (let rounds = 0; ; rounds++) {
    const s = f();
    if (s === 0) return { bytes: out(), rounds };
    if (s !== 1) throw new Error(dec.decode(out()));
    const ids = new BigUint64Array(out().buffer);
    for (const id of ids) resident.add(Number(id));
  }
}
const time = (label, n, f) => {
  for (let i = 0; i < Math.min(n, 200); i++) f(i); // warm
  const t0 = performance.now();
  for (let i = 0; i < n; i++) f(i);
  const us = ((performance.now() - t0) / n) * 1000;
  console.log(`${label.padEnd(44)} ${us.toFixed(1).padStart(8)} µs/op`);
  return us;
};

const rootLo = meta.root % 2 ** 32, rootHi = Math.floor(meta.root / 2 ** 32);
const project = (i) => `proj-${String(i % meta.projects).padStart(6, "0")}`;

// Cold: first touch of a project list = fault rounds.
{
  const k = key(project(7)), [lo, lol] = put(k), [hi, hil] = put(prefixEnd(k));
  const r = call(() => e.tree_scan_json(rootLo, rootHi, meta.height, lo, lol, hi, hil, 50, 0));
  console.log(`cold list (50 rows): ${r.rounds} fault rounds, ${JSON.parse(dec.decode(r.bytes)).length} rows, host calls ${hostCalls}`);
}
// Warm everything into the "SQLite" tier for the steady-state numbers.
for (let id = 0; id < meta.pages; id++) resident.add(id);

const keys = Array.from({ length: 512 }, (_, i) => { const k = key(project(i)); return [put(k), put(prefixEnd(k))]; });
e.set_ram_budget(4096);
time("list 50 rows → JSON (RAM tier)", 20000, (i) => { const [[lo, lol], [hi, hil]] = keys[i % 512]; e.tree_scan_json(rootLo, rootHi, meta.height, lo, lol, hi, hil, 50, 0); });
time("list 500 rows → JSON (RAM tier)", 4000, (i) => { const [[lo, lol], [hi, hil]] = keys[i % 512]; e.tree_scan_json(rootLo, rootHi, meta.height, lo, lol, hi, hil, 500, 0); });
time("count project (RAM tier)", 20000, (i) => { const [[lo, lol], [hi, hil]] = keys[i % 512]; e.tree_count(rootLo, rootHi, meta.height, meta.rows, lo, lol, hi, hil); });
// Point lookups by exact key: take the first key of each project's list.
const firstKeys = keys.slice(0, 256).map(([[lo, lol], [hi, hil]]) => {
  e.tree_scan_json(rootLo, rootHi, meta.height, lo, lol, hi, hil, 1, 0);
  return null;
});
e.set_ram_budget(8);
time("list 50 rows → JSON (host/SQLite tier)", 4000, (i) => { const [[lo, lol], [hi, hil]] = keys[(i * 7) % 512]; e.tree_scan_json(rootLo, rootHi, meta.height, lo, lol, hi, hil, 50, 0); });
console.log("stats [ram pages, ram hits, host hits]:", e.stats() === 0 && [...new BigUint64Array(out().buffer)].map(Number));
console.log(`wasm ${wasmBytes.length} bytes, memory ${(mem.buffer.byteLength / 1e6).toFixed(1)} MB`);
