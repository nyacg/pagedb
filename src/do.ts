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
import { Engine, FAULT, OK, PAGE, type LayerTrees } from "./engine";
import { encodeRecords, splitRecords, type OvRecord } from "./overlay-codec";
import { verifyLease } from "./lease";

export interface Env {
  DB: DurableObjectNamespace<DbObject>;
  /** R2 on Cloudflare; inside a container (workerd) a fetcher to the R2 bridge instead. */
  BUCKET: R2Bucket | Fetcher;
  ASSETS: Fetcher;
  /** The Hacker News live tail (src/hn-tail.ts). */
  HN_TAIL: DurableObjectNamespace;
  /** Signs and verifies leases (signed queries): see src/lease.ts. */
  LEASE_SECRET?: string;
  /** This deploy's version (the Worker passes its id to sockets, so stale pages can reload). */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** RAM tier size in 64 KiB pages (default 512 = 32 MiB, the DO budget). */
  RAM_PAGES?: string;
  /** In a container: R2 through a Worker's public route (with a bearer token). */
  R2_URL?: string;
  R2_TOKEN?: string;
  /** Set in the container's workerd config: BUCKET is the R2 bridge, not an R2 binding. */
  R2_BRIDGE?: string;
  /** Concurrent page fetches (6 in a DO; fewer in a container, see node-worker.ts). */
  FETCH_CONCURRENCY?: string;
  ADMIN_TOKEN?: string;
  /** Workers AI (embeddings for semantic search; see src/embed.ts). */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  EMBED_MODEL?: string;
  EMBED_URL?: string;
  EMBED_KEY?: string;
}

/** The slice of R2 we use, over a real binding or (in a container) the R2 bridge. */
interface Blob {
  put?(key: string, body: Uint8Array): Promise<unknown>;
  get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>;
}
function blobStore(b: R2Bucket | Fetcher, bridge?: string, viaUrl?: string, token?: string): Blob {
  // The container says so explicitly (R2_BRIDGE): feature detection can't tell, because a
  // workerd service binding answers *any* property with a JS-RPC stub.
  if (!bridge) return b as R2Bucket;
  return {
    async get(key, opts) {
      const q = new URLSearchParams({ key });
      if (opts?.range) (q.set("offset", String(opts.range.offset)), q.set("length", String(opts.range.length)));
      // Global fetch (the worker's globalOutbound): from a Durable Object inside workerd, a
      // fetch through the network-service binding never reaches the container's intercept.
      const res = viaUrl ? await fetch(`${viaUrl}?${q}`, { headers: { authorization: `Bearer ${token}` } }) : await fetch(`http://r2.internal/get?${q}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`r2 bridge: ${res.status}`);
      return res;
    },
  };
}

/** Cloudflare's Cache API, or nothing (workerd opens a cache but throws on use). Probed once. */
let cacheProbe: Promise<Cache | null> | undefined;
function openCache(): Promise<Cache | null> {
  cacheProbe ??= (async () => {
    try {
      if (typeof caches === "undefined") return null;
      const c = await caches.open("pagedb");
      await c.match("https://pagedb.cache/probe");
      return c;
    } catch {
      return null;
    }
  })();
  return cacheProbe;
}

const PAGES_PER_PART = 64;
const PAGES_PER_CHUNK = 16; // 1 MiB: R2 latency is flat up to ~1 MiB, so over-fetch is free
const CONCURRENCY = 6; // a DO request may hold 6 outgoing connections
const MAX_ROUNDS = 16;
/** Overlay log: rows stay well under SQLite's 2 MB limit; compact after this many rows. */
const LOG_ROW_BYTES = 1_500_000;
const COMPACT_AT = 5_000;
/** Also compact once the log holds this many bytes beyond twice the overlay itself: replaying
 *  a big log on wake is what costs memory (HN's live tail writes ~1 MB rows). */
const COMPACT_BYTES = 16_000_000;
/** Fold the overlay into an R2 layer once it holds this many bytes of keys and values: it lives
 *  in the engine's memory, and an object that never resets (HN) would otherwise outgrow 128 MB. */
const FOLD_BYTES = Number((globalThis as { PAGEDB_FOLD_BYTES?: number }).PAGEDB_FOLD_BYTES ?? 4_000_000);

/** A folded layer in R2: its pages are ids [first, first + pages), stored as 4 MiB parts under
 *  db/<db>/layer/<object id>/<layer id>/ (objects that share a database, like prod and preview,
 *  never see each other's layers). `prev` is the layer it replaced, kept until the next fold so a read that
 *  started before the swap can still finish. */
interface LayerMeta {
  id: string;
  base: string;
  first: number;
  pages: number;
  trees: LayerTrees["trees"];
  at: number;
  prev?: { id: string; first: number; pages: number };
}

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

/** At most 6 outgoing connections per object, shared by every concurrent query and write. */
class Gate {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private limit = CONCURRENCY) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await f();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class DbObject extends DurableObject<Env> {
  private sql: SqlStorage;
  private gate: Gate;
  /** Chunks being fetched right now: concurrent faults on the same chunk share one GET. */
  private inflight = new Map<number, Promise<ArrayBuffer>>();
  /** Rows and bytes in the overlay log since its last compaction. */
  private logRows = 0;
  private logBytes = 0;
  private live: Live = { subs: new Map(), pidOf: new Map() };
  private engine?: Engine;
  private db?: string;
  private base?: string;
  /** Page ranges built after the base (e.g. a vector index), each in its own R2 directory. */
  private segments: Segment[] = [];
  private baseChunkPages?: number;
  /** The database whose directory holds the base's parts, if not this one (a database that
   *  reuses another's base, e.g. with a vector index attached). */
  private baseDb?: string;
  private basePages = 0;
  private layer?: LayerMeta;
  /** A fold's layer while it uploads and commits (its pages may be read before it's current). */
  private pendingLayer?: LayerMeta;
  private foldRun?: Promise<Record<string, unknown>>;
  private sqliteHits = 0;
  private salt = "";
  /** The next start reads the manifest from R2, not the colo cache. */
  private freshManifest = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.gate = new Gate(Number(env.FETCH_CONCURRENCY ?? CONCURRENCY));
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    // Writes since the base: durable here on acknowledgement (like any DO write).
    this.sql.exec("CREATE TABLE IF NOT EXISTS ovl (tree INTEGER NOT NULL, key BLOB NOT NULL, val BLOB, delta INTEGER NOT NULL, PRIMARY KEY (tree, key)) WITHOUT ROWID");
    // The overlay as a log: one row per write (all its index entries, encoded), compacted now
    // and then. SQLite rows written are billed per row whatever their size, so one row per write
    // instead of one per entry (~7) keeps a busy object inside the free allowance. (`ovl` above
    // is the old one-row-per-entry form: still loaded, and emptied by the first compaction.)
    this.sql.exec("CREATE TABLE IF NOT EXISTS ovlog (seq INTEGER PRIMARY KEY, recs BLOB NOT NULL, version INTEGER NOT NULL)");
    // Live subscriptions, so they survive hibernation: (socket id, client query id) → AST.
    this.sql.exec("CREATE TABLE IF NOT EXISTS subs (cid TEXT NOT NULL, id TEXT NOT NULL, q TEXT NOT NULL, PRIMARY KEY (cid, id))");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    // Sockets survive deploys (hibernation), so a page can keep running a client older than this
    // code. Tell those pages which build is current; they reload.
    const build = env.CF_VERSION_METADATA?.id;
    if (build) {
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as { cid: string; admin?: boolean; build?: string };
        if (a.build === build) continue;
        ws.serializeAttachment({ ...a, build });
        try {
          ws.send(JSON.stringify({ t: "hello", build }));
        } catch {}
      }
    }
  }

  /** Start the engine (once per object lifetime); returns how long that took if it started. */
  private async ensure(db: string): Promise<number | undefined> {
    if (this.engine && this.db === db) return undefined;
    // Page ids, the overlay and subscriptions are per base: one object serves one database.
    const bound = this.ctx.storage.kv.get<string>("boundDb");
    if (bound && bound !== db) throw new Error(`this object serves ${bound}, not ${db}`);
    if (!bound) this.ctx.storage.kv.put("boundDb", db);
    const t0 = performance.now();
    let manifest = this.ctx.storage.kv.get<string>(`manifest:${db}`);
    if (!manifest) {
      // The manifest is the one mutable object; the colo cache holds it briefly.
      const cache = await openCache();
      const url = `https://pagedb.cache/db/${db}/manifest.json${this.salt ? `?s=${this.salt}` : ""}`;
      // (After a reset or remanifest, straight from R2: the cached copy may be the old one.)
      const hit = this.freshManifest ? undefined : await cache?.match(url);
      this.freshManifest = false;
      if (hit) manifest = await hit.text();
      else {
        const obj = await blobStore(this.env.BUCKET, this.env.R2_BRIDGE, this.env.R2_URL, this.env.R2_TOKEN).get(`db/${db}/manifest.json`);
        if (!obj) throw new Error(`no database ${db}`);
        manifest = await obj.text();
        this.cachePuts.push([url, new TextEncoder().encode(manifest).buffer as ArrayBuffer, 60]);
      }
      this.ctx.storage.kv.put(`manifest:${db}`, manifest);
    }
    const m = JSON.parse(manifest) as { base: string; baseDb?: string; pages: number; pinnedFrom?: number; chunkPages?: number; segments?: Segment[] };
    const engine = new Engine(
      (id, dst) => {
        const row = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM pages WHERE id = ?", id).toArray()[0];
        if (!row) return false;
        dst.set(new Uint8Array(row.data));
        this.sqliteHits++;
        return true;
      },
      // A fold wrote a page: it's in the SQLite tier before the layer that holds it is uploaded.
      (id, page) => this.sql.exec("INSERT OR REPLACE INTO pages (id, data) VALUES (?, ?)", id, page.slice()),
      // A search about to read many pages: one statement per 100 (about twice as fast as one
      // statement per page, measured).
      (ids, put) => {
        for (let i = 0; i < ids.length; i += 100) {
          const part = ids.slice(i, i + 100);
          for (const r of this.sql.exec<{ id: number; data: ArrayBuffer }>(`SELECT id, data FROM pages WHERE id IN (${part.map(() => "?").join(",")})`, ...part)) {
            put(r.id, new Uint8Array(r.data));
            this.sqliteHits++;
          }
        }
      },
    );
    engine.init(manifest);
    // Folded writes (a layer in R2) sit between the base and the overlay log.
    const layer = this.ctx.storage.kv.get<LayerMeta>(`layer:${db}`);
    this.layer = layer && layer.base === m.base ? layer : undefined;
    if (this.layer) engine.setLayer({ trees: this.layer.trees });
    engine.setRamBudget(Number(this.env.RAM_PAGES ?? 512)); // 512 = 32 MiB (a DO); GBs in a container
    this.loadLog(engine, db);
    this.engine = engine;
    if (this.needsCompaction()) this.compactNow();
    this.db = db;
    this.base = m.base;
    this.segments = m.segments ?? [];
    this.baseChunkPages = m.chunkPages;
    this.baseDb = m.baseDb;
    this.basePages = m.pages;
    if (engine.overlayStats().bytes > FOLD_BYTES) this.scheduleFold();
    // Pinned region: small tables + every tree's interior pages, contiguous at the end of the
    // base (and of each segment). With it resident, a query only ever faults leaves (one round).
    const pinned: [number, number][] = [...(m.pinnedFrom !== undefined ? [[m.pinnedFrom, m.pages] as [number, number]] : []), ...this.segments.map((g) => [g.pinnedFrom, g.pages] as [number, number])];
    if (pinned.length) {
      const ids: number[] = [];
      for (const [from, to] of pinned)
        for (let id = from; id < to; id++) {
          if (!this.sql.exec("SELECT 1 FROM pages WHERE id = ?", id).toArray().length) ids.push(id);
        }
      if (ids.length) {
        const st: QueryStats = { rounds: 0, roundMs: [], pages: 0, chunks: 0, cacheHits: 0, r2Gets: 0, bytes: 0, sqliteHits: 0, r2Ms: [], cacheMs: [], engineMs: 0, fetchMs: 0, totalMs: 0 };
        // Small pinned regions go straight into RAM. A big one (100 GB base: ~73 MB of interior
        // pages) goes to SQLite now, synchronously, and into RAM only as queries touch it:
        // holding it all in memory would crowd a 128 MB isolate.
        const small = ids.length * PAGE <= Number(this.env.RAM_PAGES ?? 512) * PAGE / 4;
        await this.resolve(ids, st, small, !small);
      }
    }
    await this.rehydrate();
    return performance.now() - t0;
  }

  private cachePuts: [string, ArrayBuffer, number?][] = [];

  /**
   * Storage writes that aren't needed for correctness of the reply (page-cache inserts,
   * subscription records) run *after* the reply has gone out. A Durable Object holds every
   * outgoing message until earlier writes are durable (the output gate), so writing first
   * would make a warm read wait on a disk commit.
   */
  private later: (() => void)[] = [];
  private persistLater(f: () => void) {
    this.later.push(f);
    if (this.later.length === 1)
      setTimeout(() => {
        const fs = this.later.splice(0);
        this.ctx.storage.transactionSync(() => {
          for (const f of fs) f();
        });
      }, 0);
  }

  /** Fill the colo cache after the answer has gone out (puts would compete for connections). */
  private flushCachePuts() {
    const puts = this.cachePuts.splice(0);
    if (!puts.length) return;
    void (async () => {
      const cache = await openCache();
      if (!cache) return;
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

  /** Pages per chunk (the unit of the colo cache and of R2 reads) for the region holding
   *  `id`: 16 (1 MiB) by default, smaller for indexes read in many small pieces (vectors). */
  private chunkPages(id: number): number {
    const g = this.segments.find((g) => id >= g.firstPage && id < g.pages);
    return (g ? g.chunkPages : this.baseChunkPages) ?? PAGES_PER_CHUNK;
  }

  /** Fetch the chunks holding `ids`, hand the pages to the engine and the SQLite tier. Chunks
   *  are named by their first page. */
  private async resolve(ids: number[], stats: QueryStats, all = false, persistNow = false) {
    // A round bigger than half the RAM tier could have wanted pages evicted before the retry
    // reads them; written to SQLite now, they are found there instead (no fault loop).
    if (ids.length > Number(this.env.RAM_PAGES ?? 512) / 2) persistNow = true;
    const chunks = [...new Set(ids.map((id) => id - (id % this.chunkPages(id))))].sort((a, b) => a - b);
    stats.pages += ids.length;
    stats.chunks += chunks.length;
    const wanted = new Set(ids);
    // Chunks not already on their way, in runs of neighbours within one part: a run is one
    // ranged GET (a big scan's pages arrive in a few large reads, not many small ones).
    const part = (c: number) => Math.floor(c / PAGES_PER_PART);
    const runs: number[][] = [];
    for (const c of chunks) {
      if (this.inflight.has(c)) continue;
      const last = runs.at(-1);
      if (last && last.at(-1)! + this.chunkPages(c) === c && part(c) === part(last[0])) last.push(c);
      else runs.push([c]);
    }
    for (const run of runs) {
      const got = this.gate.run(() => this.fetchRun(run, stats));
      for (const c of run) this.inflight.set(c, got.then((m) => m.get(c)!).finally(() => this.inflight.delete(c)));
    }
    const pending = chunks.map((c) => [c, this.inflight.get(c)!] as const);
    await Promise.all(
      pending.map(async ([first, p]) => {
        const bytes = await p;
        for (let i = 0; i * PAGE < bytes.byteLength; i++) {
          const id = first + i;
          const page = new Uint8Array(bytes, i * PAGE, PAGE);
          if ((all || wanted.has(id)) && !this.engine!.putPage(id, page)) throw new Error(`page ${id} failed its checksum`);
          if (persistNow) this.sql.exec("INSERT OR REPLACE INTO pages (id, data) VALUES (?, ?)", id, page);
          else this.persistLater(() => this.sql.exec("INSERT OR REPLACE INTO pages (id, data) VALUES (?, ?)", id, page));
        }
      }),
    );
  }

  /** R2 key of the part holding page `id`: the base's, a segment's, or a folded layer's. */
  private partKey(id: number): string {
    const part = Math.floor(id / PAGES_PER_PART);
    for (const l of [this.layer, this.pendingLayer, this.layer?.prev]) {
      if (l && id >= l.first && id < l.first + l.pages) return `${this.layerPrefix(this.db!)}${l.id}/part-${String((id - l.first) / PAGES_PER_PART).padStart(6, "0")}`;
    }
    const g = this.segments.find((g) => id >= g.firstPage && id < g.pages);
    return `db/${g?.db ?? this.baseDb ?? this.db}/base/${g?.base ?? this.base}/part-${String(part).padStart(6, "0")}`;
  }

  /** Neighbouring chunks of one part: each from the city cache if it's there, the rest from R2
   *  in as few ranged GETs as possible (then cached chunk by chunk). */
  private async fetchRun(run: number[], stats: QueryStats): Promise<Map<number, ArrayBuffer>> {
    const key = this.partKey(run[0]);
    const cp = this.chunkPages(run[0]);
    const CHUNK = cp * PAGE;
    const offsetOf = (c: number) => (c % PAGES_PER_PART) * PAGE;
    // (1 MiB chunks keep their original cache keys; other sizes are named by size too.)
    const cacheUrl = (c: number) => `https://pagedb.cache/${key}/${offsetOf(c)}${cp === PAGES_PER_CHUNK ? "" : `-${cp}`}${this.salt ? `?s=${this.salt}` : ""}`;
    const out = new Map<number, ArrayBuffer>();
    const cache = await openCache();
    if (cache) {
      await Promise.all(
        run.map(async (c) => {
          const c0 = performance.now();
          const hit = await cache.match(cacheUrl(c));
          if (!hit) return;
          const buf = await hit.arrayBuffer();
          stats.cacheHits++;
          stats.cacheMs.push(+(performance.now() - c0).toFixed(1));
          stats.bytes += buf.byteLength;
          out.set(c, buf);
        }),
      );
    }
    for (let i = 0; i < run.length; ) {
      if (out.has(run[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < run.length && !out.has(run[j + 1])) j++;
      const r0 = performance.now();
      const obj = await blobStore(this.env.BUCKET, this.env.R2_BRIDGE, this.env.R2_URL, this.env.R2_TOKEN).get(key, { range: { offset: offsetOf(run[i]), length: (j - i + 1) * CHUNK } });
      if (!obj) throw new Error(`missing ${key}`);
      const buf = await obj.arrayBuffer();
      stats.r2Ms.push(+(performance.now() - r0).toFixed(1));
      stats.r2Gets++;
      stats.bytes += buf.byteLength;
      for (let k = i; k <= j; k++) {
        const piece = buf.slice((k - i) * CHUNK, (k - i + 1) * CHUNK);
        out.set(run[k], piece);
        if (cache && piece.byteLength) this.cachePuts.push([cacheUrl(run[k]), piece.slice(0)]);
      }
      i = j + 1;
    }
    return out;
  }

  /**
   * Prewarm: copy page ranges (by default every segment, e.g. a vector index) into the SQLite
   * tier in the background, whole 4 MiB parts at a time, so queries over them never wait on
   * the network. Runs from the alarm in slices; the state survives restarts.
   */
  async prewarm(db: string, from?: number, to?: number) {
    await this.ensure(db);
    const ranges: [number, number][] = from !== undefined && to !== undefined ? [[from, to]] : this.segments.map((g) => [g.firstPage, g.pages]);
    if (!ranges.length) return { error: "nothing to prewarm (no segments)" };
    const st: Prewarm = { db, ranges, ri: 0, next: ranges[0][0], pages: 0, skipped: 0, started: Date.now() };
    this.ctx.storage.kv.put("prewarm", st);
    await this.ctx.storage.setAlarm(Date.now());
    return st;
  }

  /** One slice of a prewarm (from the alarm); true while there's more to copy. */
  private async prewarmStep(): Promise<boolean> {
    const st = this.ctx.storage.kv.get<Prewarm>("prewarm");
    if (!st || st.finished) return false;
    await this.ensure(st.db);
    const deadline = Date.now() + 20_000;
    const PAR = 3; // leave connections for queries
    while (st.ri < st.ranges.length && Date.now() < deadline) {
      const [, end] = st.ranges[st.ri];
      const parts: number[] = [];
      for (let id = st.next; id < end && parts.length < PAR; id = (Math.floor(id / PAGES_PER_PART) + 1) * PAGES_PER_PART) parts.push(id);
      await Promise.all(
        parts.map(async (first) => {
          const last = Math.min(end, (Math.floor(first / PAGES_PER_PART) + 1) * PAGES_PER_PART);
          const have = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE id >= ? AND id < ?", first, last).one().n;
          if (have === last - first) {
            st.skipped += have;
            return;
          }
          const p0 = Math.floor(first / PAGES_PER_PART) * PAGES_PER_PART;
          const obj = await blobStore(this.env.BUCKET, this.env.R2_BRIDGE, this.env.R2_URL, this.env.R2_TOKEN).get(this.partKey(first), { range: { offset: (first - p0) * PAGE, length: (last - first) * PAGE } });
          if (!obj) throw new Error(`missing ${this.partKey(first)}`);
          const buf = await obj.arrayBuffer();
          this.ctx.storage.transactionSync(() => {
            for (let i = 0; i * PAGE < buf.byteLength; i++) this.sql.exec("INSERT OR IGNORE INTO pages (id, data) VALUES (?, ?)", first + i, new Uint8Array(buf, i * PAGE, PAGE));
          });
          st.pages += buf.byteLength / PAGE;
        }),
      );
      st.next = parts.length ? Math.min(end, (Math.floor(parts.at(-1)! / PAGES_PER_PART) + 1) * PAGES_PER_PART) : end;
      if (st.next >= end) {
        st.ri++;
        if (st.ri < st.ranges.length) st.next = st.ranges[st.ri][0];
      }
    }
    if (st.ri >= st.ranges.length) st.finished = Date.now();
    this.ctx.storage.kv.put("prewarm", st);
    return !st.finished;
  }

  private layerPrefix(db: string) {
    return `db/${db}/layer/${this.ctx.id.toString()}/`;
  }

  /** Run an engine call to completion, resolving page faults. `onOk` runs in the same turn as
   *  the successful call (nothing else can run in between). */
  private async drive(call: () => { status: number; out: Uint8Array }, stats?: QueryStats, onOk?: (out: Uint8Array) => void, persistNow = false) {
    const st = stats ?? newStats();
    for (;;) {
      const r = call();
      if (r.status === OK) {
        onOk?.(r.out);
        return r.out;
      }
      if (++st.rounds > MAX_ROUNDS) throw new Error(`gave up after ${st.rounds} fault rounds`);
      const f0 = performance.now();
      await this.resolve(Engine.faults(r.out), st, false, persistNow);
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
    this.live.pidOf.set(`${cid}\u0000${id}`, pid);
    let m = this.live.subs.get(pid);
    if (!m) this.live.subs.set(pid, (m = new Map()));
    let ids = m.get(cid);
    if (!ids) m.set(cid, (ids = new Set()));
    ids.add(id);
  }

  private untrack(cid: string, id: string) {
    const k = `${cid}\u0000${id}`;
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
    if (this.ctx.storage.kv.get("db") !== db) this.persistLater(() => this.ctx.storage.kv.put("db", db));
    const { 0: client, 1: server } = new WebSocketPair();
    const cid = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    // Set by the Worker only (it strips this header from client requests): an admin socket may
    // subscribe raw ASTs (benchmarks); everyone else must present leases.
    const build = this.env.CF_VERSION_METADATA?.id;
    server.serializeAttachment({ cid, admin: req.headers.get("x-pagedb-admin") === "1", build });
    await this.ensure(db);
    server.send(JSON.stringify({ t: "hello", version: this.engine!.overlayStats().version, build }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const { cid, admin } = ws.deserializeAttachment() as { cid: string; admin?: boolean };
    let m: { t: string; id?: string; q?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    await this.ensure(this.db ?? this.ctx.storage.kv.get<string>("db") ?? "db1g");
    if (m.t === "subs" && Array.isArray((m as any).list)) {
      await this.subscribeMany(ws, cid, (m as any).list, !!admin);
      return;
    }
    if (m.t === "sub" && m.id && m.q && admin) {
      const q = typeof m.q === "string" ? m.q : JSON.stringify(m.q);
      const stats = newStats();
      const t0 = performance.now();
      try {
        const out = await this.drive(() => this.engine!.subscribe(q), stats);
        const r = JSON.parse(Engine.text(out)) as { pid: number; rows?: unknown[]; complete?: boolean; count?: number };
        this.untrack(cid, m.id);
        this.track(cid, m.id, r.pid);
        stats.totalMs = performance.now() - t0;
        const version = this.engine!.overlayStats().version;
        ws.send(JSON.stringify({ t: "snap", id: m.id, version, rows: r.rows, complete: r.complete, count: r.count, stats: round(stats) }));
        const sid = m.id;
        this.persistLater(() => this.sql.exec("INSERT OR REPLACE INTO subs (cid, id, q) VALUES (?, ?, ?)", cid, sid, q));
      } catch (e) {
        ws.send(JSON.stringify({ t: "error", id: m.id, message: String((e as Error).message ?? e) }));
      }
    } else if (m.t === "unsub" && m.id) {
      this.untrack(cid, m.id);
      this.sql.exec("DELETE FROM subs WHERE cid = ? AND id = ?", cid, m.id);
    }
  }

  /**
   * Hydrate several subscriptions together: every query's missing pages are gathered into one
   * fault round (shared chunks fetched once), then each query is retried. A board's ten
   * queries cost one round instead of ten.
   */
  private async subscribeMany(ws: WebSocket, cid: string, list: { id: string; q?: unknown; lease?: string }[], admin: boolean) {
    const t0 = performance.now();
    const stats = newStats();
    // Every subscription must carry a lease signed for this database and object (raw ASTs only
    // on admin sockets). Rejected ones get an error; the rest proceed.
    const pending: { id: string; q: string }[] = [];
    for (const x of list.slice(0, 256)) {
      if (!x?.id) continue;
      try {
        if (typeof x.lease === "string") {
          if (!this.env.LEASE_SECRET) throw new Error("leases are not configured");
          const p = await verifyLease(this.env.LEASE_SECRET, x.lease, { db: this.db!, obj: this.ctx.id.name ?? "" });
          pending.push({ id: x.id, q: JSON.stringify(p.ast) });
        } else if (admin && x.q) pending.push({ id: x.id, q: typeof x.q === "string" ? x.q : JSON.stringify(x.q) });
        else throw new Error("a lease is required");
      } catch (e) {
        ws.send(JSON.stringify({ t: "error", id: x.id, message: String((e as Error).message ?? e) }));
      }
    }
    const done: { id: string; q: string; r: { pid: number; rows?: unknown[]; complete?: boolean; count?: number; ann?: unknown } }[] = [];
    while (pending.length) {
      const faults = new Set<number>();
      for (let i = pending.length - 1; i >= 0; i--) {
        try {
          const { status, out } = this.engine!.subscribe(pending[i].q);
          if (status === OK) {
            done.push({ ...pending[i], r: JSON.parse(Engine.text(out)) });
            pending.splice(i, 1);
          } else for (const id of Engine.faults(out)) faults.add(id);
        } catch (e) {
          ws.send(JSON.stringify({ t: "error", id: pending[i].id, message: String((e as Error).message ?? e) }));
          pending.splice(i, 1);
        }
      }
      if (!faults.size) break;
      if (++stats.rounds > MAX_ROUNDS) throw new Error("too many fault rounds");
      const f0 = performance.now();
      await this.resolve([...faults], stats);
      stats.roundMs.push(+(performance.now() - f0).toFixed(1));
    }
    stats.totalMs = performance.now() - t0;
    const version = this.engine!.overlayStats().version;
    for (const d of done) {
      this.untrack(cid, d.id);
      this.track(cid, d.id, d.r.pid);
    }
    ws.send(JSON.stringify({ t: "snaps", version, stats: round(stats), list: done.map((d) => ({ id: d.id, rows: d.r.rows, complete: d.r.complete, count: d.r.count, ann: d.r.ann })) }));
    for (const d of done) this.persistLater(() => this.sql.exec("INSERT OR REPLACE INTO subs (cid, id, q) VALUES (?, ?, ?)", cid, d.id, d.q));
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const { cid } = ws.deserializeAttachment() as { cid: string };
    for (const k of [...this.live.pidOf.keys()]) if (k.startsWith(`${cid}\u0000`)) this.untrack(cid, k.slice(cid.length + 1));
    this.sql.exec("DELETE FROM subs WHERE cid = ?", cid);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }

  /** Apply a batch of row ops. Durable before the version is returned and the pokes go out. */
  /** The persisted overlay: old per-entry rows, then the log in order (later records win). */
  /**
   * Replay the overlay into the engine one log row at a time: memory peaks at the overlay plus
   * one row, never the whole log (WebAssembly memory never shrinks once grown).
   */
  private loadLog(engine: Engine, db: string) {
    let version = this.ctx.storage.kv.get<number>(`version:${db}`) ?? 0;
    // Old per-entry rows (until the first compaction empties them) in ~1.5 MB batches too.
    let batch: OvRecord[] = [];
    let size = 0;
    for (const r of this.sql.exec<{ tree: number; key: ArrayBuffer; val: ArrayBuffer | null; delta: number }>("SELECT tree, key, val, delta FROM ovl")) {
      batch.push({ tree: r.tree, key: new Uint8Array(r.key), kind: 1, delta: r.delta, val: r.val ? new Uint8Array(r.val) : null });
      size += 13 + r.key.byteLength + (r.val?.byteLength ?? 0);
      if (size >= LOG_ROW_BYTES) {
        engine.loadOverlay(encodeRecords(batch), version);
        (batch = []), (size = 0);
      }
    }
    engine.loadOverlay(encodeRecords(batch), version);
    this.logRows = 0;
    this.logBytes = 0;
    for (const r of this.sql.exec<{ recs: ArrayBuffer; version: number }>("SELECT recs, version FROM ovlog ORDER BY seq")) {
      version = Math.max(version, r.version);
      engine.loadOverlay(new Uint8Array(r.recs), version);
      this.logRows++;
      this.logBytes += r.recs.byteLength;
    }
  }

  /** The overlay's version without loading it. */
  private logVersion(db: string): number {
    const v = this.sql.exec<{ v: number | null }>("SELECT MAX(version) AS v FROM ovlog").one().v;
    return Math.max(this.ctx.storage.kv.get<number>(`version:${db}`) ?? 0, v ?? 0);
  }

  private needsCompaction(): boolean {
    if (this.logRows > COMPACT_AT) return true;
    return this.logBytes > COMPACT_BYTES + 2 * (this.engine?.overlayStats().bytes ?? 0);
  }

  /** Append encoded overlay records as log rows (split under SQLite's 2 MB row limit). */
  private appendLog(records: Uint8Array, version: number) {
    for (const piece of records.length <= LOG_ROW_BYTES ? [records] : splitRecords(records, LOG_ROW_BYTES)) {
      this.sql.exec("INSERT INTO ovlog (recs, version) VALUES (?, ?)", piece, version);
      this.logRows++;
      this.logBytes += piece.length;
    }
  }

  /** Collapse the log (and any old per-entry rows) into the current state: a few big rows. */
  async compactOverlay() {
    const db = this.db ?? this.ctx.storage.kv.get<string>("boundDb");
    if (!db) return { compacted: false };
    await this.ensure(db);
    return this.compactNow();
  }

  /** The engine already holds the deduplicated overlay: snapshot it, replacing the log. */
  private compactNow() {
    const before = { rows: this.logRows, bytes: this.logBytes };
    const snapshot = this.engine!.exportOverlay();
    const version = this.engine!.overlayStats().version;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ovlog");
      this.sql.exec("DELETE FROM ovl");
      this.logRows = 0;
      this.logBytes = 0;
      this.appendLog(snapshot, version);
    });
    console.log(`compacted overlay log: ${before.rows} rows / ${(before.bytes / 1e6).toFixed(1)} MB -> ${this.logRows} rows / ${(this.logBytes / 1e6).toFixed(1)} MB`);
    return { compacted: true, before, after: { rows: this.logRows, bytes: this.logBytes } };
  }

  // ---------------------------------------------------------------- folding (core/src/fold.rs)

  /** Fold soon, from an alarm (which keeps the object alive until it's done). */
  private scheduleFold() {
    if (this.foldRun || this.env.R2_BRIDGE) return;
    void this.ctx.storage.getAlarm().then((at) => (at === null ? this.ctx.storage.setAlarm(Date.now() + 1000) : undefined));
  }

  async alarm() {
    // A prewarm in progress copies one slice per alarm, then comes back.
    if (await this.prewarmStep()) await this.ctx.storage.setAlarm(Date.now() + 100);
    const db = this.ctx.storage.kv.get<string>("boundDb");
    if (!db) return;
    await this.ensure(db);
    if (this.engine!.overlayStats().bytes > FOLD_BYTES) {
      try {
        console.log("fold", JSON.stringify(await this.fold()));
      } catch (e) {
        console.error("fold failed", String((e as Error).stack ?? e));
      }
    }
  }

  /** Admin: fold now (whatever the overlay's size). */
  async foldNow(db?: string) {
    db ??= this.db ?? this.ctx.storage.kv.get<string>("boundDb");
    if (!db) return { folded: false, reason: "no database" };
    await this.ensure(db);
    return this.fold();
  }

  private fold(): Promise<Record<string, unknown>> {
    if (this.env.R2_BRIDGE) return Promise.resolve({ folded: false, reason: "no R2 writes from a container" });
    this.foldRun ??= this.runFold().finally(() => (this.foldRun = undefined));
    return this.foldRun;
  }

  /**
   * Overlay → a new layer in R2. Reads and writes carry on throughout; writes made while it
   * uploads are rebased at the commit. The swap (layer pointer + overlay log) is one SQLite
   * transaction, so a crash at any point leaves either the old state or the new one.
   */
  private async runFold(): Promise<Record<string, unknown>> {
    const engine = this.engine!;
    const db = this.db!;
    const t0 = Date.now();
    const before = engine.overlayStats();
    const stats = newStats();
    const gone = () => this.engine !== engine;
    const bucket = blobStore(this.env.BUCKET, this.env.R2_BRIDGE, this.env.R2_URL, this.env.R2_TOKEN);
    if (!bucket.put) return { folded: false, reason: "no R2 writes" };
    try {
      // 1. Every page of the current layer, straight into SQLite (more than RAM holds).
      await this.drive(() => engine.foldTouch(), stats, undefined, true);
      if (gone()) return { folded: false, reason: "reset" };
      // 2. The new layer: pages numbered after everything before it, written to SQLite as built.
      const old = this.layer;
      const first = Math.ceil(Math.max(this.basePages, old ? old.first + old.pages : 0) / PAGES_PER_PART) * PAGES_PER_PART;
      let built!: { pages: number; layer: LayerTrees };
      await this.drive(() => engine.foldBuild(first), stats, (out) => (built = JSON.parse(Engine.text(out))), true);
      const meta: LayerMeta = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        base: this.base!,
        first,
        pages: built.pages,
        trees: built.layer.trees,
        at: Date.now(),
        prev: old && { id: old.id, first: old.first, pages: old.pages },
      };
      this.pendingLayer = meta;
      // 3. Upload, as 4 MiB parts.
      const t1 = Date.now();
      const parts = Math.ceil(meta.pages / PAGES_PER_PART);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, parts) }, async () => {
          while (next < parts) {
            const p = next++;
            const lo = first + p * PAGES_PER_PART;
            const hi = Math.min(first + meta.pages, lo + PAGES_PER_PART);
            const rows = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM pages WHERE id >= ? AND id < ? ORDER BY id", lo, hi).toArray();
            if (rows.length !== hi - lo) throw new Error(`fold: part ${p} has ${rows.length} of ${hi - lo} pages`);
            const body = new Uint8Array((hi - lo) * PAGE);
            rows.forEach((r, i) => body.set(new Uint8Array(r.data), i * PAGE));
            await this.gate.run(() => bucket.put!(`${this.layerPrefix(db)}${meta.id}/part-${String(p).padStart(6, "0")}`, body));
          }
        }),
      );
      const uploadMs = Date.now() - t1;
      if (gone()) return { folded: false, reason: "reset" };
      // 4. Swap it in, and 5. persist the swap, in the same turn.
      let committed = false;
      await this.drive(() => (gone() ? { status: OK, out: new Uint8Array() } : engine.foldCommit()), stats, () => {
        if (gone()) return; // reset while the commit waited on pages: this engine is discarded
        committed = true;
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put(`layer:${db}`, meta);
          this.sql.exec("DELETE FROM ovlog");
          this.sql.exec("DELETE FROM ovl");
          this.logRows = 0;
          this.logBytes = 0;
          this.appendLog(engine.exportOverlay(), engine.overlayStats().version);
        });
        this.layer = meta;
        this.pendingLayer = undefined;
      }, true);
      if (!committed) return { folded: false, reason: "reset" };
      // 6. The layer before the old one: nothing can reach it now.
      if (old?.prev) {
        const pp = old.prev;
        this.sql.exec("DELETE FROM pages WHERE id >= ? AND id < ?", pp.first, pp.first + pp.pages);
        void this.deleteLayers(db, (id) => id === pp.id);
      }
      const after = engine.overlayStats();
      return {
        folded: true,
        layer: meta.id,
        pages: meta.pages,
        mb: +((meta.pages * PAGE) / 1e6).toFixed(1),
        overlay: { before: { entries: before.entries, bytes: before.bytes }, after: { entries: after.entries, bytes: after.bytes } },
        rounds: stats.rounds,
        uploadMs,
        ms: Date.now() - t0,
      };
    } catch (e) {
      if (!gone()) engine.foldAbort();
      this.pendingLayer = undefined;
      throw e;
    }
  }

  /** Delete layers' parts from R2 (best effort; R2 binding only). */
  private async deleteLayers(db: string, which: (id: string) => boolean) {
    const b = this.env.BUCKET as R2Bucket;
    if (this.env.R2_BRIDGE || typeof b.list !== "function") return;
    try {
      let cursor: string | undefined;
      do {
        const prefix = this.layerPrefix(db);
        const page = await b.list({ prefix, cursor });
        const idOf = (k: string) => k.slice(prefix.length).split("/")[0];
        const keys = page.objects.map((o) => o.key).filter((k) => which(idOf(k)) && idOf(k) !== this.layer?.id && idOf(k) !== this.pendingLayer?.id);
        if (keys.length) await b.delete(keys);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch (e) {
      console.error("layer cleanup", String(e));
    }
  }

  async write(db: string, ops: unknown): Promise<{ version: number; changes: number; ms: number; rounds: number } | { error: string }> {
    const t0 = performance.now();
    await this.ensure(db);
    const stats = newStats();
    let result!: { version: number; changes: number; pokes: Record<string, unknown[]> };
    try {
      await this.drive(() => this.engine!.write(typeof ops === "string" ? ops : JSON.stringify(ops)), stats, (out) => {
        // Logged in the same turn the engine applied it: a fold can't commit in between (the
        // record is relative to the layer the engine had when it applied the write).
        const jsonLen = new DataView(out.buffer, out.byteOffset).getUint32(0, true);
        result = JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + jsonLen)));
        // One log row for the whole write (its version rides along: no separate version write).
        this.ctx.storage.transactionSync(() => this.appendLog(out.subarray(4 + jsonLen), result.version));
      });
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
    if (this.needsCompaction()) this.compactNow();
    if (this.engine!.overlayStats().bytes > FOLD_BYTES) this.scheduleFold();
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
      // Sockets holding the same subscriptions get the same bytes: encode each distinct
      // message once (1,000 tabs on one board = one stringify, not 1,000).
      const encoded = new Map<Record<string, unknown[]>, string>();
      const byShape = new Map<string, Record<string, unknown[]>>();
      for (const ws of this.ctx.getWebSockets()) {
        let subs = perSocket.get((ws.deserializeAttachment() as { cid: string }).cid);
        if (!subs) continue;
        const shape = Object.keys(subs).sort().join("\u0000") + "\u0001" + Object.values(subs).map((o) => (o as unknown[]).length).join(",");
        const same = byShape.get(shape);
        if (same && Object.keys(subs).every((k) => same[k] === subs![k])) subs = same;
        else byShape.set(shape, subs);
        let msg = encoded.get(subs);
        if (!msg) encoded.set(subs, (msg = JSON.stringify({ t: "poke", version: result.version, subs })));
        try {
          ws.send(msg);
        } catch {}
      }
    }
    return { version: result.version, changes: result.changes, ms: +(performance.now() - t0).toFixed(1), rounds: stats.rounds };
  }

  /**
   * Nightly reset of a public demo: the base is immutable, so resetting is dropping the overlay.
   * Every live partition is rebuilt from scratch and open tabs are told to resubscribe.
   */
  async resetOverlay(db: string) {
    const before = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ovl").one().n + this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ovlog").one().n;
    const last = this.logVersion(db);
    this.sql.exec("DELETE FROM ovl");
    this.sql.exec("DELETE FROM ovlog");
    this.logRows = 0;
    this.logBytes = 0;
    // Folded layers go too: back to the published base.
    const layer = this.ctx.storage.kv.get<LayerMeta>(`layer:${db}`);
    this.ctx.storage.kv.delete(`layer:${db}`);
    this.layer = this.pendingLayer = undefined;
    if (layer) {
      this.sql.exec("DELETE FROM pages WHERE id >= ?", Math.min(layer.first, layer.prev?.first ?? Infinity));
      void this.deleteLayers(db, () => true);
    }
    const version = last + 1;
    this.ctx.storage.kv.put(`version:${db}`, version);
    this.engine = undefined; // next use reloads the (now empty) overlay
    this.live = { subs: new Map(), pidOf: new Map() };
    this.sql.exec("DELETE FROM subs");
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ t: "reset", version }));
      } catch {}
    }
    return { cleared: before, version };
  }

  /** Read the manifest again (e.g. a segment was attached); pages already held stay valid. */
  async remanifest(db: string) {
    // (By name: a freshly started object doesn't know its database until it serves a request.)
    this.ctx.storage.kv.delete(`manifest:${db}`);
    this.engine = undefined;
    this.freshManifest = true;
    return { ok: true };
  }

  /** Drop up to `limit` cached pages with ids in [from, to) (a big tier can't go in one
   *  statement: the storage operation would time out). Returns how many are left there. */
  async dropPages(from: number, to: number, limit = 2000) {
    this.sql.exec("DELETE FROM pages WHERE id IN (SELECT id FROM pages WHERE id >= ? AND id < ? LIMIT ?)", from, to, limit);
    return { left: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE id >= ? AND id < ?", from, to).one().n };
  }

  /** Drop the SQLite page tier and the engine (cold benchmarks). */
  async reset(db?: string) {
    this.sql.exec("DELETE FROM pages");
    this.ctx.storage.kv.delete(`manifest:${db ?? this.db}`);
    this.ctx.storage.kv.delete("prewarm");
    this.engine = undefined;
    this.freshManifest = true;
    return { ok: true };
  }

  /** Container debugging: sequential inline fetches vs blobStore, to isolate failures. */
  async debugFetch(key: string, len: number, _n: number) {
    const out: string[] = [];
    const url = (i: number) => `http://r2.internal/get?key=${encodeURIComponent(key)}&offset=${i * len}&length=${len}`;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url(i));
        out.push(`inline#${i} ${r.status}:${(await r.arrayBuffer()).byteLength}`);
      } catch (e) {
        out.push(`inline#${i} throws ${String((e as Error).message ?? e)}`);
      }
    }
    const store = blobStore(this.env.BUCKET, this.env.R2_BRIDGE, this.env.R2_URL, this.env.R2_TOKEN);
    out.push(`isR2=${typeof (this.env.BUCKET as any).createMultipartUpload} r2url=${this.env.R2_URL ?? "-"}`);
    for (let i = 0; i < 3; i++) {
      let stage = "get";
      try {
        const o = await store.get(key, { range: { offset: i * len, length: len } });
        stage = "body";
        out.push(`store#${i} ok:${(await o!.arrayBuffer()).byteLength}`);
      } catch (e) {
        out.push(`store#${i} ${stage} throws ${String((e as Error).message ?? e)} ${String((e as Error).stack ?? "").split("\n").slice(1, 3).join(" | ")}`);
      }
    }
    return out;
  }

  /** SQLite page-tier microbenchmark: read `n` pages (ids from the table) `how` ways. The
   *  object's clock doesn't advance during synchronous work, so callers time it from outside. */
  async sqliteBench(n: number, how: "one" | "batch" | "ids") {
    const ids = this.sql.exec<{ id: number }>("SELECT id FROM pages ORDER BY id LIMIT ?", n).toArray().map((r) => r.id);
    let bytes = 0;
    if (how === "one") for (const id of ids) bytes += this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM pages WHERE id = ?", id).toArray()[0].data.byteLength;
    else if (how === "batch")
      for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100);
        for (const r of this.sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM pages WHERE id IN (${part.map(() => "?").join(",")})`, ...part)) bytes += r.data.byteLength;
      }
    return { n: ids.length, bytes };
  }

  /** Evict this object from memory, keeping its storage (measures wake from hibernation). */
  async evict() {
    this.ctx.abort("evicted for a benchmark");
  }

  /** The base's size and row counts (from its manifest), for pages to show. */
  async baseStats(db: string) {
    await this.ensure(db);
    const m = JSON.parse(this.ctx.storage.kv.get<string>(`manifest:${db}`) ?? "{}") as { bytes?: number; rows?: Record<string, number>; pages?: number };
    return { bytes: m.bytes ?? 0, rows: m.rows ?? {}, pages: m.pages ?? 0 };
  }

  async info() {
    const ov = this.engine?.overlayStats();
    const pages = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pages").one().n;
    const log = { rows: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ovlog").one().n, legacyEntries: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ovl").one().n };
    const layer = this.layer && { id: this.layer.id, pages: this.layer.pages, mb: +((this.layer.pages * PAGE) / 1e6).toFixed(1), at: new Date(this.layer.at).toISOString(), folding: !!this.foldRun };
    return { db: this.db, base: this.base, segments: this.segments.map(({ db, base, firstPage, pages }) => ({ db, base, firstPage, pages })), prewarm: this.ctx.storage.kv.get("prewarm"), layer, overlayLog: log, sqlitePages: pages, sqliteMB: +((pages * PAGE) / 1e6).toFixed(1), engine: this.engine?.stats(), overlay: ov, sockets: this.ctx.getWebSockets().length, build: this.env.CF_VERSION_METADATA?.id };
  }
}

function newStats(): QueryStats {
  return { rounds: 0, roundMs: [], pages: 0, chunks: 0, cacheHits: 0, r2Gets: 0, bytes: 0, sqliteHits: 0, r2Ms: [], cacheMs: [], engineMs: 0, fetchMs: 0, totalMs: 0 };
}

function round(s: QueryStats): QueryStats {
  for (const k of ["engineMs", "fetchMs", "totalMs"] as const) s[k] = +s[k].toFixed(2);
  return s;
}

/** Pages [firstPage, pages) of a base live in db/<db>/base/<base>/ (their pinned region from
 *  pinnedFrom), numbered as if they continued the base. */
interface Segment {
  /** Another database's directory (a segment shared by several bases), else this one's. */
  db?: string;
  base: string;
  firstPage: number;
  pages: number;
  pinnedFrom: number;
  chunkPages?: number;
}

interface Prewarm {
  db: string;
  ranges: [number, number][];
  ri: number;
  next: number;
  pages: number;
  skipped: number;
  started: number;
  finished?: number;
}

// ---------------------------------------------------------------- live queries over WebSockets

export interface Live {
  /** partition id → subscribers (socket id → client query ids) */
  subs: Map<number, Map<string, Set<string>>>;
  /** (socket id, client query id) → partition id */
  pidOf: Map<string, number>;
}
