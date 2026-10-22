# pagedb

**A 100 GB database in R2, served by one Durable Object, with live queries in every tab.**

pagedb keeps an immutable base in R2 as 4 MiB parts of 64 KiB B+tree pages. One Durable Object
serves it and only ever holds what queries touch. Every list, board column and thread in the demo
is a **live query**: when anyone writes, the object works out which rows of which open views changed
and pushes exactly those.

It's our take on [r2db](https://demo.r2db.dev), rebuilt from its public behaviour (no code copied),
with benchmarks against it. The engine is Rust: WebAssembly inside the Durable Object, and native
for the dataset builder. The Durable Object shell, sync protocol and UI are TypeScript.

Four apps run on the same engine, each one database in R2 and one object serving it:

| App | Data | What's live |
|---|---|---|
| [Issue tracker](https://pagedb.do-pool-lab.workers.dev) | 27.1M generated issues, 96 GB | lists, board, threads, search (titles, tags, comments) |
| [Hacker News](https://pagedb.do-pool-lab.workers.dev/hn) | every story and comment since 2006 (~49M items) | new items stream in from the HN API; front page, threads, comments, votes |
| [r/place 2022](https://pagedb.do-pool-lab.workers.dev/place) | all ~160M pixel placements | each pixel's history, each user's pixels, a timelapse, painting |
| [Taxi sheet](https://pagedb.do-pool-lab.workers.dev/sheet) | every NYC yellow-cab trip of 2015 (~146M) | sort, jump to any row, group counts, shared cell edits |

- How it works: https://pagedb.do-pool-lab.workers.dev/how
- The same object in a container: https://pagedb-node.do-pool-lab.workers.dev/api/…

## Results (deployed, measured)

| | pagedb | r2db demo |
|---|---|---|
| Issues on screen after opening the page (both 100 GB, same laptop, median of 8 loads) | **0.25 s** | 1.09 s |
| Every demo query from cold (100 GB) | **1 fault round**: list, board column, count, filter, detail, feed | rounds = dependency depth |
| Warm queries from a laptop (100 GB) | 35–49 ms | — |
| Count of a project's issues | 3.6 µs of engine time (counted branch pages) | 3 ms (published) |
| Your own edit | instant (optimistic UI) | after the server round trip |
| Object waking from sleep (1 GB base) | ~0 ms of I/O: manifest, interior pages and cache are in its SQLite | — |
| Fan-out, 1,000 sockets, 5 writes/s (1 GB base, laptop ↔ Cloudflare) | p50 255 ms, p99 684 ms; **container: 128 / 296 ms** | — |
| Builder | 96 GB, 27.1 M issues, 1.47 M pages in 28 min on one Cloudflare vCPU | offline |

Details: `bench/results/*.md`.

## How it works (short)

1. **Tiers.** A page is looked up in the engine's RAM (32 MiB), then the object's SQLite (synchronous,
   survives sleep), then the Cloudflare cache in the object's city (10–30 ms; parts are immutable),
   and finally R2 (100–370 ms). A page id is its position in a part, so its R2 location is arithmetic.
2. **Faults, not awaits.** The engine never blocks. A query that needs non-resident pages records
   *all* of them and returns `Fault([ids])`. The shell fetches them as coalesced 1 MiB chunks (at most 6
   at once, a DO limit) and calls again.
3. **One round per query.**
   - Every tree's interior pages and the small tables sit in a pinned region, loaded at startup.
   - Branch pages count the rows under each child, so a scan knows which leaves it needs before
     reading any.
   - Issue indexes are covering, with tags and comment counts in the row.
   - A detail query prefetches its comment thread with the issue.
   - A view's subscriptions share a round.
4. **Writes.**
   - Index entries go into an overlay in the object's SQLite, durable when acknowledged.
   - Reads merge base ⊕ overlay. Counts add each entry's rank delta.
   - The base is never written. A nightly reset of the demo drops the overlay.
5. **Live queries (IVM).**
   - Each subscription is a window of keys.
   - A write's row changes produce add, remove and edit ops (and refills) per window. These are
     computed purely, with a retry on any page fault, so a push never half-applies.
   - Then the overlay and every window commit, and each socket gets one message.
6. **Signed queries.** A page can only subscribe to the app's named queries.
   - `POST /api/lease {list: [{name, args}]}`: the Worker validates the arguments, builds the AST
     (`src/app.ts`) and signs it: HMAC-SHA256 over `{ast, db, obj, exp}`, valid for 60 s
     (`src/lease.ts`).
   - The socket sends `{t: "subs", list: [{id, lease}]}`. The object checks the signature, the
     expiry and that the lease names its database. It then runs the signed AST, never one a client wrote.
   - The first view's leases are in the server-rendered HTML, so the socket needs no lease round trip.
   - Raw ASTs (`/api/query`, raw socket subscriptions) and raw row ops (`/api/write`) need the admin token.
     Benchmarks and tests use it. Visitors always reach the demo object.

7. **Search.** The search box takes terms as chips: `title:`, `status:`, `priority:`, `owner:`,
   `tag:`, `comment:` (plain text searches titles). Several statuses, priorities or owners match any
   of them; tags, title words and comment words must all match.
   - Comment search is `EXISTS (comment of the issue whose body ILIKE …)`. There's no word index, so
     the object reads a project's comment pages, in rounds that grow (~200 issues first, then ~8×).
   - From R2 it takes 1.4–1.9 s for a common word, ~3.5–5 s for a word in no comment of a 10k-issue
     project (~20–35 MB, read as a few large ranged GETs). Once a project's comments are in the
     object it's instant. Live: adding or deleting a matching comment moves the issue in or out.

## Schemas and datasets

A base carries its schema in `manifest.json`: tables (typed columns, column 0 is the primary
key), indexes and relations, as JSON (`engine/core/src/catalog.rs` documents the format; the
tracker's is `TRACKER_JSON`). Bases built before schemas existed get the tracker's.

- **Indexes**: key columns (`-col` descending), covering by default; `truncate` for previews,
  `cols` + `rowIndex` for pointer primaries, `multi` for list columns (one entry per element),
  `where: {notNull}` for partial indexes (used only by queries that say `IS NOT NULL`),
  `baseLimit` to keep only the first n keys in the base.
- **Relations** (parent → child by `fk`) are maintained by the engine: counts, a touched
  timestamp, columns copied from the parent (kept in sync), cascading deletes. Queries use them
  for related counts and `EXISTS` searches over children.

Any dataset becomes a base with the generic builder: newline-delimited JSON per table in,
parts + manifest out (external sort, LZ4 spill runs, bounded memory):

```sh
pagedb-builder ingest --schema schema.json --input story=stories.ndjson --input comment=- --mem 6000 --out DIR
```

It produces byte-identical output to the tracker's hand-written builder for the same rows.

## The apps

Each app is a schema (`datasets/<app>/schema.json`), a dataset build (`datasets/<app>/build.sh`,
run in the builder container: `POST /start?db=<app>&job=<app>` on pagedb-builder), and named
queries + mutators (`src/apps/<app>.ts`). The Worker routes `/hn`, `/place` and `/sheet` to them;
leases, sockets and mutations carry `?app=`.

- **Hacker News**: DuckDB reads the open-index monthly parquet over HTTPS, resolves every
  comment's story (walking parents up, one level per pass), and streams stories and comments
  into the builder; items newer than the dump come from the HN API (`pagedb-builder fetch-hn`).
  `HnTail` (a Durable Object) then tails the API every 10 s and mirrors the front page into a
  partial index (`topRank`). Story → comment is a relation: `descendants` is a maintained count.
- **r/place**: `pagedb-builder place-prep` reads Reddit's CSVs, sorts ~160M placements in memory
  (16 bytes each), replays them onto the canvas, and emits placements (history per pixel and per
  user), the pre-whiteout canvas as 128×128 tiles (one character per pixel) and PNG snapshots
  every 30 minutes. A paint is a placement plus a `splice` of one character into its tile.
- **Taxi**: DuckDB numbers the trips in pickup order (the primary key, so row N is trip N);
  sort indexes are covering, group indexes are pointers. `offset` queries find row N from the
  branch pages' counts; a cell edit is a `set` (note) or an `add` (tip and total).

## Layout

```
engine/core      Rust: key/row codec, 64 KiB pages, B+tree (bulk build + fault-aware reads),
                 catalog, generator, queries, overlay, writes, IVM
                 tests: oracle queries, write+IVM fuzz with fault injection, B+tree property tests
engine/wasm      the engine as WebAssembly (raw exports, synchronous host import for SQLite pages)
engine/builder   native builder → 4 MiB parts + manifest (Dockerfile.builder runs it in a Container)
src/do.ts        DbObject: tiers, fault rounds, sockets, overlay persistence, hibernation
src/apps/        the apps' named queries and validated mutators (tracker, hn, place, taxi)
src/hn-tail.ts   HnTail: keeps the HN base live from the official API
datasets/        per-app schema.json and build.sh (run in the builder container)
src/lease.ts     signed queries: lease signing and verification
src/worker.ts    edge Worker: SSR first paint, /api/socket, /api/mutate, admin, nightly reset
src/node-*.ts    the same DbObject in workerd in a Container (pagedb-node)
web/             the tracker UI (optimistic sync client) and the how-it-works page
bench/           R2/tier spikes, query tiers, fan-out load, WASM microbenchmarks
test/            live sync and hibernation end-to-end tests (deployed)
```

## Run

```sh
cd engine && cargo test --release                       # engine tests
cargo run --release -p pagedb-builder -- build --projects 27 --out ../data/db1g   # 1 GB in ~7 s
cd .. && npm i && npm run deploy                        # wasm + web + Worker
npm run deploy:preview                                  # same, to pagedb-preview (own objects; try changes there first)
node scripts/upload.mjs data/db1g db1g                  # base → R2 (or the builder container for 100 GB)
node bench/query.mjs db1g && node bench/load.mjs --sockets 200
node --import tsx --test test/live.test.ts test/hibernate.test.ts test/lease.test.ts   # need ADMIN_TOKEN in .env
```

## Limitations

pagedb is a demo of an idea, built in days. Here is what it can't do, or hasn't proven yet.

**Queries**
- **Only the queries an app defines.** A page can't send its own query. It subscribes to the app's
  named queries, which the Worker signs (leases).
- **Only indexed queries.** Every filter and sort needs an index declared in the schema. Anything
  else is refused, never scanned. Postgres, Zero or Convex would run it.
- **A new index means rebuilding the base** from the source data. For the 137 GB taxi set that was
  hours of container time.
- **Text search is thin.**
  - HN search matches title words.
  - Comment search is a substring scan in growing batches, with no word index. A rare word reads
    20–35 MB of a project's comments from R2: seconds.

**Writes**
- **The data is built offline and is read-mostly.**
  - The 100 GB base is bulk-built by a container job and never changes.
  - Live writes go into an overlay in the object's SQLite.
  - **Nothing folds the overlay back into R2 yet** (see [Next step](#next-step-folding-writes-back-into-r2)).
    So the writable part is capped by the object's SQLite (10 GB). You can't stream 100 GB of
    writes through it.
- **The demos reset nightly.** The Hacker News copy doesn't; its overlay grows with new HN items.

**Scale**
- **One object is one thread in one place.**
  - Every write, live-query update and socket message for a database goes through one Durable
    Object, in one Cloudflare location.
  - Users far from it pay the network distance.
  - There are no read replicas yet.
- **Cold reads pay R2 latency.**
  - A page nobody has read recently comes from R2: 100–370 ms per round.
  - Before the taxi sheet had covering indexes, a cold "sort by tip" took 10.7 s.
- **The load tests are the easy case.**
  - Each fan-out test ran for 30 s, with 1,000–2,000 Node WebSocket clients on one laptop, not
    real browsers.
  - Every client watched the same list and count, with one writer. Real users watch different
    views, and each distinct live query costs the object CPU.
  - Higher write rates are untested.

**Cost claims**
- **The ~$9/month figure is projected, not a bill.**
  - It's a 30 s load test (100 GB, 1,000 sockets, 5 writes/s) scaled to a month at Cloudflare's
    list prices.
  - That's $5 for the Workers plan, $1.35 for R2 and ~$2.75 for requests. Row writes and duration
    fit in the included free amounts.
- **Competitors' prices are our list-price estimates for the same workload.** We sent every write
  to all 1,000 clients:
  - That's the worst case for anything that bills per message (Supabase Realtime, Convex,
    PowerSync, Firestore).
  - With ~50 recipients per write, our estimates fall to $190–2,100.
  - Electric + Neon (~$190) is the fairest comparison.

**Everything else**
- **No auth or permissions.** Visitors are anonymous guests. Leases stop clients from inventing
  queries, but there are no per-user rules.
- **No production use.** It was built quickly by Claude Code, tested hard (oracles, fuzzing,
  browser tests), but it has no operational history.
- **Demo data quirks.** In the tracker, users and projects are read-only. The feed index holds the
  base's newest 500k comments, plus everything written since.
- **The container variant:**
  - at most 4,096 inbound connections per container;
  - cold starts of several seconds;
  - R2 through a bridge limited to ~4 concurrent connections.

## Next step: folding writes back into R2

Today the base is immutable and every write lives in the object's SQLite overlay. Folding turns
the overlay into **layers** in R2, LSM-style, so writes are no longer capped by SQLite. The design:

1. **Freeze the overlay and build a layer.**
   - When the overlay passes a threshold (say 64 MB), freeze it. New writes go into a fresh
     overlay on top. Reads merge base ⊕ layers ⊕ frozen ⊕ new, so nothing visible changes.
   - The object builds the frozen overlay into a small B+tree in the same page format and uploads
     its parts.
   - Only changed entries are written. Rewriting the 64 KiB base leaves that writes touch instead
     would write thousands of times more bytes than changed, because writes land all over 100 GB.
2. **Publish atomically.**
   - The manifest becomes a list of layers, each owning a range of page ids. A page's R2 location
     stays arithmetic, and no cached page goes stale.
   - Write the new manifest, then drop the frozen overlay. The manifest records which overlay
     version it folded, so a crash in between finishes on restart.
3. **Merge across layers.**
   - Layer cells carry tombstones and count deltas.
   - Layer branch pages sum those deltas, so counts stay O(height).
   - `nth` (jump to row N) needs a few correction rounds across layers instead of one overlay pass.
     It's the riskiest piece.
4. **Compact.**
   - Merge small layers in the object, in chunks driven by alarms.
   - Now and then, rewrite the base in the builder container by streaming the merged view through
     `build_tables`. That's a few dollars for 100 GB.
   - Delete superseded parts.

Tests: fuzz that the merged view is identical before and after a fold (rows, counts, `nth`,
live-query output), with crash injection at every step and faults on layer reads.

Folding doesn't lift the one-thread limit on writes; that needs sharding or replicas.

## License

MIT, see [LICENSE](LICENSE). That covers the code in this repo. The datasets the apps are built from
(Hacker News, Reddit's r/place 2022 canvas history, NYC TLC trip records) keep their own terms.
