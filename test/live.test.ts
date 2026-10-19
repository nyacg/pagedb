/**
 * Live sync end to end against the deployed Worker: two clients subscribe; writes over HTTP
 * must reach both as pokes, and applying the pokes must equal a fresh query.
 *   BASE=https://pagedb.do-pool-lab.workers.dev node --import tsx --test test/live.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://pagedb.do-pool-lab.workers.dev";
const TOKEN = (await import("node:fs")).readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)![1];
const AUTH = { authorization: `Bearer ${TOKEN}` };
const DB = "db1g";
const OBJ = `live-${Date.now().toString(36)}`; // a private object: the overlay starts empty
const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const order = [["createdAt", "desc"], ["id", "asc"]];
const LIST = { table: "issue", where: eq("projectId", "p0003"), orderBy: order, limit: 10 };
const COUNT = { table: "issue", where: eq("projectId", "p0003"), aggregate: "count" };
const DETAIL_ID = "i000300100";
const DETAIL = {
  table: "issue", where: eq("id", DETAIL_ID), one: true,
  related: [{ alias: "comments", correlation: { parentField: ["id"], childField: ["issueId"] }, subquery: { table: "comment", orderBy: [["createdAt", "asc"], ["id", "asc"]], limit: 200 } }],
};

type Msg = { t: string; id?: string; rows?: { id: string }[]; count?: number; subs?: Record<string, unknown[][]>; version?: number };

class Client {
  ws!: WebSocket;
  msgs: Msg[] = [];
  waiters: [(m: Msg) => boolean, (m: Msg) => void][] = [];
  views = new Map<string, Map<string, { id: string }>>();
  counts = new Map<string, number>();
  async open() {
    this.ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/socket?db=${DB}&obj=${OBJ}&token=${TOKEN}`);
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Msg;
      if (m.t === "snap") {
        if (m.rows) this.views.set(m.id!, new Map(m.rows.map((r) => [r.id, r])));
        if (m.count !== undefined) this.counts.set(m.id!, m.count);
      }
      if (m.t === "poke") {
        for (const [id, ops] of Object.entries(m.subs!)) {
          for (const op of ops) {
            const v = this.views.get(id);
            if (op[0] === "a" || op[0] === "e") v!.set(op[1] as string, op[2] as { id: string });
            else if (op[0] === "r") v!.delete(op[1] as string);
            else if (op[0] === "c") this.counts.set(id, op[1] as number);
          }
        }
      }
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w[0](m)) (this.waiters.splice(this.waiters.indexOf(w), 1), w[1](m));
    });
    await this.next((m) => m.t === "hello");
  }
  next(pred: (m: Msg) => boolean, timeout = 15000): Promise<Msg> {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timed out")), timeout);
      this.waiters.push([pred, (m) => (clearTimeout(t), res(m))]);
    });
  }
  sub(id: string, q: unknown) {
    this.ws.send(JSON.stringify({ t: "sub", id, q }));
    return this.next((m) => m.t === "snap" && m.id === id);
  }
}

async function write(ops: unknown[]) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/write`, { method: "POST", headers: AUTH, body: JSON.stringify({ db: DB, obj: OBJ, ops: { ops } }) });
  const body = (await res.json()) as { version: number; error?: string };
  assert.equal(body.error, undefined, body.error);
  return { ...body, t0 };
}

async function fresh(q: unknown) {
  const res = await fetch(`${BASE}/api/query`, { method: "POST", headers: AUTH, body: JSON.stringify({ db: DB, obj: OBJ, ast: q }) });
  return ((await res.json()) as { result: { rows?: { id: string }[]; count?: number } }).result;
}

test("writes reach every subscriber and keep their views exact", async () => {
  const a = new Client(), b = new Client();
  await Promise.all([a.open(), b.open()]);
  for (const c of [a, b]) {
    await c.sub("list", LIST);
    await c.sub("count", COUNT);
    await c.sub("detail", DETAIL);
  }
  const count0 = a.counts.get("count")!;
  const now = Date.now() + 1e9; // newer than any generated issue → lands at the top of the list
  const lat: number[] = [];
  const step = async (ops: unknown[], check: () => Promise<void>) => {
    const pokesBefore = b.msgs.filter((m) => m.t === "poke").length;
    const w = await write(ops);
    await b.next((m) => m.t === "poke" && m.version === w.version);
    lat.push(performance.now() - w.t0);
    assert.ok(b.msgs.filter((m) => m.t === "poke").length > pokesBefore);
    await check();
  };
  const agree = async () => {
    const f = await fresh(LIST);
    for (const c of [a, b]) {
      await c.next((m) => m.t === "poke" && m.version === b.msgs.filter((x) => x.t === "poke").at(-1)!.version);
      assert.deepEqual([...c.views.get("list")!.keys()].sort(), f.rows!.map((r) => r.id).sort());
    }
  };
  await step([{ op: "insert", table: "issue", row: { id: `t-${OBJ}`, projectId: "p0003", title: "Live sync works", status: "todo", priority: "high", ownerId: "u00001", createdAt: now, updatedAt: now, tags: ["sync"] } }], async () => {
    assert.ok(b.views.get("list")!.has(`t-${OBJ}`));
    assert.equal(b.counts.get("count"), count0 + 1);
    await agree();
  });
  await step([{ op: "update", table: "issue", id: `t-${OBJ}`, set: { status: "review" } }], async () => {
    assert.equal((b.views.get("list")!.get(`t-${OBJ}`) as unknown as { status: string }).status, "review");
  });
  await step([{ op: "insert", table: "comment", row: { id: `k-${OBJ}`, issueId: DETAIL_ID, authorId: "u00002", body: "on it", createdAt: now } }], async () => {
    const d = b.views.get("detail")!.get(DETAIL_ID) as unknown as { comments: { id: string }[]; commentCount: number };
    assert.ok(d.comments.some((c) => c.id === `k-${OBJ}`));
  });
  await step([{ op: "delete", table: "issue", id: `t-${OBJ}` }], async () => {
    assert.ok(!b.views.get("list")!.has(`t-${OBJ}`));
    assert.equal(b.counts.get("count"), count0);
    await agree();
  });
  lat.sort((x, y) => x - y);
  console.log(`write → poke at the other client (incl. internet both ways): ${lat.map(Math.round).join(", ")} ms`);
  a.ws.close();
  b.ws.close();
});
