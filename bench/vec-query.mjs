// Vector search latency per tier, on a deployed object, with recall against ground truth.
//   node bench/vec-query.mjs <db> <gt.json> [--url https://pagedb-preview…] [--index doc_vec] [--table doc]
//        [--n 20] [--nprobe 32] [--pages 256] [--obj NAME]
// Tiers, per query: R2 (SQLite pages dropped, fresh cache salt), colo cache (SQLite dropped,
// cache warm), SQLite (object evicted, its storage intact), RAM (the same query again).
// Server ms are measured inside the object (its clock only advances on I/O, so engine CPU
// is missing there); "in the Worker" is the Worker's round trip to the object, CPU included.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [db, gtPath] = args;
const url = opt("--url", "https://pagedb-preview.do-pool-lab.workers.dev");
const index = opt("--index", "doc_vec");
const table = opt("--table", "doc");
const n = Number(opt("--n", 20));
const nprobe = Number(opt("--nprobe", 32));
const maxPages = Number(opt("--pages", 256));
const obj = opt("--obj", `${db}-bench`);
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const gt = JSON.parse(readFileSync(gtPath, "utf8")).slice(0, n);
const auth = { authorization: `Bearer ${token}` };

const b64 = (q) => Buffer.from(new Float32Array(q).buffer).toString("base64");
async function query(ast, salt) {
  const t0 = performance.now();
  const r = await fetch(`${url}/api/query`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ db, obj, ast, salt }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return { ...j, clientMs: performance.now() - t0 };
}
const admin = (path) => fetch(`${url}/api/admin/${path}?db=${db}&obj=${obj}`, { method: "POST", headers: auth }).then((r) => r.json());
const ann = (q) => ({ table, ann: { index, vec: b64(q), k: 10, nprobe, maxPages } });

const rows = { r2: [], cache: [], sqlite: [], ram: [] };
let found = 0;
const pk = { table, where: { type: "simple", op: "=", left: { type: "column", name: "id" }, right: { type: "literal", value: "d1" } }, one: true };
const lookups = [];
// Start the object once (loads the pinned region: centroids + branch pages).
await admin("reset");
const start = await query(pk);
console.log(`object start: ${start.stats.startMs} ms (pinned region), point lookup ${start.clientMs.toFixed(0)} ms client`);
for (let i = 0; i < gt.length; i++) {
  const { q, ids } = gt[i];
  const salt = `v${Date.now().toString(36)}${i}`;
  // R2: leaves in no tier (fresh cache keys; SQLite pages dropped then the pinned region reloaded).
  await admin("reset");
  await query(pk, salt);
  const r2 = await query(ann(q), salt);
  rows.r2.push(r2);
  // Colo cache: the leaves are in the city cache now (filled after the reply above).
  await new Promise((r) => setTimeout(r, 6000));
  await admin("reset");
  await query(pk, salt);
  rows.cache.push(await query(ann(q), salt));
  // SQLite: the object is evicted; its SQLite holds the pages.
  await new Promise((r) => setTimeout(r, 500));
  await admin("evict");
  await query(pk, salt);
  rows.sqlite.push(await query(ann(q), salt));
  // RAM.
  const ram = await query(ann(q), salt);
  rows.ram.push(ram);
  lookups.push((await query(pk, salt)).clientMs);
  const want = new Set(ids.slice(0, 10));
  found += ram.result.rows.filter((r) => want.has(r.id)).length;
  process.stdout.write(`\r${i + 1}/${gt.length}`);
}
console.log("");

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f = (x) => (x === undefined ? "-" : x.toFixed(0));
console.log(`\n${db}: ${gt.length} queries, k=10, nprobe=${nprobe}, maxPages=${maxPages}; recall@10 ${(found / (gt.length * 10)).toFixed(3)}`);
console.log(`| tier | rounds | pages | R2 GETs | cache hits | SQLite hits | server ms p50 / p90 | in the Worker p50 / p90 | client ms p50 / p90 |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const [tier, rs] of Object.entries(rows)) {
  const avg = (k) => (rs.reduce((a, r) => a + (r.stats[k] ?? 0), 0) / rs.length).toFixed(1);
  const server = rs.map((r) => r.stats.totalMs);
  const client = rs.map((r) => r.clientMs);
  const worker = rs.map((r) => r.workerMs);
  console.log(`| ${tier} | ${avg("rounds")} | ${avg("pages")} | ${avg("r2Gets")} | ${avg("cacheHits")} | ${avg("sqliteHits")} | ${f(pct(server, 0.5))} / ${f(pct(server, 0.9))} | ${f(pct(worker, 0.5))} / ${f(pct(worker, 0.9))} | ${f(pct(client, 0.5))} / ${f(pct(client, 0.9))} |`);
}
console.log(`point lookup (RAM), client ms p50 / p90: ${f(pct(lookups, 0.5))} / ${f(pct(lookups, 0.9))}`);
const a = rows.ram[0].result.ann;
const all = (tier, k) => rows[tier].flatMap((r) => r.stats[k] ?? []);
if (all("r2", "r2Ms").length) console.log(`R2 tier: GET ms p50 ${f(pct(all("r2", "r2Ms"), 0.5))} p90 ${f(pct(all("r2", "r2Ms"), 0.9))}; round ms p50 ${f(pct(all("r2", "roundMs"), 0.5))}; MB per query ${(rows.r2.reduce((s, r) => s + r.stats.bytes, 0) / rows.r2.length / 1e6).toFixed(1)}`);
if (all("cache", "cacheMs").length) console.log(`cache tier: match ms p50 ${f(pct(all("cache", "cacheMs"), 0.5))} p90 ${f(pct(all("cache", "cacheMs"), 0.9))}; round ms p50 ${f(pct(all("cache", "roundMs"), 0.5))}`);
console.log(`per query: ${a.clusters} clusters, ${a.pages} pages, ${a.scanned} vectors scored`);
