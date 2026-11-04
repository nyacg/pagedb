# Postgres in a Durable Object: spike findings (Nov 3, 2026)

**Verdict: it works, and it scales out well.** Postgres 18.6 (PGlite 0.5.15, compiled to
WebAssembly) runs inside a Cloudflare Durable Object with its data directory in the object's own
SQLite. It survives restarts, branches copy-on-write from template images in R2, and passes 34 of
36 compatibility checks run side by side with Neon, including all the JSONB ones.

Sauna's 153 drizzle migrations apply cleanly and produce a schema identical to Neon's.

With one database per tenant, 1,000 tenants did **9,080 ops/s at p50 16 ms**. Neon's endpoint
peaked at **~2,900 ops/s at p50 300 ms** under the same load. One object is one CPU core, though:
a single database tops out around 700–900 ops/s.

Live: `https://pagedb-pg-spike.do-pool-lab.workers.dev/sql?db=<name>[&image=hn150|tenant|sauna]` (POST the SQL).

## 1. Against Neon

How it was measured:
- **Neon:** the user's endpoint, Postgres 18.6 in us-east-2, through its serverless HTTP driver.
- **Durable Object:** RPC to the object.
- Both are timed in the same Worker. The Worker ran in SJC because the benchmark client was in California.

### One client, back to back (p50 ms)

| op | Neon (us-east-2) | DO near the Worker | DO pinned to `enam` |
|---|---|---|---|
| `select 1` | 61 | 6 | – |
| point read | 65 | 11–24 | 105 |
| single-row update | 86 | 24 | 93 |
| upsert a JSONB doc | 62 | 18 | 90 |
| JSONB `@>` over a GIN index (100k docs) | 89 | 46–51 | 102 |
| JSONB path filter + order by | 85 | 30–62 | 105 |
| 2 updates + 1 read, one transaction | 64 | 23 | 91 |
| group by over 100k JSONB docs | 101 | 136–179 | 180 |
| insert 1,000 rows (one transaction) | 209 | 46 | 105 |
| bulk-load 200k rows (setup) | 3.0 s | 21–30 s | |

How to read it:
- **Latency is geography.** A DO is created next to whoever touches it first and answers in one
  hop. Neon is one region away. Pinned to the east (`enam`), the DO pays the cross-country trip
  plus its own CPU, so it's slower than Neon from California. For a user next to us-east-2, Neon
  would answer in ~5–15 ms.
- **Neon's CPU is 3–8× faster.** Postgres execution time (`EXPLAIN ANALYZE` on Neon; round trip
  minus `select 1` for the DO, because Workers freeze the clock during CPU work):
  - group by: Neon 21–28 ms, DO ~125 ms
  - JSONB `like` scan: Neon ~10 ms, DO ~85 ms
  - sort: Neon ~26 ms, DO ~85 ms

  The DO is wasm on a shared core with tiny buffers. Bulk loads and analytics belong on Neon.

### Many clients

Each client runs a mix back to back: 60% point reads, 20% updates, 10% two-update transactions and
10% JSONB `@>` lookups. On the DO side, each client is a tenant with its own object (10k-row
tables, branched from the `tenant` image). On the Neon side, all clients share the one database.

| clients | DO, one object per tenant | Neon, one endpoint |
|---|---|---|
| 25 | 555 ops/s, p50 17 ms | 320 ops/s, p50 69 ms |
| 100 | 1,684 ops/s, p50 17 ms | 1,228 ops/s, p50 66 ms |
| 250 | 4,647 ops/s, p50 16 ms | 2,734 ops/s, p50 72 ms |
| 500 | 7,434 ops/s, p50 17 ms | 2,332 ops/s, p50 166 ms |
| 1,000 | **9,080 ops/s, p50 16 ms, p99 80 ms** | **2,959 ops/s, p50 298 ms, p99 1.0 s** |
| 2,000 | 22,945 ops/s, p50 17 ms, p99 117 ms | 2,478 ops/s, p50 127 ms, p99 10.4 s |

What saturates, and what fails:
- **Neon saturates at ~3,000 ops/s.** At 2,000 clients it rejects connections ("Too many database
  connection attempts") and sees deadlocks, normal for concurrent transfers in Postgres. A bigger
  compute would raise that ceiling.
- **The DO side keeps scaling** because each tenant has its own core.
- **The DO side's failures are isolate memory resets**, between 0 and 0.8% of ops (section 4).
- **One hot database is the DO's ceiling.** With 100 clients on one object: 914 reads/s, 664
  writes/s, 709 ops/s on the mix. Neon managed 943 reads/s at the same concurrency, and it can
  scale its compute up; an object can't.

## 2. Compatibility: what works, what's missing

`src/compat.ts` runs 36 feature checks on both targets and compares the rows: `/vs?target=neon|do&compat`.

**Same results on both (34/36):**

- **JSONB:**
  - operators (`#>`, `->>`, `?`, `-`, `||`, `#-`), `jsonb_set` / `jsonb_insert`
  - jsonpath (`@?`, `jsonb_path_query_array`), SQL/JSON (`json_value`, `json_query`, `JSON_TABLE`)
  - `jsonb_to_recordset`, aggregates
  - GIN indexes (`@>`, `?`, `?|`)
  - generated columns from JSONB
  - a 5,000-element TOASTed document
- **Arrays and types:** `text[]` with GIN (`&&`, `@>`), unnest; enums with `ALTER TYPE … ADD VALUE`;
  identity columns, `gen_random_uuid()`, `uuidv7()`; numerics; time zones.
- **Indexes and writes:** partial and expression unique indexes; `ON CONFLICT … DO UPDATE … WHERE`;
  `MERGE`.
- **Locking:** `FOR UPDATE SKIP LOCKED` (a job queue), advisory locks.
- **Queries:** recursive CTEs, window functions, `LATERAL`; full-text search (`websearch_to_tsquery`,
  GIN, `ts_rank`); `information_schema`.
- **Procedural and security:** PL/pgSQL triggers, `DO` blocks; RLS policies, roles.
- **Extensions:** pgcrypto, uuid-ossp, pg_trgm, citext, hstore and **pgvector**. 19 extensions are
  bundled now (below). An HNSW index over 20k 64-dim vectors builds and is used by the planner.

**Missing or different:**

| | |
|---|---|
| ICU collations (`"en-x-icu"`) | not in the build (PGlite has an `icuDataDir` option; untested) |
| postgis | no wasm build available |
| `upper('ß')` | `ẞ` vs Neon's `ß`: libc case tables differ |
| `convert_to(…, 'LATIN1')` | breaks the session (upstream PGlite bug) |

Building a 20k-vector HNSW index reset the isolate once, after the data had committed. Big index
builds need the memory knobs (section 4).

**Extensions in Workers.** PGlite ships contrib as tarballs it fetches at runtime.
`scripts/extract-exts.mjs` unpacks 18 of them plus pgvector at build time:
- each `.so` becomes a precompiled module, which the patched loader swaps in by name;
- the control and SQL files are written into Emscripten's filesystem in `preRun`;
- the shipped `.so` file is a one-byte placeholder, since only the swapped-in module is read.

The bundle is 8.2 MB gzipped, against the 10 MB limit.

**What Neon has that this doesn't (beyond SQL):**
- The Postgres wire protocol, so psql, pgx, Hyperdrive and other drivers just work. Here clients
  speak HTTP/RPC; Workers can't accept TCP.
- Concurrency inside one database (many backends, parallel query).
- Compute that scales up past one core.
- Read replicas, point-in-time restore and logical replication.
- postgis and ICU.
- Fast bulk work.
- Databases far bigger than 10 GB (the DO's SQLite limit).

**What this has that Neon doesn't:**
- A database per tenant for the cost of an idle object.
- Placement next to the user.
- Branches that cost ~30 MB, not a copy.
- No connection limits across tenants.

## 3. Could Sauna's database live in one of these?

**Schema: yes.**
- All 153 migrations (683 statements: JSONB, `text[]`, partial and expression indexes, `DO` blocks,
  `CREATE INDEX CONCURRENTLY`, …) apply on both Neon and a DO.
- Hashes of every column, index and constraint definition match exactly: 50 tables, 152 indexes,
  434 constraints.
- Applying them took 29 s on the DO and 43 s on Neon (one round trip per statement).
- A `sauna` template image is in R2, so a new empty Sauna database answers its first query in **2.5 s**.

**All of Sauna in one object: no, for concurrency rather than size.**
- One object serializes every query on one core: ~700 mixed ops/s at best. A heavy query (an
  admin report, a big group by) stalls everyone behind it.
- Sauna runs ~93 transactional code paths over Hyperdrive with up to 1,000 connections, plus a Go
  pgx pool. The Go service would also need a Postgres-wire proxy in front.
- Size isn't known from here. `select pg_database_size(current_database())` on prod would settle
  it; up to a few GB fits.

**Sauna sharded: plausible.** Most tables carry `user_id` (27 tables), `space_id` or
`organization_id`.
- A database per organization or space would hold the tenant data.
- A small global database (or Neon) would keep the cross-tenant tables: users, sessions, OAuth,
  billing, webhooks.
- The schema stays the same in every shard (one template image).
- What you give up: cross-tenant joins and transactions, and admin queries that span tenants.
  Those need fan-out or the analytics copy in ClickHouse.

## 4. Sharding: what the many-tenants runs taught

**Routing needs no directory.** A tenant's object is `getByName(tenantId)`:
- the id is a hash of the name, and Cloudflare's own directory finds the object;
- there's no lookup hop and nothing to cache;
- objects are created next to their first request and evicted when idle (storage stays, memory
  goes);
- a new tenant from the 28 MB `tenant` image answers in ~2.5 s.

**The wall is isolate memory, and the fix is spreading across classes.** Cloudflare packs objects
of one class into shared isolates: 2–5 per isolate under load, with 128 MB per isolate, not per
object. Each object reported its isolate: 1,000 tenants of one class landed in 484 isolates.
Out-of-the-box PGlite takes ~50 MB, so 500 active tenants hit "isolate exceeded its memory limit"
on 20–40% of ops.

Fixes, in the order they helped:

| change | effect |
|---|---|
| wasm heap starts at 16 MB (binary patched), `shared_buffers=4MB`, `max_connections=4` | heap 34 → 24 MB per instance |
| share the 6 MB Postgres file bundle and extension files across instances (MEMFS `canOwn` views) | ~7 MB less per instance |
| block cache 24 → 4 MB, dirty limit 8 → 2 MB | |
| **hash tenants over 8 identical classes** (`PgObject` … `PgObject7`) | 1,000 tenants in 915 isolates rather than 484; errors 19% → 0–0.5% |
| 8 KiB blocks in SQLite instead of 64 KiB (new databases) | a commit rewrites 8 KiB rows, not 64 KiB; one hot object 270 → 709 mixed ops/s, writes no longer reset it |

**Speed versus density.** These are per-op times inside one object for 100k-row tables. The defaults are 4/4.

| block cache / `shared_buffers` | read | update | TPC-B | wasm heap |
|---|---|---|---|---|
| 1 MB / 2 MB | 1.12 ms | 3.49 ms | 5.28 ms | 24.2 MB |
| 4 MB / 4 MB (64 KiB blocks) | 0.46 ms | 1.10 ms | 3.17 ms | 24.2 MB |
| 4 MB / 4 MB (8 KiB blocks, default) | 1.17 ms | 1.61 ms | 3.40 ms | 24–29 MB |
| 24 MB / 8 MB (the original setup) | 0.34 ms | 0.71 ms | 1.97 ms | 29.1 MB |

A per-database `/config?db=…&cacheMB=&sharedBuffers=` lets a big tenant trade density for speed.

**A lost-write bug, found and fixed.** The small cache exposed a bug in `SqliteFS`:
- A freshly written block could be evicted before it was marked dirty, and its write was then
  dropped at flush.
- Postgres reported "unexpected zero page" in an index.
- Dirty blocks now own their bytes and are read before SQLite.
- Verified with `amcheck` (`bt_index_check`) and balance sums after thousands of updates.

**Recommended strategy, for lots of users:**
1. **Database per tenant.** `getByName(tenant)`, hashed over N identical classes. That's the whole
   router. It scales out with tenants, down to zero when idle, and has no connection limits.
2. **Placement.** Let the first request place the object, or pass `locationHint` / jurisdiction
   at creation. To move a tenant, branch it into a new object elsewhere and record the override.
   Overrides are sparse (most tenants never move), so a small table cached in Worker memory is
   enough. Serve it from a directory DO with a version number; an object that receives a request
   it no longer owns answers "stale, refresh".
3. **Tenants that outgrow one core or 10 GB.** Split them inside, by a key (Sauna: `space_id` or
   `user_id`).
   - Ranges go in a per-tenant shard map held by that directory DO and cached in the Worker.
   - Single-key queries go to one shard; others scatter and gather.
   - No cross-shard transactions.
4. **Read scaling.** Branches of an R2 image are cheap read replicas for a snapshot. Live replicas
   need WAL shipping from the primary (not built).
5. **Global and analytical data stays out** of tenant shards: a global database and a warehouse.

## Earlier results

### Postgres in a DO at all (the first four questions)

1. **PGlite runs in a Durable Object** after four patches (no runtime wasm compilation, so
   precompiled shims and side modules; Node detection hidden; memory floor lowered; PGDATA in
   SQLite).
2. **PGDATA lives in the object's SQLite** (`src/sqlitefs.ts`), durable before the reply. The data
   matches an independent run after restarts.
3. **Branches copy-on-write** from a template in R2:
   - a branch of a 240 MB, 1.5M-row image starts in 0.7–2.5 s and stores ~30 MB;
   - a first point lookup takes 3.1–5.5 s (4–5 fetch rounds), then 20 ms;
   - a cold full scan takes 60 s.
4. **A query can't yet wait on R2 mid-statement.** A missing page fails the statement, the object
   fetches it and retries. JSPI (`WebAssembly.Suspending`) is available in workerd and is the
   proper fix.

What it took:
- `scripts/patch-pglite.mjs`: precompiled `addFunction` shims.
- `scripts/extract-libs.mjs` and `scripts/extract-exts.mjs`: Postgres side modules.
- `src/no-node.ts`: hides workerd's `process.versions.node`.
- `scripts/patch-wasm-memory.mjs`: lowers the declared memory minimum (LEB128 in place).

Other measurements:
- **Cold boot** of an existing database from SQLite: 1.3–1.5 s.
- **Big statements:** 1M-row insert 22 s, index build 8.4 s, group by 1.8 s. These need
  `limits.cpu_ms` raised (5 min here).
- **Creating 1,000 tenants at once** is slow: p50 6.8 s, worst 104 s. Each pulls the image's 25 MB
  eager prefix from R2.

## Open problems

- **Isolate memory remains the main risk.**
  - 0–0.8% of ops at 1,000–2,000 active tenants still hit a reset.
  - The first burst of writes after a boot once reset a lone object.
  - Measuring isolate memory directly isn't possible from inside.
  - Next levers: closing idle Postgres instances inside a live object, and more classes.
- **CPU:** 3–8× slower than Neon on scans, sorts and bulk loads.
- **Cold starts:** 1.3 s to boot, 2.5 s to create. Fixes: a smaller eager prefix (lazy catalogs)
  and a colo cache of image ranges.
- **Retry semantics:** a fault on a lazy branch page retries the whole request. JSPI removes this.
- **No wire protocol:** HTTP/RPC only.

## Files

- `src/index.ts` · the Worker and the `PgObject` Durable Object (and its 7 aliases). Routes:
  - `/sql`, `/bench`, `/config`
  - `/vs` (Neon vs DO: ops, `&compat`, `&explain`, POSTed statement lists)
  - `/load` (many tenants)
- `src/sqlitefs.ts` · PGDATA in SQLite, template images, lazy blocks
- `src/bench.ts` · workloads and the load mix · `src/compat.ts` · the 36 feature checks
- `src/exts.ts` (generated) · bundled extensions · `src/libs.ts`, `src/shims.ts` (generated)
- `scripts/mkimage.mjs <name> <rows> [schema.sql|statements.json]` · build a template image
  (`tenant` from `scripts/tenant.sql`; `sauna` from Sauna's migrations)
- `scripts/load.py <do|neon> <invocations> <ops> <prefix> [hot] [classes=8] [only=0..3]` · the
  many-tenants driver (5 clients per Worker invocation)
- `deploy.sh` · wrangler with the repo's credentials · `tailcheck.sh` · tail logs around one request
