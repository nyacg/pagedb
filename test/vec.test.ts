/**
 * Vector search end to end against the deployed vec Worker: a story and its vector written in
 * one batch are found by the next search; a live semantic subscription gets the new story
 * pushed; deleting the story removes it (and its vector); visitors can only run the signed
 * semantic query (a forged vector query is refused).
 *   BASE=https://pagedb-vec.do-pool-lab.workers.dev node --import tsx --test test/vec.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://pagedb-vec.do-pool-lab.workers.dev";
const TOKEN = (await import("node:fs")).readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)![1];
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const DB = process.env.DB ?? "hnv";
const OBJ = `vec-${Date.now().toString(36)}`; // a private object: its overlay starts empty
const DIMS = 1024;

function unit(seed: number): number[] {
  let x = seed;
  const v = Array.from({ length: DIMS }, () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5);
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}
const b64 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const ann = (v: number[], k = 5) => ({ table: "story", ann: { index: "story_vec", vec: b64(v), k } });

async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
  return (await r.json()) as any;
}

test("a vector written with its row is found by the next search, and goes with the row", async () => {
  const v = unit(42);
  const id = `t-${Date.now().toString(36)}`;
  const w = await post("/api/write", { db: DB, obj: OBJ, ops: { ops: [
    { op: "insert", table: "story", row: { id, title: "vector test story", time: Date.now(), kind: "story", score: 1 } },
    { op: "vec_put", index: "story_vec", id, vec: b64(v) },
  ] } });
  assert.ok(!w.error, w.error);
  const q = await post("/api/query", { db: DB, obj: OBJ, ast: ann(v) });
  // Top hit. (Its score isn't ~1: a random vector is far from every cluster of real stories, so
  // its residual saturates the 4-bit codes, which were calibrated on real data.)
  assert.equal(q.result.rows[0].id, id);
  assert.equal(q.result.ann.overlay, 1);
  const d = await post("/api/write", { db: DB, obj: OBJ, ops: { ops: [{ op: "delete", table: "story", id }] } });
  assert.ok(!d.error, d.error);
  const q2 = await post("/api/query", { db: DB, obj: OBJ, ast: ann(v) });
  assert.ok(!q2.result.rows.some((r: { id: string }) => r.id === id));
});

test("a live semantic subscription is pushed a new matching story", async () => {
  const v = unit(7);
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/socket?db=${DB}&obj=${OBJ}&token=${TOKEN}`);
  const msgs: any[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  const next = async (pred: (m: any) => boolean, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
      const m = msgs.find(pred);
      if (m) return m;
    }
    throw new Error("timed out");
  };
  await next((m) => m.t === "hello");
  ws.send(JSON.stringify({ t: "sub", id: "s1", q: ann(v, 10) }));
  const snap = await next((m) => m.t === "snap" && m.id === "s1");
  assert.equal(snap.rows.length, 10);
  const id = `live-${Date.now().toString(36)}`;
  const near = v.map((x, i) => x + (i === 0 ? 0.001 : 0));
  await post("/api/write", { db: DB, obj: OBJ, ops: { ops: [
    { op: "insert", table: "story", row: { id, title: "pushed by meaning", time: Date.now(), kind: "story", score: 1 } },
    { op: "vec_put", index: "story_vec", id, vec: b64(near) },
  ] } });
  const poke = await next((m) => m.t === "poke" && m.subs?.s1);
  const ops = poke.subs.s1 as unknown[][];
  assert.ok(ops.some((o) => o[0] === "a" && o[1] === id && (o[2] as any).title === "pushed by meaning"), JSON.stringify(ops).slice(0, 300));
  assert.ok(ops.some((o) => o[0] === "r"), "the 10th result makes room");
  await post("/api/write", { db: DB, obj: OBJ, ops: { ops: [{ op: "delete", table: "story", id }] } });
  const gone = await next((m) => m.t === "poke" && (m.subs?.s1 as unknown[][] | undefined)?.some((o) => o[0] === "r" && o[1] === id));
  assert.ok(gone);
  ws.close();
});

test("visitors get semantic results only through the signed query", async () => {
  // A raw vector query without the admin token is refused; the named query is leased.
  const raw = await fetch(`${BASE}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: DB, ast: ann(unit(1)) }) });
  assert.equal(raw.status, 401);
  const res = await fetch(`${BASE}/api/lease?app=hn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ list: [{ name: "semantic", args: { q: "databases on object storage" } }, { name: "semantic", args: { q: "x".repeat(201) } }] }) });
  const { leases } = (await res.json()) as { leases: { token?: string; ast?: any; error?: string }[] };
  assert.ok(leases[0].token && leases[0].ast.ann.index === "story_vec");
  assert.ok(leases[1].error, "an over-long query is refused");
  // A socket that sends a raw vector AST (no lease, no admin) gets an error, not results.
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/socket?app=hn`);
  const msgs: any[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.t === "snaps") for (const x of m.list) msgs.push({ ...x, t: "snap" });
    else msgs.push(m);
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ t: "subs", list: [{ id: "forged", q: ann(unit(3)) }] }));
  for (const end = Date.now() + 10000; Date.now() < end && !msgs.some((m) => m.id === "forged"); ) await new Promise((r) => setTimeout(r, 50));
  const m = msgs.find((x) => x.id === "forged");
  assert.equal(m?.t, "error");
  ws.close();
});
