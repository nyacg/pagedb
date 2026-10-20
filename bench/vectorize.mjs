// Vectorize side of the pagevec benchmark (spikes/vectorize-bench).
//   node bench/vectorize.mjs load <prefix> <shards> [--from 0] [--par 4]   load PVEC shards
//       (shards already loaded, per data/vectorize-loaded.json, are skipped; missing ones too)
//   node bench/vectorize.mjs info
//   node bench/vectorize.mjs query <gt.json> [--n 50] [--filter]           recall@10 + latency
//   node bench/vectorize.mjs visibility [--n 5]                             write → visible
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const url = opt("--url", "https://pagedb-vectorize-bench.do-pool-lab.workers.dev");
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const call = async (path, body) => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: auth, body: body === undefined ? undefined : JSON.stringify(body) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (r.ok) return r.json();
    if (attempt >= 5) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
};
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const unit = (q, d = 1024) => {
  const v = q.slice(0, d);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

const cmd = args[0];
if (cmd === "info") console.log(JSON.stringify(await call("/info"), null, 1));

if (cmd === "load") {
  const [prefix, shards] = [args[1], Number(args[2])];
  const from = Number(opt("--from", 0));
  const par = Number(opt("--par", 4));
  const log = "data/vectorize-loaded.json";
  const loaded = new Set(existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : []);
  let next = from;
  let done = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: par }, async () => {
      for (let s = next++; s < shards; s = next++) {
        if (loaded.has(s)) continue;
        const r = await fetch(`${url}/load?prefix=${encodeURIComponent(prefix)}&shard=${s}`, { method: "POST", headers: auth }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
        if (r.error) continue; // not embedded yet (or a transient error): next run
        loaded.add(s);
        writeFileSync(log, JSON.stringify([...loaded].sort((a, b) => a - b)));
        done += r.vectors;
        process.stdout.write(`\rshard ${s}: ${done} vectors upserted, ${(done / ((Date.now() - t0) / 1000)).toFixed(0)}/s   `);
      }
    }),
  );
  console.log(`\nupserted ${done} vectors in ${((Date.now() - t0) / 1000).toFixed(0)} s (indexing continues asynchronously: see info)`);
}

if (cmd === "query") {
  const gt = JSON.parse(readFileSync(args[1], "utf8")).slice(0, Number(opt("--n", 50)));
  const filtered = args.includes("--filter");
  const since = Date.now() - 365 * 86400e3;
  let hit = 0;
  let hitFull = 0;
  const server = [];
  const client = [];
  for (const g of gt) {
    const t0 = performance.now();
    const r = await call("/query", { vec: unit(g.q), topK: 10, ...(filtered ? { filter: { kind: "story", time: { $gte: since } } } : {}) });
    client.push(performance.now() - t0);
    server.push(r.ms);
    if (!filtered) {
      const want = new Set(g.ids.slice(0, 10));
      hit += r.matches.filter((m) => want.has(m.id)).length;
      if (g.idsFull) hitFull += r.matches.filter((m) => new Set(g.idsFull.slice(0, 10)).has(m.id)).length;
    }
  }
  console.log(`Vectorize, ${gt.length} queries${filtered ? " (filtered: kind=story, past year)" : ""}`);
  if (!filtered) console.log(`recall@10 vs exact (index dims): ${(hit / (gt.length * 10)).toFixed(3)}${gt[0].idsFull ? `; vs full dims: ${(hitFull / (gt.length * 10)).toFixed(3)}` : ""}`);
  console.log(`server ms (in the Worker) p50 ${pct(server, 0.5)} p90 ${pct(server, 0.9)}; client ms p50 ${pct(client, 0.5).toFixed(0)} p90 ${pct(client, 0.9).toFixed(0)}`);
}

if (cmd === "visibility") {
  const n = Number(opt("--n", 5));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const v = unit(Array.from({ length: 1024 }, () => Math.random() - 0.5));
    const r = await call("/visibility", { vec: v, id: `probe-${Date.now()}-${i}` });
    rows.push(r);
    console.log(JSON.stringify(r));
  }
  const vis = rows.map((r) => r.visibleMs).filter((x) => x !== null);
  console.log(`Vectorize write → visible: p50 ${pct(vis, 0.5)} ms, max ${Math.max(...vis)} ms (${rows.length - vis.length} never within 10 min)`);
}
