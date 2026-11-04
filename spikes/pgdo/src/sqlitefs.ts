// PGDATA in the Durable Object's SQLite: a synchronous filesystem for PGlite.
//
// Files are rows of 64 KiB blocks (the last one only as long as the file needs). Blocks are read
// through an in-memory LRU cache; writes dirty the cached block and are flushed to SQLite in one
// transaction when PGlite syncs (after every query, unless relaxedDurability). So a transaction's
// page writes become a handful of row writes, durable before the object replies.
import { BaseFilesystem, ERRNO_CODES, type FsStats } from "@electric-sql/pglite/basefs";

const BLOCK = 64 * 1024;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

type Node = { mode: number; size: number; mtime: number };

const fail = (code: keyof typeof ERRNO_CODES, what: string): never => {
  throw Object.assign(new Error(`${code}: ${what}`), { code: ERRNO_CODES[code] });
};
const norm = (p: string) => (p === "" || p === "/" ? "/" : p.startsWith("/") ? p : `/${p}`);
const parent = (p: string) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");

export interface FsStatsSnapshot {
  nodes: number;
  cachedBlocks: number;
  cachedMB: number;
  dirty: number;
  reads: number;
  readMisses: number;
  rowsWritten: number;
  flushes: number;
}

export class SqliteFS extends BaseFilesystem {
  private nodes = new Map<string, Node>();
  private dirtyNodes = new Set<string>();
  private cache = new Map<string, Uint8Array>(); // `${path}\0${n}` → block, in LRU order
  private dirty = new Set<string>();
  private cacheBytes = 0;
  private fds = new Map<number, string>();
  private nextFd = 3;
  readonly stats = { reads: 0, readMisses: 0, rowsWritten: 0, flushes: 0 };

  constructor(private sql: SqlStorage, private cacheLimit = 24 * 1024 * 1024, debug = false) {
    super(undefined, { debug });
    sql.exec("CREATE TABLE IF NOT EXISTS fs_node (path TEXT PRIMARY KEY, mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL) WITHOUT ROWID");
    sql.exec("CREATE TABLE IF NOT EXISTS fs_block (path TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, n)) WITHOUT ROWID");
    for (const r of sql.exec<{ path: string; mode: number; size: number; mtime: number }>("SELECT path, mode, size, mtime FROM fs_node")) this.nodes.set(r.path, { mode: r.mode, size: r.size, mtime: r.mtime });
    if (!this.nodes.has("/")) this.putNode("/", { mode: S_IFDIR | 0o700, size: 0, mtime: Date.now() });
  }

  get empty() {
    return this.nodes.size <= 1;
  }

  snapshot(): FsStatsSnapshot {
    return { nodes: this.nodes.size, cachedBlocks: this.cache.size, cachedMB: +(this.cacheBytes / 1e6).toFixed(1), dirty: this.dirty.size, ...this.stats };
  }

  /** Load a tarball (an initdb'd PGDATA, paths relative to it) straight into the tables. */
  loadTar(tar: Uint8Array) {
    const dec = new TextDecoder();
    const str = (o: number, n: number) => dec.decode(tar.subarray(o, o + n)).replace(/\0.*$/s, "");
    const oct = (o: number, n: number) => parseInt(str(o, n).trim() || "0", 8);
    let off = 0, files = 0, longName: string | null = null;
    this.sql.exec("DELETE FROM fs_block");
    this.sql.exec("DELETE FROM fs_node");
    this.nodes.clear();
    this.putNode("/", { mode: S_IFDIR | 0o700, size: 0, mtime: Date.now() });
    while (off + 512 <= tar.length) {
      const name0 = str(off, 100);
      if (!name0) break;
      const size = oct(off + 124, 12), type = String.fromCharCode(tar[off + 156] || 48), prefix = str(off + 345, 155);
      const mode = oct(off + 100, 8) & 0o7777, mtime = oct(off + 136, 12) * 1000;
      const body = off + 512;
      let name = longName ?? (prefix ? `${prefix}/${name0}` : name0);
      longName = null;
      if (type === "L") longName = str(body, size);
      else if (type === "x") {
        const m = dec.decode(tar.subarray(body, body + size)).match(/\d+ path=([^\n]*)\n/);
        if (m) longName = m[1];
      } else {
        const path = norm(name.replace(/^\.\//, "").replace(/\/$/, ""));
        if (type === "5") this.putNode(path, { mode: S_IFDIR | (mode || 0o700), size: 0, mtime });
        else if (type === "0" || type === "\0") {
          this.putNode(path, { mode: S_IFREG | (mode || 0o600), size, mtime });
          for (let n = 0; n * BLOCK < size; n++) this.sql.exec("INSERT INTO fs_block (path, n, data) VALUES (?, ?, ?)", path, n, tar.subarray(body + n * BLOCK, body + Math.min(size, (n + 1) * BLOCK)));
          files++;
        }
      }
      off = body + Math.ceil(size / 512) * 512;
    }
    this.flushNodes();
    return files;
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
    const hit = this.cache.get(k);
    this.stats.reads++;
    if (hit) {
      this.cache.delete(k);
      this.cache.set(k, hit);
      return hit;
    }
    this.stats.readMisses++;
    const row = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM fs_block WHERE path = ? AND n = ?", path, n).toArray()[0];
    if (!row) return undefined;
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
      for (const [ck, cb] of this.cache) {
        if (this.cacheBytes <= this.cacheLimit * 0.8) break;
        if (this.dirty.has(ck)) continue; // dirty blocks stay until flushed
        this.cache.delete(ck);
        this.cacheBytes -= cb.length;
      }
    }
  }
  private dropBlocks(path: string, from = 0) {
    for (const k of [...this.cache.keys()]) {
      if (!k.startsWith(`${path}\0`)) continue;
      if (Number(k.slice(path.length + 1)) < from) continue;
      this.cacheBytes -= this.cache.get(k)!.length;
      this.cache.delete(k);
      this.dirty.delete(k);
    }
    this.sql.exec("DELETE FROM fs_block WHERE path = ? AND n >= ?", path, from);
  }
  private flushNodes() {
    for (const p of this.dirtyNodes) {
      const n = this.nodes.get(p);
      if (n) this.sql.exec("INSERT OR REPLACE INTO fs_node (path, mode, size, mtime) VALUES (?, ?, ?, ?)", p, n.mode, n.size, n.mtime);
      else this.sql.exec("DELETE FROM fs_node WHERE path = ?", p);
      this.stats.rowsWritten++;
    }
    this.dirtyNodes.clear();
  }

  /** Write dirty blocks and metadata to SQLite. */
  flush() {
    if (!this.dirty.size && !this.dirtyNodes.size) return;
    this.stats.flushes++;
    for (const k of this.dirty) {
      const b = this.cache.get(k);
      if (!b) continue;
      const i = k.indexOf("\0");
      this.sql.exec("INSERT OR REPLACE INTO fs_block (path, n, data) VALUES (?, ?, ?)", k.slice(0, i), Number(k.slice(i + 1)), b);
      this.stats.rowsWritten++;
    }
    this.dirty.clear();
    this.flushNodes();
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
      const bn = Math.floor(pos / BLOCK), bo = pos % BLOCK, take = Math.min(BLOCK - bo, end - pos);
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
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${a}\0`)) (this.cacheBytes -= this.cache.get(k)!.length), this.cache.delete(k);
    this.sql.exec("UPDATE fs_block SET path = ? WHERE path = ?", b, a);
    if ((n.mode & S_IFDIR) === S_IFDIR) {
      for (const [k, v] of [...this.nodes]) if (k.startsWith(`${a}/`)) {
        const nk = b + k.slice(a.length);
        this.nodes.delete(k);
        this.dirtyNodes.add(k);
        this.putNode(nk, v);
        this.sql.exec("UPDATE fs_block SET path = ? WHERE path = ?", nk, k);
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
    const keep = Math.ceil(len / BLOCK);
    this.dropBlocks(p, keep);
    if (len % BLOCK && keep > 0) {
      const last = this.block(p, keep - 1);
      if (last && last.length > len % BLOCK) {
        const t = last.slice(0, len % BLOCK);
        this.remember(this.key(p, keep - 1), t);
        this.dirty.add(this.key(p, keep - 1));
      }
    }
    this.putNode(p, { ...n, size: len, mtime: Date.now() });
  }
  unlink(path: string) {
    const p = norm(path);
    const n = this.node(p);
    if ((n.mode & S_IFDIR) === S_IFDIR) fail("EISDIR", p);
    this.dropBlocks(p, 0);
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
    this.dropBlocks(p, 0);
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
      const pos = position + done, bn = Math.floor(pos / BLOCK), bo = pos % BLOCK, take = Math.min(BLOCK - bo, length - done);
      const k = this.key(p, bn);
      let b = this.block(p, bn) ?? new Uint8Array(0);
      if (b.length < bo + take) {
        const grown = new Uint8Array(Math.min(BLOCK, bo + take));
        grown.set(b);
        b = grown;
      } else if (!this.dirty.has(k)) b = b.slice(); // don't mutate a buffer SQLite handed us
      b.set(src.subarray(offset + done, offset + done + take), bo);
      this.remember(k, b);
      this.dirty.add(k);
      done += take;
    }
    const size = Math.max(n.size, position + length);
    this.putNode(p, { ...n, size, mtime: Date.now() });
    return length;
  }
}
