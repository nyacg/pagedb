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
import { SqliteFS, type ImageIndex, type ShipBatch } from "./sqlitefs";
import { PgPage, type PutBatch } from "./pagedo";
import { scanWal } from "./walscan";
import { SMALL_SHMEM, START } from "./pgconfig";
import { CHECKS, runCheck } from "./compat";
import { Gate, lastStatus, WireConn, type WireHost } from "./wire";
import { bench as pgbench, initStatements, WireClient } from "./tpcb";
import { explain, load, neonTarget, run as runOps, SETUP, type Stmt, type Target } from "./bench";

/** Template images (scripts/mkimage.mjs): pgspike/img/<name>.json (the index) and .blob (PGDATA). */
const IMG = (name: string) => `pgspike/img/${name}`;

/** Objects of one class can share an isolate (and its 128 MB): which isolate, and who's in it. */
let isolate: string | undefined; // named on first use (no randomness at global scope)
const running = new Set<PgObject>();

export { PgPage };

interface Env { PG: DurableObjectNamespace<PgObject>; BIG: DurableObjectNamespace<PgObject>; PAGE: DurableObjectNamespace<PgPage>; REPA: DurableObjectNamespace<PgObject>; REPB: DurableObjectNamespace<PgObject>; [k: `PG${number}`]: DurableObjectNamespace<PgObject>; BUCKET: R2Bucket; NEON_DATABASE_URL: string; PGDO_TOKEN: string }

/** An object name in `ns` whose object runs in `colo`: Durable Objects can't be placed in a
 *  chosen data center, so try names until one lands there (placement sticks to the name). */
export async function nearby(ns: DurableObjectNamespace<PgObject> | DurableObjectNamespace<PgPage>, prefix: string, colo: string | undefined, tries = 12) {
  let best = `${prefix}-0`;
  for (let i = 0; i < tries; i++) {
    const name = `${prefix}-${i}`;
    if ((await (ns as DurableObjectNamespace<PgPage>).getByName(name).colo()) === colo) return name;
  }
  return best;
}

/** A primary's housekeeping cadence: snapshot points for replicas, eviction, shipping. */
const TICK_MS = 5_000;
/** A primary checkpoints at least this often while it's being written to, so crash recovery (and
 *  a replica's boot) replays little WAL. */
const CHECKPOINT_MS = 30_000;
/** Local SQLite budget for a primary's cached pages (blocks of 8 KiB), unless configured. */
const LOCAL_BLOCKS = (6 * 1024 * 1024 * 1024) / 8192;

/** Replicas: how long a lease on an epoch lasts (renewed while in use), how stale a replica may
 *  get before a fresh one takes over, and how long an old one serves its connections after. */
const LEASE_MS = 60_000;
const REFRESH_MS = 30_000;
const DRAIN_MS = 60_000;

type ReplicaInfo = { primary: string; slot: number; gen: number };

/** Postgres is closed in an object nobody has used for this long (the object, and its storage, stay). */
const IDLE_MS = 60_000;

/** A database's object: big databases ("big-…") get their own class, so they never share an
 *  isolate with densely packed tenants. */
export function dbStub(env: Env, name: string) {
  return (name.startsWith("big-") ? env.BIG : env.PG).getByName(name);
}

/** Constant-time comparison of a presented secret with the expected one. */
export async function sameSecret(given: string | null | undefined, expected: string | undefined) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export class PgObject extends DurableObject<Env> {
  /** Ceiling for the wasm heap (MB): past it a statement gets "out of memory" instead of taking
   *  the isolate down. Tenants share isolates 2–5 to one (128 MB), so theirs is small. */
  protected maxMB = 48;
  pg?: PGlite;
  private lastUse = Date.now();
  private faultRounds = 0;
  private alarmAt = 0;
  private fs?: SqliteFS;
  private started?: { templateMs?: number; files?: number };
  private readonly instance = crypto.randomUUID().slice(0, 8);

  /** Start Postgres: a new database is a branch of a template image (default "base", empty).
   *  One boot at a time: concurrent callers (a request, the alarm) share it, so there's only ever
   *  one filesystem object and one Postgres. */
  private booting?: Promise<unknown>;
  private ensure(image?: string): Promise<unknown> {
    if (this.pg) return Promise.resolve(undefined);
    return (this.booting ??= this.boot0(image).finally(() => (this.booting = undefined)));
  }

  /** A replica's epoch (it reads the primary's disk as of this flush). */
  private replicaAt?: { shards: number; at: number };

  private makeFs(conf: { cacheMB?: number }) {
    const fs = new SqliteFS(this.ctx.storage.sql, (conf.cacheMB ?? 4) * 1024 * 1024);
    if (this.replicaAt) fs.setReplica(this.replicaAt.shards, this.replicaAt.at);
    return fs;
  }

  private async boot0(image?: string) {
    // Memory knobs (per database, for experiments): /config?db=…&cacheMB=1&sharedBuffers=2MB
    const conf = this.ctx.storage.kv.get<{ cacheMB?: number; sharedBuffers?: string }>("conf") ?? {};
    const fs = (this.fs = this.makeFs(conf));
    const st: { image?: string; branchMs?: number; files?: number; lazy?: number; eagerMB?: number; restored?: number; recoveryBlocks?: number; bootRetries?: number; wal?: unknown; epoch?: number } = {};
    const replica = this.ctx.storage.kv.get<ReplicaInfo>("replica");
    if (replica) {
      // A replica: the primary's disk as of its newest epoch, leased so it stays readable.
      const at = await this.page(0).acquire(this.ctx.id.name!, LEASE_MS);
      if (at === null) throw new Error("the primary has no epoch yet");
      const files = (await this.page(0).nodes(at)) as [string, number, number, number][];
      fs.initReplica(this.ctx.storage.kv.get<string[]>("pages")!.length, at, files);
      this.replicaAt = { shards: fs.shards, at };
      this.ctx.storage.kv.put("pgdb", replica.primary); // the primary's disk already has its name
      st.epoch = at;
    } else if (fs.empty) {
      const t0 = Date.now();
      const name = image ?? "base";
      const index = (await (await this.env.BUCKET.get(`${IMG(name)}.json`))!.json()) as ImageIndex;
      const eager = new Uint8Array(await (await this.env.BUCKET.get(`${IMG(name)}.blob`, { range: { offset: 0, length: index.eagerEnd } }))!.arrayBuffer());
      const shards = this.ctx.storage.kv.get<string[]>("pages")?.length;
      const r = this.ctx.storage.transactionSync(() => {
        const r = fs.initFromImage(index, eager);
        if (shards) fs.enablePrimary(shards); // the disk lives on page servers from here on
        return r;
      });
      this.ctx.storage.kv.put("image", name);
      Object.assign(st, { image: name, ...r, eagerMB: +(eager.length / 1e6).toFixed(1), branchMs: Date.now() - t0 });
    }
    // A primary (or replica) may be missing blocks Postgres reads before anyone can retry it:
    // catalogs and control files, and whatever crash recovery will replay WAL onto.
    const remote = async (shard: number, keys: [string, number][], at: number) => (await this.page(shard).get(keys, at)) as [string, number, ArrayBuffer | null][];
    if (fs.kind !== "local") {
      st.restored = await fs.restoreLocal(remote);
      let wal: ReturnType<typeof scanWal> = null;
      try {
        wal = scanWal((p) => fs.readLocal(p));
      } catch (e) {
        console.log("walscan:", String((e as Error)?.message ?? e));
      }
      if (wal) {
        st.recoveryBlocks = await fs.ensureBlocks(wal.blocks, remote);
        st.wal = { records: wal.records, blocks: wal.blocks.size, redo: wal.redo.toString(16), end: wal.end.toString(16) };
      }
    }
    // The database inside is called what clients connect to (current_database(), information_schema):
    // the first boot renames the image's "postgres" from template1, then reconnects.
    const want = replica?.primary ?? (this.ctx.id.name && this.ctx.id.name.length < 64 ? this.ctx.id.name : "postgres");
    const have = this.ctx.storage.kv.get<string>("pgdb") ?? "postgres";
    if (have !== want) {
      const pg = await this.boot(fs, conf, "template1");
      await pg.exec(`ALTER DATABASE "${have.replace(/"/g, '""')}" RENAME TO "${want.replace(/"/g, '""')}"`);
      await pg.close();
      this.ctx.storage.kv.put("pgdb", want);
      this.fs = this.makeFs(conf);
    }
    // PGlite is one process: a lock file left behind is never a live postmaster's.
    this.fs!.removeIfExists("/postmaster.pid");
    // If recovery still reads a block that isn't here, fetch it and boot again.
    for (let attempt = 0; ; attempt++) {
      try {
        this.pg = await this.boot(this.fs!, conf, want);
        break;
      } catch (e) {
        if (!this.fs!.missing.size || attempt >= 3) {
          throw Object.assign(new Error(`${(e as Error).message} [boot ${JSON.stringify(st)}; still missing: ${[...this.fs!.missing].slice(0, 6).join(", ").replace(/\0/g, "#")}]`), { cause: e });
        }
        st.bootRetries = attempt + 1;
        await this.fs!.fetchMissing(async () => new ArrayBuffer(0), remote);
        this.fs = this.makeFs(conf);
        this.fs.removeIfExists("/postmaster.pid");
      }
    }
    running.add(this);
    this.writeExtraFiles();
    return st;
  }

  /** Postgres's recent stderr (startup failures say why here). */
  private stderr: string[] = [];

  private async boot(fs: SqliteFS, conf: { sharedBuffers?: string; maxMB?: number }, database: string) {
    (globalThis as { __pgMaxPages?: number }).__pgMaxPages = (conf.maxMB ?? this.maxMB) * 16; // 64 KiB pages
    this.stderr = [];
    try {
      return await this.boot1(fs, conf, database);
    } catch (e) {
      throw Object.assign(new Error(`${(e as Error).message}: ${this.stderr.slice(-6).join(" | ").slice(0, 1500)}`), { cause: e });
    }
  }

  private boot1(fs: SqliteFS, conf: { sharedBuffers?: string; maxMB?: number }, database: string) {
    return PGlite.create({
      onStderr: (t: string) => {
        this.stderr.push(t.trim());
        if (this.stderr.length > 50) this.stderr.shift();
        return true;
      },
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
      startParams: [...START, ...(this.replicaAt ? ["-c", "default_transaction_read_only=on"] : []), "-c", `shared_buffers=${conf.sharedBuffers ?? "4MB"}`, "-c", "wal_buffers=64kB", "-c", "work_mem=4MB", "-c", "maintenance_work_mem=8MB", "-c", "temp_file_limit=2GB", ...SMALL_SHMEM],
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
      exec: (bytes, idle, parsed) => (this.used(), this.execRaw(bytes, idle, parsed)),
      retry: (f, inTx) => this.retryQuery(f, inTx),
      readOnly: !!this.ctx.storage.kv.get("replica"),
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

  /** Raw protocol messages. A read can miss a page that isn't here yet (a template image, or
   *  another object); the statement then fails, the pages are fetched and it runs again:
   *  - a batch that started outside a transaction block is rolled back and rerun whole;
   *  - inside one, each batch runs under a savepoint, so only it is rolled back and rerun, and the
   *    transaction carries on (if the miss ended the transaction, e.g. in COMMIT, it can't be).
   *  Writes become durable when a transaction ends (the reply waits for SQLite only then). */
  private async execRaw(bytes: Uint8Array, idle: boolean, parsed: string[]) {
    const pg = this.pg!;
    const guard = !idle && this.fs!.mayMiss;
    if (guard) await pg.exec("SAVEPOINT pgdo_stmt").catch(() => {});
    for (let round = 0; ; round++) {
      const out = await pg.execProtocolRaw(bytes, { syncToFs: false }).catch((e) => this.died(e));
      const st = lastStatus(out);
      if (!this.fs!.missing.size || round >= 400) {
        this.fs!.missing.clear();
        if (guard && st === "T") await pg.exec("RELEASE SAVEPOINT pgdo_stmt").catch(() => {});
        if (st !== "T") {
          this.fs!.flush();
          this.kickShip();
        }
        return out;
      }
      if (idle) await pg.exec("ROLLBACK").catch(() => {});
      else if (guard && st !== "I") await pg.exec("ROLLBACK TO SAVEPOINT pgdo_stmt").catch(() => {});
      else {
        this.fs!.missing.clear(); // the transaction ended in the miss: report it
        return out;
      }
      for (const n of parsed) await pg.exec(`DEALLOCATE "${n.replace(/"/g, '""')}"`).catch(() => {});
      this.faultRounds++;
      await this.fetchMissing();
    }
  }

  /** `f` (high-level PGlite calls) rerun after fetching any pages a read missed. */
  private async retryQuery<T>(f: () => Promise<T>, inTx: boolean): Promise<T> {
    const pg = this.pg!;
    const guard = inTx && this.fs!.mayMiss;
    if (guard) await pg.exec("SAVEPOINT pgdo_q").catch(() => {});
    for (let round = 0; ; round++) {
      try {
        const r = await f();
        if (guard) await pg.exec("RELEASE SAVEPOINT pgdo_q").catch(() => {});
        return r;
      } catch (e) {
        if (!this.fs!.missing.size || round >= 400) {
          this.fs!.missing.clear();
          throw e;
        }
        if (guard) await pg.exec("ROLLBACK TO SAVEPOINT pgdo_q").catch(() => {});
        else if (!inTx) await pg.exec("ROLLBACK").catch(() => {});
        this.faultRounds++;
        await this.fetchMissing();
      }
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
    return this.fs!.fetchMissing(
      async (offset, length) => (await (await this.env.BUCKET.get(`${IMG(image)}.blob`, { range: { offset, length } }))!.arrayBuffer()),
      async (shard, keys, at) => (await this.page(shard).get(keys, at)) as [string, number, ArrayBuffer | null][],
    );
  }

  // ---------------------------------------------------------------- page servers (primary mode)

  private pageNames?: string[];
  /** Page server `i` of this database. */
  protected page(i: number) {
    this.pageNames ??= this.ctx.storage.kv.get<string[]>("pages") ?? [];
    return this.env.PAGE.getByName(this.pageNames[i]);
  }

  /** Create this database with its disk on `shards` page servers (RPC). Each server is picked to
   *  run in this object's data center (see nearby). */
  async create(shards: number, image?: string) {
    if (this.ctx.storage.kv.get("pages") || this.ctx.storage.kv.get("image")) return { error: "exists" };
    const colo = await this.colo();
    const names: string[] = [];
    for (let i = 0; i < shards; i++) names.push(await nearby(this.env.PAGE, `${this.ctx.id.name}#p${i}`, colo, 6));
    this.ctx.storage.kv.put("pages", names);
    this.pageNames = names;
    const start = await this.ensure(image);
    this.kickShip();
    this.used();
    const colos = await Promise.all(names.map((n) => this.env.PAGE.getByName(n).colo()));
    return { start, colo, pages: names.map((n, i) => `${n}@${colos[i]}`) };
  }

  private shipping?: Promise<void>;
  private keep = Number.MAX_SAFE_INTEGER;
  private epochPublished = 0;
  private lastBarrierSeq = 0;
  private lastCheckpoint = { at: Date.now(), seq: 0 };

  /** Send what page servers don't have yet, in the background (one loop at a time). */
  private kickShip() {
    if (this.fs?.kind !== "primary" || this.shipping) return;
    this.shipping = this.shipLoop()
      .catch((e) => console.log("ship:", String((e as Error)?.message ?? e)))
      .finally(() => (this.shipping = undefined));
  }

  private async shipLoop() {
    for (;;) {
      const fs = this.fs;
      if (!fs || fs.kind !== "primary") return;
      const b = fs.shipBatch(1024);
      if (b) {
        const per = new Map<number, PutBatch>();
        const of = (i: number) => per.get(i) ?? per.set(i, { blocks: [], truncs: [], nodes: [], keep: this.keep }).get(i)!;
        for (const x of b.blocks) of(x.shard).blocks.push(x.row);
        if (b.nodes.length) of(0).nodes.push(...b.nodes);
        if (b.truncs.length) for (let i = 0; i < fs.shards; i++) of(i).truncs.push(...b.truncs);
        await Promise.all([...per].map(([i, batch]) => this.page(i).put(batch)));
        if (this.fs !== fs) return; // restarted meanwhile: the next loop starts over from SQLite
        fs.shipped(b);
        continue;
      }
      // Caught up: a snapshot point that's now entirely on the page servers is usable by replicas.
      const barrier = this.ctx.storage.kv.get<number>("barrier") ?? 0;
      if (barrier > this.epochPublished && barrier <= fs.shippedThrough()) {
        await this.page(0).epoch(barrier);
        this.epochPublished = barrier;
      }
      return;
    }
  }

  /** A primary's periodic work: a snapshot point for replicas (if anything was written), shipping,
   *  eviction past the local budget, and the oldest version replicas still read. */
  private async tick() {
    const fs = this.fs;
    if (!fs || fs.kind !== "primary") return;
    if (fs.flushSeq > this.lastCheckpoint.seq && Date.now() - this.lastCheckpoint.at > CHECKPOINT_MS) {
      await this.gate.run({}, async () => {
        if (!this.pg || this.gate.txOwner) return; // (the gate never runs this inside a client's transaction)
        await this.retryQuery(() => this.pg!.exec("CHECKPOINT"), false);
        this.fs?.flush();
      });
      this.lastCheckpoint = { at: Date.now(), seq: this.fs?.flushSeq ?? 0 };
    }
    if (fs.flushSeq > this.lastBarrierSeq) {
      const barrier = await this.gate.run({}, async () => this.fs!.setBarrier());
      this.lastBarrierSeq = barrier;
      this.ctx.storage.kv.put("barrier", barrier);
    }
    this.kickShip();
    const conf = this.ctx.storage.kv.get<{ localBlocks?: number }>("conf") ?? {};
    await this.gate.run({}, async () => this.fs?.evict(conf.localBlocks ?? LOCAL_BLOCKS));
    const floor = await this.page(0).keepFloor();
    this.keep = floor === 0 ? 0 : floor; // 0: no epochs yet, prune nothing
  }

  // ---------------------------------------------------------------- replicas

  /** Make `n` read replicas of this primary (RPC): slot i starts as generation 0. */
  async startReplicas(n: number) {
    const db = this.ctx.id.name!;
    const out = [];
    for (let slot = 0; slot < n; slot++) out.push(await replicaStub(this.env, db, slot, 0).startReplica({ primary: db, slot, gen: 0 }, this.ctx.storage.kv.get<string[]>("pages")!));
    return out;
  }

  /** A replica is ready to serve (RPC): new read-only connections to this slot go to it. */
  registerReplica(slot: number, gen: number, epoch: number) {
    const cur = this.ctx.storage.kv.get<{ gen: number }>(`rep:${slot}`);
    if (!cur || gen >= cur.gen) this.ctx.storage.kv.put(`rep:${slot}`, { gen, epoch, at: Date.now() });
    return this.ctx.storage.kv.get(`rep:${slot}`);
  }

  /** Where a new read-only connection should go (RPC): a slot's current replica. */
  pickReplica(): { slot: number; gen: number } | null {
    const slots = [...this.ctx.storage.kv.list<{ gen: number }>({ prefix: "rep:" })];
    if (!slots.length) return null;
    const [k, v] = slots[Math.floor(Math.random() * slots.length)];
    return { slot: Number(k.slice(4)), gen: v.gen };
  }

  replicaSlots() {
    return Object.fromEntries(this.ctx.storage.kv.list({ prefix: "rep:" }));
  }

  /** This object becomes a replica (RPC): boot at the primary's newest epoch, then register. */
  async startReplica(info: ReplicaInfo, pages: string[]) {
    this.ctx.storage.kv.put("replica", info);
    this.ctx.storage.kv.put("pages", pages);
    this.ctx.storage.kv.delete("draining");
    this.pageNames = pages;
    if (this.pg) await this.closePg();
    this.replicaAt = undefined;
    const st = (await this.ensure()) as { epoch?: number };
    await dbStub(this.env, info.primary).registerReplica(info.slot, info.gen, st?.epoch ?? 0);
    this.bootedAt = Date.now();
    this.alarmAt = Date.now() + 5_000;
    await this.ctx.storage.setAlarm(this.alarmAt);
    return { name: this.ctx.id.name, epoch: st?.epoch, boot: st };
  }

  private bootedAt = 0;

  /** A replica's periodic work: keep its lease, and when it's stale hand over to a fresh one
   *  (the other generation, in the other class) and drain. */
  private async replicaTick(info: ReplicaInfo) {
    const draining = this.ctx.storage.kv.get<number>("draining");
    if (draining) {
      if (this.gate.conns.size === 0 || Date.now() - draining > DRAIN_MS) {
        await this.closePg();
        await this.page(0).release(this.ctx.id.name!);
        this.ctx.storage.kv.delete("replica"); // done until started again
        return false;
      }
      return true;
    }
    if (!this.replicaAt) return true;
    await this.page(0).lease(this.ctx.id.name!, this.replicaAt.at, LEASE_MS);
    const latest = await this.page(0).latestEpoch();
    if (latest && latest.seq > this.replicaAt.at && Date.now() - this.bootedAt > REFRESH_MS) {
      const next = { ...info, gen: info.gen + 1 };
      await replicaStub(this.env, info.primary, info.slot, next.gen).startReplica(next, this.ctx.storage.kv.get<string[]>("pages")!);
      this.ctx.storage.kv.put("draining", Date.now());
    }
    return true;
  }

  private async closePg() {
    await this.gate.run({}, async () => {
      const pg = this.pg;
      running.delete(this);
      this.pg = undefined;
      this.fs = undefined;
      this.gate.sessionOwner = null;
      await pg?.close().catch(() => {});
    });
  }

  replicaState() {
    return { replica: this.ctx.storage.kv.get("replica"), epoch: this.replicaAt?.at, draining: this.ctx.storage.kv.get("draining") ?? null, conns: this.gate.conns.size, running: !!this.pg };
  }

  /** Where things are (RPC): this primary's cache and queues, and each page server. */
  async pageStats() {
    await this.ensure();
    const fs = this.fs!;
    const n = this.ctx.storage.kv.get<string[]>("pages")?.length ?? 0;
    const q = (sql: string) => this.ctx.storage.sql.exec<{ c: number }>(sql).toArray()[0]?.c ?? 0;
    return {
      fs: fs.snapshot(),
      local: { blocks: q("SELECT count(*) AS c FROM fs_block"), unshipped: q("SELECT count(*) AS c FROM ship"), held: q("SELECT count(*) AS c FROM ship_hold"), sqliteMB: +(this.ctx.storage.sql.databaseSize / 1e6).toFixed(1) },
      shippedThrough: fs.shippedThrough(),
      barrier: this.ctx.storage.kv.get<number>("barrier") ?? 0,
      epoch: n ? await this.page(0).latestEpoch() : null,
      pages: await Promise.all(Array.from({ length: n }, (_, i) => this.page(i).stats())),
    };
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
    this.used();
    return this.gate.run({}, async () => {
      await this.gate.switchTo(this.pg!, null);
      let rounds = 0;
      const t0 = Date.now();
      for (;;) {
        try {
          const r = await f();
          this.kickShip();
          return { r, faultRounds: rounds, faultMs: rounds ? Date.now() - t0 : 0 };
        } catch (e) {
          if (!this.fs!.missing.size || rounds >= 400) throw e;
          rounds++;
          await this.pg!.exec("ROLLBACK").catch(() => {});
          await this.fetchMissing();
        }
      }
    });
  }

  /** Note activity, and make sure an alarm will come round to close Postgres once it's idle. */
  private used() {
    this.lastUse = Date.now();
    if (!this.alarmAt) {
      this.alarmAt = this.lastUse + (this.fs?.kind === "primary" ? TICK_MS : IDLE_MS);
      void this.ctx.storage.setAlarm(this.alarmAt);
    }
  }

  override async alarm() {
    this.alarmAt = 0;
    const replica = this.ctx.storage.kv.get<ReplicaInfo>("replica");
    if (replica) {
      const again = await this.replicaTick(replica).catch((e) => (console.log("replica tick:", String((e as Error)?.message ?? e)), true));
      if (again) {
        this.alarmAt = Date.now() + 5_000;
        await this.ctx.storage.setAlarm(this.alarmAt);
      }
      return;
    }
    if (this.fs?.kind === "primary" || this.ctx.storage.kv.get("pages")) {
      // a primary stays up while it's in use, ticking; its disk is on page servers anyway
      await this.ensure();
      await this.tick().catch((e) => console.log("tick:", String((e as Error)?.message ?? e)));
      if (Date.now() - this.lastUse < 10 * 60_000 || this.fs?.shippedThrough() !== this.fs?.flushSeq) {
        this.alarmAt = Date.now() + TICK_MS;
        await this.ctx.storage.setAlarm(this.alarmAt);
      }
      return;
    }
    const idle = Date.now() - this.lastUse;
    if (this.pg && idle >= IDLE_MS && this.gate.conns.size === 0) {
      // Nobody's here: give the memory back. The next request boots Postgres from SQLite again.
      await this.gate.run({}, async () => {
        const pg = this.pg;
        running.delete(this);
        this.pg = undefined;
        this.fs = undefined;
        this.gate.sessionOwner = null;
        await pg?.close().catch(() => {});
      });
    } else if (this.pg) {
      this.alarmAt = this.lastUse + IDLE_MS + 1000;
      await this.ctx.storage.setAlarm(this.alarmAt);
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
    return { instance: this.instance, wireFaultRounds: this.faultRounds, heapMB: heap ? +(heap / 1e6).toFixed(1) : null, sqliteMB: +(this.ctx.storage.sql.databaseSize / 1e6).toFixed(1), fs: this.fs?.snapshot() };
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
  async configure(conf: { cacheMB?: number; sharedBuffers?: string; localBlocks?: number }) {
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

  /** Round trips from this object to another one nearby, for 8 KiB and 1 MiB payloads (RPC). */
  async rpcPing(n = 30) {
    const other = this.env.PG.getByName(`${this.ctx.id.name ?? "x"}#ping`);
    await other.echo(new Uint8Array(1)); // create it (next to us) before timing
    const out: Record<string, unknown> = {};
    for (const size of [8192, 1 << 20]) {
      const b = new Uint8Array(size), t: number[] = [];
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        const s = Date.now();
        await other.echo(b);
        t.push(Date.now() - s);
      }
      t.sort((a, b) => a - b);
      out[size === 8192 ? "8KiB" : "1MiB"] = { avgMs: +((Date.now() - t0) / n).toFixed(2), p50: t[Math.floor(n / 2)], p99: t[n - 1] };
    }
    return out;
  }

  echo(b: Uint8Array) {
    return b.length;
  }

  /** pgbench against database `db`, driven from this object (placed next to it by `nearby`). */
  async drive(db: string, opts: { clients: number; seconds: number; mode: string; scale: number }) {
    return pgbench(async () => WireClient.connect(await wireStub(this.env, db), db, this.env.PGDO_TOKEN), opts);
  }

  /** Which data center this object runs in (egress colo of an outbound request). */
  private coloCache?: string;
  async colo() {
    if (this.coloCache) return this.coloCache;
    const t = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
    return (this.coloCache = t.match(/colo=(\w+)/)?.[1]);
  }

  async colos() {
    const other = this.env.PG.getByName(`${this.ctx.id.name ?? "x"}#ping`);
    return { me: await this.colo(), ping: await other.colo() };
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
    for (const t of ["ship", "ship_hold", "ship_node", "ship_trunc"]) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    for (const k of ["pages", "barrier"]) this.ctx.storage.kv.delete(k);
    this.pageNames = undefined;
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

/** The object a wire connection to `db` reaches: "<db>-ro" is one of the primary's replicas. */
export async function wireStub(env: Env, db: string): Promise<{ fetch(r: Request): Promise<Response> }> {
  if (!db.endsWith("-ro")) return dbStub(env, db);
  const primary = db.slice(0, -3);
  const pick = await dbStub(env, primary).pickReplica();
  if (!pick) throw new Error("no replicas");
  return replicaStub(env, primary, pick.slot, pick.gen);
}

/** Read replicas. Generations alternate between two classes, so a replica and the fresh one taking
 *  over from it never share an isolate. */
export class PgReplicaA extends PgObject {
  protected override maxMB = 64;
}
export class PgReplicaB extends PgObject {
  protected override maxMB = 64;
}
export function replicaStub(env: Env, primary: string, slot: number, gen: number) {
  return (gen % 2 ? env.REPB : env.REPA).getByName(`${primary}~r${slot}g${gen}`);
}

/** A big database: its own class (so its own isolates) and room for a bigger heap. */
export class PgBig extends PgObject {
  protected override maxMB = 80;
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
    if (url.pathname === "/wire") {
      const db = url.searchParams.get("db") || "postgres";
      if (db.endsWith("-ro")) {
        // a read replica of the primary: its current one for a random slot
        const primary = db.slice(0, -3);
        const pick = await dbStub(env, primary).pickReplica();
        if (!pick) return new Response("no replicas", { status: 503 });
        return replicaStub(env, primary, pick.slot, pick.gen).fetch(req);
      }
      return dbStub(env, db).fetch(req);
    }
    // Everything else runs arbitrary SQL (and some routes reach Neon): bearer token required.
    const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!(await sameSecret(auth, env.PGDO_TOKEN))) return new Response("unauthorized", { status: 401 });
    const stub = dbStub(env, url.searchParams.get("db") ?? "spike");
    const t0 = Date.now();
    let r: unknown;
    if (url.pathname === "/sql") r = await stub.exec(req.method === "POST" ? await req.text() : (url.searchParams.get("q") ?? "select 1"), url.searchParams.get("image") ?? undefined);
    else if (url.pathname === "/bench") r = await stub.bench(url.searchParams.get("kind") ?? "update", Number(url.searchParams.get("n") ?? 200));
    else if (url.pathname === "/reset") r = await stub.reset();
    else if (url.pathname === "/files") r = await stub.putFiles(await req.json());
    else if (url.pathname === "/create") r = await stub.create(Number(url.searchParams.get("shards") ?? 4), url.searchParams.get("image") ?? undefined);
    else if (url.pathname === "/pagestats") r = await stub.pageStats();
    else if (url.pathname === "/replicas") r = url.searchParams.has("n") ? await stub.startReplicas(Number(url.searchParams.get("n"))) : { slots: await stub.replicaSlots() };
    else if (url.pathname === "/replica") {
      const [slot, gen] = [Number(url.searchParams.get("slot") ?? 0), Number(url.searchParams.get("gen") ?? 0)];
      r = await replicaStub(env, url.searchParams.get("db")!, slot, gen).replicaState();
    }
    else if (url.pathname === "/config") r = await stub.configure({ cacheMB: Number(url.searchParams.get("cacheMB") ?? 4), sharedBuffers: url.searchParams.get("sharedBuffers") ?? "4MB", ...(url.searchParams.has("localBlocks") ? { localBlocks: Number(url.searchParams.get("localBlocks")) } : {}) });
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
    } else if (url.pathname === "/tpcb") {
      // pgbench's TPC-B (or select-only) from this Worker, next to the database:
      //   /tpcb?db=…&clients=8&seconds=20&mode=tpcb|select&scale=1
      // &near=1 drives it from an object in the database's own data center instead of this Worker.
      const db = url.searchParams.get("db") ?? "pgbench";
      const opts = {
        clients: Number(url.searchParams.get("clients") ?? 4),
        seconds: Number(url.searchParams.get("seconds") ?? 15),
        mode: url.searchParams.get("mode") ?? "tpcb",
        scale: Number(url.searchParams.get("scale") ?? 1),
      };
      if (url.searchParams.has("near")) {
        const colo = await dbStub(env, db.replace(/-ro$/, "")).colo();
        const driver = await nearby(env.PG, `bench:${db}`, colo);
        r = { ...((await env.PG.getByName(driver).drive(db, opts)) as object), dbColo: colo, driverColo: await env.PG.getByName(driver).colo() };
      } else r = await pgbench(async () => WireClient.connect(await wireStub(env, db), db, env.PGDO_TOKEN), opts);
    } else if (url.pathname === "/pginit") {
      // pgbench -i in pieces: /pginit?db=…&scale=…&from=1&to=500000 (from=1 also creates the tables)
      const scale = Number(url.searchParams.get("scale") ?? 1);
      const from = Number(url.searchParams.get("from") ?? 1), to = Number(url.searchParams.get("to") ?? 100000 * scale);
      const results = [];
      for (const sql of initStatements(scale, from, to)) {
        const x = (await stub.exec(sql)) as { error?: string };
        results.push(x.error ? x.error.slice(0, 300) : "ok");
        if (x.error) break;
      }
      r = { scale, from, to, results };
    } else if (url.pathname === "/rpcping") r = { ...((await stub.rpcPing(Number(url.searchParams.get("n") ?? 30))) as object), colos: await stub.colos(), worker: (req as { cf?: { colo?: string } }).cf?.colo };
    else if (url.pathname === "/env") r = { jspi: { Suspending: typeof (WebAssembly as any).Suspending, promising: typeof (WebAssembly as any).promising }, typeReflection: typeof (WebAssembly as any).Function };
    else if (url.pathname === "/evict") r = await stub.evict().then(() => ({ ok: true }), () => ({ ok: true, aborted: true }));
    else return new Response("pgdo spike: /sql?q=…[&image=hn150] | /bench?kind=update|read|tpcb&n=… | /evict | /reset   (&db=name)");
    return Response.json({ ...(r as object), workerMs: Date.now() - t0 });
  },
};
