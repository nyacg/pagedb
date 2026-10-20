// pagevec vs Vectorize on the same queries and the same filter (time < cutoff): recall@10 against
// exact search over the stories that pass the filter (gt from `pagedb-builder vec-gt --reuse`).
//   node bench/vec-compare.mjs <gt.json> <cutoff ms> [--n 100] [--pages 256,512]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [gtPath, cutoff] = [args[0], Number(args[1])];
const gt = JSON.parse(readFileSync(gtPath, "utf8")).slice(0, Number(opt("--n", 100)));
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const post = async (url, body) => {
  for (let a = 0; ; a++) {
    const t0 = performance.now();
    const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) }).catch(() => null);
    const j = r?.ok ? await r.json() : null;
    if (j && !j.error) return { ...j, clientMs: performance.now() - t0 };
    if (a >= 4) throw new Error(`${url}: ${j?.error ?? r?.status}`);
    await new Promise((res) => setTimeout(res, 1000 * (a + 1)));
  }
};
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const unit = (q) => {
  const n = Math.hypot(...q) || 1;
  return q.map((x) => x / n);
};
const where = { type: "simple", op: "<", left: { type: "column", name: "time" }, right: { type: "literal", value: cutoff } };
const rows = [];
for (const pages of opt("--pages", "256,512").split(",").map(Number)) {
  let hit = 0;
  const ms = [];
  for (const g of gt) {
    const vec = Buffer.from(new Float32Array(g.q).buffer).toString("base64");
    const r = await post("https://pagedb-vec.do-pool-lab.workers.dev/api/query", { db: "hnv", obj: "hnv", ast: { table: "story", ann: { index: "story_vec", vec, k: 10, nprobe: 512, maxPages: pages }, where } });
    const want = new Set(g.ids.slice(0, 10));
    hit += r.result.rows.filter((x) => want.has(x.id)).length;
    ms.push(r.clientMs);
  }
  rows.push(`| pagevec (prewarmed), ≤ ${pages} pages | ${(hit / (10 * gt.length)).toFixed(3)} | ${pct(ms, 0.5).toFixed(0)} / ${pct(ms, 0.9).toFixed(0)} |`);
}
{
  let hit = 0;
  const ms = [], server = [];
  for (const g of gt) {
    const r = await post("https://pagedb-vectorize-bench.do-pool-lab.workers.dev/query", { vec: unit(g.q), topK: 10, filter: { time: { $lt: cutoff } } });
    const want = new Set(g.ids.slice(0, 10));
    hit += r.matches.filter((m) => want.has(m.id)).length;
    ms.push(r.clientMs);
    server.push(r.ms);
  }
  rows.push(`| Vectorize (in-Worker ${pct(server, 0.5)} / ${pct(server, 0.9)} ms) | ${(hit / (10 * gt.length)).toFixed(3)} | ${pct(ms, 0.5).toFixed(0)} / ${pct(ms, 0.9).toFixed(0)} |`);
}
console.log(`${gt.length} queries, filter time < ${new Date(cutoff).toISOString().slice(0, 10)}\n| | recall@10 vs exact | client ms p50 / p90 |\n|---|---|---|\n${rows.join("\n")}`);
