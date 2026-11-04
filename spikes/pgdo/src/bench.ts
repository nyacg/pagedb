// Same workloads against Neon (its serverless driver over HTTP, from this Worker) and against a
// PgObject (an RPC to the Durable Object), timed here at the edge: what an app in a Worker sees.
import { neon } from "@neondatabase/serverless";

export type Stmt = { sql: string; params?: unknown[] };
export interface Target {
  name: string;
  /** One statement, one round trip. */
  q(sql: string, params?: unknown[]): Promise<unknown[]>;
  /** Several statements as one transaction, one round trip. */
  tx(stmts: Stmt[]): Promise<unknown[][]>;
}

export function neonTarget(url: string): Target {
  const sql = neon(url);
  return {
    name: "neon",
    q: (text, params = []) => sql.query(text, params) as Promise<unknown[]>,
    tx: (stmts) => sql.transaction(stmts.map((s) => sql.query(s.sql, s.params ?? []))) as Promise<unknown[][]>,
  };
}

export const SETUP: Stmt[] = [
  { sql: "create table if not exists acct (id int primary key, bal bigint not null default 0, note text)" },
  { sql: "create table if not exists docs (id int primary key, owner int not null, data jsonb not null)" },
  { sql: "create index if not exists docs_gin on docs using gin (data jsonb_path_ops)" },
  { sql: "create table if not exists scratch (id int, data jsonb)" },
  { sql: "insert into acct (id, note) select g, 'n' || g from generate_series(1, 100000) g on conflict do nothing" },
  {
    sql: `insert into docs select g, g % 1000, jsonb_build_object('name', 'doc ' || g, 'tags', jsonb_build_array('t' || (g % 50), 't' || (g % 7)), 'n', g,
          'nested', jsonb_build_object('score', g % 100, 'flags', jsonb_build_array(g % 2 = 0, g % 3 = 0))) from generate_series(1, 100000) g on conflict do nothing`,
  },
  { sql: "analyze" },
];

let seed = 1;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n) + 1;

/** One operation per kind; each returns after its result arrives. */
export const OPS: Record<string, (t: Target, i: number) => Promise<unknown>> = {
  ping: (t) => t.q("select 1"),
  ping_param: (t) => t.q("select $1::int x", [1]),
  read_fixed: (t) => t.q("select bal, note from acct where id = $1", [4242]),
  read_literal: (t) => t.q("select bal, note from acct where id = 4242"),
  seqscan: (t) => t.q("select count(*)::int c from docs where data->>'name' like '%99%'"),
  sort: (t) => t.q("select id from docs order by data->>'name' desc limit 10"),
  read: (t) => t.q("select bal, note from acct where id = $1", [rnd(100000)]),
  write: (t) => t.q("update acct set bal = bal + 1 where id = $1", [rnd(100000)]),
  insert_json: (t, i) =>
    t.q("insert into docs values ($1, $2, $3::jsonb) on conflict (id) do update set data = excluded.data", [200000 + i, i % 1000, JSON.stringify({ name: `new ${i}`, tags: [`t${i % 50}`], n: i, nested: { score: i % 100 } })]),
  json_contains: (t) => t.q("select count(*)::int c from docs where data @> $1::jsonb", [JSON.stringify({ tags: [`t${rnd(50) - 1}`] })]),
  json_path: (t) => t.q("select id, data->>'name' as name from docs where owner = $1 and (data->'nested'->>'score')::int > 50 order by id limit 10", [rnd(1000) - 1]),
  txn: (t) => {
    const a = rnd(100000), b = rnd(100000);
    return t.tx([
      { sql: "update acct set bal = bal - 1 where id = $1", params: [a] },
      { sql: "update acct set bal = bal + 1 where id = $1", params: [b] },
      { sql: "select bal from acct where id = $1", params: [a] },
    ]);
  },
  agg: (t) => t.q("select owner % 10 as g, count(*)::int n, avg((data->>'n')::int)::int a from docs group by 1 order by 1"),
  bulk_1k: (t, i) => t.tx([{ sql: "insert into scratch select g, jsonb_build_object('g', g, 'i', $1::int) from generate_series(1, 1000) g", params: [i] }, { sql: "delete from scratch where (data->>'i')::int < $1::int - 5", params: [i] }]),
};

export async function run(t: Target, op: string, n: number) {
  const f = OPS[op];
  if (!f) throw new Error(`unknown op ${op}`);
  const ms: number[] = [];
  let err: string | undefined;
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      await f(t, i);
    } catch (e) {
      err = String((e as Error).message ?? e).slice(0, 300);
      break;
    }
    ms.push(Date.now() - t0);
  }
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { target: t.name, op, n: ms.length, p50: p(0.5), p90: p(0.9), min: s[0], max: s.at(-1), ...(err ? { error: err } : {}) };
}

/** Postgres's own execution time (EXPLAIN ANALYZE) for representative queries: compute only. */
export const EXPLAIN: Record<string, Stmt> = {
  read: { sql: "select bal, note from acct where id = $1", params: [4242] },
  write: { sql: "update acct set bal = bal + 1 where id = $1", params: [4242] },
  json_contains: { sql: "select count(*) from docs where data @> $1::jsonb", params: [JSON.stringify({ tags: ["t7"] })] },
  json_path: { sql: "select id, data->>'name' from docs where owner = $1 and (data->'nested'->>'score')::int > 50 order by id limit 10", params: [42] },
  agg: { sql: "select owner % 10, count(*), avg((data->>'n')::int) from docs group by 1 order by 1" },
  seqscan: { sql: "select count(*) from docs where data->>'name' like '%99%'" },
  sort: { sql: "select id from docs order by data->>'name' desc limit 10" },
};

export async function explain(t: Target, name: string, n = 5) {
  const s = EXPLAIN[name];
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const rows = (await t.q(`explain (analyze, format json) ${s.sql}`, s.params)) as Record<string, any>[];
    const plan = rows[0]["QUERY PLAN"];
    const j = typeof plan === "string" ? JSON.parse(plan) : plan;
    times.push(j[0]["Execution Time"]);
  }
  times.sort((a, b) => a - b);
  return { target: t.name, query: name, execMs: +times[Math.floor(times.length / 2)].toFixed(3) };
}
