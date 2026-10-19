# pagedb

**A 100 GB database in R2, served by one Durable Object, with live queries in every tab.**

pagedb keeps an immutable base in R2 as 4 MiB parts of 64 KiB B+tree pages. One Durable Object
serves it and only ever holds what queries touch. Every list, board column and thread in the demo
is a **live query**: when anyone writes, the object works out which rows of which open views changed
and pushes exactly those.

It's our take on [r2db](https://demo.r2db.dev), rebuilt from its public behaviour (no code copied),
with benchmarks against it. The engine is Rust: WebAssembly inside the Durable Object, and native
for the dataset builder. The Durable Object shell, sync protocol and UI are TypeScript.

- Demo (Linear-style tracker on the 100 GB base): https://pagedb.do-pool-lab.workers.dev
- How it works: https://pagedb.do-pool-lab.workers.dev/how
- The same object in a container: https://pagedb-node.do-pool-lab.workers.dev/api/…

## Results (deployed, measured)

| | pagedb | r2db demo |
|---|---|---|
| Object waking from sleep | ~0 ms of I/O: manifest, interior pages and cache are in its SQLite | 3.2 s |
| Issue list on a new object, page in the city cache | 44 ms (start + 1 fault round) | 172 ms |
| Every demo query from cold | **1 fault round**: list, board column, count, filter, detail, feed | rounds = dependency depth |
| Count of a project's issues | 3.6 µs of engine time (counted branch pages) | 3 ms |
| HTML of the first page (same laptop) | 85–227 ms, issues inlined | 195–496 ms, no data |
| First live result over the socket (same laptop) | 114–223 ms | 371–1,015 ms |
| Your own edit | instant (optimistic UI) | after the server round trip |
| Fan-out, 1,000 sockets, 5 writes/s (laptop ↔ Cloudflare) | p50 255 ms, p99 684 ms; **container: 128 / 296 ms** | — |
| 100 GB base (27.1 M issues), every demo query | 1 fault round; warm 35–49 ms; results match the generator | — |
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

## Layout

```
engine/core      Rust: key/row codec, 64 KiB pages, B+tree (bulk build + fault-aware reads),
                 catalog, generator, queries, overlay, writes, IVM
                 tests: oracle queries, write+IVM fuzz with fault injection, B+tree property tests
engine/wasm      the engine as WebAssembly (raw exports, synchronous host import for SQLite pages)
engine/builder   native builder → 4 MiB parts + manifest (Dockerfile.builder runs it in a Container)
src/do.ts        DbObject: tiers, fault rounds, sockets, overlay persistence, hibernation
src/app.ts       the tracker's named queries and validated mutators
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
node scripts/upload.mjs data/db1g db1g                  # base → R2 (or the builder container for 100 GB)
node bench/query.mjs db1g && node bench/load.mjs --sockets 200
node --import tsx --test test/live.test.ts test/hibernate.test.ts
```

## Limits

- **Indexed queries only.** Anything not answerable from an index is refused rather than scanned.
- **One object's thread** serves a database. Read replicas sharing the base are the next step.
- **Cold reads pay R2 latency** for parts no one has read recently.
- **Demo data:** users and projects are read-only. The feed index holds the base's newest 500k
  comments, plus everything written since.
- **Container variant:** at most 4,096 inbound connections per container, seconds-long cold starts,
  and R2 through a bridge limited to ~4 concurrent connections.
