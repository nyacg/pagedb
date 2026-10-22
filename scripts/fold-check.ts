/**
 * Fold an app's object and check nothing visible changed: the same queries before the fold,
 * right after it, after the object restarts (reloading layer + log from storage), and with its
 * page cache dropped (every page, the layer's included, read back from R2).
 *   node --import tsx scripts/fold-check.ts <app> [--edits n] [--base URL]
 * Needs ADMIN_TOKEN (in .env). Results are compared exactly when no write landed in between
 * (the overlay version is unchanged); otherwise the differences are listed.
 */
import { readFileSync } from "node:fs";
import * as hn from "../src/apps/hn";
import * as taxi from "../src/apps/taxi";
import * as place from "../src/apps/place";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const app = process.argv[2] ?? "taxi";
const BASE = arg("base", "https://pagedb-preview.do-pool-lab.workers.dev")!;
const EDITS = Number(arg("edits", "0"));
const H = { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "content-type": "application/json" };
const db = app, obj = app;

const QUERIES: Record<string, [string, Record<string, unknown>][]> = {
  taxi: [
    ["rows", {}], ["rows", { offset: 73_000_000 }], ["rows", { offset: 146_039_100 }], ["rows", { sort: "tip" }], ["rows", { sort: "tip", dir: "asc", offset: 5_000_000 }],
    ["rows", { sort: "total", offset: 1000 }], ["rows", { payment: 2, offset: 20_000_000 }], ["count", {}], ["count", { payment: 1 }], ["count", { borough: "Queens" }],
    ["trip", { id: "073000000" }], ["trip", { id: "072999998" }],
  ],
  hn: [
    ["top", {}], ["new", {}], ["best", {}], ["kind", { kind: "ask" }], ["kind", { kind: "show" }], ["search", { words: ["rust"] }], ["search", { words: ["postgres"] }],
    ["from", { domain: "github.com" }], ["userStories", { by: "pg" }], ["userComments", { by: "dang" }], ["newComments", {}], ["item", { id: "8863" }], ["thread", { story: "8863" }],
  ],
  place: [["meta", {}], ["tiles", {}], ["recent", {}], ["pixel", { pos: 998 * 2000 + 999 }], ["pixel", { pos: 1000 * 2000 + 1000 }], ["snap", { k: 3 }]],
};
const named = { hn: hn.namedQuery, taxi: taxi.namedQuery, place: place.namedQuery }[app as "hn"]!;

async function post(path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
}
const info = async () => (await fetch(`${BASE}/api/admin/info?db=${db}&obj=${obj}`, { headers: H })).json() as Promise<any>;

async function snapshot() {
  const out: Record<string, string> = {};
  for (const [name, args] of QUERIES[app]) {
    const r = await post("/api/query", { db, obj, ast: named(name, args) });
    out[`${name} ${JSON.stringify(args)}`] = JSON.stringify(r.result);
  }
  return out;
}

function compare(label: string, a: Record<string, string>, b: Record<string, string>, strict: boolean) {
  const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
  console.log(`${label}: ${diff.length ? `${diff.length} of ${Object.keys(a).length} queries differ${strict ? "  <-- FAIL (no writes in between)" : " (writes landed in between)"}` : `all ${Object.keys(a).length} queries identical`}`);
  for (const k of diff) console.log(`   ${k}\n     before ${a[k].slice(0, 160)}\n     after  ${b[k].slice(0, 160)}`);
  return !(strict && diff.length);
}

let ok = true;
if (EDITS && app === "taxi") {
  for (let i = 0; i < EDITS; i++) {
    const id = String(73_000_000 + i * 7919).padStart(9, "0");
    await post("/api/mutate?app=taxi", { name: "edit", args: { id, note: `fold check ${i}`, tipDelta: 0.25 } });
  }
  console.log(`made ${EDITS} edits`);
}
const i0 = await info();
console.log("before:", JSON.stringify({ layer: i0.layer, overlay: i0.overlay, log: i0.overlayLog, wasmMemMB: i0.engine?.wasmMemMB }));
const s1 = await snapshot();
const v1 = (await info()).overlay?.version;
const f = await post(`/api/admin/fold?db=${db}&obj=${obj}`);
console.log("fold:", JSON.stringify(f));
const s2 = await snapshot();
const i2 = await info();
console.log("after: ", JSON.stringify({ layer: i2.layer, overlay: i2.overlay, log: i2.overlayLog, wasmMemMB: i2.engine?.wasmMemMB }));
ok = compare("fold", s1, s2, i2.overlay?.version === v1) && ok;
await post(`/api/admin/evict?db=${db}&obj=${obj}`).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const s3 = await snapshot();
const i3 = await info();
console.log("reload:", JSON.stringify({ layer: i3.layer, overlay: i3.overlay, log: i3.overlayLog, wasmMemMB: i3.engine?.wasmMemMB }));
ok = compare("restart", s2, s3, i3.overlay?.version === i2.overlay?.version) && ok;
// Cold: drop the object's SQLite page tier, so every page (the layer's too) comes from R2.
await post(`/api/admin/reset?db=${db}&obj=${obj}`);
await post(`/api/admin/evict?db=${db}&obj=${obj}`).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const s4 = await snapshot();
const i4 = await info();
console.log("cold:  ", JSON.stringify({ layer: i4.layer?.id, sqliteMB: i4.sqliteMB, overlay: i4.overlay }));
ok = compare("cold from R2", s3, s4, i4.overlay?.version === i3.overlay?.version) && ok;
process.exit(ok ? 0 : 1);
