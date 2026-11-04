// Feature checks run on both targets, statement by statement; the last statement's rows are the
// answer. Same rows from Neon and the object = the feature works the same.
import type { Target } from "./bench";

const big = JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => ({ i, name: `item ${i}`, tags: ["a", "b", String(i % 9)] })) });

export const CHECKS: Record<string, string[]> = {
  jsonb_ops: [`select '{"a":{"b":[1,2,3]}}'::jsonb #> '{a,b}' ->> 1 as x, '{"a":1}'::jsonb ? 'a' as has, '{"a":1,"b":2}'::jsonb - 'a' as minus, '{"a":1}'::jsonb || '{"c":3}' as cat`],
  jsonb_set: [`select jsonb_set('{"a":{"b":1}}', '{a,b}', '42') s, jsonb_insert('{"a":[1,2]}', '{a,0}', '0') i, '{"a":{"b":1,"c":2}}'::jsonb #- '{a,c}' d, jsonb_strip_nulls('{"a":null,"b":1}') n`],
  jsonpath: [`select jsonb_path_query_array('{"a":[1,5,10]}', '$.a[*] ? (@ > 2)') q, jsonb_path_exists('{"u":{"age":30}}', '$.u ? (@.age >= 18)') e, '{"a":[1,5]}'::jsonb @? '$.a[*] ? (@ == 5)' atq`],
  sql_json: [`select json_value('{"a":{"b":"x"}}', '$.a.b') v, json_query('{"a":[1,2]}', '$.a') q, json_exists('{"a":1}', '$.a') e`],
  json_table: [`select * from json_table('[{"id":1,"n":"a"},{"id":2,"n":"b"}]'::jsonb, '$[*]' columns (id int path '$.id', n text path '$.n')) t`],
  jsonb_recordset: [`select * from jsonb_to_recordset('[{"a":1,"b":"x"},{"a":2,"b":"y"}]') as r(a int, b text)`],
  jsonb_agg: [`select jsonb_agg(g order by g) a, jsonb_object_agg('k' || g, g) o, json_build_object('n', 1) b from generate_series(1, 3) g`],
  jsonb_gin: [
    "drop table if exists c_gin",
    "create table c_gin (id int primary key, d jsonb not null)",
    `insert into c_gin select g, jsonb_build_object('tags', jsonb_build_array('t' || (g % 10)), 'n', g) from generate_series(1, 2000) g`,
    "create index c_gin_d on c_gin using gin (d)",
    "analyze c_gin",
    `select (select count(*)::int from c_gin where d @> '{"tags":["t3"]}') contains, (select count(*)::int from c_gin where d ? 'n') has_key, (select count(*)::int from c_gin where d->'tags' ?| array['t1','t2']) any_of`,
  ],
  jsonb_generated: [
    "drop table if exists c_gen",
    "create table c_gen (id int, d jsonb, email text generated always as (lower(d->>'email')) stored)",
    `insert into c_gen (id, d) values (1, '{"email":"A@B.com"}')`,
    "select email from c_gen",
  ],
  jsonb_big_toast: [
    "drop table if exists c_big",
    "create table c_big (id int, d jsonb)",
    `insert into c_big values (1, '${big}'::jsonb)`,
    "select jsonb_array_length(d->'items') n, pg_column_size(d) > 10000 toasted, d->'items'->4999->>'name' last from c_big",
  ],
  text_array: [
    "drop table if exists c_arr",
    "create table c_arr (id int, tags text[] not null default '{}')",
    "insert into c_arr values (1, '{a,b}'), (2, '{b,c}'), (3, array['c','d'])",
    "create index c_arr_tags on c_arr using gin (tags)",
    "select (select array_agg(id order by id) from c_arr where tags && '{b}') overlap, (select array_agg(id order by id) from c_arr where tags @> array['c']) contains, (select count(*)::int from c_arr, unnest(tags)) unnested, array_position('{x,y}'::text[], 'y') pos",
  ],
  enum: [
    "drop table if exists c_enum",
    "drop type if exists c_mood",
    "create type c_mood as enum ('sad', 'ok')",
    "alter type c_mood add value 'happy'",
    "create table c_enum (m c_mood)",
    "insert into c_enum values ('happy'), ('sad')",
    "select array_agg(m order by m) from c_enum",
  ],
  partial_expr_index: [
    "drop table if exists c_idx",
    "create table c_idx (id int, email text, deleted_at timestamptz)",
    "create unique index c_idx_email on c_idx (lower(email)) where deleted_at is null",
    "insert into c_idx values (1, 'A@x.com', null), (2, 'a@X.com', now())",
    "select count(*)::int from c_idx where lower(email) = 'a@x.com' and deleted_at is null",
  ],
  upsert: [
    "drop table if exists c_up",
    "create table c_up (k text primary key, n int, updated_at timestamptz)",
    "insert into c_up values ('a', 1, now())",
    "insert into c_up values ('a', 5, now()) on conflict (k) do update set n = c_up.n + excluded.n where c_up.n < 10 returning n",
  ],
  merge: [
    "drop table if exists c_merge",
    "create table c_merge (k int primary key, v text)",
    "insert into c_merge values (1, 'old')",
    "merge into c_merge t using (values (1, 'new'), (2, 'ins')) s(k, v) on t.k = s.k when matched then update set v = s.v when not matched then insert values (s.k, s.v)",
    "select array_agg(v order by k) from c_merge",
  ],
  for_update_skip_locked: [
    "drop table if exists c_q",
    "create table c_q (id int primary key, state text)",
    "insert into c_q select g, 'ready' from generate_series(1, 5) g",
    "with j as (select id from c_q where state = 'ready' order by id limit 2 for update skip locked) update c_q set state = 'taken' from j where c_q.id = j.id returning c_q.id",
  ],
  advisory_lock: ["select pg_advisory_xact_lock(hashtext('job:1')) is null as locked, pg_try_advisory_lock(42) got, pg_advisory_unlock(42) released"],
  cte_window_lateral: [
    `with recursive r(n) as (select 1 union all select n + 1 from r where n < 5)
     select n, sum(n) over (order by n) running, rank() over (order by n desc) rk, l.sq from r, lateral (select n * n as sq) l order by n`,
  ],
  fts: [
    "drop table if exists c_fts",
    "create table c_fts (id int, body text, tsv tsvector generated always as (to_tsvector('english', body)) stored)",
    "insert into c_fts values (1, 'The quick brown foxes jumped'), (2, 'Lazy dogs sleeping')",
    "create index c_fts_i on c_fts using gin (tsv)",
    "select id, ts_rank(tsv, websearch_to_tsquery('english', 'fox jump')) > 0 hit from c_fts where tsv @@ websearch_to_tsquery('english', 'fox jump')",
  ],
  uuid_identity_seq: [
    "drop table if exists c_ids",
    "create table c_ids (id bigint generated always as identity, u uuid default gen_random_uuid(), v7 uuid default uuidv7())",
    "insert into c_ids default values",
    "select id, length(u::text) ulen, uuid_extract_version(v7) ver from c_ids",
  ],
  timezones: [`select ('2026-03-08 06:59:00+00'::timestamptz at time zone 'America/New_York')::text ny, ('2026-11-03 12:00+00'::timestamptz at time zone 'Asia/Tokyo')::text tk, date_trunc('month', '2026-11-03'::date)::date::text m`],
  collation_icu: [`select array_agg(x order by x collate "en-x-icu") from unnest(array['b','A','a','B']) x`],
  unicode: [`select lower('ÄÖÜ ΣΑΣ') l, upper('straße') u, 'naïve' ~* 'NAÏVE' re, regexp_replace('a1b22c333', '\\d+', '#', 'g') rr, normalize('é', nfd) = 'é' n`],
  plpgsql_trigger: [
    "drop table if exists c_trg",
    "create table c_trg (id int, updated_at timestamptz, n int default 0)",
    "create or replace function c_touch() returns trigger language plpgsql as $$ begin new.updated_at := '2000-01-01'; new.n := old.n + 1; return new; end $$",
    "create trigger c_trg_touch before update on c_trg for each row execute function c_touch()",
    "insert into c_trg (id) values (1)",
    "update c_trg set id = 1",
    "select updated_at::date::text d, n from c_trg",
  ],
  do_block: ["do $$ begin if not exists (select 1 from pg_type where typname = 'c_never') then perform 1; end if; end $$", "select 'ran' r"],
  rls_roles: [
    "drop table if exists c_rls",
    "create table c_rls (owner text, v int)",
    "alter table c_rls enable row level security",
    "create policy c_own on c_rls using (owner = current_setting('app.user', true))",
    "select relrowsecurity from pg_class where relname = 'c_rls'",
  ],
  create_role: ["drop role if exists c_reader", "create role c_reader nologin", "select count(*)::int from pg_roles where rolname = 'c_reader'"],
  numeric: [`select 12345678901234567890.123456789::numeric * 2 n, (2::numeric ^ 100)::text p, 9223372036854775807::bigint b, 0.1::float8 + 0.2 f`],
  information_schema: [`select count(*)::int > 0 ok from information_schema.columns where table_schema = 'pg_catalog'`],
  ext_pgcrypto: ["create extension if not exists pgcrypto", "select encode(digest('abc', 'sha256'), 'hex') h"],
  ext_uuid_ossp: [`create extension if not exists "uuid-ossp"`, "select length(uuid_generate_v4()::text) l"],
  ext_pg_trgm: ["create extension if not exists pg_trgm", "select similarity('postgres', 'postgis') > 0.3 s"],
  ext_citext: ["create extension if not exists citext", "select 'ABC'::citext = 'abc' eq"],
  ext_hstore: ["create extension if not exists hstore", "select 'a=>1'::hstore -> 'a' v"],
  ext_vector: ["create extension if not exists vector", "select '[1,2,3]'::vector <-> '[1,2,4]' d"],
  ext_postgis: ["create extension if not exists postgis", "select st_astext(st_point(1, 2)) p"],
};

export async function runCheck(t: Target, name: string) {
  const stmts = CHECKS[name];
  let rows: unknown[] = [];
  try {
    for (const s of stmts) rows = await t.q(s);
    return { name, ok: true, rows: JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Date ? v.toISOString() : v))) };
  } catch (e) {
    return { name, ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  }
}
