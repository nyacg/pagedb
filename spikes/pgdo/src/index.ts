// Postgres in a Durable Object: PGlite (Postgres compiled to WebAssembly) with PGDATA in the
// object's own SQLite (src/sqlitefs.ts). A new database starts from a template PGDATA in R2.
import "./no-node";
import "./shims";
import { DurableObject } from "cloudflare:workers";
import { PGlite } from "@electric-sql/pglite";
import pgliteWasm from "../vendor/pglite.wasm";
import initdbWasm from "../vendor/initdb.wasm";
import fsBundle from "../vendor/pglite.data";
import { SqliteFS } from "./sqlitefs";

const TEMPLATE = "pgspike/template-seg1.tgz"; // initdb'd PGDATA (scripts/mktemplate.mjs), gzipped tar

interface Env { PG: DurableObjectNamespace<PgObject>; BUCKET: R2Bucket }

export class PgObject extends DurableObject<Env> {
  private pg?: PGlite;
  private fs?: SqliteFS;
  private started?: { templateMs?: number; files?: number };
  private readonly instance = crypto.randomUUID().slice(0, 8);

  private async ensure() {
    if (this.pg) return undefined;
    const fs = (this.fs = new SqliteFS(this.ctx.storage.sql));
    const st: { templateMs?: number; files?: number } = {};
    if (fs.empty) {
      const t0 = Date.now();
      const obj = await this.env.BUCKET.get(TEMPLATE);
      if (!obj) throw new Error(`no template at ${TEMPLATE}`);
      const tar = new Uint8Array(await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
      st.files = this.ctx.storage.transactionSync(() => fs.loadTar(tar));
      st.templateMs = Date.now() - t0;
    }
    this.pg = await PGlite.create({
      // (No noInitDb: PGlite finds PG_VERSION in the filesystem and resumes the database.)
      fs,
      pgliteWasmModule: pgliteWasm,
      initdbWasmModule: initdbWasm,
      fsBundle: new Blob([fsBundle]),
      // A Durable Object has 128 MB in all: start the wasm heap at 32 MB (the binary is patched to
      // allow it); Postgres's own buffers are set small in the template's postgresql.conf.
      initialMemory: 32 * 1024 * 1024,
    });
    this.started = st;
    return st;
  }

  private mem() {
    const m = (this.pg as any)?.mod;
    const heap = m?.HEAPU8?.length ?? m?.wasmMemory?.buffer?.byteLength;
    return { instance: this.instance, heapMB: heap ? +(heap / 1e6).toFixed(1) : null, sqliteMB: +(this.ctx.storage.sql.databaseSize / 1e6).toFixed(1), fs: this.fs?.snapshot() };
  }

  async exec(sql: string) {
    try {
      const start = await this.ensure();
      const res = await this.pg!.exec(sql);
      return { start, results: res.map((r) => ({ rows: r.rows.slice(0, 20), n: r.rows.length, affected: r.affectedRows })), ...this.mem() };
    } catch (e) {
      return { error: String((e as Error).stack ?? e).slice(0, 2000), ...this.mem() };
    }
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
    return { ok: true };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = env.PG.getByName(url.searchParams.get("db") ?? "spike");
    const t0 = Date.now();
    let r: unknown;
    if (url.pathname === "/sql") r = await stub.exec(req.method === "POST" ? await req.text() : (url.searchParams.get("q") ?? "select 1"));
    else if (url.pathname === "/bench") r = await stub.bench(url.searchParams.get("kind") ?? "update", Number(url.searchParams.get("n") ?? 200));
    else if (url.pathname === "/reset") r = await stub.reset();
    else if (url.pathname === "/evict") r = await stub.evict().then(() => ({ ok: true }), () => ({ ok: true, aborted: true }));
    else return new Response("pgdo spike: /sql?q=… | /bench?kind=update|read|tpcb&n=… | /reset   (&db=name)");
    return Response.json({ ...(r as object), workerMs: Date.now() - t0 });
  },
};
