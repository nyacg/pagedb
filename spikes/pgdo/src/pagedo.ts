// A page server: one shard of a database's disk, held for a primary that runs Postgres elsewhere.
//
// Everything is versioned by the primary's flush sequence number (`seq`: each flush of its
// SQLite is one atomic step of its disk). A read "at S" returns the newest version with seq ≤ S,
// so the shards together reconstruct the primary's disk exactly as of any flush S that's still
// retained: the primary reads at the latest, a replica at the epoch it booted from.
//
//   blk(path, n, seq, data)    file blocks (8 KiB), several versions per block
//   trunc(path, seq, from_n)   truncations: blocks n ≥ from_n older than seq are gone
//   node(path, seq, …, gone)   file metadata (shard 0 only): size, mode, existence
//   epoch(seq, at)             replica snapshot points the primary has fully shipped (shard 0)
//   lease(name, seq, until)    epochs replicas are reading from, which pins old versions (shard 0)
import { DurableObject } from "cloudflare:workers";

export type Block = [path: string, n: number, seq: number, data: ArrayBuffer | Uint8Array];
export type Trunc = [path: string, seq: number, from: number];
export type NodeRow = [path: string, seq: number, mode: number, size: number, mtime: number, gone: number];
export interface PutBatch {
  blocks: Block[];
  truncs: Trunc[];
  nodes: NodeRow[];
  /** Versions newer than the newest one at or before `keep` must stay (the oldest live epoch). */
  keep: number;
}

export class PgPage extends DurableObject {
  private sql = this.ctx.storage.sql;
  private coloCache?: string;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS blk (path TEXT NOT NULL, n INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, n, seq)) WITHOUT ROWID");
    this.sql.exec("CREATE TABLE IF NOT EXISTS trunc (path TEXT NOT NULL, seq INTEGER NOT NULL, from_n INTEGER NOT NULL, PRIMARY KEY (path, seq, from_n)) WITHOUT ROWID");
    this.sql.exec("CREATE TABLE IF NOT EXISTS node (path TEXT NOT NULL, seq INTEGER NOT NULL, mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, gone INTEGER NOT NULL, PRIMARY KEY (path, seq)) WITHOUT ROWID");
    this.sql.exec("CREATE TABLE IF NOT EXISTS epoch (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS lease (name TEXT PRIMARY KEY, seq INTEGER NOT NULL, until INTEGER NOT NULL)");
  }

  /** Store a batch from the primary. Idempotent (a retried batch changes nothing), and durable
   *  before the reply (the output gate holds it until SQLite has it). */
  put(b: PutBatch) {
    const touched = new Set<string>();
    for (const [path, n, seq, data] of b.blocks) {
      this.sql.exec("INSERT OR IGNORE INTO blk (path, n, seq, data) VALUES (?, ?, ?, ?)", path, n, seq, data);
      touched.add(`${path}\0${n}`);
    }
    for (const [path, seq, from] of b.truncs) this.sql.exec("INSERT OR IGNORE INTO trunc (path, seq, from_n) VALUES (?, ?, ?)", path, seq, from);
    for (const [path, seq, mode, size, mtime, gone] of b.nodes) this.sql.exec("INSERT OR IGNORE INTO node (path, seq, mode, size, mtime, gone) VALUES (?, ?, ?, ?, ?, ?)", path, seq, mode, size, mtime, gone);
    // Old versions nobody can read any more: below the newest one at or before `keep`.
    for (const k of touched) {
      const i = k.indexOf("\0"), path = k.slice(0, i), n = Number(k.slice(i + 1));
      this.sql.exec("DELETE FROM blk WHERE path = ? AND n = ? AND seq < (SELECT max(seq) FROM blk WHERE path = ? AND n = ? AND seq <= ?)", path, n, path, n, b.keep);
    }
    for (const path of new Set(b.nodes.map((r) => r[0]))) this.sql.exec("DELETE FROM node WHERE path = ? AND seq < (SELECT max(seq) FROM node WHERE path = ? AND seq <= ?)", path, path, b.keep);
    return { blocks: b.blocks.length };
  }

  /** Blocks as of `at`: the newest version with seq ≤ at, unless a truncation since removed it.
   *  `null` data: the block doesn't exist here (never written, or truncated away). */
  get(keys: [path: string, n: number][], at: number) {
    const out: [string, number, ArrayBuffer | null][] = [];
    for (const [path, n] of keys) {
      const v = this.sql.exec<{ seq: number; data: ArrayBuffer }>("SELECT seq, data FROM blk WHERE path = ? AND n = ? AND seq <= ? ORDER BY seq DESC LIMIT 1", path, n, at).toArray()[0];
      if (!v) {
        out.push([path, n, null]);
        continue;
      }
      const t = this.sql.exec<{ s: number | null }>("SELECT max(seq) AS s FROM trunc WHERE path = ? AND from_n <= ? AND seq <= ? AND seq > ?", path, n, at, v.seq).toArray()[0];
      out.push([path, n, t?.s ? null : v.data]);
    }
    return out;
  }

  /** Every file as of `at` (shard 0): the newest metadata version of each path, live ones only. */
  nodes(at: number) {
    return this.sql
      .exec<{ path: string; mode: number; size: number; mtime: number; gone: number }>(
        "SELECT n.path, n.mode, n.size, n.mtime, n.gone FROM node n JOIN (SELECT path, max(seq) AS s FROM node WHERE seq <= ? GROUP BY path) m ON n.path = m.path AND n.seq = m.s",
        at,
      )
      .toArray()
      .filter((r) => !r.gone)
      .map((r) => [r.path, r.mode, r.size, r.mtime] as [string, number, number, number]);
  }

  // ---------------------------------------------------------------- epochs and leases (shard 0)

  /** The primary: everything through flush `seq` is now on the shards, usable as a snapshot. */
  epoch(seq: number) {
    this.sql.exec("INSERT OR IGNORE INTO epoch (seq, at) VALUES (?, ?)", seq, Date.now());
    this.sql.exec("DELETE FROM epoch WHERE seq < (SELECT min(seq) FROM (SELECT seq FROM epoch ORDER BY seq DESC LIMIT 20))");
    return seq;
  }

  latestEpoch(): { seq: number; at: number } | null {
    return this.sql.exec<{ seq: number; at: number }>("SELECT seq, at FROM epoch ORDER BY seq DESC LIMIT 1").toArray()[0] ?? null;
  }

  /** A replica reads at `seq` until `until`: versions it needs stay. */
  lease(name: string, seq: number, ms: number) {
    this.sql.exec("INSERT OR REPLACE INTO lease (name, seq, until) VALUES (?, ?, ?)", name, seq, Date.now() + ms);
  }

  release(name: string) {
    this.sql.exec("DELETE FROM lease WHERE name = ?", name);
  }

  /** A replica takes the latest epoch and a lease on it in one step, so nothing it needs can be
   *  pruned between the two. */
  acquire(name: string, ms: number): number | null {
    const e = this.latestEpoch();
    if (!e) return null;
    this.lease(name, e.seq, ms);
    return e.seq;
  }

  /** What the primary must keep: everything a lease reads, and the last two epochs (a replica
   *  booting now takes the newest; the one before covers a lease that's just being made). */
  keepFloor(): number {
    const leased = this.minLease();
    const epochs = this.sql.exec<{ seq: number }>("SELECT seq FROM epoch ORDER BY seq DESC LIMIT 2").toArray().map((r) => r.seq);
    const floor = epochs.length ? epochs[epochs.length - 1] : 0; // 0: no epochs yet, keep everything
    return leased === null ? floor : Math.min(leased, floor);
  }

  /** The oldest epoch still being read (or null: nobody reads old versions). */
  minLease(): number | null {
    this.sql.exec("DELETE FROM lease WHERE until < ?", Date.now());
    return this.sql.exec<{ s: number | null }>("SELECT min(seq) AS s FROM lease").toArray()[0]?.s ?? null;
  }

  stats() {
    const one = (q: string) => this.sql.exec<{ c: number }>(q).toArray()[0]?.c ?? 0;
    return { blocks: one("SELECT count(*) AS c FROM blk"), truncs: one("SELECT count(*) AS c FROM trunc"), nodes: one("SELECT count(*) AS c FROM node"), sqliteMB: +(this.sql.databaseSize / 1e6).toFixed(1) };
  }

  /** Restart this page server (crash testing): memory is gone, SQLite stays. */
  evict() {
    this.ctx.abort("evict");
  }

  async colo() {
    if (this.coloCache) return this.coloCache;
    const t = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
    return (this.coloCache = t.match(/colo=(\w+)/)?.[1]);
  }
}
