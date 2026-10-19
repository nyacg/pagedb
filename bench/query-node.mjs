// Query latency in the deployed DO across tiers.
//   node bench/query.mjs [db] [base-url]
const [db = "db1g", BASE = "https://pagedb.do-pool-lab.workers.dev"] = process.argv.slice(2);
const eq = (c, v) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const card = [
  { alias: "project", correlation: { parentField: ["projectId"], childField: ["id"] }, subquery: { table: "project" } },
  { alias: "owner", correlation: { parentField: ["ownerId"], childField: ["id"] }, subquery: { table: "user" } },
  { alias: "commentCount", correlation: { parentField: ["id"], childField: ["issueId"] }, subquery: { table: "comment", aggregate: "count" } },
];
const order = [["createdAt", "desc"], ["id", "asc"]];
const project = (i) => `p${String(i).padStart(4, "0")}`;
const queries = (p) => ({
  list: { table: "issue", where: eq("projectId", p), orderBy: order, limit: 50, related: card },
  board_todo: { table: "issue", where: { type: "and", conditions: [eq("projectId", p), eq("status", "todo")] }, orderBy: order, limit: 25, related: card },
  count: { table: "issue", where: eq("projectId", p), aggregate: "count" },
  filtered: { table: "issue", where: { type: "and", conditions: [eq("projectId", p), { type: "simple", op: "ILIKE", left: { type: "column", name: "title" }, right: { type: "literal", value: "%cache%" } }] }, orderBy: order, limit: 50, related: card },
  detail: { table: "issue", where: eq("id", `i${p.slice(1)}00123`), one: true, related: [card[1], { alias: "comments", correlation: { parentField: ["id"], childField: ["issueId"] }, subquery: { table: "comment", orderBy: [["createdAt", "asc"], ["id", "asc"]], limit: 200, related: [{ alias: "author", correlation: { parentField: ["authorId"], childField: ["id"] }, subquery: { table: "user" } }] } }] },
  feed: { table: "comment", orderBy: order, limit: 30 },
});
async function q(obj, ast, salt) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/query${process.env.NODE ? `?node=${process.env.NODE}` : ""}`, { method: "POST", body: JSON.stringify({ db, ast, obj, salt }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return { client: performance.now() - t0, ...body.stats, rows: body.result.rows?.length ?? body.result.count };
}
const run = Date.now().toString(36);
const ms = (a) => (a?.length ? `[${a.map(Math.round).join(",")}]` : "");
const fmt = (s) => `${s.r2Ms?.length ? `r2 ${ms(s.r2Ms)} · ` : ""}${s.cacheMs?.length ? `cache ${ms(s.cacheMs)} · ` : ""}${s.startMs !== undefined ? `start ${String(Math.round(s.startMs)).padStart(4)} · ` : ""}rounds [${s.roundMs.map(Math.round).join(",")}] · ${String(Math.round(s.totalMs)).padStart(5)} ms server · ${String(Math.round(s.client)).padStart(4)} ms client · rounds ${s.rounds} · pages ${String(s.pages).padStart(3)} · chunks ${s.chunks} (cache ${s.cacheHits}, r2 ${s.r2Gets}) · ${(s.bytes / 1e6).toFixed(1)} MB · engine ${s.engineMs.toFixed(1)} ms`;
for (const [state, objOf, saltOf] of [
  ["COLD (new object, R2)", (n) => `cold-${run}-${n}`, (n) => `${run}-${n}`],
  ["COLD object, colo cache filling", (n) => `fill-${run}-${n}`, () => undefined],
  ["COLD object, warm colo cache", (n) => `warmcache-${run}-${n}`, () => undefined],
]) {
  console.log(`\n== ${state}`);
  for (const [name] of Object.entries(queries(project(3)))) {
    // Each query in its own fresh object so nothing is shared between them.
    const s = await q(objOf(name), queries(project(3))[name], saltOf(name));
    await new Promise((r) => setTimeout(r, 300)); // let deferred cache puts land
    console.log(`${name.padEnd(11)} ${fmt(s)}  rows ${s.rows}`);
  }
}
const token = (await import("node:fs")).readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
console.log("\n== WAKE (object evicted from memory, its SQLite intact)");
for (const [name, ast] of Object.entries(queries(project(3)))) {
  const obj = `fill-${run}-${name}`; // these already ran once above: pages are in their SQLite
  await fetch(`${BASE}/api/admin/evict?obj=${obj}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  await new Promise((r) => setTimeout(r, 200));
  const s = await q(obj, ast);
  console.log(`${name.padEnd(11)} ${fmt(s)}`);
}
console.log("\n== WARM (same object, repeated; median of 5)");
const warm = `warm-${run}`;
for (const [name, ast] of Object.entries(queries(project(5)))) {
  await q(warm, ast);
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await q(warm, ast));
  runs.sort((a, b) => a.totalMs - b.totalMs);
  console.log(`${name.padEnd(11)} ${fmt(runs[2])}`);
}
