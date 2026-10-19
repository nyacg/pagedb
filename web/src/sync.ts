/**
 * Browser side of the sync protocol: one WebSocket per page, many subscriptions, plus an
 * optimistic layer so a mutation shows instantly and is reconciled when the server's poke
 * (at or past the mutation's version) arrives.
 */

export type Row = Record<string, any>;

export interface SubStats {
  rounds: number;
  pages: number;
  cacheHits: number;
  r2Gets: number;
  sqliteHits: number;
  totalMs: number;
  bytes: number;
}

export interface Sub {
  id: string;
  q: any;
  key: string;
  rows: Map<string, Row>;
  count?: number;
  complete?: boolean;
  ready: boolean;
  stats?: SubStats;
  firstMs?: number;
  updates: number;
  sentAt: number;
}

interface Pending {
  mid: number;
  version?: number;
  doneAt?: number;
  patch?: { id: string; set: Row };
  insert?: Row;
  remove?: string;
  comment?: Row;
  uncomment?: string;
}

type Listener = () => void;

export class Sync {
  private ws?: WebSocket;
  private subs = new Map<string, Sub>();
  private pending: Pending[] = [];
  private mid = 0;
  private listeners = new Set<Listener>();
  private retry = 0;
  version = 0;
  state: "connecting" | "live" | "offline" = "connecting";
  lastWrite?: { name: string; ms: number; serverMs: number };

  constructor(private url: string) {
    this.connect();
    setInterval(() => this.gc(), 500);
  }

  onChange(f: Listener) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private scheduled = false;
  private emit() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const f of this.listeners) f();
    });
  }

  private connect() {
    this.state = "connecting";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.state = "live";
      for (const s of this.subs.values()) this.send(s);
      this.emit();
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      this.state = "offline";
      this.emit();
      setTimeout(() => this.connect(), Math.min(250 * 2 ** this.retry++, 5000));
    };
  }

  private outbox: Sub[] = [];
  /** Subscriptions made in the same tick go out as one message (one fault round server-side). */
  private send(s: Sub) {
    s.sentAt = performance.now();
    this.outbox.push(s);
    if (this.outbox.length === 1)
      queueMicrotask(() => {
        const list = this.outbox.splice(0).filter((x) => this.subs.get(x.id) === x);
        if (list.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "subs", list: list.map((x) => ({ id: x.id, q: x.q })) }));
      });
  }

  /** Subscribe (or re-point) `id` at query `q`. Returns the live subscription. */
  sub(id: string, q: any, seed?: { rows?: Row[]; count?: number }): Sub {
    const key = JSON.stringify(q);
    const cur = this.subs.get(id);
    if (cur && cur.key === key) return cur;
    const s: Sub = { id, q, key, rows: new Map(), ready: false, updates: 0, sentAt: performance.now() };
    if (seed?.rows) {
      for (const r of seed.rows) s.rows.set(r.id, r);
      s.ready = true;
    }
    if (seed?.count !== undefined) {
      s.count = seed.count;
      s.ready = true;
    }
    this.subs.set(id, s);
    this.send(s);
    this.emit();
    return s;
  }

  unsub(id: string) {
    if (!this.subs.delete(id)) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "unsub", id }));
  }

  get(id: string) {
    return this.subs.get(id);
  }

  all() {
    return [...this.subs.values()];
  }

  private onMessage(m: any) {
    if (m.t === "hello") this.version = Math.max(this.version, m.version ?? 0);
    if (m.t === "reset") {
      // The demo was reset to its base: start every subscription over.
      this.version = m.version;
      this.pending = [];
      for (const s of this.subs.values()) this.send(s);
    }
    if (m.t === "snap") {
      const s = this.subs.get(m.id);
      if (!s) return;
      s.rows = new Map((m.rows ?? []).map((r: Row) => [r.id, r]));
      s.count = m.count;
      s.complete = m.complete;
      s.ready = true;
      s.stats = m.stats;
      s.firstMs = performance.now() - s.sentAt;
      this.version = Math.max(this.version, m.version ?? 0);
    }
    if (m.t === "snaps") {
      for (const one of m.list) this.onMessage({ t: "snap", ...one, version: m.version, stats: m.stats, batch: m.list.length });
      return;
    }
    if (m.t === "poke") {
      for (const [id, ops] of Object.entries(m.subs as Record<string, any[]>)) {
        const s = this.subs.get(id);
        if (!s) continue;
        s.updates++;
        for (const op of ops) {
          if (op[0] === "a" || op[0] === "e") s.rows.set(op[1], op[2]);
          else if (op[0] === "r") s.rows.delete(op[1]);
          else if (op[0] === "c") s.count = op[1];
        }
      }
      this.version = Math.max(this.version, m.version);
      this.gc();
    }
    if (m.t === "error") console.warn("query error", m.id, m.message);
    this.emit();
  }

  /** Drop optimistic entries the server has caught up with. */
  private gc() {
    const before = this.pending.length;
    const now = performance.now();
    this.pending = this.pending.filter((p) => p.version === undefined || (this.version < p.version && now - (p.doneAt ?? now) < 3000));
    if (this.pending.length !== before) this.emit();
  }

  /** Run a named mutator optimistically. */
  async mutate(name: string, args: Row, predicted: Omit<Pending, "mid">, user: string) {
    const p: Pending = { mid: ++this.mid, ...predicted };
    this.pending.push(p);
    this.emit();
    const t0 = performance.now();
    try {
      const res = await fetch("/api/mutate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, args, user }) });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      p.version = body.version;
      p.doneAt = performance.now();
      this.lastWrite = { name, ms: performance.now() - t0, serverMs: body.ms };
      this.gc();
      return body;
    } catch (e) {
      this.pending = this.pending.filter((x) => x !== p);
      this.emit();
      throw e;
    }
  }

  // ---------------------------------------------------------------- views (server ⊕ optimistic)

  /** Rows of a subscription with optimistic changes applied, filtered and sorted client-side. */
  view(id: string, match?: (r: Row) => boolean, sort?: (a: Row, b: Row) => number, limit?: number): Row[] {
    const s = this.subs.get(id);
    if (!s) return [];
    const rows = new Map(s.rows);
    for (const p of this.pending) {
      if (p.patch) {
        const base = rows.get(p.patch.id) ?? this.findRow(p.patch.id);
        if (base) rows.set(p.patch.id, { ...base, ...p.patch.set });
      }
      if (p.insert) rows.set(p.insert.id, p.insert);
      if (p.remove) rows.delete(p.remove);
      if (p.comment) {
        const parent = rows.get(p.comment.issueId);
        if (parent) {
          const comments = parent.comments ? [...parent.comments.filter((c: Row) => c.id !== p.comment!.id), p.comment] : undefined;
          rows.set(parent.id, { ...parent, comments, commentCount: (parent.commentCount ?? 0) + (s.rows.get(parent.id)?.comments?.some((c: Row) => c.id === p.comment!.id) ? 0 : 1) });
        }
      }
      if (p.uncomment) {
        for (const [k, r] of rows) if (r.comments?.some((c: Row) => c.id === p.uncomment)) rows.set(k, { ...r, comments: r.comments.filter((c: Row) => c.id !== p.uncomment) });
      }
    }
    let out = [...rows.values()];
    if (match) out = out.filter(match);
    if (sort) out.sort(sort);
    return limit ? out.slice(0, limit) : out;
  }

  count(id: string, delta?: (p: Pending) => number) {
    const s = this.subs.get(id);
    if (s?.count === undefined) return undefined;
    return s.count + (delta ? this.pending.reduce((n, p) => n + delta(p), 0) : 0);
  }

  pendingOps() {
    return this.pending;
  }

  /** Find a row by id in any subscription (to patch a row the current view doesn't hold). */
  findRow(id: string): Row | undefined {
    for (const s of this.subs.values()) {
      const r = s.rows.get(id);
      if (r) return r;
    }
    return undefined;
  }
}
