// Why does turbopuffer have higher recall? Ask pagevec for its top 50, then check (a) whether the
// true top 10 are among them and (b) the recall@10 after reranking those 50 with exact vectors
// (from the local PVEC shards), i.e. what a full-precision rerank stage would give. (Stories the
// live tail added since the shards were cut have no exact vector here and are left out.)
//   node bench/vec-rerank-probe.mjs data/gt-full.json data/shards-all [--n 100] [--k 50] [--pages 512]
import { readFileSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [gtPath, dir] = args;
const n = Number(opt("--n", 100)), K = Number(opt("--k", 50));
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const gt = JSON.parse(readFileSync(gtPath, "utf8")).slice(0, n);
const unit = (v) => { const s = Math.hypot(...v) || 1; return v.map((x) => x / s); };
const cands = [];
for (const g of gt) {
  const vec = Buffer.from(new Float32Array(g.q).buffer).toString("base64");
  const r = await fetch("https://pagedb-vec.do-pool-lab.workers.dev/api/query", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ db: "hnv", obj: "hnv", ast: { table: "story", ann: { index: "story_vec", vec, k: K, ...(opt("--pages") ? { maxPages: Number(opt("--pages")), nprobe: 512 } : {}) } } }) }).then((x) => x.json());
  cands.push(r.result.rows.map((x) => x.id));
}
// Exact vectors for every candidate, from the shards.
const want = new Set(cands.flat());
const vecs = new Map();
const f16 = (h) => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff; return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15); };
for (const f of readdirSync(dir).filter((f) => f.endsWith(".bin"))) {
  const b = readFileSync(`${dir}/${f}`);
  const dims = b.readUInt32LE(8), count = b.readUInt32LE(12);
  let p = 16;
  for (let i = 0; i < count; i++) {
    const jl = b.readUInt32LE(p); p += 4;
    const id = JSON.parse(b.subarray(p, p + jl).toString()).id; p += jl;
    if (want.has(id)) vecs.set(id, unit(Array.from({ length: dims }, (_, d) => f16(b.readUInt16LE(p + 2 * d)))));
    p += 2 * dims;
  }
}
let raw = 0, inCands = 0, reranked = 0;
gt.forEach((g, i) => {
  const truth = new Set(g.ids.slice(0, 10));
  const q = unit(g.q);
  const c = cands[i];
  raw += c.slice(0, 10).filter((id) => truth.has(id)).length;
  inCands += c.filter((id) => truth.has(id)).length;
  const exact = c.filter((id) => vecs.has(id)).map((id) => [id, vecs.get(id).reduce((s, x, d) => s + x * q[d], 0)]).sort((a, b) => b[1] - a[1]);
  reranked += exact.slice(0, 10).filter(([id]) => truth.has(id)).length;
});
const r = (x) => (x / (10 * gt.length)).toFixed(3);
console.log(`${gt.length} queries: recall@10 as served ${r(raw)}; true top 10 found among pagevec's top ${K}: ${r(inCands)}; recall@10 after an exact rerank of those ${K}: ${r(reranked)}`);
