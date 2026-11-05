// PGDATA in the Durable Object's SQLite: a synchronous filesystem for PGlite.
//
// Files are rows of blocks (8 KiB for new databases: Postgres's page size). Blocks are read
// through an in-memory LRU cache; writes dirty the cached block and are flushed to SQLite in one
// transaction when PGlite syncs, so a transaction's page writes become a handful of row writes,
// durable before the object replies.
//
// Three modes:
//   local    everything lives here (plus template blocks fetched from R2 on first read)
//   primary  the database's disk lives on page servers (src/pagedo.ts); this SQLite is a
//            write-back cache of it. Every flush is numbered (`seq`), and what it changed is
//            queued in `ship` until a page server has it. Relation blocks that a page server
//            holds can be evicted here and fetched back on a miss.
//   replica  a read-only copy of the primary's disk as of one flush (`at`): every block comes
//            from the page servers (newest version ≤ at) and writes stay local.
// A read that misses throws EIO after noting what it needed (`missing`); the host fetches it
// (`fetchMissing`) and runs the statement again.
import { BaseFilesystem, ERRNO_CODES, type FsStats } from "@electric-sql/pglite/basefs";
import type { Block, NodeRow, Trunc } from "./pagedo";

const NEW_BLOCK = 8 * 1024;
/** Dirty blocks beyond this are written to SQLite mid-statement, so one big statement never holds
 *  its whole output in memory. */
const DIRTY_LIMIT = 2 * 1024 * 1024;
/** Blocks per stripe: a file is spread over the page servers in stripes of this many blocks. */
export const STRIPE = 128;
/** A scan's fetch window grows to this many blocks (16 MiB, fetched from all shards at once). */
const SCAN_MAX = 2048;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

type Node = { mode: number; size: number; mtime: number };
/** A file still backed by the template image in R2 (blocks fetched when first read). */
type Base = { off: number; size: number };
export type ImageIndex = { block: number; eagerEnd: number; dirs: { path: string; mode: number }[]; files: { path: string; mode: number; mtime: number; size: number; off: number }[] };
const EIO = 29; // Emscripten's errno for EIO: Postgres reports "could not read block …"

/** Relation files of user objects (relfilenode ≥ 16384; main, fsm, vm and init forks and their
 *  segments): the ones a primary may evict. System catalogs always stay local, so Postgres's own
 *  lookups (and the wire layer's) never wait on a page server. */
const RELATION_FILE = /^\/(base\/\d+|global)\/(\d+)(_fsm|_vm|_init)?(\.\d+)?$/;
/** Any relation file: a primary may have to fetch it back (catalogs too, if evicted before
 *  they were kept). */
const remoteBacked = (path: string) => RELATION_FILE.test(path);
export const evictable = (path: string) => {
  // main forks only: the visibility and free-space maps are tiny, and crash recovery reads them
  // without the WAL naming them (redo clears visibility bits and records free space)
  const m = RELATION_FILE.exec(path);
  return !!m && Number(m[2]) >= 16384 && !m[3];
};

export type Mode = { kind: "local" } | { kind: "primary"; shards: number } | { kind: "replica"; shards: number; at: number };
export type RemoteGet = (shard: number, keys: [string, number][], at: number) => Promise<[string, number, ArrayBuffer | null][]>;
export interface ShipBatch {
  blocks: { shard: number; row: Block; hold: boolean }[];
  nodes: NodeRow[];
  truncs: Trunc[];
}

const fail = (code: keyof typeof ERRNO_CODES, what: string): never => {
  throw Object.assign(new Error(`${code}: ${what}`), { code: ERRNO_CODES[code] });
};
const norm = (p: string) => (p === "" || p === "/" ? "/" : p.startsWith("/") ? p : `/${p}`);
const parent = (p: string) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");

/** Which page server holds block n of path (FNV-1a over the path and stripe number). */
export function shardOf(path: string, n: number, shards: number) {
  let h = 0x811c9dc5;
  const s = `${path}#${Math.floor(n / STRIPE)}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) % shards;
}

export interface FsStatsSnapshot {
  mode: string;
  nodes: number;
  lazyFiles: number;
  faults: number;
  fetchedMB: number;
  remoteFetches: number;
  cachedBlocks: number;
  cachedMB: number;
  dirty: number;
  reads: number;
  readMisses: number;
  rowsWritten: number;
  flushes: number;
  seq: number;
  evicted: number;
}

export class SqliteFS extends BaseFilesystem {
  private nodes = new Map<string, Node>();
  private dirtyNodes = new Set<string>();
  private cache = new Map<string, Uint8Array>(); // `${path}\0${n}` → block, in LRU order
  /** Written blocks not yet in SQLite. They own their bytes, so evicting one from the cache can't
   *  lose a write, and reads look here before SQLite. */
  private dirty = new Map<string, Uint8Array>();
  private dirtyBytes = 0;
  private cacheBytes = 0;
  private fds = new Map<number, string>();
  private base = new Map<string, Base>();
  /** Blocks a read needed but didn't have (`${path}\0${n}`): fetched, then the statement retried. */
  readonly missing = new Set<string>();
  private window = new Map<string, number>(); // blocks to fetch next time this file misses
  /** Per file: where the last remote fetch ended, and its size (scans continue from there). */
  private remoteNext = new Map<string, [number, number]>();
  private remoteMisses = new Map<string, number>();
  /** Files up to this many blocks get warmed a stripe at a time; bigger ones (more than a quarter
   *  of the local budget) fetch just the block a random read wants. */
  warmableBlocks = (6 * 1024 * 1024 * 1024) / 8192 / 4;
  private nextFd = 3;
  readonly stats = { reads: 0, readMisses: 0, rowsWritten: 0, flushes: 0, faults: 0, fetchedMB: 0, remoteFetches: 0, evicted: 0 };
  private readonly bs: number;

  // primary and replica modes
  private mode: Mode = { kind: "local" };
  /** The last flush's number. */
  private seq = 0;
  /** The newest replica snapshot point: versions at or before it must reach the page servers. */
  private barrier = 0;
  private pendingTruncs: [string, number][] = [];
  private reship: string[] = [];
  /** Stripes read since the last eviction pass (they stay). */
  private touched = new Set<string>();
  private evictCursor: [string, number] = ["", -1];

  constructor(private sql: SqlStorage, private cacheLimit = 4 * 1024 * 1024, debug = false) {
    super(undefined, { debug });
    sql.exec("CREATE TABLE IF NOT EXISTS fs_node (path TEXT PRIMARY KEY, mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL) WITHOUT ROWID");
    sql.exec("CREATE TABLE IF NOT EXISTS fs_block (path TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, shipped INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (path, n)) WITHOUT ROWID");
    try {
      sql.exec("ALTER TABLE fs_block ADD COLUMN shipped INTEGER NOT NULL DEFAULT 0"); // databases made before it existed
    } catch {}
    sql.exec("CREATE TABLE IF NOT EXISTS fs_base (path TEXT PRIMARY KEY, off INTEGER NOT NULL, size INTEGER NOT NULL) WITHOUT ROWID");
    sql.exec("CREATE TABLE IF NOT EXISTS fs_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL) WITHOUT ROWID");
    // primary mode: what page servers don't have yet
    sql.exec("CREATE TABLE IF NOT EXISTS ship (path TEXT NOT NULL, n INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (path, n)) WITHOUT ROWID");
    sql.exec("CREATE TABLE IF NOT EXISTS ship_hold (path TEXT NOT NULL, n INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, n, seq)) WITHOUT ROWID");
    sql.exec("CREATE TABLE IF NOT EXISTS ship_node (seq INTEGER NOT NULL, path TEXT NOT NULL, mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, gone INTEGER NOT NULL, PRIMARY KEY (seq, path)) WITHOUT ROWID");
    sql.exec("CREATE TABLE IF NOT EXISTS ship_trunc (seq INTEGER NOT NULL, path TEXT NOT NULL, from_n INTEGER NOT NULL, PRIMARY KEY (seq, path, from_n)) WITHOUT ROWID");
    for (const r of sql.exec<{ path: string; mode: number; size: number; mtime: number }>("SELECT path, mode, size, mtime FROM fs_node")) this.nodes.set(r.path, { mode: r.mode, size: r.size, mtime: r.mtime });
    for (const r of sql.exec<{ path: string; off: number; size: number }>("SELECT path, off, size FROM fs_base")) this.base.set(r.path, { off: r.off, size: r.size });
    const meta = new Map(sql.exec<{ k: string; v: number }>("SELECT k, v FROM fs_meta").toArray().map((r) => [r.k, r.v]));
    this.bs = meta.get("block") ?? (this.nodes.size === 0 ? NEW_BLOCK : 64 * 1024);
    if (!meta.has("block")) this.setMeta("block", this.bs);
    this.seq = meta.get("seq") ?? 0;
    this.barrier = meta.get("barrier") ?? 0;
    if (meta.get("shards")) this.mode = { kind: "primary", shards: meta.get("shards")! };
    if (!this.nodes.has("/")) this.putNode("/", { mode: S_IFDIR | 0o700, size: 0, mtime: Date.now() });
  }

  private setMeta(k: string, v: number) {
    this.sql.exec("INSERT OR REPLACE INTO fs_meta (k, v) VALUES (?, ?)", k, v);
  }

  /** Whether a read can miss (blocks still in a template image, or held elsewhere). */
  get mayMiss() {
    return this.base.size > 0 || this.mode.kind !== "local";
  }
  get kind() {
    return this.mode.kind;
  }
  get shards() {
    return this.mode.kind === "local" ? 0 : this.mode.shards;
  }
  get flushSeq() {
    return this.seq;
  }

  get empty() {
    return this.nodes.size <= 1;
  }

  snapshot(): FsStatsSnapshot {
    return { mode: this.mode.kind, nodes: this.nodes.size, lazyFiles: this.base.size, cachedBlocks: this.cache.size, cachedMB: +(this.cacheBytes / 1e6).toFixed(1), dirty: this.dirty.size, seq: this.seq, ...this.stats };
  }

  /** A branch of a template image: every file's metadata, small files' bytes (`eager`, the image's
   *  first eagerEnd bytes), and big files left in R2 until a read needs them. */
  initFromImage(index: ImageIndex, eager: Uint8Array) {
    this.sql.exec("DELETE FROM fs_block");
    this.sql.exec("DELETE FROM fs_node");
    this.sql.exec("DELETE FROM fs_base");
    this.nodes.clear();
    this.base.clear();
    this.putNode("/", { mode: S_IFDIR | 0o700, size: 0, mtime: Date.now() });
    for (const d of index.dirs) if (d.path !== "/") this.putNode(d.path, { mode: S_IFDIR | (d.mode || 0o700), size: 0, mtime: Date.now() });
    let lazy = 0;
    for (const f of index.files) {
      this.putNode(f.path, { mode: S_IFREG | (f.mode || 0o600), size: f.size, mtime: f.mtime });
      if (f.off + f.size <= index.eagerEnd) {
        for (let n = 0; n * this.bs < f.size; n++) this.sql.exec("INSERT INTO fs_block (path, n, data) VALUES (?, ?, ?)", f.path, n, eager.subarray(f.off + n * this.bs, f.off + Math.min(f.size, (n + 1) * this.bs)));
      } else {
        this.base.set(f.path, { off: f.off, size: f.size });
        this.sql.exec("INSERT INTO fs_base (path, off, size) VALUES (?, ?, ?)", f.path, f.off, f.size);
        lazy++;
      }
    }
    this.flushNodes();
    return { files: index.files.length, lazy };
  }

  /** Make this database's disk live on `shards` page servers (a new database, right after its
   *  image is in): everything here is queued for them as one flush. */
  enablePrimary(shards: number) {
    if (this.base.size) throw new Error("primary mode needs an image without lazy files");
    this.flush();
    this.mode = { kind: "primary", shards };
    this.setMeta("shards", shards);
    const seq = ++this.seq;
    this.setMeta("seq", seq);
    this.sql.exec("INSERT OR REPLACE INTO ship (path, n, seq) SELECT path, n, ? FROM fs_block", seq);
    for (const [p, n] of this.nodes) this.sql.exec("INSERT OR REPLACE INTO ship_node (seq, path, mode, size, mtime, gone) VALUES (?, ?, ?, ?, ?, 0)", seq, p, n.mode, n.size, n.mtime);
  }

  /** A replica of a primary's disk as of flush `at`: the file list comes from page server 0. */
  initReplica(shards: number, at: number, files: [string, number, number, number][]) {
    this.sql.exec("DELETE FROM fs_block");
    this.sql.exec("DELETE FROM fs_node");
    this.sql.exec("DELETE FROM fs_base");
    this.nodes.clear();
    this.base.clear();
    this.cache.clear();
    this.cacheBytes = 0;
    for (const [p, mode, size, mtime] of files) this.putNode(p, { mode, size, mtime });
    if (!this.nodes.has("/")) this.putNode("/", { mode: S_IFDIR | 0o700, size: 0, mtime: Date.now() });
    this.flushNodes();
    this.mode = { kind: "replica", shards, at };
  }

  /** This (already initialised) replica's mode again, after the object rebuilt its filesystem. */
  setReplica(shards: number, at: number) {
    this.mode = { kind: "replica", shards, at };
  }

  /** A replica snapshot point: the disk as of flush `seq` must reach the page servers intact,
   *  even if blocks are rewritten before they're shipped (they're held first, see flush). */
  setBarrier() {
    this.flush();
    this.barrier = this.seq;
    this.setMeta("barrier", this.barrier);
    return this.barrier;
  }

  /** Fetch what reads were missing: template blocks from R2 (a window after each, doubling per
   *  file up to 64 MiB) and remote blocks from page servers (one block, or a doubling window for scans),
   *  without touching blocks written since. */
  async fetchMissing(template: (off: number, len: number) => Promise<ArrayBuffer>, remote?: RemoteGet) {
    const want = new Map<string, number>();
    for (const k of this.missing) {
      const i = k.indexOf("\0"), p = k.slice(0, i), n = Number(k.slice(i + 1));
      if (!want.has(p) || n < want.get(p)!) want.set(p, n);
    }
    this.missing.clear();
    const fromTemplate: [string, number][] = [];
    const byShard = new Map<number, [string, number][]>();
    for (const [p, n0] of want) {
      if (this.mode.kind !== "local" && (this.mode.kind === "replica" || remoteBacked(p))) {
        // Random reads fetch just their block; a miss right where the last fetch ended is a scan,
        // and its window doubles (to a stripe).
        // A file that keeps missing (a hot table being warmed) fetches whole stripes instead.
        const size = this.nodes.get(p)?.size ?? 0;
        const prev = this.remoteNext.get(p);
        const misses = (this.remoteMisses.get(p) ?? 0) + 1;
        this.remoteMisses.set(p, misses);
        let first = n0, w: number;
        if (prev && prev[0] === n0) w = Math.min(prev[1] * 4, SCAN_MAX);
        else if (misses >= 16 && this.relationBlocks(p) <= this.warmableBlocks) {
          first = n0 - (n0 % STRIPE);
          w = STRIPE;
        } else w = 1;
        const last = Math.min(Math.ceil(size / this.bs), first + w);
        this.remoteNext.set(p, [last, w]);
        for (let n = first; n < last; n++) {
          const s = shardOf(p, n, this.mode.shards);
          (byShard.get(s) ?? byShard.set(s, []).get(s)!).push([p, n]);
        }
      } else fromTemplate.push([p, n0]);
    }
    if (byShard.size && remote) fromTemplate.push(...(await this.fetchRemote(byShard, remote)));
    await Promise.all(
      fromTemplate.map(async ([p, n0]) => {
        const b = this.base.get(p);
        if (!b) return;
        const w = this.window.get(p) ?? (1 << 20) / this.bs; // 1 MiB first
        this.window.set(p, Math.min(w * 2, (64 << 20) / this.bs));
        const last = Math.min(Math.ceil(b.size / this.bs), n0 + w);
        const buf = new Uint8Array(await template(b.off + n0 * this.bs, Math.min(b.size, last * this.bs) - n0 * this.bs));
        this.stats.fetchedMB += buf.length / 1e6;
        for (let n = n0; n < last; n++) this.sql.exec("INSERT OR IGNORE INTO fs_block (path, n, data, shipped) VALUES (?, ?, ?, 2)", p, n, buf.subarray((n - n0) * this.bs, Math.min(buf.length, (n - n0 + 1) * this.bs)));
      }),
    );
  }

  /** A relation's size in blocks across its 1 GiB segment files (path, path.1, path.2, …). */
  private relationBlocks(path: string) {
    const base = path.replace(/\.\d+$/, "");
    let total = Math.ceil((this.nodes.get(base)?.size ?? 0) / this.bs);
    for (let i = 1; this.nodes.has(`${base}.${i}`); i++) total += Math.ceil(this.nodes.get(`${base}.${i}`)!.size / this.bs);
    return total;
  }

  /** Fetch blocks from page servers into SQLite; returns the ones the template image has instead. */
  private async fetchRemote(byShard: Map<number, [string, number][]>, remote: RemoteGet) {
    const at = this.mode.kind === "replica" ? this.mode.at : Number.MAX_SAFE_INTEGER;
    const fromTemplate: [string, number][] = [];
    const chunks: [number, [string, number][]][] = [];
    for (const [s, keys] of byShard) for (let i = 0; i < keys.length; i += 512) chunks.push([s, keys.slice(i, i + 512)]);
    const results = await Promise.all(chunks.map(([s, keys]) => remote(s, keys, at)));
    this.stats.remoteFetches += chunks.length;
    for (const rows of results)
      for (const [p, n, data] of rows) {
        if (data) {
          this.stats.fetchedMB += data.byteLength / 1e6;
          this.sql.exec("INSERT OR IGNORE INTO fs_block (path, n, data, shipped) VALUES (?, ?, ?, 1)", p, n, data);
        } else if (this.base.get(p) && n * this.bs < this.base.get(p)!.size) fromTemplate.push([p, n]);
        else {
          // never written (a hole) or gone: zeros, as a file system would return
          const size = this.nodes.get(p)?.size ?? 0;
          const len = Math.max(0, Math.min(this.bs, size - n * this.bs));
          this.sql.exec("INSERT OR IGNORE INTO fs_block (path, n, data, shipped) VALUES (?, ?, ?, 1)", p, n, new Uint8Array(len));
        }
      }
    return fromTemplate;
  }

  /** Before Postgres starts: bring back every block that must be here (not an evictable user
   *  relation) but isn't: a replica's control files, catalogs and WAL, or catalog blocks a
   *  primary evicted before catalogs were kept. */
  async restoreLocal(remote: RemoteGet) {
    if (this.mode.kind === "local") return 0;
    const shards = this.mode.shards;
    const byShard = new Map<number, [string, number][]>();
    let n = 0;
    for (const [p, node] of this.nodes) {
      if ((node.mode & S_IFDIR) === S_IFDIR || evictable(p) || !node.size) continue;
      if (this.mode.kind === "primary" && !remoteBacked(p)) continue; // the rest never leaves a primary
      const have = new Set(this.sql.exec<{ n: number }>("SELECT n FROM fs_block WHERE path = ?", p).toArray().map((r) => r.n));
      for (let b = 0; b * this.bs < node.size; b++)
        if (!have.has(b)) {
          const s = shardOf(p, b, shards);
          (byShard.get(s) ?? byShard.set(s, []).get(s)!).push([p, b]);
          n++;
        }
    }
    if (n) await this.fetchRemote(byShard, remote);
    return n;
  }

  /** Remove a file if it's there (a stale postmaster.pid from a boot that died). */
  removeIfExists(path: string) {
    if (!this.nodes.has(path)) return false;
    this.unlink(path);
    this.flush();
    return true;
  }

  /** User-data blocks held here (a replica's working set, for warming its successor). */
  localDataKeys(limit: number) {
    const out: string[] = [];
    for (const r of this.sql.exec<{ path: string; n: number }>("SELECT path, n FROM fs_block LIMIT ?", limit * 4)) {
      if (evictable(r.path)) out.push(`${r.path}\0${r.n}`);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** A whole file from local SQLite (for scanning WAL and the control file before boot). */
  readLocal(path: string): Uint8Array | null {
    const node = this.nodes.get(path);
    if (!node) return null;
    const out = new Uint8Array(node.size);
    for (const r of this.sql.exec<{ n: number; data: ArrayBuffer }>("SELECT n, data FROM fs_block WHERE path = ?", path)) {
      const off = r.n * this.bs;
      if (off < out.length) out.set(new Uint8Array(r.data).subarray(0, out.length - off), off);
    }
    return out;
  }

  /** Make sure these blocks (`${path}\0${n}`, e.g. what crash recovery will touch) are here. */
  async ensureBlocks(keys: Iterable<string>, remote: RemoteGet) {
    if (this.mode.kind === "local") return 0;
    const shards = this.mode.shards;
    const byShard = new Map<number, [string, number][]>();
    let n = 0;
    for (const k of keys) {
      const i = k.indexOf("\0"), p = k.slice(0, i), b = Number(k.slice(i + 1));
      const node = this.nodes.get(p);
      if (!node || b * this.bs >= node.size || !remoteBacked(p)) continue;
      if (this.sql.exec("SELECT 1 FROM fs_block WHERE path = ? AND n = ?", p, b).toArray().length) continue;
      const s = shardOf(p, b, shards);
      (byShard.get(s) ?? byShard.set(s, []).get(s)!).push([p, b]);
      n++;
    }
    if (n) await this.fetchRemote(byShard, remote);
    return n;
  }

  // -------------------------------------------------------------- shipping (primary mode)

  /** The next things to send to page servers. `hold` rows are older versions kept for a replica
   *  snapshot point. */
  shipBatch(max = 256): ShipBatch | null {
    if (this.mode.kind !== "primary") return null;
    const shards = this.mode.shards;
    const blocks: ShipBatch["blocks"] = [];
    for (const r of this.sql.exec<{ path: string; n: number; seq: number; data: ArrayBuffer | null }>("SELECT s.path, s.n, s.seq, b.data FROM ship s LEFT JOIN fs_block b ON b.path = s.path AND b.n = s.n LIMIT ?", max))
      blocks.push({ shard: shardOf(r.path, r.n, shards), row: [r.path, r.n, r.seq, r.data ?? new ArrayBuffer(0)], hold: false });
    for (const r of this.sql.exec<{ path: string; n: number; seq: number; data: ArrayBuffer }>("SELECT path, n, seq, data FROM ship_hold LIMIT ?", max))
      blocks.push({ shard: shardOf(r.path, r.n, shards), row: [r.path, r.n, r.seq, r.data], hold: true });
    const nodes = this.sql.exec<{ seq: number; path: string; mode: number; size: number; mtime: number; gone: number }>("SELECT seq, path, mode, size, mtime, gone FROM ship_node ORDER BY seq LIMIT 1000").toArray().map((r) => [r.path, r.seq, r.mode, r.size, r.mtime, r.gone] as NodeRow);
    const truncs = this.sql.exec<{ seq: number; path: string; from_n: number }>("SELECT seq, path, from_n FROM ship_trunc ORDER BY seq LIMIT 1000").toArray().map((r) => [r.path, r.seq, r.from_n] as Trunc);
    if (!blocks.length && !nodes.length && !truncs.length) return null;
    return { blocks, nodes, truncs };
  }

  /** Page servers have `b`: drop it from the queues (unless rewritten since) and mark the blocks
   *  evictable. */
  shipped(b: ShipBatch) {
    for (const { row, hold } of b.blocks) {
      const [p, n, seq] = row;
      if (hold) this.sql.exec("DELETE FROM ship_hold WHERE path = ? AND n = ? AND seq = ?", p, n, seq);
      else {
        this.sql.exec("DELETE FROM ship WHERE path = ? AND n = ? AND seq = ?", p, n, seq);
        this.sql.exec("UPDATE fs_block SET shipped = 1 WHERE path = ? AND n = ? AND NOT EXISTS (SELECT 1 FROM ship WHERE path = ? AND n = ?)", p, n, p, n);
      }
    }
    for (const [p, seq] of b.nodes) this.sql.exec("DELETE FROM ship_node WHERE seq = ? AND path = ?", seq, p);
    for (const [p, seq, from] of b.truncs) this.sql.exec("DELETE FROM ship_trunc WHERE seq = ? AND path = ? AND from_n = ?", seq, p, from);
  }

  /** Every flush up to this one is entirely on the page servers. */
  shippedThrough() {
    const q = (t: string) => this.sql.exec<{ s: number | null }>(`SELECT min(seq) AS s FROM ${t}`).toArray()[0]?.s ?? null;
    const pending = [q("ship"), q("ship_hold"), q("ship_node"), q("ship_trunc")].filter((x): x is number => x !== null);
    return pending.length ? Math.min(...pending) - 1 : this.seq;
  }

  /** Free local space: drop relation blocks page servers have (or the template can give back),
   *  in stripes nobody has read since the last pass, until at most `maxBlocks` remain. */
  evict(maxBlocks: number) {
    if (this.mode.kind !== "primary") return 0;
    const count = this.sql.exec<{ c: number }>("SELECT count(*) AS c FROM fs_block").toArray()[0].c;
    let excess = count - maxBlocks, dropped = 0;
    for (let pass = 0; excess > 0 && pass < 2; pass++) {
      const rows = this.sql
        .exec<{ path: string; n: number }>("SELECT path, n FROM fs_block WHERE shipped > 0 AND (path > ? OR (path = ? AND n > ?)) ORDER BY path, n LIMIT 8192", this.evictCursor[0], this.evictCursor[0], this.evictCursor[1])
        .toArray();
      if (!rows.length) {
        this.evictCursor = ["", -1];
        continue;
      }
      for (const { path, n } of rows) {
        this.evictCursor = [path, n];
        if (excess <= 0) break;
        if (!evictable(path) || this.touched.has(`${path}#${Math.floor(n / STRIPE)}`)) continue;
        this.sql.exec("DELETE FROM fs_block WHERE path = ? AND n = ? AND shipped > 0", path, n);
        const k = this.key(path, n), c = this.cache.get(k);
        if (c) (this.cacheBytes -= c.length), this.cache.delete(k);
        excess--;
        dropped++;
      }
    }
    this.touched.clear();
    this.stats.evicted += dropped;
    return dropped;
  }

  private unbase(path: string) {
    if (this.base.delete(path)) this.sql.exec("DELETE FROM fs_base WHERE path = ?", path);
  }

  // -------------------------------------------------------------- storage

  private putNode(path: string, n: Node) {
    this.nodes.set(path, n);
    this.dirtyNodes.add(path);
  }
  private node(path: string) {
    const n = this.nodes.get(norm(path));
    if (!n) fail("ENOENT", path);
    return n!;
  }
  private key(path: string, n: number) {
    return `${path}\0${n}`;
  }
  private block(path: string, n: number): Uint8Array | undefined {
    const k = this.key(path, n);
    const hit = this.cache.get(k) ?? this.dirty.get(k);
    this.stats.reads++;
    if (this.mode.kind === "primary") this.touched.add(`${path}#${Math.floor(n / STRIPE)}`);
    if (hit) {
      this.remember(k, hit);
      return hit;
    }
    this.stats.readMisses++;
    const row = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM fs_block WHERE path = ? AND n = ?", path, n).toArray()[0];
    if (!row) {
      const remote = this.mode.kind === "replica" || (this.mode.kind === "primary" && remoteBacked(path));
      const b = this.base.get(path);
      if ((remote && n * this.bs < (this.nodes.get(path)?.size ?? 0)) || (b && n * this.bs < b.size)) {
        // Not here yet: Postgres gets an I/O error for this statement; the object fetches the
        // block and runs the statement again.
        this.missing.add(k);
        this.stats.faults++;
        throw Object.assign(new Error(`EIO: ${path} block ${n} not fetched yet`), { code: EIO });
      }
      return undefined;
    }
    const b = new Uint8Array(row.data);
    this.remember(k, b);
    return b;
  }
  private remember(k: string, b: Uint8Array) {
    const old = this.cache.get(k);
    if (old) this.cacheBytes -= old.length;
    this.cache.delete(k);
    this.cache.set(k, b);
    this.cacheBytes += b.length;
    if (this.cacheBytes > this.cacheLimit) {
      if (this.dirtyBytes > this.cacheLimit / 2) this.flush();
      for (const [ck, cb] of this.cache) {
        if (this.cacheBytes <= this.cacheLimit * 0.8) break;
        if (ck === k || this.dirty.has(ck)) continue; // dirty blocks stay until flushed (bounded by DIRTY_LIMIT)
        this.cache.delete(ck);
        this.cacheBytes -= cb.length;
      }
    }
  }
  /** Versions a replica snapshot still needs (queued at or before the barrier) are kept before
   *  their block changes or goes. */
  private holdForBarrier(path: string, from = 0, only?: number) {
    if (this.mode.kind !== "primary" || !this.barrier) return;
    if (only !== undefined)
      this.sql.exec("INSERT OR IGNORE INTO ship_hold (path, n, seq, data) SELECT b.path, b.n, s.seq, b.data FROM fs_block b JOIN ship s ON s.path = b.path AND s.n = b.n WHERE b.path = ? AND b.n = ? AND s.seq <= ?", path, only, this.barrier);
    else this.sql.exec("INSERT OR IGNORE INTO ship_hold (path, n, seq, data) SELECT b.path, b.n, s.seq, b.data FROM fs_block b JOIN ship s ON s.path = b.path AND s.n = b.n WHERE b.path = ? AND b.n >= ? AND s.seq <= ?", path, from, this.barrier);
  }
  private dropBlocks(path: string, from = 0) {
    const mine = (k: string) => k.startsWith(`${path}\0`) && Number(k.slice(path.length + 1)) >= from;
    for (const [k, b] of [...this.cache]) if (mine(k)) (this.cacheBytes -= b.length), this.cache.delete(k);
    for (const [k, b] of [...this.dirty]) if (mine(k)) (this.dirtyBytes -= b.length), this.dirty.delete(k);
    if (this.mode.kind === "primary") {
      this.holdForBarrier(path, from);
      this.sql.exec("DELETE FROM ship WHERE path = ? AND n >= ?", path, from);
      this.pendingTruncs.push([path, from]);
    }
    this.sql.exec("DELETE FROM fs_block WHERE path = ? AND n >= ?", path, from);
  }
  private flushNodes(seq?: number) {
    for (const p of this.dirtyNodes) {
      const n = this.nodes.get(p);
      if (n) this.sql.exec("INSERT OR REPLACE INTO fs_node (path, mode, size, mtime) VALUES (?, ?, ?, ?)", p, n.mode, n.size, n.mtime);
      else this.sql.exec("DELETE FROM fs_node WHERE path = ?", p);
      if (seq !== undefined) this.sql.exec("INSERT OR REPLACE INTO ship_node (seq, path, mode, size, mtime, gone) VALUES (?, ?, ?, ?, ?, ?)", seq, p, n?.mode ?? 0, n?.size ?? 0, n?.mtime ?? 0, n ? 0 : 1);
      this.stats.rowsWritten++;
    }
    this.dirtyNodes.clear();
  }

  private markDirty(k: string, b: Uint8Array) {
    const old = this.dirty.get(k);
    this.dirtyBytes += b.length - (old?.length ?? 0);
    this.dirty.set(k, b);
    if (this.dirtyBytes > DIRTY_LIMIT) this.flush();
  }

  /** Write dirty blocks and metadata to SQLite (one numbered step of the disk, in primary mode,
   *  queued for the page servers). */
  flush() {
    if (!this.dirty.size && !this.dirtyNodes.size && !this.pendingTruncs.length && !this.reship.length) return;
    this.stats.flushes++;
    const primary = this.mode.kind === "primary";
    const seq = primary ? ++this.seq : undefined;
    if (primary) for (const [p, from] of this.pendingTruncs.splice(0)) this.sql.exec("INSERT OR IGNORE INTO ship_trunc (seq, path, from_n) VALUES (?, ?, ?)", seq, p, from);
    for (const [k, b] of this.dirty) {
      const i = k.indexOf("\0"), p = k.slice(0, i), n = Number(k.slice(i + 1));
      if (primary) this.holdForBarrier(p, 0, n);
      this.sql.exec("INSERT OR REPLACE INTO fs_block (path, n, data, shipped) VALUES (?, ?, ?, 0)", p, n, b);
      if (primary) this.sql.exec("INSERT OR REPLACE INTO ship (path, n, seq) VALUES (?, ?, ?)", p, n, seq);
      this.stats.rowsWritten++;
    }
    if (primary) for (const p of this.reship.splice(0)) this.sql.exec("INSERT OR REPLACE INTO ship (path, n, seq) SELECT path, n, ? FROM fs_block WHERE path = ?", seq, p);
    this.dirty.clear();
    this.dirtyBytes = 0;
    this.flushNodes(seq);
    if (primary) this.setMeta("seq", seq!);
  }

  override async syncToFs() {
    this.flush();
  }
  override async closeFs() {
    this.flush();
  }

  // -------------------------------------------------------------- the filesystem

  chmod(path: string, mode: number) {
    const n = this.node(path);
    this.putNode(norm(path), { ...n, mode: (n.mode & ~0o7777) | (mode & 0o7777) });
  }
  close(fd: number) {
    if (!this.fds.delete(fd)) fail("EBADF", String(fd));
  }
  private stat(path: string, n: Node): FsStats {
    return { dev: 0, ino: 0, mode: n.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size: n.size, blksize: 4096, blocks: Math.ceil(n.size / 4096), atime: n.mtime, mtime: n.mtime, ctime: n.mtime };
  }
  fstat(fd: number) {
    const p = this.fds.get(fd) ?? fail("EBADF", String(fd));
    return this.stat(p, this.node(p));
  }
  lstat(path: string) {
    return this.stat(path, this.node(path));
  }
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }) {
    const p = norm(path);
    if (this.nodes.has(p)) {
      if (options?.recursive) return;
      fail("EEXIST", p);
    }
    const up = parent(p);
    if (!this.nodes.has(up)) {
      if (!options?.recursive) fail("ENOENT", up);
      this.mkdir(up, options);
    }
    this.putNode(p, { mode: S_IFDIR | ((options?.mode ?? 0o700) & 0o7777), size: 0, mtime: Date.now() });
  }
  open(path: string, _flags?: string, _mode?: number) {
    const p = norm(path);
    const n = this.node(p);
    if ((n.mode & S_IFDIR) === S_IFDIR) fail("EISDIR", p);
    const fd = this.nextFd++;
    this.fds.set(fd, p);
    return fd;
  }
  readdir(path: string) {
    const p = norm(path);
    const n = this.node(p);
    if ((n.mode & S_IFDIR) !== S_IFDIR) fail("ENOTDIR", p);
    const pre = p === "/" ? "/" : `${p}/`;
    const out: string[] = [];
    for (const k of this.nodes.keys()) if (k !== p && k.startsWith(pre) && !k.slice(pre.length).includes("/")) out.push(k.slice(pre.length));
    return out;
  }
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number) {
    const p = this.fds.get(fd) ?? fail("EBADF", String(fd));
    const n = this.node(p);
    const end = Math.min(n.size, position + length);
    let done = 0;
    for (let pos = position; pos < end; ) {
      const bn = Math.floor(pos / this.bs), bo = pos % this.bs, take = Math.min(this.bs - bo, end - pos);
      const b = this.block(p, bn);
      const dst = buffer.subarray(offset + done, offset + done + take);
      if (b && bo < b.length) {
        const have = Math.min(take, b.length - bo);
        dst.set(b.subarray(bo, bo + have));
        if (have < take) dst.fill(0, have);
      } else dst.fill(0);
      done += take;
      pos += take;
    }
    return done;
  }
  rename(oldPath: string, newPath: string) {
    const a = norm(oldPath), b = norm(newPath);
    const n = this.node(a);
    if (this.nodes.has(b)) this.unlink(b);
    this.flush(); // so the moved blocks are all in SQLite
    if (this.mode.kind === "primary") {
      // page servers see a rename as the old file truncated away and the new one written whole
      // (only files kept entirely here are renamed: WAL segments, control and map files)
      this.holdForBarrier(a);
      this.sql.exec("DELETE FROM ship WHERE path = ?", a);
      this.pendingTruncs.push([a, 0]);
      this.reship.push(b);
    }
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${a}\0`)) (this.cacheBytes -= this.cache.get(k)!.length), this.cache.delete(k);
    this.sql.exec("UPDATE fs_block SET path = ? WHERE path = ?", b, a);
    const ba = this.base.get(a);
    if (ba) {
      this.unbase(a);
      this.base.set(b, ba);
      this.sql.exec("INSERT OR REPLACE INTO fs_base (path, off, size) VALUES (?, ?, ?)", b, ba.off, ba.size);
    }
    if ((n.mode & S_IFDIR) === S_IFDIR) {
      for (const [k, v] of [...this.nodes]) if (k.startsWith(`${a}/`)) {
        const nk = b + k.slice(a.length);
        this.nodes.delete(k);
        this.dirtyNodes.add(k);
        this.putNode(nk, v);
        this.sql.exec("UPDATE fs_block SET path = ? WHERE path = ?", nk, k);
        if (this.mode.kind === "primary") {
          this.pendingTruncs.push([k, 0]);
          this.reship.push(nk);
        }
      }
    }
    this.nodes.delete(a);
    this.dirtyNodes.add(a);
    this.putNode(b, n);
  }
  rmdir(path: string) {
    const p = norm(path);
    if (this.readdir(p).length) fail("ENOTEMPTY", p);
    this.nodes.delete(p);
    this.dirtyNodes.add(p);
  }
  truncate(path: string, len: number) {
    const p = norm(path);
    const n = this.node(p);
    const keep = Math.ceil(len / this.bs);
    const bb = this.base.get(p);
    if (bb && len === 0) this.unbase(p);
    else if (bb && len < bb.size) {
      this.base.set(p, { ...bb, size: len });
      this.sql.exec("UPDATE fs_base SET size = ? WHERE path = ?", len, p);
    }
    if (len < n.size) {
      if (len % this.bs && keep > 0) {
        const last = this.block(p, keep - 1);
        if (last && last.length > len % this.bs) {
          const t = last.slice(0, len % this.bs);
          this.remember(this.key(p, keep - 1), t);
          this.markDirty(this.key(p, keep - 1), t);
        }
      }
      this.dropBlocks(p, keep);
    }
    this.putNode(p, { ...n, size: len, mtime: Date.now() });
  }
  unlink(path: string) {
    const p = norm(path);
    const n = this.node(p);
    if ((n.mode & S_IFDIR) === S_IFDIR) fail("EISDIR", p);
    this.dropBlocks(p, 0);
    this.unbase(p);
    this.nodes.delete(p);
    this.dirtyNodes.add(p);
  }
  utimes(path: string, _atime: number, mtime: number) {
    const n = this.node(path);
    this.putNode(norm(path), { ...n, mtime });
  }
  writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; mode?: number; flag?: string }) {
    const p = norm(path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (!this.nodes.has(parent(p))) fail("ENOENT", parent(p));
    if (this.nodes.has(p)) this.dropBlocks(p, 0);
    this.unbase(p);
    this.putNode(p, { mode: S_IFREG | ((options?.mode ?? 0o600) & 0o7777), size: 0, mtime: Date.now() });
    if (bytes.length) {
      const fd = this.open(p);
      this.write(fd, bytes, 0, bytes.length, 0);
      this.close(fd);
    }
  }
  write(fd: number, buffer: Uint8Array | ArrayBuffer, offset: number, length: number, position: number) {
    const p = this.fds.get(fd) ?? fail("EBADF", String(fd));
    const n = this.node(p);
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let done = 0;
    while (done < length) {
      const pos = position + done, bn = Math.floor(pos / this.bs), bo = pos % this.bs, take = Math.min(this.bs - bo, length - done);
      const k = this.key(p, bn);
      let b: Uint8Array;
      if (bo === 0 && take === this.bs) b = src.slice(offset + done, offset + done + take); // a whole block: no need to read the old one
      else {
        b = this.block(p, bn) ?? new Uint8Array(0);
        if (b.length < bo + take) {
          const grown = new Uint8Array(Math.min(this.bs, bo + take));
          grown.set(b);
          b = grown;
        } else if (!this.dirty.has(k)) b = b.slice(); // don't mutate a buffer SQLite handed us
        b.set(src.subarray(offset + done, offset + done + take), bo);
      }
      this.remember(k, b);
      this.markDirty(k, b);
      done += take;
    }
    const size = Math.max(n.size, position + length);
    this.putNode(p, { ...n, size, mtime: Date.now() });
    return length;
  }
}
