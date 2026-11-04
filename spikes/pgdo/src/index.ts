// Postgres in a Durable Object: PGlite (Postgres compiled to WebAssembly) with PGDATA in the
// object's own SQLite (src/sqlitefs.ts). A new database starts from a template PGDATA in R2.
import "./no-node";
import "./clock";
import "./shims";
import "./libs";
import { contrib } from "./exts";
import { DurableObject } from "cloudflare:workers";
import { PGlite } from "@electric-sql/pglite";
import pgliteWasm from "../vendor/pglite.wasm";
import initdbWasm from "../vendor/initdb.wasm";
import fsBundle from "../vendor/pglite.data";
import { SqliteFS, type ImageIndex } from "./sqlitefs";
import { SMALL_SHMEM, START } from "./pgconfig";
import { CHECKS, runCheck } from "./compat";
import { Gate, WireConn, type WireHost } from "./wire";
import { explain, load, neonTarget, run as runOps, SETUP, type Stmt, type Target } from "./bench";

/** Template images (scripts/mkimage.mjs): pgspike/img/<name>.json (the index) and .blob (PGDATA). */
const IMG = (name: string) => `pgspike/img/${name}`;

/** Objects of one class can share an isolate (and its 128 MB): which isolate, and who's in it. */
let isolate: string | undefined; // named on first use (no randomness at global scope)
const running = new Set<PgObject>();

interface Env { PG: DurableObjectNamespace<PgObject>; [k: `PG${number}`]: DurableObjectNamespace<PgObject>; BUCKET: R2Bucket; NEON_DATABASE_URL: string; PGDO_TOKEN: string }

/** Constant-time comparison of a presented secret with the expected one. */
export async function sameSecret(given: string | null | undefined, expected: string | undefined) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export class PgObject extends DurableObject<Env> {
  pg?: PGlite;
  private fs?: SqliteFS;
  private started?: { templateMs?: number; files?: number };
  private readonly instance = crypto.randomUUID().slice(0, 8);

  /** Start Postgres: a new database is a branch of a template image (default "base", empty). */
  private async ensure(image?: string) {
    if (this.pg) return undefined;
    // Memory knobs (per database, for experiments): /config?db=…&cacheMB=1&sharedBuffers=2MB
    const conf = this.ctx.storage.kv.get<{ cacheMB?: number; sharedBuffers?: string }>("conf") ?? {};
    const fs = (this.fs = new SqliteFS(this.ctx.storage.sql, (conf.cacheMB ?? 4) * 1024 * 1024));
    const st: { image?: string; branchMs?: number; files?: number; lazy?: number; eagerMB?: number } = {};
    if (fs.empty) {
      const t0 = Date.now();
      const name = image ?? "base";
      const index = (await (await this.env.BUCKET.get(`${IMG(name)}.json`))!.json()) as ImageIndex;
      const eager = new Uint8Array(await (await this.env.BUCKET.get(`${IMG(name)}.blob`, { range: { offset: 0, length: index.eagerEnd } }))!.arrayBuffer());
      const r = this.ctx.storage.transactionSync(() => fs.initFromImage(index, eager));
      this.ctx.storage.kv.put("image", name);
      Object.assign(st, { image: name, ...r, eagerMB: +(eager.length / 1e6).toFixed(1), branchMs: Date.now() - t0 });
    }
    // The database inside is called what clients connect to (current_database(), information_schema):
    // the first boot renames the image's "postgres" from template1, then reconnects.
    const want = this.ctx.id.name && this.ctx.id.name.length < 64 ? this.ctx.id.name : "postgres";
    const have = this.ctx.storage.kv.get<string>("pgdb") ?? "postgres";
    if (have !== want) {
      const pg = await this.boot(fs, conf, "template1");
      await pg.exec(`ALTER DATABASE "${have.replace(/"/g, '""')}" RENAME TO "${want.replace(/"/g, '""')}"`);
      await pg.close();
      this.ctx.storage.kv.put("pgdb", want);
      this.fs = new SqliteFS(this.ctx.storage.sql, (conf.cacheMB ?? 4) * 1024 * 1024);
    }
    this.pg = await this.boot(this.fs!, conf, want);
    running.add(this);
    this.writeExtraFiles();
    return st;
  }

  private boot(fs: SqliteFS, conf: { sharedBuffers?: string }, database: string) {
    return PGlite.create({
      fs,
      database,
      pgliteWasmModule: pgliteWasm,
      initdbWasmModule: initdbWasm,
      // Every instance in the isolate reads the same bundle buffer, and MEMFS keeps views into it
      // (the loader writes with canOwn), so share/ costs nothing per instance.
      fsBundle: { arrayBuffer: async () => fsBundle } as unknown as Blob,
      extensions: { contrib },
      // Objects share isolates (2–4 per 128 MB isolate under load), so keep each one small: the wasm
      // heap starts at 16 MB (the binary is patched to allow it); Postgres gets 4 MB of buffers.
      initialMemory: 16 * 1024 * 1024,
      startParams: [...START, "-c", `shared_buffers=${conf.sharedBuffers ?? "4MB"}`, "-c", "wal_buffers=64kB", "-c", "work_mem=1MB", "-c", "maintenance_work_mem=4MB", ...SMALL_SHMEM],
    });
  }

  // ---------------------------------------------------------------- the wire protocol

  /** Everything that touches Postgres goes through here: wire clients and the HTTP routes. */
  private readonly gate = new Gate();
  private wireHost?: WireHost;

  /** A Postgres wire connection, carried over a WebSocket (scripts/pgdo-proxy.mjs bridges TCP). */
  override async fetch(req: Request) {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.binaryType = "arraybuffer"; // the standard default (newer compatibility dates) is Blob
    const send = (b: Uint8Array) => {
      // keep each WebSocket message well under the 1 MiB limit; the client sees one byte stream
      for (let i = 0; i < b.length; i += 1 << 19) server.send(b.subarray(i, i + (1 << 19)));
    };
    const conn = new WireConn(this.host(), send, () => {
      try {
        server.close(1000, "bye");
      } catch {}
    });
    server.addEventListener("message", (e) => conn.feed(typeof e.data === "string" ? new TextEncoder().encode(e.data) : new Uint8Array(e.data as ArrayBuffer)));
    server.addEventListener("close", () => void conn.end());
    server.addEventListener("error", () => void conn.end());
    return new Response(null, { status: 101, webSocket: client });
  }

  private host(): WireHost {
    return (this.wireHost ??= {
      gate: this.gate,
      pg: async () => {
        await this.ensure();
        return this.pg!;
      },
      checkPassword: (_user, password) => sameSecret(password, this.env.PGDO_TOKEN),
      exec: (bytes, idle) => this.execRaw(bytes, idle),
      restart: async () => {
        const pg = this.pg;
        running.delete(this);
        this.pg = undefined;
        this.fs = undefined;
        this.gate.txOwner = null;
        this.gate.sessionOwner = null;
        await pg?.close().catch(() => {});
      },
    });
  }

  /** Raw protocol messages. A batch that read a page still in the template image is rolled back
   *  and run again once the page is fetched, if it started outside a transaction block. */
  private async execRaw(bytes: Uint8Array, idle: boolean) {
    for (let round = 0; ; round++) {
      const out = await this.pg!.execProtocolRaw(bytes).catch((e) => this.died(e));
      if (!this.fs!.missing.size) return out;
      if (!idle || round >= 80) {
        this.fs!.missing.clear();
        return out;
      }
      await this.pg!.exec("ROLLBACK").catch(() => {});
      await this.fetchMissing();
    }
  }

  /** Postgres exited (a PGlite bug path): forget the instance, so the next request boots it again
   *  from SQLite (crash recovery), and fail this one. */
  private died(e: unknown): never {
    if ((e as { name?: string })?.name === "ExitStatus" || /exit\(/.test(String((e as Error)?.message))) {
      running.delete(this);
      this.pg = undefined;
      this.fs = undefined;
      this.gate.txOwner = null;
      this.gate.sessionOwner = null;
    }
    throw e;
  }

  private fetchMissing() {
    const image = this.ctx.storage.kv.get<string>("image") ?? "base";
    return this.fs!.fetchMissing(async (offset, length) => (await (await this.env.BUCKET.get(`${IMG(image)}.blob`, { range: { offset, length } }))!.arrayBuffer()));
  }

  /** Files outside PGDATA that server-side COPY should see (pg_regress's data files), kept in
   *  SQLite and written into the in-memory filesystem at every boot (RPC). An entry without
   *  data is a directory. */
  async putFiles(files: [string, string | null][]) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS extra_files (path TEXT PRIMARY KEY, data BLOB)");
    for (const [path, b64] of files) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO extra_files (path, data) VALUES (?, ?)", path, b64 === null ? null : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    this.writeExtraFiles();
    return { files: files.length };
  }

  private writeExtraFiles() {
    const FS = (this.pg as any)?.mod?.FS;
    if (!FS) return;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS extra_files (path TEXT PRIMARY KEY, data BLOB)");
    for (const r of this.ctx.storage.sql.exec<{ path: string; data: ArrayBuffer | null }>("SELECT path, data FROM extra_files ORDER BY path")) {
      if (r.data === null) FS.mkdirTree(r.path);
      else {
        FS.mkdirTree(r.path.slice(0, r.path.lastIndexOf("/")));
        FS.writeFile(r.path, new Uint8Array(r.data));
      }
    }
  }

  /** Run SQL; a read of a block still in the template image fails the statement, so fetch what
   *  it was missing and run it again (rolled back first: the whole request retries). */
  private run<T>(f: () => Promise<T>) {
    // in turn with wire clients (never inside one's transaction), with default session settings
    return this.gate.run({}, async () => {
      await this.gate.switchTo(this.pg!, null);
      let rounds = 0;
      const t0 = Date.now();
      for (;;) {
        try {
          const r = await f();
          return { r, faultRounds: rounds, faultMs: rounds ? Date.now() - t0 : 0 };
        } catch (e) {
          if (!this.fs!.missing.size || rounds >= 80) throw e;
          rounds++;
          await this.pg!.exec("ROLLBACK").catch(() => {});
          await this.fetchMissing();
        }
      }
    });
  }

  /** This object's isolate and the Postgres instances running in it (RPC). */
  where() {
    const heaps = [...running].map((o) => (o.pg as any)?.mod?.HEAPU8?.length ?? 0);
    return { isolate: (isolate ??= crypto.randomUUID().slice(0, 8)), postgresInIsolate: running.size, heapsMB: +(heaps.reduce((a, b) => a + b, 0) / 1e6).toFixed(1) };
  }

  private mem() {
    const m = (this.pg as any)?.mod;
    const heap = m?.HEAPU8?.length ?? m?.wasmMemory?.buffer?.byteLength;
    return { instance: this.instance, heapMB: heap ? +(heap / 1e6).toFixed(1) : null, sqliteMB: +(this.ctx.storage.sql.databaseSize / 1e6).toFixed(1), fs: this.fs?.snapshot() };
  }

  async exec(sql: string, image?: string) {
    try {
      const start = await this.ensure(image);
      const { r: res, faultRounds, faultMs } = await this.run(() => this.pg!.exec(sql));
      return { start, faultRounds, faultMs, results: res.map((r) => ({ rows: r.rows.slice(0, 20), n: r.rows.length, affected: r.affectedRows })), ...this.mem() };
    } catch (e) {
      return { error: String((e as Error).stack ?? e).slice(0, 2000), ...this.mem() };
    }
  }

  /** Set memory knobs and restart Postgres with them (RPC). */
  async configure(conf: { cacheMB?: number; sharedBuffers?: string }) {
    this.ctx.storage.kv.put("conf", conf);
    this.fs?.flush();
    await this.pg?.close().catch(() => {});
    running.delete(this);
    this.pg = undefined;
    this.fs = undefined;
    return conf;
  }

  /** Create the database from a template image if it doesn't exist yet (RPC). */
  async init(image?: string) {
    return this.ensure(image);
  }

  /** One statement with parameters (RPC). */
  async q(sql: string, params: unknown[] = []) {
    await this.ensure();
    return (await this.run(() => this.pg!.query(sql, params))).r.rows;
  }

  /** Several statements as one transaction (RPC). */
  async tx(stmts: Stmt[]) {
    await this.ensure();
    const { r } = await this.run(() => this.pg!.transaction(async (t) => {
      const out: unknown[][] = [];
      for (const s of stmts) out.push((await t.query(s.sql, s.params ?? [])).rows);
      return out;
    }));
    return r;
  }

  /** n single-statement transactions (each synced to SQLite), for throughput. */
  async bench(kind: string, n: number) {
    try {
      const start = await this.ensure();
      const pg = this.pg!;
      await pg.exec("create table if not exists acct (id int primary key, bal bigint not null default 0, note text)");
      const have = Number((await pg.query<{ c: number }>("select count(*)::int c from acct")).rows[0].c);
      if (have < 100000) await pg.exec(`insert into acct (id) select g from generate_series(${have + 1}, 100000) g`);
      const w0 = this.fs!.snapshot().rowsWritten;
      let x = 12345;
      for (let i = 0; i < n; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        const id = (x % 100000) + 1;
        if (kind === "read") await pg.query("select bal from acct where id = $1", [id]);
        else if (kind === "tpcb") await pg.transaction(async (tx) => {
          await tx.query("update acct set bal = bal + $1 where id = $2", [1, id]);
          await tx.query("update acct set bal = bal - $1 where id = $2", [1, (id % 100000) + 1]);
          await tx.query("select bal from acct where id = $1", [id]);
        });
        else await pg.query("update acct set bal = bal + 1 where id = $1", [id]);
      }
      return { start, n, kind, rowsWrittenPerTx: +((this.fs!.snapshot().rowsWritten - w0) / n).toFixed(1), ...this.mem() };
    } catch (e) {
      return { error: String((e as Error).stack ?? e).slice(0, 2000), ...this.mem() };
    }
  }

  /** Restart the object (its memory is gone; SQLite stays). */
  async evict() {
    this.fs?.flush();
    this.ctx.abort("evict");
  }

  async reset() {
    await this.pg?.close().catch(() => {});
    this.pg = undefined;
    this.fs = undefined;
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS fs_block");
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS fs_node");
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS fs_base");
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS fs_meta");
    this.ctx.storage.kv.delete("image");
    this.ctx.storage.kv.delete("pgdb");
    return { ok: true };
  }
}

/** The same Neon endpoint, another database on it. */
function neonUrl(base: string, db: string | null) {
  if (!db) return base;
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

export class PgObject1 extends PgObject {}
export class PgObject2 extends PgObject {}
export class PgObject3 extends PgObject {}
export class PgObject4 extends PgObject {}
export class PgObject5 extends PgObject {}
export class PgObject6 extends PgObject {}
export class PgObject7 extends PgObject {}

/** A tenant's object, its class picked by a hash of its name (classes = 1 → everything in PG). */
function tenant(env: Env, name: string, classes: number) {
  let h = 0;
  for (const c of name) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  const k = Math.abs(h) % classes;
  return (k === 0 ? env.PG : env[`PG${k}`]).getByName(name);
}

function doTarget(stub: DurableObjectStub<PgObject>, name: string): Target & { stub: DurableObjectStub<PgObject> } {
  return { name, stub, q: (sql, params) => stub.q(sql, params) as Promise<unknown[]>, tx: (stmts) => stub.tx(stmts) as Promise<unknown[][]> };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Postgres wire connections authenticate inside the protocol (password = the token).
    if (url.pathname === "/wire") return env.PG.getByName(url.searchParams.get("db") || "postgres").fetch(req);
    // Everything else runs arbitrary SQL (and some routes reach Neon): bearer token required.
    const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!(await sameSecret(auth, env.PGDO_TOKEN))) return new Response("unauthorized", { status: 401 });
    const stub = env.PG.getByName(url.searchParams.get("db") ?? "spike");
    const t0 = Date.now();
    let r: unknown;
    if (url.pathname === "/sql") r = await stub.exec(req.method === "POST" ? await req.text() : (url.searchParams.get("q") ?? "select 1"), url.searchParams.get("image") ?? undefined);
    else if (url.pathname === "/bench") r = await stub.bench(url.searchParams.get("kind") ?? "update", Number(url.searchParams.get("n") ?? 200));
    else if (url.pathname === "/reset") r = await stub.reset();
    else if (url.pathname === "/files") r = await stub.putFiles(await req.json());
    else if (url.pathname === "/config") r = await stub.configure({ cacheMB: Number(url.searchParams.get("cacheMB") ?? 4), sharedBuffers: url.searchParams.get("sharedBuffers") ?? "4MB" });
    else if (url.pathname === "/vs") {
      // Same workload on Neon and on a PgObject, timed in this Worker.
      //   /vs?target=neon|do&op=read&n=100[&db=bench][&hint=enam]   /vs?target=…&setup=1
      const which = url.searchParams.get("target") ?? "do";
      const name = url.searchParams.get("db") ?? "bench";
      const hint = url.searchParams.get("hint") as DurableObjectLocationHint | null;
      const t: Target = which === "neon" ? neonTarget(neonUrl(env.NEON_DATABASE_URL, url.searchParams.get("neondb"))) : doTarget(hint ? env.PG.get(env.PG.idFromName(name), { locationHint: hint }) : env.PG.getByName(name), `do:${name}`);
      if (which === "do" && url.searchParams.has("image")) await (t as Target & { stub: DurableObjectStub<PgObject> }).stub.init(url.searchParams.get("image")!);
      if (req.method === "POST") {
        // A list of statements, in order (e.g. a project's migrations): /vs?target=…  body: ["…", …]
        const stmts = (await req.json()) as string[];
        const errors: { i: number; sql: string; error: string }[] = [];
        let last: unknown[] = [];
        for (let i = 0; i < stmts.length; i++) {
          try {
            last = await t.q(stmts[i]);
          } catch (e) {
            errors.push({ i, sql: stmts[i].slice(0, 160), error: String((e as Error).message ?? e).slice(0, 300) });
          }
        }
        r = { target: t.name, statements: stmts.length, errors: errors.length, firstErrors: errors.slice(0, 10), last: last.slice(0, 20), ms: Date.now() - t0 };
      } else if (url.searchParams.has("compat")) {
        const only = url.searchParams.get("compat");
        const out = [];
        for (const name of only ? only.split(",") : Object.keys(CHECKS)) out.push(await runCheck(t, name));
        r = { target: t.name, checks: out };
      } else if (url.searchParams.has("explain")) r = await explain(t, url.searchParams.get("explain")!, Number(url.searchParams.get("n") ?? 5));
      else if (url.searchParams.has("setup")) {
        for (const s of SETUP) await t.q(s.sql, s.params);
        r = { ok: true, target: t.name, setupMs: Date.now() - t0 };
      } else r = await runOps(t, url.searchParams.get("op") ?? "read", Number(url.searchParams.get("n") ?? 50));
    } else if (url.pathname === "/load") {
      // /load?target=do|neon&clients=5&ops=40&prefix=t&inv=0[&image=tenant][&hot=1]
      // Each client is a tenant with its own object (do), or a client of the one Neon database;
      // with &hot=1 every client shares one object. New objects branch from &image first.
      const which = url.searchParams.get("target") ?? "do";
      const k = Number(url.searchParams.get("clients") ?? 5), ops = Number(url.searchParams.get("ops") ?? 40);
      const prefix = url.searchParams.get("prefix") ?? "t", inv = url.searchParams.get("inv") ?? "0", image = url.searchParams.get("image") ?? "tenant";
      const targets = Array.from({ length: k }, (_, i) =>
        which === "neon" ? neonTarget(neonUrl(env.NEON_DATABASE_URL, url.searchParams.get("neondb"))) : doTarget(tenant(env, url.searchParams.has("hot") ? `${prefix}-hot` : `${prefix}-${inv}-${i}`, Number(url.searchParams.get("classes") ?? 1)), "do"));
      const initLat: number[] = [];
      if (which === "do") await Promise.all(targets.map(async (t) => { const s = Date.now(); await (t as ReturnType<typeof doTarget>).stub.init(image); initLat.push(Date.now() - s); }));
      const only = url.searchParams.get("only"); // 0 read, 1 write, 2 txn, 3 jsonb
      r = { ...(await load(targets, ops, only === null ? undefined : Number(only))), initLat: initLat.sort((a, b) => a - b) };
      if (which === "do") (r as any).where = await Promise.all(targets.map((t) => (t as ReturnType<typeof doTarget>).stub.where().catch(() => null)));
    } else if (url.pathname === "/env") r = { jspi: { Suspending: typeof (WebAssembly as any).Suspending, promising: typeof (WebAssembly as any).promising }, typeReflection: typeof (WebAssembly as any).Function };
    else if (url.pathname === "/evict") r = await stub.evict().then(() => ({ ok: true }), () => ({ ok: true, aborted: true }));
    else return new Response("pgdo spike: /sql?q=…[&image=hn150] | /bench?kind=update|read|tpcb&n=… | /evict | /reset   (&db=name)");
    return Response.json({ ...(r as object), workerMs: Date.now() - t0 });
  },
};
