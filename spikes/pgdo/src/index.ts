// Postgres in a Durable Object: PGlite (Postgres compiled to WebAssembly) with PGDATA in the
// object's own SQLite (src/sqlitefs.ts). A new database starts from a template PGDATA in R2.
import "./no-node";
import "./shims";
import "./libs";
import { contrib } from "./exts";
import { DurableObject } from "cloudflare:workers";
import { PGlite } from "@electric-sql/pglite";
import pgliteWasm from "../vendor/pglite.wasm";
import initdbWasm from "../vendor/initdb.wasm";
import fsBundle from "../vendor/pglite.data";
import { SqliteFS, type ImageIndex } from "./sqlitefs";
import { CHECKS, runCheck } from "./compat";
import { explain, load, neonTarget, run as runOps, SETUP, type Stmt, type Target } from "./bench";

/** Template images (scripts/mkimage.mjs): pgspike/img/<name>.json (the index) and .blob (PGDATA). */
const IMG = (name: string) => `pgspike/img/${name}`;

/** Objects of one class can share an isolate (and its 128 MB): which isolate, and who's in it. */
// PGlite's own start parameters (its defaultStartParams), to which we add memory settings.
const START = ["--single", "-F", "-O", "-j", "-c", "search_path=public", "-c", "exit_on_error=false", "-c", "log_checkpoints=false", "-c", "max_worker_processes=0", "-c", "max_parallel_workers=0", "-c", "max_parallel_workers_per_gather=0", "-c", "io_method=sync", "-c", "max_parallel_maintenance_workers=0"];
// Shared memory is sized for max_connections backends; PGlite is one.
const SMALL_SHMEM = ["-c", "max_connections=4", "-c", "max_wal_senders=0", "-c", "max_replication_slots=0", "-c", "max_prepared_transactions=0", "-c", "max_locks_per_transaction=64", "-c", "autovacuum_worker_slots=1"];
let isolate: string | undefined; // named on first use (no randomness at global scope)
const running = new Set<PgObject>();

interface Env { PG: DurableObjectNamespace<PgObject>; [k: `PG${number}`]: DurableObjectNamespace<PgObject>; BUCKET: R2Bucket; NEON_DATABASE_URL: string }

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
    this.pg = await PGlite.create({
      fs,
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
    running.add(this);
    return st;
  }

  /** Run SQL; a read of a block still in the template image fails the statement, so fetch what
   *  it was missing and run it again (rolled back first: the whole request retries). */
  private async run<T>(f: () => Promise<T>) {
    const image = this.ctx.storage.kv.get<string>("image") ?? "base";
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
        await this.fs!.fetchMissing(async (offset, length) => (await (await this.env.BUCKET.get(`${IMG(image)}.blob`, { range: { offset, length } }))!.arrayBuffer()));
      }
    }
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
    const stub = env.PG.getByName(url.searchParams.get("db") ?? "spike");
    const t0 = Date.now();
    let r: unknown;
    if (url.pathname === "/sql") r = await stub.exec(req.method === "POST" ? await req.text() : (url.searchParams.get("q") ?? "select 1"), url.searchParams.get("image") ?? undefined);
    else if (url.pathname === "/bench") r = await stub.bench(url.searchParams.get("kind") ?? "update", Number(url.searchParams.get("n") ?? 200));
    else if (url.pathname === "/reset") r = await stub.reset();
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
