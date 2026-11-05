// pgbench's workloads, driven from a Worker next to the database: a minimal Postgres wire client
// over a WebSocket straight to the object's /wire endpoint, one statement per round trip (as
// pgbench does by default), so the numbers measure the database, not the path to a laptop.
const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(type: string, body: Uint8Array) {
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}
const cstr = (s: string) => {
  const b = enc.encode(s);
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  return out;
};

export class WireClient {
  private buf = new Uint8Array(0);
  private waiters: (() => void)[] = [];
  private closed = false;
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const d = new Uint8Array(e.data as ArrayBuffer);
      const b = new Uint8Array(this.buf.length + d.length);
      b.set(this.buf);
      b.set(d, this.buf.length);
      this.buf = b;
      this.waiters.splice(0).forEach((w) => w());
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static async connect(stub: { fetch(r: Request): Promise<Response> }, db: string, password: string) {
    const r = await stub.fetch(new Request(`https://pg/wire?db=${encodeURIComponent(db)}`, { headers: { upgrade: "websocket" } }));
    const ws = r.webSocket;
    if (!ws) throw new Error(`no websocket (${r.status})`);
    ws.accept();
    (ws as WebSocket & { binaryType: string }).binaryType = "arraybuffer";
    const c = new WireClient(ws);
    const params = [...cstr("user"), ...cstr("postgres"), ...cstr("database"), ...cstr(db), 0];
    const startup = new Uint8Array(8 + params.length);
    new DataView(startup.buffer).setInt32(0, startup.length);
    new DataView(startup.buffer).setInt32(4, 196608);
    startup.set(params, 8);
    ws.send(startup);
    for (;;) {
      const [t, body] = await c.next();
      if (t === "R" && new DataView(body.buffer, body.byteOffset).getInt32(0) === 3) ws.send(frame("p", cstr(password)));
      else if (t === "E") throw new Error(`connect: ${errorText(body)}`);
      else if (t === "Z") return c;
    }
  }

  private async next(): Promise<[string, Uint8Array]> {
    for (;;) {
      if (this.buf.length >= 5) {
        const len = new DataView(this.buf.buffer, this.buf.byteOffset).getInt32(1);
        if (this.buf.length >= len + 1) {
          const t = String.fromCharCode(this.buf[0]);
          const body = this.buf.slice(5, len + 1);
          this.buf = this.buf.subarray(len + 1);
          return [t, body];
        }
      }
      if (this.closed) throw new Error("connection closed");
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  /** One simple query; the first column of each row, and the error if there was one. */
  async query(sql: string): Promise<{ rows: (string | null)[]; error?: string }> {
    this.ws.send(frame("Q", cstr(sql)));
    const rows: (string | null)[] = [];
    let error: string | undefined;
    for (;;) {
      const [t, body] = await this.next();
      if (t === "D") {
        const dv = new DataView(body.buffer, body.byteOffset);
        const n = dv.getInt32(2);
        rows.push(n < 0 ? null : dec.decode(body.subarray(6, 6 + n)));
      } else if (t === "E") error = errorText(body);
      else if (t === "Z") return { rows, error };
    }
  }

  close() {
    try {
      this.ws.send(frame("X", new Uint8Array(0)));
      this.ws.close();
    } catch {}
  }
}

function errorText(body: Uint8Array) {
  const s = dec.decode(body);
  return s.split("\0").find((f) => f.startsWith("M"))?.slice(1) ?? s;
}

const rand = (n: number) => 1 + Math.floor(Math.random() * n);

/** pgbench's built-in scripts. */
export function script(mode: string, scale: number): string[] {
  const aid = rand(100000 * scale), bid = rand(scale), tid = rand(10 * scale), delta = Math.floor(Math.random() * 10001) - 5000;
  if (mode === "select") return [`SELECT abalance FROM pgbench_accounts WHERE aid = ${aid}`];
  return [
    "BEGIN",
    `UPDATE pgbench_accounts SET abalance = abalance + ${delta} WHERE aid = ${aid}`,
    `SELECT abalance FROM pgbench_accounts WHERE aid = ${aid}`,
    `UPDATE pgbench_tellers SET tbalance = tbalance + ${delta} WHERE tid = ${tid}`,
    `UPDATE pgbench_branches SET bbalance = bbalance + ${delta} WHERE bid = ${bid}`,
    `INSERT INTO pgbench_history (tid, bid, aid, delta, mtime) VALUES (${tid}, ${bid}, ${aid}, ${delta}, CURRENT_TIMESTAMP)`,
    "END",
  ];
}

/** Run `clients` connections for `seconds`; transactions per second and latency. */
export async function bench(connect: () => Promise<WireClient>, opts: { clients: number; seconds: number; mode: string; scale: number }) {
  const lat: number[] = [];
  let errors = 0, firstError: string | undefined;
  const clients = await Promise.all(Array.from({ length: opts.clients }, () => connect()));
  const t0 = Date.now(), until = t0 + opts.seconds * 1000;
  await Promise.all(
    clients.map(async (c) => {
      while (Date.now() < until) {
        const s = Date.now();
        let failed = false;
        for (const sql of script(opts.mode, opts.scale)) {
          const r = await c.query(sql);
          if (r.error) {
            failed = true;
            firstError ??= r.error;
          }
        }
        if (failed) {
          errors++;
          await c.query("ROLLBACK");
        } else lat.push(Date.now() - s);
      }
    }),
  );
  const wall = (Date.now() - t0) / 1000;
  clients.forEach((c) => c.close());
  lat.sort((a, b) => a - b);
  const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? null;
  return { mode: opts.mode, clients: opts.clients, seconds: +wall.toFixed(1), transactions: lat.length, tps: +(lat.length / wall).toFixed(1), p50: p(0.5), p90: p(0.9), p99: p(0.99), errors, firstError };
}

/** pgbench -i, in chunks a request can finish: tables and keys first, then accounts in ranges. */
export function initStatements(scale: number, from: number, to: number) {
  const out: string[] = [];
  if (from === 1) {
    out.push(
      "DROP TABLE IF EXISTS pgbench_history, pgbench_tellers, pgbench_accounts, pgbench_branches",
      "CREATE TABLE pgbench_branches (bid int primary key, bbalance int, filler char(88)) WITH (fillfactor=100)",
      "CREATE TABLE pgbench_tellers (tid int primary key, bid int, tbalance int, filler char(84)) WITH (fillfactor=100)",
      "CREATE TABLE pgbench_accounts (aid int primary key, bid int, abalance int, filler char(84)) WITH (fillfactor=100)",
      "CREATE TABLE pgbench_history (tid int, bid int, aid int, delta int, mtime timestamp, filler char(22))",
      `INSERT INTO pgbench_branches (bid, bbalance) SELECT g, 0 FROM generate_series(1, ${scale}) g`,
      `INSERT INTO pgbench_tellers (tid, bid, tbalance) SELECT g, (g - 1) / 10 + 1, 0 FROM generate_series(1, ${10 * scale}) g`,
    );
  }
  out.push(`INSERT INTO pgbench_accounts (aid, bid, abalance, filler) SELECT g, (g - 1) / 100000 + 1, 0, '' FROM generate_series(${from}, ${to}) g ON CONFLICT DO NOTHING`);
  return out;
}
