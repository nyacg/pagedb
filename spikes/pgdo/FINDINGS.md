# Postgres in a Durable Object: spike findings (Nov 3, 2026)

**Verdict: it works.** Postgres 18.6 (PGlite 0.5.15, compiled to WebAssembly) runs inside one
Cloudflare Durable Object with its data directory in the object's own SQLite, survives restarts,
runs PL/pgSQL, triggers, JSONB and full-text search, and branches copy-on-write from a template
image in R2 that it only pulls in as queries touch it.

Live: `https://pagedb-pg-spike.do-pool-lab.workers.dev/sql?db=<name>[&image=hn150]` (POST the SQL).

## The four questions

| Question | Answer |
|---|---|
| 1. Does PGlite run in a Durable Object at all? | Yes, after four fixes (below). 6.8 MB gzipped bundle (limit 10 MB). |
| 2. Can PGDATA live in the object's SQLite? Throughput and memory? | Yes (`src/sqlitefs.ts`). 0.87 ms per durable single-row update, 0.39 ms reads, 34–48 MB of wasm heap. |
| 3. Branch copy-on-write from a template in R2? | Yes. A branch of a 240 MB database starts in 0.7–2.5 s and stores ~30 MB; the rest stays in R2 until read. |
| 4. Can a query wait on a page from R2? | Not mid-statement in this build: a missing page fails the statement, the object fetches it and retries (works). JSPI *is* available in workerd (`WebAssembly.Suspending`), the path to doing it properly. |

## What it took

1. **No runtime wasm compilation in Workers.** Two places compile at runtime:
   - Emscripten's `addFunction` wraps JS callbacks in tiny generated modules. Their bytes depend
     only on the signature, so `scripts/patch-pglite.mjs` precompiles one per signature
     (`src/shims.ts`) and rewrites the call to use them.
   - Postgres `dlopen`s side modules (plpgsql, dict_snowball, pgoutput, 25 encoding converters).
     `scripts/extract-libs.mjs` copies them out of PGlite's bundle into `vendor/lib/` and
     `src/libs.ts`; the patched loader swaps in the precompiled module by library name.
2. **Node detection.** workerd exposes `process.versions.node`, so Emscripten took its Node path
   (`createRequire(import.meta.url)`). `src/no-node.ts` hides `process` before PGlite loads.
3. **Memory.** `pglite.wasm` declares 128 MB of initial memory: an entire Durable Object.
   `scripts/patch-wasm-memory.mjs` lowers the declared minimum to 32 MB in place (two LEB128
   bytes; static data ends at 2.8 MB and memory still grows to 2 GB). Postgres runs with
   `shared_buffers=8MB`, `work_mem=1MB`, 1 MB WAL segments.
4. **PGDATA in SQLite** (`src/sqlitefs.ts`): files are rows of 64 KiB blocks behind a 24 MB LRU;
   writes dirty the cached block and are flushed when PGlite syncs (after each query) or past
   8 MB mid-statement, so a request's writes commit together in the object's SQLite (durable
   before the reply). ~2 SQLite rows written per transaction.

## Measured (deployed, Cloudflare)

Times are the Worker's round trip to the object (CPU included).

| | |
|---|---|
| New empty database (copy the 24 MB base image from R2, boot Postgres) | ~1.0 s + boot, first answer ~2.5 s |
| Cold boot of an existing database from its SQLite | 1.3 s |
| Point read (warm) | 0.39 ms |
| Single-row update, durable | 0.87 ms (~1,150/s) |
| TPC-B-style transaction (2 updates + 1 read) | 1.51 ms (~660/s) |
| Insert 1M rows / build an index on them / group by over them | 22 s / 8.4 s / 1.8 s |
| wasm heap | 33.6 MB at boot, 48 MB after big sorts |
| Data intact after a restart | yes (md5 of all rows matches an independent run) |

### Branches of a template image (`scripts/mkimage.mjs`: 1.5M rows + an index, 240 MB)

The image is one blob in R2 (small files packed first, big relation files on 64 KiB boundaries)
plus an index. A branch copies the metadata and the 24 MB of small files (system catalogs,
WAL); the three big files (the 175 MB table and two 34 MB indexes) stay in R2.

| | |
|---|---|
| Create a branch | 0.65–2.5 s |
| First point lookup on a new branch | 3.1–5.5 s total (4–5 fetch rounds, ~9 MB fetched) |
| Same lookup again | 20 ms |
| Index range query, cold | 0.9 s (2 rounds) |
| Full count over 1.5M rows, cold / warm | 60 s (6 rounds, 189 MB fetched) / 2.3 s |
| Storage per branch after point lookups | ~30 MB of SQLite (vs 240 MB for a full copy) |
| Isolation | a write in one branch is invisible to the others |

## Limits and risks

- **Memory headroom is thin.** Heap (34–48 MB) + block cache (24 MB) + V8's compiled code for a
  9 MB wasm module. A long-lived instance that had built a 1M-row index failed a big
  `count(distinct)` twice (once "invalid memory alloc", once an isolate reset); a fresh instance
  ran it fine. Needs a smaller cache, tighter `work_mem`, and measuring isolate memory directly.
- **CPU.** The object is ~5× slower than an M-series laptop for bulk work; a 1M-row insert needs
  the CPU limit raised (`limits.cpu_ms`, 5 min here; the default is 30 s).
- **Cold scans of a branch are slow**: each fetch round re-runs the statement. Fixes, in order of
  effort: background hydration of the rest of the image from an alarm (like pagedb's prewarm),
  the colo cache for image ranges (immutable, like pagedb's pages), fetching a whole file on its
  second miss, and JSPI (suspend on the read; no retry).
- **Retry semantics.** The object retries the whole request after a ROLLBACK, so a request is a
  transaction unit. An interactive transaction spanning several requests could be aborted by a
  fault. JSPI removes this.
- **One connection, no wire protocol.** PGlite is single-user and the object serializes requests
  anyway. Clients talk HTTP/RPC; a Postgres wire endpoint would need a TCP front (Workers can't
  accept inbound TCP), e.g. a small proxy.
- **Upstream PGlite bug**: `convert_to(…, 'LATIN1')` breaks the session (same in Node).
- Template images are built offline in Node (`scripts/mkimage.mjs`).

## Next steps

1. Background hydration for branches + colo-cache image ranges (biggest user-visible win).
2. Memory budget pass: measure isolate memory, shrink the cache, find the safe query envelope.
3. JSPI prototype: wrap the read syscall import as `WebAssembly.Suspending` and Postgres's entry
   as `WebAssembly.promising`, so a cold page is fetched mid-query.
4. A "branch from a live database" (fork an existing object's SQLite into a new image) and the
   1,000-branches cost demo.

## Files

- `src/index.ts` · the Worker and the `PgObject` Durable Object (branching, fault retry, benches)
- `src/sqlitefs.ts` · PGDATA in SQLite, template images, lazy blocks
- `scripts/patch-pglite.mjs`, `scripts/patch-wasm-memory.mjs`, `scripts/extract-libs.mjs` · the patches (run by `npm install` / `npm run vendor`)
- `scripts/mkimage.mjs` · build a template image (`node scripts/mkimage.mjs <name> <rows>`)
- `deploy.sh` · wrangler with the repo's credentials · `tailcheck.sh` · tail logs around one request
