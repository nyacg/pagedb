// Fan-out load: N sockets subscribed to one project's list + count on a private object, a
// writer changing statuses at R/s; reports write → poke latency at every subscriber.
//   node bench/load.mjs --sockets 300 --rate 5 --secs 30 [--project p0003] [--db db1g]
import WebSocket from "ws";
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "https://pagedb.do-pool-lab.workers.dev");
const TOKEN = (await import("node:fs")).readFileSync(".env", "utf8").match(BASE.includes("pagedb-node") ? /NODE_TOKEN=(\S+)/ : /ADMIN_TOKEN=(\S+)/)[1];
const AUTH = { authorization: `Bearer ${TOKEN}` };
const DB = arg("db", "db1g"), N = +arg("sockets", 200), RATE = +arg("rate", 5), SECS = +arg("secs", 30), P = arg("project", "p0003");
const OBJ = arg("obj", `load-${Date.now().toString(36)}`);
const NODE = arg("node", ""); // pagedb-node: which container
const nq = NODE ? `&node=${NODE}` : "";
const eq = (c, v) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const LIST = { table: "issue", where: eq("projectId", P), orderBy: [["createdAt", "desc"], ["id", "asc"]], limit: 50 };
const COUNT = { table: "issue", where: eq("projectId", P), aggregate: "count" };
const sent = new Map(), arrivals = [], lat = [];
let pokes = 0;
const sockets = [];
const t0 = performance.now();
for (let i = 0; i < N; i += 50) {
  await Promise.all(Array.from({ length: Math.min(50, N - i) }, () => new Promise((res, rej) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/socket?db=${DB}&obj=${OBJ}${nq}&token=${TOKEN}`, { perMessageDeflate: false });
    ws.on("open", () => { ws.send(JSON.stringify({ t: "subs", list: [{ id: "l", q: LIST }, { id: "c", q: COUNT }] })); });
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.t === "snaps") res();
      if (m.t === "poke") { pokes++; const s = sent.get(m.version); if (s) lat.push(performance.now() - s); else arrivals.push([m.version, performance.now()]); }
    });
    ws.on("error", rej);
    sockets.push(ws);
  })));
}
console.log(`${N} sockets subscribed in ${Math.round(performance.now() - t0)} ms (object ${OBJ})`);
// Issue ids in the window: newest 50 of the project.
const snap = await (await fetch(`${BASE}/api/query${NODE ? `?node=${NODE}` : ""}`, { method: "POST", headers: AUTH, body: JSON.stringify({ db: DB, obj: OBJ, ast: LIST }) })).json();
const ids = snap.result.rows.map((r) => r.id);
const statuses = ["backlog", "todo", "in-progress", "review", "done"];
const writeMs = [];
const end = performance.now() + SECS * 1000;
let w = 0;
while (performance.now() < end) {
  const t = performance.now();
  const ops = { ops: [{ op: "update", table: "issue", id: ids[w % ids.length], set: { status: statuses[w % 5], updatedAt: Date.now() } }] };
  w++;
  fetch(`${BASE}/api/write${NODE ? `?node=${NODE}` : ""}`, { method: "POST", headers: AUTH, body: JSON.stringify({ db: DB, obj: OBJ, ops }) }).then(async (r) => {
    const b = await r.json();
    writeMs.push(b.ms);
    sent.set(b.version, t);
    for (const [v, at] of arrivals.splice(0)) (v === b.version ? lat.push(at - t) : arrivals.push([v, at]));
  });
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 / RATE - (performance.now() - t))));
}
await new Promise((r) => setTimeout(r, 3000));
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))]) : null; };
console.log(JSON.stringify({ sockets: N, writes: w, rate: RATE, pokes, expected: w * N, latency: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99), max: pct(lat, 1) }, serverWriteMs: { p50: pct(writeMs, 0.5), p99: pct(writeMs, 0.99) } }));
for (const s of sockets) s.close();
process.exit(0);
