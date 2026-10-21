// Vector search on a prewarmed object (its index in SQLite): recall@10 against exact ground truth
// and latency, first run (SQLite tier) and repeat (RAM tier), for every query in gt.json.
//   node bench/vec-warm.mjs <db> <gt.json> [--obj NAME] [--url …] [--nprobe N] [--pages N] [--n N]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [db, gtPath] = args;
const url = opt("--url", "https://pagedb-vec.do-pool-lab.workers.dev");
const obj = opt("--obj", db);
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const gt = JSON.parse(readFileSync(gtPath, "utf8")).slice(0, Number(opt("--n", 1e9)));
const ann = (q) => ({ table: "story", ann: { index: "story_vec", vec: Buffer.from(new Float32Array(q).buffer).toString("base64"), k: 10, ...(args.includes("--nprobe") ? { nprobe: Number(opt("--nprobe")) } : {}), ...(args.includes("--pages") ? { maxPages: Number(opt("--pages")) } : {}) } });
const query = async (ast) => {
  const t0 = performance.now();
  const r = await fetch(`${url}/api/query`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ db, obj, ast }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return { ...j, ms: performance.now() - t0 };
};
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
let hit = 0;
const first = [], again = [], pages = [], scanned = [], net = [], wFirst = [], wAgain = [];
for (const g of gt) {
  const a = await query(ann(g.q));
  const b = await query(ann(g.q));
  first.push(a.ms);
  wFirst.push(a.workerMs);
  wAgain.push(b.workerMs);
  again.push(b.ms);
  pages.push(a.result.ann.pages);
  scanned.push(a.result.ann.scanned);
  net.push(a.stats.r2Gets + a.stats.cacheHits);
  const want = new Set(g.ids.slice(0, 10));
  hit += b.result.rows.filter((r) => want.has(r.id)).length;
}
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
console.log(`${db}: ${gt.length} queries; recall@10 ${(hit / (10 * gt.length)).toFixed(3)}; ${avg(pages).toFixed(0)} pages, ${avg(scanned).toFixed(0)} vectors scored per query; network fetches ${avg(net).toFixed(2)}/query`);
console.log(`first run (SQLite tier) client ms p50 ${pct(first, 0.5).toFixed(0)} p90 ${pct(first, 0.9).toFixed(0)}; repeat (RAM) p50 ${pct(again, 0.5).toFixed(0)} p90 ${pct(again, 0.9).toFixed(0)}`);
if (wAgain[0] != null) console.log(`in the Worker (object round trip, CPU included): first p50 ${pct(wFirst, 0.5)} p90 ${pct(wFirst, 0.9)}; repeat p50 ${pct(wAgain, 0.5)} p90 ${pct(wAgain, 0.9)} ms`);
