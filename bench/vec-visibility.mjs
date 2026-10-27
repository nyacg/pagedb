// pagevec write → visible: insert a row and its vector, then search for that vector right after
// the write is acknowledged (the write is durable in the object's SQLite before it returns).
//   node bench/vec-visibility.mjs <db> [--url …] [--obj NAME] [--n 10] [--index story_vec] [--table story] [--dims 1024]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const db = args[0];
const url = opt("--url", "https://pagedb-vec.do-pool-lab.workers.dev");
const obj = opt("--obj", `${db}-vis`);
const n = Number(opt("--n", 10));
const index = opt("--index", "story_vec");
const table = opt("--table", "story");
const dims = Number(opt("--dims", 1024));
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const post = async (path, body) => {
  const t0 = performance.now();
  const r = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return { ...j, clientMs: performance.now() - t0 };
};
const rows = [];
for (let i = 0; i < n; i++) {
  const v = Array.from({ length: dims }, () => Math.random() - 0.5);
  const norm = Math.hypot(...v);
  const vec = Buffer.from(new Float32Array(v.map((x) => x / norm)).buffer).toString("base64");
  const id = `vis-${Date.now().toString(36)}-${i}`;
  const w = await post("/api/write", { db, obj, ops: { ops: [
    { op: "insert", table, row: { id, title: `visibility probe ${i}`, time: Date.now(), kind: "story", score: 1 } },
    { op: "vec_put", index, id, vec },
  ] } });
  const q = await post("/api/query", { db, obj, ast: { table, ann: { index, vec, k: 3 } } });
  const found = q.result.rows[0]?.id === id;
  rows.push({ writeMs: w.clientMs, queryMs: q.clientMs, found });
  // Clean up (the row and, by cascade, its vector).
  await post("/api/write", { db, obj, ops: { ops: [{ op: "delete", table, id }] } });
}
const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`pagevec, ${n} writes: visible on the first search after the write ${rows.filter((r) => r.found).length}/${n}; write ack p50 ${p50(rows.map((r) => r.writeMs)).toFixed(0)} ms, then search p50 ${p50(rows.map((r) => r.queryMs)).toFixed(0)} ms (client)`);
