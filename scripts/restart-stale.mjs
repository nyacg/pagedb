// After a deploy: an object that never goes idle (HN's, written to every 10 s by its live tail)
// can keep running the previous code. Restart any app object whose build isn't the new one;
// its state is in its SQLite, and open sockets reconnect.
//   node scripts/restart-stale.mjs [https://pagedb.do-pool-lab.workers.dev]
import { readFileSync } from "node:fs";
const base = process.argv[2] ?? "https://pagedb.do-pool-lab.workers.dev";
const token = readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const auth = { authorization: `Bearer ${token}` };
const html = await fetch(`${base}/hn`).then((r) => r.text());
const current = JSON.parse(html.match(/window\.__BOOT=(\{.*?\})<\/script>/s)[1]).build;
for (const [db, obj] of [["db100g", "demo100g"], ["hn", "hn"], ["place", "place"], ["taxi", "taxi"]]) {
  const info = await fetch(`${base}/api/admin/info?db=${db}&obj=${obj}`, { headers: auth }).then((r) => r.json());
  if (info.build && info.build !== current) {
    await fetch(`${base}/api/admin/evict?obj=${obj}`, { method: "POST", headers: auth });
    console.log(`${obj}: was on ${info.build.slice(0, 8)}, restarted onto ${current.slice(0, 8)}`);
  } else console.log(`${obj}: current`);
}
