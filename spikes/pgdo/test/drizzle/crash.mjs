// Crash consistency: transfers in real transactions while the object is killed over and over.
//   DATABASE_URL=postgres://postgres:<token>@localhost:6543/<db> node crash.mjs [seconds] [clients]
// Kills: /evict (ctx.abort: drops the object, usually between statements of open transactions)
// and a query that blows the isolate's 128 MB (the isolate dies wherever Postgres happens to be).
// Afterwards: money is conserved, every COMMIT the server acknowledged is there, and amcheck
// finds every index consistent with its table.
import pg from "pg";

const url = process.env.DATABASE_URL;
const seconds = Number(process.argv[2] ?? 120), clients = Number(process.argv[3] ?? 10);
const db = new URL(url).pathname.slice(1);
const token = decodeURIComponent(new URL(url).password);
const N = 1000, START = 1000;
const KILLS = (process.env.KILLS ?? "evict,oom").split(","); // which ways to kill the object

async function connect() {
  for (;;) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30000 });
    c.on("error", () => {});
    try {
      await c.connect();
      return c;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const setup = await connect();
await setup.query("create extension if not exists amcheck");
await setup.query("drop table if exists ledger; drop table if exists acct");
await setup.query("create table acct (id int primary key, bal bigint not null)");
await setup.query("create table ledger (txid text primary key, src int not null, dst int not null, amount int not null)");
await setup.query("create index ledger_src on ledger (src)");
await setup.query(`insert into acct select g, ${START} from generate_series(1, ${N}) g`);
await setup.end();

const acked = new Set();
let attempts = 0, failures = 0, kills = { evict: 0, oom: 0 };
const until = Date.now() + seconds * 1000;

async function worker(w) {
  let c = await connect(), n = 0;
  while (Date.now() < until) {
    const txid = `w${w}-${n++}`, a = 1 + Math.floor(Math.random() * N), b = 1 + Math.floor(Math.random() * N), amt = 1 + Math.floor(Math.random() * 50);
    attempts++;
    try {
      await c.query("begin");
      await c.query("update acct set bal = bal - $1 where id = $2", [amt, a]);
      await c.query("update acct set bal = bal + $1 where id = $2", [amt, b]);
      await c.query("insert into ledger values ($1, $2, $3, $4)", [txid, a, b, amt]);
      await c.query("commit");
      acked.add(txid); // the server said COMMIT: this must survive anything
    } catch {
      failures++;
      try { await c.end(); } catch {}
      c = await connect();
    }
  }
  await c.end().catch(() => {});
}

async function killer() {
  const U = "https://pagedb-pg-spike.do-pool-lab.workers.dev";
  while (Date.now() < until - 5000) {
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 4000));
    if (KILLS.includes("evict") && (!KILLS.includes("oom") || Math.random() < 0.5)) {
      kills.evict++;
      await fetch(`${U}/evict?db=${encodeURIComponent(db)}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => {});
    } else {
      kills.oom++;
      const c = await connect();
      await c.query("select length(string_agg(repeat(md5(g::text), 1000), '')) from generate_series(1, 20000) g").catch(() => {});
      await c.end().catch(() => {});
    }
  }
}

const t0 = Date.now();
await Promise.all([killer(), ...Array.from({ length: clients }, (_, i) => worker(i))]);

const v = await connect();
const [{ total }] = (await v.query("select sum(bal)::bigint as total from acct")).rows;
const ledger = new Set((await v.query("select txid from ledger")).rows.map((r) => r.txid));
const lost = [...acked].filter((t) => !ledger.has(t));
const balancesMatchLedger = (await v.query(`
  select count(*)::int as bad from acct a left join (
    select id, sum(d) as d from (select src as id, -amount as d from ledger union all select dst, amount from ledger) x group by id
  ) l using (id) where a.bal <> ${START} + coalesce(l.d, 0)`)).rows[0].bad;
const idx = (await v.query("select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid join pg_class t on t.oid = i.indrelid where t.relname in ('acct', 'ledger')")).rows;
const amcheck = [];
for (const { relname } of idx) {
  try {
    await v.query("select bt_index_check($1::regclass, true)", [relname]);
    amcheck.push(`${relname} ok`);
  } catch (e) {
    amcheck.push(`${relname} FAILED: ${e.message}`);
  }
}
await v.end();
const ok = Number(total) === N * START && lost.length === 0 && balancesMatchLedger === 0 && amcheck.every((s) => s.endsWith("ok"));
console.log(JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), kills, attempts, committedAcked: acked.size, failed: failures, ledgerRows: ledger.size, total: Number(total), expected: N * START, ackedButLost: lost.length, accountsNotMatchingLedger: balancesMatchLedger, amcheck, verdict: ok ? "CONSISTENT" : "INCONSISTENT" }, null, 1));
process.exit(ok ? 0 : 1);
