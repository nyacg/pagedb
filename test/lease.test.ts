/**
 * Signed queries, end to end against the deployed Worker, as a visitor (no admin token):
 * only leased named queries are served; raw ASTs, forged leases and raw writes are refused.
 *   BASE=https://pagedb.do-pool-lab.workers.dev node --import tsx --test test/lease.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://pagedb.do-pool-lab.workers.dev";
type Msg = { t: string; id?: string; rows?: { id: string; projectId?: string }[]; count?: number; message?: string };

async function socket(headers: Record<string, string> = {}, qs = "") {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/socket${qs}`, { headers });
  const msgs: Msg[] = [];
  // A batch of subscriptions answers with one `snaps` message; split it into per-id snaps.
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as Msg & { list?: Msg[] };
    if (m.t === "snaps") for (const x of m.list ?? []) msgs.push({ ...x, t: "snap" });
    else msgs.push(m);
  });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const next = async (pred: (m: Msg) => boolean, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
      const m = msgs.find(pred);
      if (m) return m;
    }
    throw new Error("timed out");
  };
  await next((m) => m.t === "hello");
  return { ws, msgs, next };
}

async function lease(list: { name: string; args?: Record<string, unknown> }[]) {
  const res = await fetch(`${BASE}/api/lease`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ list }) });
  assert.equal(res.status, 200);
  return ((await res.json()) as { leases: { key: string; token?: string; exp?: number; ast?: unknown; error?: string }[] }).leases;
}

const RAW = { table: "issue", where: { type: "simple", op: "=", left: { type: "column", name: "projectId" }, right: { type: "literal", value: "p0003" } }, orderBy: [["createdAt", "desc"], ["id", "asc"]], limit: 5 };

test("raw queries and writes need the admin token", async () => {
  for (const path of ["/api/query", "/api/write"]) {
    const res = await fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify({ db: "db1g", ast: RAW, ops: { ops: [] } }) });
    assert.equal(res.status, 401, path);
  }
});

test("a leased named query is served; bad arguments get no lease", async () => {
  const [ok, count, bad, unknown] = await lease([
    { name: "issues", args: { project: "p0003", filter: { status: ["todo"] }, limit: 5 } },
    { name: "count", args: { project: "p0003" } },
    { name: "issues", args: { project: "p0003; drop", limit: 5 } },
    { name: "everything" },
  ]);
  assert.ok(ok.token && ok.exp! > Date.now() + 50_000);
  assert.match(bad.error!, /bad project/);
  assert.match(unknown.error!, /unknown query/);
  const s = await socket();
  s.ws.send(JSON.stringify({ t: "subs", list: [{ id: "l", lease: ok.token }, { id: "c", lease: count.token }] }));
  const snap = await s.next((m) => m.t === "snap" && m.id === "l");
  assert.equal(snap.rows!.length, 5);
  assert.ok(snap.rows!.every((r) => (r as { status?: string }).status === "todo"));
  assert.ok((await s.next((m) => m.t === "snap" && m.id === "c")).count! > 0);
  s.ws.close();
});

test("raw ASTs, forged leases and a spoofed admin header are refused", async () => {
  const [ok] = await lease([{ name: "issues", args: { project: "p0003", limit: 5 } }]);
  const [v, payload, sig] = ok.token!.split(".");
  // Same signature, payload re-pointed at another project's issues, without a limit.
  const p = JSON.parse(Buffer.from(payload, "base64url").toString());
  p.ast.where.right.value = "p0004";
  p.ast.limit = 1000;
  const forged = `${v}.${Buffer.from(JSON.stringify(p)).toString("base64url")}.${sig}`;
  const s = await socket({ "x-pagedb-admin": "1" }, "?db=db1g&obj=elsewhere");
  s.ws.send(JSON.stringify({ t: "subs", list: [{ id: "raw", q: RAW }, { id: "forged", lease: forged }, { id: "junk", lease: "v1.x.y" }] }));
  s.ws.send(JSON.stringify({ t: "sub", id: "single", q: RAW }));
  assert.match((await s.next((m) => m.t === "error" && m.id === "raw")).message!, /lease is required/);
  assert.match((await s.next((m) => m.t === "error" && m.id === "forged")).message!, /signature/);
  assert.ok(await s.next((m) => m.t === "error" && m.id === "junk"));
  // The genuine lease still works on the same socket (the visitor reached the demo object).
  s.ws.send(JSON.stringify({ t: "subs", list: [{ id: "ok", lease: ok.token }] }));
  assert.equal((await s.next((m) => m.t === "snap" && m.id === "ok")).rows!.length, 5);
  assert.ok(!s.msgs.some((m) => m.t === "snap" && ["raw", "forged", "junk", "single"].includes(m.id!)));
  s.ws.close();
});

test("leases expire, and are bound to one database and object (offline)", async () => {
  const { signLease, verifyLease } = await import("../src/lease.ts");
  const at = { ast: RAW, db: "db1g", obj: "demo" };
  const { token } = await signLease("s3cret", at);
  assert.deepEqual((await verifyLease("s3cret", token, at)).ast, RAW);
  await assert.rejects(verifyLease("other", token, at), /signature/);
  await assert.rejects(verifyLease("s3cret", token, { db: "db1g", obj: "other" }), /another database/);
  const old = await signLease("s3cret", at, -1);
  await assert.rejects(verifyLease("s3cret", old.token, at), /expired/);
});
