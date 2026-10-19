// Upload a built base to R2 through the Worker's admin route.
//   node scripts/upload.mjs data/db1g db1g [https://pagedb.do-pool-lab.workers.dev]
import { readFileSync, readdirSync } from "node:fs";
const [dir, db, base = "https://pagedb.do-pool-lab.workers.dev"] = process.argv.slice(2);
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
const baseId = `b${Date.now().toString(36)}`;
const parts = readdirSync(`${dir}/parts`).sort();
let done = 0, bytes = 0;
const t0 = Date.now();
const put = async (key, body) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/api/admin/r2/${encodeURIComponent(key)}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body });
    if (res.ok) return;
    if (attempt >= 4) throw new Error(`${key}: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
};
const queue = [...parts];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let p = queue.shift(); p; p = queue.shift()) {
    const body = readFileSync(`${dir}/parts/${p}`);
    await put(`db/${db}/base/${baseId}/${p}`, body);
    bytes += body.length;
    if (++done % 25 === 0 || done === parts.length) process.stdout.write(`\r${done}/${parts.length} parts, ${(bytes / 1e6).toFixed(0)} MB, ${((bytes / 1e6) / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s`);
  }
}));
manifest.base = baseId;
await put(`db/${db}/manifest.json`, JSON.stringify(manifest));
console.log(`\nmanifest → db/${db}/manifest.json (base ${baseId})`);
