/**
 * DbObject: one Durable Object per database. Owns the engine and the page tiers below it:
 *
 *   RAM (inside engine.wasm) → DO SQLite `pages` (synchronous, via host import)
 *     → colo Cache API (immutable 1 MiB chunks) → R2 ranged GET (≤ 6 at once)
 *
 * A query that needs pages none of the synchronous tiers hold returns FAULT with every page id
 * it needs; we fetch them as coalesced 1 MiB chunks and call again.
 */
import { DurableObject } from "cloudflare:workers";
import { Engine, FAULT, OK, PAGE } from "./engine";
import { decodeRecords, encodeRecords, type OvRecord } from "./overlay-codec";

export interface Env {
  DB: DurableObjectNamespace<DbObject>;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
}

const PAGES_PER_PART = 64;
const PAGES_PER_CHUNK = 16; // 1 MiB: R2 latency is flat up to ~1 MiB, so over-fetch is free
const CONCURRENCY = 6; // a DO request may hold 6 outgoing connections
const MAX_ROUNDS = 16;

export interface QueryStats {
  rounds: number;
  roundMs: number[];
  startMs?: number;
  pages: number;
  chunks: number;
  cacheHits: number;
  r2Gets: number;
  bytes: number;
  sqliteHits: number;
  r2Ms: number[];
  cacheMs: number[];
  engineMs: number;
  fetchMs: number;
  totalMs: number;
}

export class DbObject extends DurableObject<Env> {
  private sql: SqlStorage;
  private live: Live = { subs: new Map(), pidOf: new Map() };
  private engine?: Engine;
  private db?: string;
  private base?: string;
  private sqliteHits = 0;
  private salt = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    // Writes since the base: durable here on acknowledgement (like any DO write).
    this.sql.exec("CREATE TABLE IF NOT EXISTS ovl (tree INTEGER NOT NULL, key BLOB NOT NULL, val BLOB, delta INTEGER NOT NULL, PRIMARY KEY (tree, key)) WITHOUT ROWID");
    // Live subscriptions, so they survive hibernation: (socket id, client query id) → AST.
    this.sql.exec("CREATE TABLE IF NOT EXISTS subs (cid TEXT NOT NULL, id TEXT NOT NULL, q TEXT NOT NULL, PRIMARY KEY (cid, id))");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  /** Start the engine (once per object lifetime); returns how long that took if it started. */
  private async ensure(db: string): Promise<number | undefined> {
    if (this.engine && this.db === db) return undefined;
    const t0 = performance.now();
    let manifest = this.ctx.storage.kv.get<string>(`manifest:${db}`);
    if (!manifest) {
      // The manifest is the one mutable object; the colo cache holds it briefly.
      const cache = await caches.open("pagedb");
      const url = `https://pagedb.cache/db/${db}/manifest.json${this.salt ? `?s=${this.salt}` : ""}`;
      const hit = await cache.match(url);
      if (hit) manifest = await hit.text();
      else {
        const obj = await this.env.BUCKET.get(`db/${db}/manifest.json`);
        if (!obj) throw new Error(`no database ${db}`);
        manifest = await obj.text();
        this.cachePuts.push([url, new TextEncoder().encode(manifest).buffer as ArrayBuffer, 60]);
      }
      this.ctx.storage.kv.put(`manifest:${db}`, manifest);
    }
    const m = JSON.parse(manifest) as { base: string; pages: number; pinnedFrom?: number };
    const engine = new Engine((id, dst) => {
      const row = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM pages WHERE id = ?", id).toArray()[0];
      if (!row) return false;
      dst.set(new Uint8Array(row.data));
      this.sqliteHits++;
      return true;
    });
    engine.init(manifest);
    engine.setRamBudget(512); // 32 MiB
    const recs: OvRecord[] = this.sql
      .exec<{ tree: number; key: ArrayBuffer; val: ArrayBuffer | null; delta: number }>("SELECT tree, key, val, delta FROM ovl")
      .toArray()
      .map((r) => ({ tree: r.tree, key: new Uint8Array(r.key), kind: 1, delta: r.delta, val: r.val ? new Uint8Array(r.val) : null }));
    engine.loadOverlay(encodeRecords(recs), this.ctx.storage.kv.get<number>(`version:${db}`) ?? 0);
    this.engine = engine;
    this.db = db;
    this.base = m.base;
    // Pinned region: small tables + every tree's interior pages, contiguous at the end of the
    // base. With it resident, a query only ever faults leaves (one round for a list).
    if (m.pinnedFrom !== undefined) {
      const ids: number[] = [];
      for (let id = m.pinnedFrom; id < m.pages; id++) {
        if (!this.sql.exec("SELECT 1 FROM pages WHERE id = ?", id).toArray().length) ids.push(id);
      }
      if (ids.length) {
        const st: QueryStats = { rounds: 0, roundMs: [], pages: 0, chunks: 0, cacheHits: 0, r2Gets: 0, bytes: 0, sqliteHits: 0, r2Ms: [], cacheMs: [], engineMs: 0, fetchMs: 0, totalMs: 0 };
        await this.resolve(ids, st, true);
      }
    }
    await this.rehydrate();
    return performance.now() - t0;
  }

  private cachePuts: [string, ArrayBuffer, number?][] = [];

  /** Fill the colo cache after the answer has gone out (puts would compete for connections). */
  private flushCachePuts() {
    const puts = this.cachePuts.splice(0);
    if (!puts.length) return;
    void (async () => {
      const cache = await caches.open("pagedb");
      for (const [url, buf, ttl] of puts) {
        await cache.put(url, new Response(buf, { headers: { "cache-control": ttl ? `public, max-age=${ttl}` : "public, max-age=31536000, immutable" } })).catch(() => {});
      }
    })();
  }

  /** Run a query AST. `salt` makes the colo cache keys unique (cold benchmarks). */
  async query(db: string, ast: unknown, opts: { salt?: string } = {}) {
    const t0 = performance.now();
    this.salt = opts.salt ?? "";
    const started = await this.ensure(db);
    const astText = typeof ast === "string" ? ast : JSON.stringify(ast);
    const stats: QueryStats = { rounds: 0, roundMs: [], pages: 0, chunks: 0, cacheHits: 0, r2Gets: 0, bytes: 0, sqliteHits: 0, r2Ms: [], cacheMs: [], engineMs: 0, fetchMs: 0, totalMs: 0 };
    const hits0 = this.sqliteHits;
    for (;;) {
      const e0 = performance.now();
      const { status, out } = this.engine!.query(astText);
      stats.engineMs += performance.now() - e0;
      if (status === OK) {
        stats.sqliteHits = this.sqliteHits - hits0;
        stats.totalMs = performance.now() - t0;
        if (started !== undefined) stats.startMs = +started.toFixed(1);
        this.flushCachePuts();
        return { result: JSON.parse(Engine.text(out)), stats: round(stats), engine: this.engine!.stats() };
      }
      if (status !== FAULT || ++stats.rounds > MAX_ROUNDS) throw new Error(`query did not finish after ${stats.rounds} fault rounds`);
      const f0 = performance.now();
      await this.resolve(Engine.faults(out), stats);
      stats.fetchMs += performance.now() - f0;
      stats.roundMs.push(+(performance.now() - f0).toFixed(1));
    }
  }

  /** Fetch the chunks holding `ids`, hand the pages to the engine and the SQLite tier. */
  private async resolve(ids: number[], stats: QueryStats, all = false) {
    const chunks = [...new Set(ids.map((id) => Math.floor(id / PAGES_PER_CHUNK)))];
    stats.pages += ids.length;
    stats.chunks += chunks.length;
    const wanted = new Set(ids);
    const queue = [...chunks];
    const worker = async () => {
      for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
        const bytes = await this.fetchChunk(c, stats);
        const first = c * PAGES_PER_CHUNK;
        for (let i = 0; i * PAGE < bytes.byteLength; i++) {
          const id = first + i;
          const page = new Uint8Array(bytes, i * PAGE, PAGE);
          if ((all || wanted.has(id)) && !this.engine!.putPage(id, page)) throw new Error(`page ${id} failed its checksum`);
          this.sql.exec("INSERT OR REPLACE INTO pages (id, data) VALUES (?, ?)", id, page);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  }

  private async fetchChunk(chunk: number, stats: QueryStats): Promise<ArrayBuffer> {
    const part = Math.floor((chunk * PAGES_PER_CHUNK) / PAGES_PER_PART);
    const offset = ((chunk * PAGES_PER_CHUNK) % PAGES_PER_PART) * PAGE;
    const key = `db/${this.db}/base/${this.base}/part-${String(part).padStart(6, "0")}`;
    const cacheUrl = `https://pagedb.cache/${key}/${offset}${this.salt ? `?s=${this.salt}` : ""}`;
    const cache = await caches.open("pagedb");
    const c0 = performance.now();
    const hit = await cache.match(cacheUrl);
    if (hit) {
      stats.cacheHits++;
      const buf = await hit.arrayBuffer();
      stats.cacheMs.push(+(performance.now() - c0).toFixed(1));
      stats.bytes += buf.byteLength;
      return buf;
    }
    const r0 = performance.now();
    const obj = await this.env.BUCKET.get(key, { range: { offset, length: PAGES_PER_CHUNK * PAGE } });
    if (!obj) throw new Error(`missing ${key}`);
    const buf = await obj.arrayBuffer();
    stats.r2Ms.push(+(performance.now() - r0).toFixed(1));
    stats.r2Gets++;
    stats.bytes += buf.byteLength;
    this.cachePuts.push([cacheUrl, buf.slice(0)]);
    return buf;
  }

  /** Run an engine call to completion, resolving page faults. */
  private async drive(call: () => { status: number; out: Uint8Array }, stats?: QueryStats) {
    const st = stats ?? newStats();
    for (;;) {
      const r = call();
      if (r.status === OK) return r.out;
      if (++st.rounds > MAX_ROUNDS) throw new Error(`gave up after ${st.rounds} fault rounds`);
      const f0 = performance.now();
      await this.resolve(Engine.faults(r.out), st);
      st.roundMs.push(+(performance.now() - f0).toFixed(1));
    }
  }

  /** After a wake: rebuild partitions for subscriptions held by still-open sockets. Clients
   *  already hold these results (nothing can be written while the object sleeps), so no resend. */
  private async rehydrate() {
    const open = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as { cid: string }).cid));
    this.sql.exec(`DELETE FROM subs WHERE cid NOT IN (${[...open].map(() => "?").join(",") || "''"})`, ...open);
    for (const { cid, id, q } of this.sql.exec<{ cid: string; id: string; q: string }>("SELECT cid, id, q FROM subs").toArray()) {
      const out = await this.drive(() => this.engine!.subscribe(q));
      this.track(cid, id, JSON.parse(Engine.text(out)).pid);
    }
  }

  private track(cid: string, id: string, pid: number) {
    this.live.pidOf.set(`${cid} ${id}`, pid);
    let m = this.live.subs.get(pid);
    if (!m) this.live.subs.set(pid, (m = new Map()));
    let ids = m.get(cid);
    if (!ids) m.set(cid, (ids = new Set()));
    ids.add(id);
  }

  private untrack(cid: string, id: string) {
    const k = `${cid} ${id}`;
    const pid = this.live.pidOf.get(k);
    if (pid === undefined) return;
    this.live.pidOf.delete(k);
    const m = this.live.subs.get(pid);
    m?.get(cid)?.delete(id);
    if (m?.get(cid)?.size === 0) m.delete(cid);
    if (m?.size === 0) this.live.subs.delete(pid);
    this.engine?.unsubscribe(pid);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const db = new URL(req.url).searchParams.get("db") ?? "db1g";
    this.ctx.storage.kv.put("db", db);
    const { 0: client, 1: server } = new WebSocketPair();
    const cid = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cid });
    await this.ensure(db);
    server.send(JSON.stringify({ t: "hello", version: this.engine!.overlayStats().version }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const { cid } = ws.deserializeAttachment() as { cid: string };
    let m: { t: string; id?: string; q?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    await this.ensure(this.db ?? this.ctx.storage.kv.get<string>("db") ?? "db1g");
    if (m.t === "sub" && m.id && m.q) {
      const q = typeof m.q === "string" ? m.q : JSON.stringify(m.q);
      const stats = newStats();
      const t0 = performance.now();
      try {
        const out = await this.drive(() => this.engine!.subscribe(q), stats);
        const r = JSON.parse(Engine.text(out)) as { pid: number; rows?: unknown[]; complete?: boolean; count?: number };
        this.untrack(cid, m.id);
        this.track(cid, m.id, r.pid);
        this.sql.exec("INSERT OR REPLACE INTO subs (cid, id, q) VALUES (?, ?, ?)", cid, m.id, q);
        stats.totalMs = performance.now() - t0;
        const version = this.engine!.overlayStats().version;
        ws.send(JSON.stringify({ t: "snap", id: m.id, version, rows: r.rows, complete: r.complete, count: r.count, stats: round(stats) }));
      } catch (e) {
        ws.send(JSON.stringify({ t: "error", id: m.id, message: String((e as Error).message ?? e) }));
      }
    } else if (m.t === "unsub" && m.id) {
      this.untrack(cid, m.id);
      this.sql.exec("DELETE FROM subs WHERE cid = ? AND id = ?", cid, m.id);
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const { cid } = ws.deserializeAttachment() as { cid: string };
    for (const k of [...this.live.pidOf.keys()]) if (k.startsWith(`${cid} `)) this.untrack(cid, k.slice(cid.length + 1));
    this.sql.exec("DELETE FROM subs WHERE cid = ?", cid);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }

  /** Apply a batch of row ops. Durable before the version is returned and the pokes go out. */
  async write(db: string, ops: unknown): Promise<{ version: number; changes: number; ms: number; rounds: number } | { error: string }> {
    const t0 = performance.now();
    await this.ensure(db);
    const stats = newStats();
    let out: Uint8Array;
    try {
      out = await this.drive(() => this.engine!.write(typeof ops === "string" ? ops : JSON.stringify(ops)), stats);
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
    const jsonLen = new DataView(out.buffer, out.byteOffset).getUint32(0, true);
    const result = JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + jsonLen))) as { version: number; changes: number; pokes: Record<string, unknown[]> };
    const recs = decodeRecords(out.subarray(4 + jsonLen));
    this.ctx.storage.transactionSync(() => {
      for (const r of recs) {
        if (r.kind === 0) this.sql.exec("DELETE FROM ovl WHERE tree = ? AND key = ?", r.tree, r.key);
        else this.sql.exec("INSERT OR REPLACE INTO ovl (tree, key, val, delta) VALUES (?, ?, ?, ?)", r.tree, r.key, r.val, r.delta);
      }
      this.ctx.storage.kv.put(`version:${db}`, result.version);
    });
    // One message per socket with every op for its subscriptions (output gate holds these
    // until the overlay write above is durable).
    const perSocket = new Map<string, Record<string, unknown[]>>();
    for (const [pid, ops] of Object.entries(result.pokes)) {
      for (const [cid, ids] of this.live.subs.get(Number(pid)) ?? []) {
        let m = perSocket.get(cid);
        if (!m) perSocket.set(cid, (m = {}));
        for (const id of ids) m[id] = ops;
      }
    }
    if (perSocket.size) {
      for (const ws of this.ctx.getWebSockets()) {
        const subs = perSocket.get((ws.deserializeAttachment() as { cid: string }).cid);
        if (subs) {
          try {
            ws.send(JSON.stringify({ t: "poke", version: result.version, subs }));
          } catch {}
        }
      }
    }
    return { version: result.version, changes: result.changes, ms: +(performance.now() - t0).toFixed(1), rounds: stats.rounds };
  }

  /** Drop the SQLite page tier and the engine (cold benchmarks). */
  async reset() {
    this.sql.exec("DELETE FROM pages");
    this.ctx.storage.kv.delete(`manifest:${this.db}`);
    this.engine = undefined;
    return { ok: true };
  }

  /** Evict this object from memory, keeping its storage (measures wake from hibernation). */
  async evict() {
    this.ctx.abort("evicted for a benchmark");
  }

  async info() {
    const ov = this.engine?.overlayStats();
    const pages = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pages").one().n;
    return { db: this.db, base: this.base, sqlitePages: pages, sqliteMB: +((pages * PAGE) / 1e6).toFixed(1), engine: this.engine?.stats(), overlay: ov, sockets: this.ctx.getWebSockets().length };
  }
}

function newStats(): QueryStats {
  return { rounds: 0, roundMs: [], pages: 0, chunks: 0, cacheHits: 0, r2Gets: 0, bytes: 0, sqliteHits: 0, r2Ms: [], cacheMs: [], engineMs: 0, fetchMs: 0, totalMs: 0 };
}

function round(s: QueryStats): QueryStats {
  for (const k of ["engineMs", "fetchMs", "totalMs"] as const) s[k] = +s[k].toFixed(2);
  return s;
}

// ---------------------------------------------------------------- live queries over WebSockets

export interface Live {
  /** partition id → subscribers (socket id → client query ids) */
  subs: Map<number, Map<string, Set<string>>>;
  /** (socket id, client query id) → partition id */
  pidOf: Map<string, number>;
}
