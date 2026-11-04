// Build a branchable template image: PGDATA as one blob (files on 64 KiB block boundaries,
// small files first) plus an index. node mkimage.mjs <name> <rows>
import { PGlite } from "@electric-sql/pglite";
import { writeFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
const [name, rowsArg] = process.argv.slice(2);
const rows = Number(rowsArg ?? 0);
const conf = "shared_buffers=8MB\nwal_buffers=256kB\nmax_wal_size=16MB\nmin_wal_size=2MB\nwork_mem=1MB\nmaintenance_work_mem=8MB\n";
const pg = await PGlite.create({ initDbStartParams: ["--wal-segsize=1"], postgresqlconf: conf });
if (rows) {
  await pg.exec(`create table story (id int primary key, by text, score int, time timestamptz, title text);
    insert into story select g, 'user' || (g % 50000), (g::bigint * 7919) % 1000, timestamp '2006-10-09' + (g || ' minutes')::interval, 'story ' || md5(g::text) || ' about ' || (array['rust','postgres','durable objects','startups','ai','hardware'])[1 + g % 6] from generate_series(1, ${rows}) g;
    create index story_by_score on story(score, id); analyze story; checkpoint;`);
}
const info = (await pg.query("select pg_size_pretty(pg_database_size(current_database())) s")).rows[0].s;
// After a checkpoint, recovery starts in the current WAL segment: the recycled ones are dead weight.
await pg.exec("checkpoint");
const walKeep = (await pg.query("select pg_walfile_name(pg_current_wal_lsn()) f")).rows[0].f;
// a clean shutdown, so a branch starts without crash recovery
const tar = gunzipSync(Buffer.from(await (await pg.dumpDataDir("gzip")).arrayBuffer()));
await pg.close();
const BLOCK = 65536, files = [], dirs = [];
let off = 0; const dec = new TextDecoder();
const str = (o, n) => dec.decode(tar.subarray(o, o + n)).replace(/\0.*$/s, "");
while (off + 512 <= tar.length) {
  const nm = str(off, 100); if (!nm) break;
  const size = parseInt(str(off + 124, 12).trim() || "0", 8), type = String.fromCharCode(tar[off + 156] || 48), prefix = str(off + 345, 155);
  const mode = parseInt(str(off + 100, 8).trim() || "0", 8) & 0o7777, mtime = parseInt(str(off + 136, 12).trim() || "0", 8) * 1000;
  const path = "/" + (prefix ? prefix + "/" + nm : nm).replace(/^\/+/, "").replace(/\/$/, "");
  if (type === "5") dirs.push({ path, mode });
  else if ((type === "0" || type === "\0") && !(path.startsWith("/pg_wal/") && /^\/pg_wal\/[0-9A-F]{24}$/.test(path) && !path.endsWith(walKeep))) files.push({ path, mode, mtime, size, data: tar.subarray(off + 512, off + 512 + size) });
  off += 512 + Math.ceil(size / 512) * 512;
}
files.sort((a, b) => a.size - b.size);
const EAGER = 1 << 20; // files up to 1 MiB are copied whole when a branch is made: packed tight
let pos = 0; const index = [];
for (const f of files) {
  if (f.size > EAGER) pos = Math.ceil(pos / BLOCK) * BLOCK; // big files: block-aligned, fetched lazily
  index.push({ path: f.path, mode: f.mode, mtime: f.mtime, size: f.size, off: pos });
  pos += f.size;
}
pos = Math.ceil(pos / BLOCK) * BLOCK;
const blob = Buffer.alloc(pos);
files.forEach((f, i) => f.data.copy(blob, index[i].off));
const eagerEnd = index.filter((f) => f.size <= EAGER).reduce((m, f) => Math.max(m, f.off + f.size), 0);
writeFileSync(`${name}.blob`, blob);
writeFileSync(`${name}.json`, JSON.stringify({ block: BLOCK, eagerEnd, dirs, files: index }));
console.log(`${name}: db ${info}, ${files.length} files, blob ${(pos / 1e6).toFixed(1)} MB, eager prefix ${(eagerEnd / 1e6).toFixed(1)} MB (files ≤ 1 MiB), biggest ${index.at(-1).path} ${(index.at(-1).size / 1e6).toFixed(1)} MB`);
