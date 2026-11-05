// The Postgres wire protocol in front of one PGlite, for many client connections at once.
//
// PGlite is a single backend: one session, one transaction at a time. This module terminates
// each client connection itself (startup, cleartext password auth, ParameterStatus) and passes
// query messages through to PGlite's raw protocol, so psql, node-postgres, postgres.js, Drizzle
// and pg_regress talk to it unchanged. To make one session look like many:
//   - a connection inside a transaction block holds the backend until it's idle again;
//   - each connection's session settings (SET, startup parameters) are saved and restored when
//     the backend switches between connections;
//   - prepared statement and portal names are prefixed per connection, so they can't collide, and
//     each connection's unnamed statement gets a fresh private name (a describe-first client like
//     postgres.js parses it in one batch and binds it in the next, when another connection may
//     have run in between);
//   - COPY … FROM STDIN (which PGlite's raw protocol can't do: it exits) is collected here and
//     run as COPY … FROM '/dev/blob';
//   - RESET SESSION AUTHORIZATION is a no-op in PGlite (single-user mode never records the login
//     user as the default), so it's rewritten to name the connection's user explicitly; likewise
//     RESET of a setting the client sent at startup (DateStyle, TimeZone, …) restores that value;
//   - changed reported settings go back to the client as ParameterStatus (psql's lexer needs
//     standard_conforming_strings, for one).
// Runtime-agnostic: the Durable Object and a Node test server (scripts/local-wire.ts) both use it.
import type { PGlite } from "@electric-sql/pglite";

const enc = new TextEncoder();
const dec = new TextDecoder();
/** PGlite's one login role. */
const SUPERUSER = "postgres";

export interface WireHost {
  /** The database, started if needed. */
  pg(): Promise<PGlite>;
  checkPassword(user: string, password: string): Promise<boolean>;
  /** Run raw protocol messages (the host may retry them, e.g. after fetching lazy pages, when
   *  the batch started outside a transaction). */
  /** `parsed`: statement names this batch Parses, which a retry must deallocate first (prepared
   *  statements survive rollbacks). */
  exec(bytes: Uint8Array, idle: boolean, parsed: string[]): Promise<Uint8Array>;
  /** Run `f` (high-level PGlite calls), rerunning it if a read missed a page that isn't here yet
   *  (inside a transaction block under a savepoint, so only `f`'s work is undone). */
  retry?<T>(f: () => Promise<T>, inTx: boolean): Promise<T>;
  /** A read replica: statements that would turn read-write transactions back on are refused. */
  readOnly?: boolean;
  /** Throw the running Postgres away (it reported FATAL/PANIC); the next use boots it again. */
  restart(): Promise<void>;
  gate: Gate;
}

// ------------------------------------------------------------------ one backend, many clients

type Job = { who: object; f: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** Serializes everything that touches the backend. While a connection is inside a transaction
 *  block, only its own work runs; everyone else's waits in order. */
export class Gate {
  txOwner: object | null = null;
  /** Whose session settings are loaded in the backend (null: defaults). */
  sessionOwner: WireConn | null = null;
  readonly conns = new Set<WireConn>();
  private jobs: Job[] = [];
  private running = false;

  run<T>(who: object, f: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ who, f, resolve: resolve as (v: unknown) => void, reject });
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const i = this.jobs.findIndex((j) => !this.txOwner || j.who === this.txOwner);
        if (i < 0) break;
        const [j] = this.jobs.splice(i, 1);
        try {
          j.resolve(await j.f());
        } catch (e) {
          j.reject(e);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Called when a transaction owner goes away without finishing. */
  wake() {
    void this.pump();
  }

  /** Load a connection's session settings into the backend (or the defaults, for null). */
  async switchTo(pg: PGlite, conn: WireConn | null) {
    if (this.sessionOwner === conn) return;
    const prev = this.sessionOwner;
    if (prev && !prev.closed && prev.maybeSet) {
      prev.settings = await captureSettings(pg);
      prev.maybeSet = false;
    }
    const want = conn?.settings ?? new Map<string, string>();
    const had = prev && !prev.closed ? prev.settings : new Map<string, string>();
    if (!sameSettings(want, had) || prev?.closed || prev?.maybeSet) {
      await pg.exec(`SET SESSION AUTHORIZATION ${SUPERUSER}; RESET ALL`);
      // plain settings first (some need the superuser), then who we are, then the role
      for (const [k, v] of want) if (k !== "session_authorization" && k !== "role") await pg.query("select set_config($1, $2, false)", [k, v]).catch(() => {});
      const auth = want.get("session_authorization"), role = want.get("role");
      if (auth) await pg.exec(`SET SESSION AUTHORIZATION ${quoteIdent(auth)}`).catch(() => {});
      if (role) await pg.exec(`SET ROLE ${quoteIdent(role)}`).catch(() => {});
    }
    this.sessionOwner = conn;
  }
}

/** Settings this session changed from the defaults (SET, set_config, applied startup parameters). */
async function captureSettings(pg: PGlite) {
  const out = new Map<string, string>();
  const r = await pg.query<{ name: string; setting: string }>(
    `select name, setting from pg_settings where source = 'session'
       and name not in ('transaction_isolation', 'transaction_read_only', 'transaction_deferrable', 'is_superuser', 'session_authorization')
     union all select 'session_authorization', session_user::text where session_user <> 'postgres'
     union all select 'role', current_setting('role') where current_setting('role') <> 'none'`,
  );
  for (const row of r.rows) out.set(row.name, row.setting);
  return out;
}

const sameSettings = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ------------------------------------------------------------------ messages

function concat(parts: Uint8Array[]) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
const cstr = (s: string) => concat([enc.encode(s), new Uint8Array([0])]);
const int32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
};
const int16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, v);
  return b;
};
function msg(type: string, ...body: Uint8Array[]) {
  const b = concat(body);
  return concat([new Uint8Array([type.charCodeAt(0)]), int32(b.length + 4), b]);
}
const readyForQuery = (status: string) => msg("Z", enc.encode(status));
const commandComplete = (tag: string) => msg("C", cstr(tag));

type Fields = { severity?: string; code?: string; message: string; detail?: string; hint?: string; where?: string; position?: string };

export function errorResponse(f: Fields, type = "E") {
  const sev = f.severity ?? "ERROR";
  const fields: Uint8Array[] = [enc.encode("S"), cstr(sev), enc.encode("V"), cstr(sev), enc.encode("C"), cstr(f.code ?? "XX000"), enc.encode("M"), cstr(f.message)];
  if (f.detail) fields.push(enc.encode("D"), cstr(f.detail));
  if (f.hint) fields.push(enc.encode("H"), cstr(f.hint));
  if (f.position) fields.push(enc.encode("P"), cstr(f.position));
  if (f.where) fields.push(enc.encode("W"), cstr(f.where));
  fields.push(new Uint8Array([0]));
  return msg(type, ...fields);
}

/** Whether a response carries a FATAL or PANIC error (a real backend would have exited). */
function fatalIn(r: Uint8Array): boolean {
  const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
  for (let i = 0; i + 5 <= r.length; ) {
    const len = dv.getInt32(i + 1);
    if (r[i] === 69 /* E */) {
      const s = dec.decode(r.subarray(i + 5, Math.min(i + 1 + len, i + 32)));
      if (/^S(FATAL|PANIC)\0/.test(s)) return true;
    }
    i += 1 + len;
  }
  return false;
}

/** The transaction status in the last ReadyForQuery of a response, if any. */
export function lastStatus(r: Uint8Array): string | undefined {
  const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
  let status: string | undefined;
  for (let i = 0; i + 5 <= r.length; ) {
    const len = dv.getInt32(i + 1);
    if (r[i] === 90 /* Z */) status = String.fromCharCode(r[i + 5]);
    i += 1 + len;
  }
  return status;
}

function readCstr(b: Uint8Array, at: number): [string, number] {
  let end = at;
  while (b[end] !== 0) end++;
  return [dec.decode(b.subarray(at, end)), end + 1];
}

const RESET_AUTH = /\b(?:reset\s+session\s+authorization|set\s+session\s+authorization\s+default)\b/i;
// (psql accepts COPY … FROM STDOUT as a synonym)
/** What would make a replica's session read-write again. */
const READ_WRITE = /\bread\s+write\b|\bdefault_transaction_read_only\b|\btransaction_read_only\b/i;
const COPY_STDIN = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*copy\b[\s\S]*?\bfrom\s+std(?:in|out)\b/i;
/** COPY … FROM STDIN anywhere in a query (PGlite's raw protocol exits on it). */
const COPY_STDIN_ANYWHERE = /\bcopy\b[^;]*?\bfrom\s+std(?:in|out)\b/i;
const MAYBE_SET = /\b(set|reset|set_config|discard)\b|\bsession\s+authorization\b/i;
const BATCH_END = new Set(["S", "Q", "H", "X", "F", "c", "f"]);
const PARAMS_REPORTED = ["server_version", "server_encoding", "client_encoding", "DateStyle", "IntervalStyle", "TimeZone", "integer_datetimes", "standard_conforming_strings", "is_superuser", "session_authorization", "application_name", "default_transaction_read_only", "in_hot_standby", "search_path", "scram_iterations"];

// ------------------------------------------------------------------ one client connection

let nextId = 1;

export class WireConn {
  readonly id = nextId++;
  closed = false;
  /** This connection's session settings, applied whenever it gets the backend. */
  settings = new Map<string, string>();
  /** It may have changed settings since they were last captured. */
  maybeSet = false;
  /** It has run something of its own (not just connected). */
  used = false;
  /** Settings sent in the startup packet (lowercase names): what RESET returns to. */
  private startupSettings = new Map<string, string>();
  /** ParameterStatus values the client has been told, and whether they may have changed. */
  private reported = new Map<string, string>();
  private paramsDirty = false;
  private host: WireHost;
  private send: (b: Uint8Array) => void;
  private hangup: () => void;
  private state: "startup" | "password" | "ready" | "copyin" = "startup";
  private user = "postgres";
  private buf: Uint8Array = new Uint8Array(0);
  private pending: Uint8Array[] = [];
  private copy: { sql: string; data: Uint8Array[] } | null = null;
  private named = new Set<string>();
  /** What this connection's unnamed statement is really called, and the old ones to drop. */
  private unnamed = "";
  private unnamedCount = 0;
  private stale: string[] = [];
  /** Names Parsed by the batch being collected. */
  private batchParsed: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  /** An error to return at the next Sync instead of running the batch (unsupported message). */
  private refused: Uint8Array | null = null;

  constructor(host: WireHost, send: (b: Uint8Array) => void, hangup: () => void) {
    this.host = host;
    this.send = send;
    this.hangup = hangup;
    host.gate.conns.add(this);
  }

  /** Bytes from the client, in order. */
  feed(data: Uint8Array) {
    this.chain = this.chain.then(() => this.take(data)).catch((e) => this.fatal(String((e as Error)?.message ?? e)));
  }

  private fatal(message: string) {
    if (this.closed) return;
    try {
      this.send(errorResponse({ severity: "FATAL", code: "XX000", message }));
    } catch {}
    this.hangup();
    void this.end();
  }

  private async take(data: Uint8Array) {
    if (this.closed) return;
    this.buf = this.buf.length ? concat([this.buf, data]) : data;
    for (;;) {
      if (this.state === "startup") {
        if (this.buf.length < 8) return;
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
        const len = dv.getInt32(0);
        if (this.buf.length < len) return;
        const code = dv.getInt32(4);
        const packet = this.buf.subarray(0, len);
        this.buf = this.buf.subarray(len);
        if (code === 80877103 || code === 80877104) {
          this.send(enc.encode("N")); // no SSL / GSS here (the transport is already TLS)
          continue;
        }
        if (code === 80877102) return this.end(); // cancel requests aren't supported
        if (code !== 196608) return this.fatal(`unsupported protocol version ${code >> 16}.${code & 0xffff}`);
        this.startup(packet);
        continue;
      }
      if (this.buf.length < 5) return;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getInt32(1);
      if (this.buf.length < len + 1) return;
      const m = this.buf.subarray(0, len + 1);
      this.buf = this.buf.subarray(len + 1);
      await this.message(String.fromCharCode(m[0]), m);
      if (this.closed) return;
    }
  }

  private startup(packet: Uint8Array) {
    const params: Record<string, string> = {};
    for (let at = 8; at < packet.length && packet[at] !== 0; ) {
      const [k, a] = readCstr(packet, at);
      const [v, b] = readCstr(packet, a);
      params[k] = v;
      at = b;
    }
    this.user = params.user ?? "postgres";
    const skip = new Set(["user", "database", "replication", "options", "client_encoding"]);
    for (const [k, v] of Object.entries(params)) if (!skip.has(k)) this.settings.set(k, v);
    // options="-c name=value --name=value"
    for (const m of (params.options ?? "").matchAll(/(?:-c\s*|--)([\w.]+)=((?:\\ |\S)+)/g)) this.settings.set(m[1].toLowerCase(), m[2].replace(/\\ /g, " "));
    for (const [k, v] of this.settings) this.startupSettings.set(k.toLowerCase(), v);
    if (this.user !== "postgres") this.settings.set("session_authorization", this.user);
    this.state = "password";
    this.send(msg("R", int32(3))); // AuthenticationCleartextPassword
  }

  private async message(type: string, m: Uint8Array) {
    if (this.state === "password") {
      if (type !== "p") return this.fatal("expected a password message");
      const [password] = readCstr(m, 5);
      if (!(await this.host.checkPassword(this.user, password))) {
        this.send(errorResponse({ severity: "FATAL", code: "28P01", message: `password authentication failed for user "${this.user}"` }));
        this.hangup();
        return this.end();
      }
      return this.authenticated();
    }
    if (this.state === "copyin") {
      if (type === "d") this.copy!.data.push(m.slice(5));
      else if (type === "c" || type === "f") await this.finishCopy(type === "c" ? null : readCstr(m, 5)[0]);
      // Flush / Sync during COPY are ignored, as Postgres does
      return;
    }
    if (type === "X") {
      this.hangup();
      return this.end();
    }
    if (this.host.readOnly && (type === "Q" || type === "P")) {
      const [sql] = type === "Q" ? readCstr(m, 5) : readCstr(m, readCstr(m, 5)[1]);
      if (READ_WRITE.test(sql)) {
        this.refused = errorResponse({ code: "25006", message: "this is a read-only replica" });
        if (type === "Q") {
          const e = this.refused;
          this.refused = null;
          return this.send(concat([e, readyForQuery(await this.status())]));
        }
      }
    }
    if (type === "Q") {
      let [sql] = readCstr(m, 5);
      const fixed = this.fixReset(this.fixAuth(sql), true);
      if (fixed !== sql) m = msg("Q", cstr((sql = fixed)));
      if (MAYBE_SET.test(sql)) this.maybeSet = this.paramsDirty = true;
      if (COPY_STDIN.test(sql) || COPY_STDIN_ANYWHERE.test(sql)) {
        if (!COPY_STDIN.test(sql) || /;\s*\S/.test(sql.replace(/;\s*$/, ""))) {
          this.send(errorResponse({ code: "0A000", message: "COPY FROM STDIN must be the only statement in its query" }));
          return this.send(readyForQuery(await this.status()));
        }
        // same length and case as the original, so error positions still point at the right place
        this.copy = { sql: sql.replace(/\b(from)(\s+)(std(?:in|out))\b/i, (_m, f: string, sp: string, w: string) => `${f}${sp}${"'/b'".padEnd(w.length)}`), data: [] };
        this.state = "copyin";
        return this.send(msg("G", new Uint8Array([0]), int16(0)));
      }
      this.pending.push(m);
    } else {
      this.pending.push(this.rename(type, m));
    }
    if (BATCH_END.has(type)) await this.flushBatch(type);
  }

  private async status() {
    const pg = await this.host.pg();
    return this.host.gate.txOwner === this ? (pg.isInTransaction() ? "T" : "I") : "I";
  }

  private async authenticated() {
    const gate = this.host.gate;
    const params = await gate.run(this, async () => {
      const pg = await this.host.pg();
      try {
        const run = async () => {
          await gate.switchTo(pg, this);
          return (await pg.query<{ name: string; setting: string }>("select name, setting from pg_settings where name = any($1)", [PARAMS_REPORTED])).rows;
        };
        return this.host.retry ? await this.host.retry(run, false) : await run();
      } catch (e) {
        if (/FATAL|PANIC/.test(String((e as { severity?: string }).severity))) {
          await this.host.restart();
          gate.sessionOwner = null;
        }
        throw e;
      }
    });
    const out: Uint8Array[] = [msg("R", int32(0))];
    for (const p of params) {
      const v = p.name === "session_authorization" ? this.user : p.setting;
      this.reported.set(p.name, v);
      out.push(msg("S", cstr(p.name), cstr(v)));
    }
    out.push(msg("K", int32(this.id), int32(Math.floor(Math.random() * 2 ** 31))));
    out.push(readyForQuery("I"));
    this.state = "ready";
    this.send(concat(out));
  }

  private fixAuth(sql: string) {
    if (!RESET_AUTH.test(sql)) return sql;
    return sql.replace(new RegExp(RESET_AUTH.source, "gi"), `SET SESSION AUTHORIZATION ${quoteIdent(this.user)}`);
  }

  /** RESET (or SET … TO DEFAULT) of a startup setting goes back to the startup value, as it
   *  would in a real backend; RESET ALL re-applies them all (simple protocol only). */
  private fixReset(sql: string, simple: boolean) {
    if (!this.startupSettings.size || !/\b(reset|default|local)\b/i.test(sql)) return sql;
    const value = (name: string) => this.startupSettings.get(name.toLowerCase());
    const tz = value("timezone");
    let out = tz === undefined ? sql : sql.replace(/\breset\s+time\s+zone\b/gi, `SET TIME ZONE ${quoteLiteral(tz)}`).replace(/\b(set\s+(?:local\s+|session\s+)?time\s+zone\s+)(?:default|local)\b/gi, (_m, set: string) => `${set}${quoteLiteral(tz)}`);
    out = out.replace(/\b(set\s+(?:local\s+|session\s+)?)("?)([\w.]+)\2(\s*(?:to|=)\s*)default\b/gi, (m, set: string, _q, name: string, to: string) => {
      const v = value(name);
      return v === undefined ? m : `${set}${name}${to}${quoteLiteral(v)}`;
    });
    out = out.replace(/\breset\s+("?)([\w.]+)\1/gi, (m, _q, name: string) => {
      if (name.toLowerCase() === "all") {
        if (!simple) return m;
        return `${m}; ${[...this.startupSettings].map(([k, v]) => `SET ${quoteIdent(k)} = ${quoteLiteral(v)}`).join("; ")}`;
      }
      const v = value(name);
      return v === undefined ? m : `SET ${name} = ${quoteLiteral(v)}`;
    });
    return out;
  }

  /** Error and notice texts name statements as the client did, not as we renamed them. */
  private unrename(r: Uint8Array): Uint8Array {
    const tag = `_c${this.id}`;
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    let parts: Uint8Array[] | null = null;
    let from = 0;
    for (let i = 0; i + 5 <= r.length; ) {
      const len = dv.getInt32(i + 1);
      if (r[i] === 69 /* E */ || r[i] === 78 /* N */) {
        const body = dec.decode(r.subarray(i + 5, i + 1 + len));
        if (body.includes(tag)) {
          const fixed = body.replace(new RegExp(`${tag}#\\d+`, "g"), "").replace(new RegExp(`${tag}_`, "g"), "");
          (parts ??= []).push(r.subarray(from, i), msg(String.fromCharCode(r[i]), enc.encode(fixed)));
          from = i + 1 + len;
        }
      }
      i += 1 + len;
    }
    if (!parts) return r;
    parts.push(r.subarray(from));
    return concat(parts);
  }

  /** ParameterStatus for reported settings that changed, placed before the last ReadyForQuery. */
  private async reportChanges(pg: PGlite, out: Uint8Array): Promise<Uint8Array> {
    if (!this.paramsDirty) return out;
    this.paramsDirty = false;
    let rows: { name: string; setting: string }[];
    try {
      rows = (await pg.query<{ name: string; setting: string }>("select name, setting from pg_settings where name = any($1)", [PARAMS_REPORTED])).rows;
    } catch {
      return out; // e.g. inside an aborted transaction: report next time
    }
    const changed = rows.filter((p) => this.reported.get(p.name) !== p.setting);
    if (!changed.length) return out;
    for (const p of changed) this.reported.set(p.name, p.setting);
    const status = concat(changed.map((p) => msg("S", cstr(p.name), cstr(p.setting))));
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let z = -1;
    for (let i = 0; i + 5 <= out.length; i += 1 + dv.getInt32(i + 1)) if (out[i] === 90) z = i;
    return z < 0 ? concat([out, status]) : concat([out.subarray(0, z), status, out.subarray(z)]);
  }

  /** Prefix prepared statement and portal names with this connection's id. */
  private rename(type: string, m: Uint8Array): Uint8Array {
    const named = (s: string) => {
      if (!s) return this.unnamed;
      const n = `_c${this.id}_${s}`;
      this.named.add(n);
      return n;
    };
    if (type === "P") {
      const [name, a] = readCstr(m, 5);
      let [sql, b] = readCstr(m, a);
      sql = this.fixReset(this.fixAuth(sql), false);
      if (MAYBE_SET.test(sql)) this.maybeSet = this.paramsDirty = true;
      if (COPY_STDIN.test(sql)) this.refused = errorResponse({ code: "0A000", message: "COPY FROM STDIN is only supported in the simple query protocol" });
      if (!name) {
        if (this.unnamed) this.stale.push(this.unnamed);
        this.unnamed = `_c${this.id}#${++this.unnamedCount}`;
      }
      const real = named(name);
      this.batchParsed.push(real);
      return msg("P", cstr(real), cstr(sql), m.subarray(b));
    }
    if (type === "B") {
      const [portal, a] = readCstr(m, 5);
      const [stmt, b] = readCstr(m, a);
      return msg("B", cstr(portal ? `_c${this.id}_${portal}` : ""), cstr(named(stmt)), m.subarray(b));
    }
    if (type === "D" || type === "C") {
      const kind = String.fromCharCode(m[5]);
      const [name] = readCstr(m, 6);
      const renamed = kind === "S" ? named(name) : name ? `_c${this.id}_${name}` : "";
      return msg(type, enc.encode(kind), cstr(renamed));
    }
    if (type === "E") {
      const [portal, a] = readCstr(m, 5);
      return msg("E", cstr(portal ? `_c${this.id}_${portal}` : ""), m.subarray(a));
    }
    return m;
  }

  private async flushBatch(type: string) {
    const batch = concat(this.pending);
    const parsed = this.batchParsed;
    this.pending = [];
    this.batchParsed = [];
    if (this.refused && type !== "H") {
      const e = this.refused;
      this.refused = null;
      this.send(concat([e, readyForQuery(await this.status())]));
      return;
    }
    const gate = this.host.gate;
    const r = await gate.run(this, async () => {
      const pg = await this.host.pg();
      if (this.host.retry && gate.txOwner !== this) await this.host.retry(() => gate.switchTo(pg, this), false);
      else await gate.switchTo(pg, this);
      if (this.stale.length >= 16 && gate.txOwner !== this) {
        // the unnamed statements this connection has replaced (kept until here: still parsing)
        const drop = this.stale;
        this.stale = [];
        await pg.exec(drop.map((n) => `DEALLOCATE ${quoteIdent(n)};`).join(" ")).catch(() => {});
      }
      this.used = true;
      const out = this.unrename(await this.host.exec(batch, gate.txOwner !== this, parsed));
      if (fatalIn(out)) {
        // the backend is done for: everyone reconnects to a fresh one, as after a backend exit
        await this.host.restart();
        gate.txOwner = null;
        gate.sessionOwner = null;
        this.send(out);
        this.hangup();
        void this.end();
        return new Uint8Array(0);
      }
      const st = lastStatus(out);
      if (st === "T" || st === "E") gate.txOwner = this;
      else if (st === "I" && gate.txOwner === this) gate.txOwner = null;
      // (not inside the client's transaction: a query there could change its outcome)
      return st === "I" ? this.reportChanges(pg, out) : out;
    });
    if (r.length) this.send(r);
  }

  private async finishCopy(failed: string | null) {
    const { sql, data } = this.copy!;
    this.copy = null;
    this.state = "ready";
    const gate = this.host.gate;
    const out = await gate.run(this, async () => {
      const pg = await this.host.pg();
      await gate.switchTo(pg, this);
      this.used = true;
      const FS = (pg as unknown as { mod?: { FS?: any } }).mod?.FS;
      try {
        // a second name for PGlite's /dev/blob device, short enough to replace "stdin" in place
        if (FS && !FS.analyzePath("/b").exists) FS.mkdev("/b", FS.lookupPath("/dev/blob").node.rdev);
      } catch {}
      let reply: Uint8Array;
      if (failed !== null) reply = errorResponse({ code: "57014", message: `COPY from stdin failed: ${failed}` });
      else {
        try {
          const notices: Uint8Array[] = [];
          const run = () => this.copyAsUser(pg, sql, new Blob([concat(data)]), (n) => notices.push(errorResponse({ ...n, severity: n.severity ?? "NOTICE" } as Fields, "N")));
          const r = this.host.retry ? await this.host.retry(run, pg.isInTransaction()) : await run();
          reply = concat([...notices, commandComplete(`COPY ${r.affectedRows ?? 0}`)]);
        } catch (e) {
          const d = e as { message?: string; code?: string; detail?: string; hint?: string; where?: string; position?: string; severity?: string };
          reply = errorResponse({ message: d.message ?? String(e), code: d.code, detail: d.detail, hint: d.hint, where: d.where, position: d.position, severity: d.severity });
        }
      }
      const inTx = pg.isInTransaction();
      // a failed COPY inside a transaction block leaves it aborted
      const st = inTx ? (failed !== null || reply[0] === 69 ? "E" : "T") : "I";
      if (inTx) gate.txOwner = this;
      else if (gate.txOwner === this) gate.txOwner = null;
      return concat([reply, readyForQuery(st)]);
    });
    this.send(out);
  }

  /** Run the COPY as the client's own role. PGlite reads the data through a server-side path,
   *  which needs pg_read_server_files; a role without it gets it for this one statement (granted
   *  and revoked around it, inside the client's transaction if there is one, so a rollback takes
   *  both back). Table privileges and row security are still checked as the client. */
  private async copyAsUser(pg: PGlite, sql: string, blob: Blob, onNotice: (n: Fields) => void) {
    let who: { s: string; c: string; can: boolean } | undefined;
    try {
      who = (await pg.query<{ s: string; c: string; can: boolean }>("select session_user::text s, current_user::text c, pg_has_role(current_user, 'pg_read_server_files', 'USAGE') can")).rows[0];
    } catch {} // an aborted transaction: let the COPY itself report it
    if (!who || who.can) return pg.query(sql, [], { blob, onNotice: onNotice as never });
    const as = async () => {
      await pg.exec(`SET SESSION AUTHORIZATION ${quoteIdent(who!.s)}`);
      if (who!.c !== who!.s) await pg.exec(`SET ROLE ${quoteIdent(who!.c)}`);
    };
    await pg.exec(`SET SESSION AUTHORIZATION ${SUPERUSER}; GRANT pg_read_server_files TO ${quoteIdent(who.c)}`);
    await as();
    try {
      return await pg.query(sql, [], { blob, onNotice: onNotice as never });
    } finally {
      // (inside an aborted transaction these fail; the client's rollback undoes the grant)
      await pg.exec(`SET SESSION AUTHORIZATION ${SUPERUSER}; REVOKE pg_read_server_files FROM ${quoteIdent(who.c)}`).catch(() => {});
      await as().catch(() => {});
    }
  }

  /** The client went away: roll back what it left open, drop what it named. */
  async end() {
    if (this.closed) return;
    this.closed = true;
    const gate = this.host.gate;
    gate.conns.delete(this);
    await gate
      .run(this, async () => {
        const pg = await this.host.pg();
        if (gate.txOwner === this) {
          await pg.exec("ROLLBACK").catch(() => {});
          gate.txOwner = null;
        }
        if ([...gate.conns].every((c) => !c.used)) {
          // nobody else has run anything (psql's \c connects before it disconnects): give the
          // next connection a clean session, as a new backend would have
          await pg.exec(`SET SESSION AUTHORIZATION ${SUPERUSER}`).catch(() => {});
          await pg.exec("DISCARD ALL").catch(() => {});
          gate.sessionOwner = null;
        } else {
          for (const n of [...this.named, ...this.stale, ...(this.unnamed ? [this.unnamed] : [])]) await pg.exec(`DEALLOCATE ${quoteIdent(n)}`).catch(() => {});
          if (gate.sessionOwner === this) await gate.switchTo(pg, null);
        }
      })
      .catch(() => {});
    gate.wake();
  }
}
