/**
 * Subscriptions survive hibernation: subscribe, go idle long enough for the object to be
 * evicted (sockets stay open), then write — the woken object must rebuild its partitions from
 * the subs table and push a correct update over the still-open socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://pagedb.do-pool-lab.workers.dev";
const OBJ = `hib-${Date.now().toString(36)}`;
const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const LIST = { table: "issue", where: eq("projectId", "p0004"), orderBy: [["createdAt", "desc"], ["id", "asc"]], limit: 5 };

test("a woken object pushes correct updates to sockets opened before it slept", { timeout: 120_000 }, async () => {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/socket?db=db1g&obj=${OBJ}`);
  const msgs: any[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "subs", list: [{ id: "l", q: LIST }] }));
  for (let i = 0; i < 100 && !msgs.some((m) => m.t === "snaps"); i++) await new Promise((r) => setTimeout(r, 100));
  const rows: Map<string, any> = new Map(msgs.find((m) => m.t === "snaps").list[0].rows.map((r: any) => [r.id, r]));
  const victim = [...rows.keys()][2];
  // Idle: no messages either way (pings are answered without waking the object).
  await new Promise((r) => setTimeout(r, 40_000));
  // A fresh instance has no engine loaded: proof the object really was evicted.
  const token = (await import("node:fs")).readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)![1];
  const info = await (await fetch(`${BASE}/api/admin/info?db=db1g&obj=${OBJ}`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(info.engine, undefined, "object did not hibernate");
  assert.equal(info.sockets, 1, "socket should have stayed open");
  const res = await fetch(`${BASE}/api/write`, {
    method: "POST",
    body: JSON.stringify({ db: "db1g", obj: OBJ, ops: { ops: [{ op: "update", table: "issue", id: victim, set: { status: "review", title: "Edited after hibernation" } }] } }),
  });
  const w = (await res.json()) as { version: number; error?: string };
  assert.equal(w.error, undefined);
  for (let i = 0; i < 100 && !msgs.some((m) => m.t === "poke"); i++) await new Promise((r) => setTimeout(r, 100));
  const poke = msgs.find((m) => m.t === "poke");
  assert.ok(poke, "no poke after waking");
  assert.deepEqual(poke.subs.l.map((op: any[]) => [op[0], op[1]]), [["e", victim]]);
  assert.equal(poke.subs.l[0][2].title, "Edited after hibernation");
  ws.close();
});
