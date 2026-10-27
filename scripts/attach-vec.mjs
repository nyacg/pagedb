// Attach a vector index segment to a base under a new database name, leaving the base alone.
//   node scripts/attach-vec.mjs <segment dir|R2 manifest key> <base db> <new db> [--segdb hnvec] [--url https://pagedb-vec…]
// A local segment dir (pagedb-builder vec-build --out DIR) is uploaded to db/<segdb>/base/<id>/
// first; a key (db/hnvec/manifest-<id>.json, from the builder container) is used as is. The new
// database's manifest is the base's with `baseDb` (its parts stay where they are), the
// segment's trees and vector index, and the segment's location.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [seg, baseDb, newDb] = args;
const segDb = opt("--segdb", "hnvec");
const url = opt("--url", "https://pagedb-vec.do-pool-lab.workers.dev");
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const r2get = (key) => execFileSync("npx", ["wrangler", "r2", "object", "get", `pagedb/${key}`, "--remote", "--pipe"], { maxBuffer: 1 << 30 }).toString();
const put = async (key, body) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${url}/api/admin/r2/${encodeURIComponent(key)}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) return;
    if (attempt >= 6) throw new Error(`${key}: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
};

let segManifest, segBase;
if (existsSync(`${seg}/manifest.json`)) {
  segManifest = JSON.parse(readFileSync(`${seg}/manifest.json`, "utf8"));
  segBase = `b${Date.now().toString(36)}`;
  const parts = readdirSync(`${seg}/parts`).sort();
  let done = 0;
  const queue = [...parts];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      await put(`db/${segDb}/base/${segBase}/${p}`, readFileSync(`${seg}/parts/${p}`));
      if (++done % 25 === 0 || done === parts.length) process.stdout.write(`\r${done}/${parts.length} segment parts`);
    }
  }));
  console.log("");
} else {
  segManifest = JSON.parse(r2get(seg));
  segBase = segManifest.base;
}
const base = JSON.parse(r2get(`db/${baseDb}/manifest.json`));
writeFileSync("/tmp/attach-base.json", JSON.stringify(base));
writeFileSync("/tmp/attach-seg.json", JSON.stringify(segManifest));
execFileSync("./engine/target/release/pagedb-builder", ["vec-merge", "--base", "/tmp/attach-base.json", "--segment", "/tmp/attach-seg.json", "--segbase", segBase, "--segdb", segDb, "--out", "/tmp/attach-out.json"]);
const merged = JSON.parse(readFileSync("/tmp/attach-out.json", "utf8"));
merged.baseDb = base.baseDb ?? baseDb;
await put(`db/${newDb}/manifest.json`, JSON.stringify(merged));
console.log(`db/${newDb}/manifest.json: base ${merged.base} (in ${merged.baseDb}), segment ${segDb}/${segBase} (${segManifest.vectors.map((v) => `${v.name}: ${v.rows} vectors, ${v.nlist} clusters`).join("; ")})`);
