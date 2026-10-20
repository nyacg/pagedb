// turbopuffer side of the comparison: the same 1024-d story vectors (PVEC shards), the same
// queries and ground truth as bench/vec-warm.mjs and bench/vectorize.mjs.
//   TURBOPUFFER_API_KEY in .env (or the environment); TPUF_REGION (default gcp-us-west1).
//   node bench/tpuf.mjs load data/shards-all [--par 4]   upsert every shard (f16 vectors, time, kind)
//   node bench/tpuf.mjs status                            namespace size, unindexed rows
//   node bench/tpuf.mjs query <gt.json> [--n 100] [--filter CUTOFF_MS]
//   node bench/tpuf.mjs visibility [--n 10]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const env = readFileSync(".env", "utf8");
const key = process.env.TURBOPUFFER_API_KEY ?? env.match(/TURBOPUFFER_API_KEY=(\S+)/)?.[1];
if (!key) throw new Error("TURBOPUFFER_API_KEY (in .env or the environment)");
const region = process.env.TPUF_REGION ?? env.match(/TPUF_REGION=(\S+)/)?.[1] ?? "gcp-us-west1";
const NS = opt("--ns", "hn-stories-1024");
const base = `https://${region}.turbopuffer.com`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

async function call(method, path, body, tries = 6) {
  for (let a = 0; ; a++) {
    const t0 = performance.now();
    const r = await fetch(base + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (r.ok) return { j: await r.json(), ms: performance.now() - t0 };
    const t = await r.text();
    if (a >= tries || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 300)}`);
    await new Promise((res) => setTimeout(res, 1000 * 2 ** Math.min(a, 5)));
  }
}
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const b64 = (v) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const f16 = (h) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
};

/** A shard's rows as columns (vectors normalized, base64 f32 as the API takes them). */
function columns(path) {
  const b = readFileSync(path);
  const dims = b.readUInt32LE(8), count = b.readUInt32LE(12);
  const out = { id: [], vector: [], time: [], kind: [] };
  let p = 16;
  for (let i = 0; i < count; i++) {
    const jl = b.readUInt32LE(p);
    p += 4;
    const row = JSON.parse(b.subarray(p, p + jl).toString());
    p += jl;
    const v = new Float32Array(dims);
    let n = 0;
    for (let d = 0; d < dims; d++) n += (v[d] = f16(b.readUInt16LE(p + 2 * d))) ** 2;
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < dims; d++) v[d] /= n;
    p += 2 * dims;
    out.id.push(String(row.id));
    out.vector.push(Buffer.from(v.buffer).toString("base64"));
    out.time.push(Number(row.time) || 0);
    out.kind.push(String(row.kind ?? "story"));
  }
  return out;
}

const cmd = args[0];
if (cmd === "load") {
  const dir = args[1];
  const files = readdirSync(dir).filter((f) => f.endsWith(".bin")).sort();
  const log = `data/tpuf-loaded-${NS}.json`;
  const done = new Set(existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : []);
  const queue = files.filter((f) => !done.has(f));
  let rows = 0, bytes = 0;
  const t0 = Date.now();
  const writes = [];
  await Promise.all(
    Array.from({ length: Number(opt("--par", 4)) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const cols = columns(`${dir}/${f}`);
        const body = {
          upsert_columns: cols,
          distance_metric: "cosine_distance",
          schema: { vector: { type: "[1024]f16", ann: true }, time: "int", kind: "string" },
          disable_backpressure: true,
        };
        const { j, ms } = await call("POST", `/v2/namespaces/${NS}`, body);
        writes.push(ms);
        rows += cols.id.length;
        bytes += j.billing?.billable_logical_bytes_written ?? 0;
        done.add(f);
        writeFileSync(log, JSON.stringify([...done].sort()));
        process.stdout.write(`\r${done.size}/${files.length} shards, ${rows} rows this run, ${(rows / ((Date.now() - t0) / 1000)).toFixed(0)} rows/s, write p50 ${pct(writes, 0.5).toFixed(0)} ms   `);
      }
    }),
  );
  console.log(`\nloaded ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(0)} s; billable logical bytes written ${(bytes / 1e9).toFixed(2)} GB`);
}

if (cmd === "status") {
  // A strongly consistent query reports how many documents it had to scan unindexed.
  const { j } = await call("POST", `/v2/namespaces/${NS}/query`, { rank_by: ["vector", "ANN", b64(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)))], top_k: 1 });
  console.log(JSON.stringify(j.performance, null, 1));
}

if (cmd === "query") {
  const gt = JSON.parse(readFileSync(args[1], "utf8")).slice(0, Number(opt("--n", 100)));
  const cutoff = opt("--filter");
  const runs = { first: [], again: [] };
  const server = [], exec = [], temps = {};
  let hit = 0, billed = 0;
  for (const g of gt) {
    const body = { rank_by: ["vector", "ANN", b64(g.q)], top_k: 10, ...(cutoff ? { filters: ["time", "Lt", Number(cutoff)] } : {}) };
    const a = await call("POST", `/v2/namespaces/${NS}/query`, body);
    const b = await call("POST", `/v2/namespaces/${NS}/query`, body);
    runs.first.push(a.ms);
    runs.again.push(b.ms);
    server.push(b.j.performance.server_total_ms);
    billed += b.j.billing?.billable_logical_bytes_queried ?? 0;
    exec.push(b.j.performance.query_execution_ms);
    temps[a.j.performance.cache_temperature] = (temps[a.j.performance.cache_temperature] ?? 0) + 1;
    const want = new Set(g.ids.slice(0, 10));
    hit += b.j.rows.filter((r) => want.has(String(r.id))).length;
  }
  console.log(`turbopuffer (${region}), ${gt.length} queries${cutoff ? `, filter time < ${new Date(Number(cutoff)).toISOString().slice(0, 10)}` : ""}`);
  console.log(`recall@10 vs exact: ${(hit / (10 * gt.length)).toFixed(3)}`);
  console.log(`client ms first p50 ${pct(runs.first, 0.5).toFixed(0)} p90 ${pct(runs.first, 0.9).toFixed(0)}; repeat p50 ${pct(runs.again, 0.5).toFixed(0)} p90 ${pct(runs.again, 0.9).toFixed(0)}`);
  console.log(`server_total_ms p50 ${pct(server, 0.5)} p90 ${pct(server, 0.9)}; query_execution_ms p50 ${pct(exec, 0.5)}; first-run cache temperature ${JSON.stringify(temps)}`);
  console.log(`billed per query: ${(billed / gt.length / 1e9).toFixed(2)} GB logical queried`);
}

if (cmd === "visibility") {
  const n = Number(opt("--n", 10));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const v = Array.from({ length: 1024 }, () => Math.random() - 0.5);
    const norm = Math.hypot(...v);
    const vec = b64(v.map((x) => x / norm));
    const id = `vis-${Date.now()}-${i}`;
    const w = await call("POST", `/v2/namespaces/${NS}`, { upsert_columns: { id: [id], vector: [vec], time: [Date.now()], kind: ["probe"] } });
    const q = await call("POST", `/v2/namespaces/${NS}/query`, { rank_by: ["vector", "ANN", vec], top_k: 3 });
    rows.push({ writeMs: w.ms, queryMs: q.ms, found: String(q.j.rows[0]?.id) === id });
    await call("POST", `/v2/namespaces/${NS}`, { deletes: [id] });
  }
  console.log(`turbopuffer, ${n} writes: visible on the first (strongly consistent) query ${rows.filter((r) => r.found).length}/${n}; write ack p50 ${pct(rows.map((r) => r.writeMs), 0.5).toFixed(0)} ms; query p50 ${pct(rows.map((r) => r.queryMs), 0.5).toFixed(0)} ms`);
}
