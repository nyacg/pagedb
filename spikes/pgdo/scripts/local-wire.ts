// The wire layer (src/wire.ts) over an in-memory PGlite in Node: a reference for the Durable
// Object (same protocol code, no SQLite storage, no Workers), and a quick local Postgres.
//   node --experimental-strip-types scripts/local-wire.ts [port] [password] [dir to mirror …]
// PGDATA_ROOT=/some/dir keeps each database on disk (<root>/<db>), so a restart recovers it.
// Mirrored directories appear at the same paths inside the database's filesystem (pg_regress
// COPYs its data files from absolute paths on the server).
import { createServer } from "node:net";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Gate, WireConn, type WireHost } from "../src/wire.ts";

const port = Number(process.argv[2] ?? 6544);
const password = process.argv[3] ?? "local";
const mirror = process.argv.slice(4);
const dbs = new Map<string, WireHost>();

async function boot(name: string) {
  const root = process.env.PGDATA_ROOT;
  if (root) mkdirSync(root, { recursive: true });
  const pg = await PGlite.create(root ? join(root, name) : undefined);
  const FS = (pg as any).mod.FS;
  const copy = (dir: string) => {
    FS.mkdirTree(dir);
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) copy(p);
      else FS.writeFile(p, readFileSync(p));
    }
  };
  for (const d of mirror) copy(d);
  return pg;
}

function host(name: string): WireHost {
  let h = dbs.get(name);
  if (!h) {
    let pg: Promise<PGlite> | undefined;
    h = {
      gate: new Gate(),
      pg: () => (pg ??= boot(name)),
      checkPassword: async (_u, p) => p === password,
      exec: async (bytes) =>
        (await pg!).execProtocolRaw(bytes).catch((e) => {
          // Postgres exited (a PGlite bug path): boot it again next time
          if (e?.name === "ExitStatus") (pg = undefined), (h!.gate.txOwner = null), (h!.gate.sessionOwner = null);
          throw e;
        }),
    };
    dbs.set(name, h);
  }
  return h;
}

createServer((sock) => {
  sock.setNoDelay(true);
  let conn: WireConn | undefined;
  let head = Buffer.alloc(0);
  sock.on("data", (d) => {
    if (conn) return conn.feed(new Uint8Array(d));
    // the database name is in the startup packet (after any SSL/GSS request)
    head = Buffer.concat([head, d]);
    for (;;) {
      if (head.length < 8) return;
      const len = head.readInt32BE(0), code = head.readInt32BE(4);
      if (code === 80877103 || code === 80877104) {
        sock.write("N");
        head = head.subarray(8);
        continue;
      }
      if (head.length < len) return;
      const params = head.subarray(8, len).toString("utf8").split("\0");
      const at = params.indexOf("database"), user = params[params.indexOf("user") + 1];
      const db = at >= 0 ? params[at + 1] : user;
      conn = new WireConn(host(db || "postgres"), (b) => sock.write(b), () => sock.end());
      conn.feed(new Uint8Array(head));
      return;
    }
  });
  sock.on("close", () => void conn?.end());
  sock.on("error", () => void conn?.end());
}).listen(port, () => console.log(`PGlite over the wire on :${port} (password ${password})`));
