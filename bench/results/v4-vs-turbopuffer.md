# V4: pagevec vs turbopuffer vs Vectorize, same vectors (2026-10-20)

turbopuffer namespace `hn-stories-1024` in gcp-us-west1 (Oregon; the closest region to the laptop
the benchmarks ran from, 46 ms connect; pagevec's Worker ran in Cloudflare's SJC colo). Same
1024-d Qwen3 vectors (f16 in turbopuffer's schema, cosine), loaded from the same PVEC shards
(`bench/tpuf.mjs`). Same queries and exact ground truth as `v3-vs-vectorize.md`.

Updated after the two-stage index (below). Latency is p50 inside each service for a query it
hasn't seen, since the laptop's own network varied a lot between runs (TCP connect 58 ms to
Cloudflare SJC, ~45 ms to GCP Oregon on the day):
- pagevec = `workerMs`, the Worker's round trip to the object, its CPU included (Workers clocks
  only advance across I/O, so the object can't time its own engine run);
- turbopuffer = `server_total_ms` (namespace "hot" on every query);
- Vectorize = in the Worker. Vectorize caches repeated query vectors: our 100 queries, sent a
  second time, took 25 ms; 100 it hadn't seen took 318 ms (recall 0.733 on those). The table uses
  the uncached run on the same 100 queries as everyone else.

| | pagevec (two-stage) | turbopuffer | Vectorize |
|---|---|---|---|
| recall@10 vs exact (100 queries, all 4.85M) | 0.971 (300 queries: 0.943) | **0.990** | 0.786 |
| search, new query, p50 in the service | 138 ms (SQLite tier) · 44 ms (RAM) | **13 ms** | 465 ms |
| same, from the laptop (p50) | 229 ms · 130 ms | **55 ms** | 425 ms (new queries) |
| filtered (time < 2011, ~8%), p50 / recall | 140 ms / 0.885 | **13 ms / 0.91** | 10.2 s / 0.72 |
| cold, nothing resident | 1.86 s from R2 (2 rounds, 58 GETs, 34 MB), 578 ms from the city cache | 874 ms at 10M (published) | — |
| write → searchable | next search, ~150 ms ack (laptop) | next search (strong), 1,015 ms ack | 14 s p50 (1–66 s) |
| live result updates | **yes** | no | no |
| load 4.85M vectors | **~11 min** (162 s offline build + ~8 min upload of 7 GB) | ~14 min (6.7k rows/s from a laptop + 2 min indexing) | ≥ 81 min (~1,000/s, then async) |
| per 1M searches | **~$0.41** (DO request + ~0.16 s duration, estimate) | $10.03 (10.03 GB billed per query, measured, at $1/PB) | $10.24 |
| per month before queries | **~$1.50** (R2 $0.10 + SQLite $1.40) | $16 plan minimum (storage ~$3.31) | ~$52 |

The previous single-stage index (4-bit codes only, 3.6 GB) measured 0.895 recall, 59 ms warm
from the laptop (RAM tier) and 149 ms / 0.79 filtered.

## Two-stage index: 1-bit probe, 8-bit rerank (deployed)

The fix for both halves of the gap below:
- **Probe tier** (`engine/core/src/vector/probe.rs`, tree 23): per vector, the sign bits of its
  rotated, normalized residual plus one f32 (RaBitQ's estimator), and the filter columns
  (time, kind): ~150 B per entry instead of ~660 B, so a 256-page budget scores ~70k candidates
  instead of ~20k. The query is quantized to 4 bits and split into bit planes; an estimate is
  4 × 16 `popcount(bits & plane)` on u64 words. (A first version used per-byte lookup tables:
  128 KB per query, more than L1, and no faster.)
- **Rerank**: the best 100 candidates' entries in the 8-bit tree (which also carries the display
  columns), ~45 pages, one more fault round when cold; rescored with SIMD128 i8 dot products.
- Filters on probe columns apply during the probe; others at rerank.

Offline (`vec-eval`, 100 queries, nprobe 1024, rerank 100; native 6 ms per query):

| probe pages | 128 | 192 | 256 | 384 | 512 |
|---|---|---|---|---|---|
| recall@10 | 0.950 | 0.959 | 0.971 | 0.973 | 0.975 |

Deployed (the app's object, 100 queries, p50 in the Worker):

| probe pages | recall@10 | new query (SQLite) | same query again (RAM) |
|---|---|---|---|
| 128 | 0.950 | 94 ms | 34 ms |
| 192 | 0.959 | 110 ms | 39 ms |
| **256** (deployed) | **0.971** | 138 ms | 44 ms |

Where the time goes: the Worker → object hop is ~20 ms for this object (10 ms for one created
from the same colo); the same RAM-tier search on a fresh object with no overlay takes 22 ms. The
engine itself is ~5 ms per query in V8 on a laptop (`engine.wasm` in Node on the local segment).
The SQLite tier reads ~300 pages (~20 MB) per new query, which is most of its 138 ms.

Operational notes:
- The engine's RAM tier holds the pinned pages too (268 for this segment: the centroids and
  branch pages). At the default 512 pages a 300-page search evicted the next search's pages and
  every "RAM" query read SQLite; the vec Worker now sets `RAM_PAGES=768` (48 MiB).
- A search's overlay check now runs only for clusters that hold overlay entries (the app's
  object carries the live HN tail's writes).

## Why turbopuffer's recall was higher (single-stage index; `bench/vec-rerank-probe.mjs`)

Ask pagevec for its top 50, then check how many of the true top 10 are among them, and the
recall@10 after reranking those candidates with exact vectors:

| pagevec, 100 queries | served recall@10 | true top 10 among candidates | after exact rerank |
|---|---|---|---|
| 256 pages (deployed) | 0.896 | 0.946 | 0.945 |
| 512 pages | 0.915 | 0.967 | 0.966 |
| turbopuffer | 0.990 | | |

The gap (0.895 → 0.990) is about half **ordering** and half **coverage**:
- Ordering: 4-bit codes misorder near-ties. An exact rerank of pagevec's own top 20 lifts
  0.896 → 0.945. turbopuffer keeps full-precision (here f16) vectors and reranks its candidates.
- Coverage: ~5% of true neighbours sit in clusters pagevec never reads within its 256-page
  budget (512 pages: ~3%). turbopuffer scores far more candidates for the same work: 1-bit
  RaBitQ codes (128 B at 1024 dims, vs pagevec's 512 B code + ~150 B of inline row), a
  hierarchical centroid tree, served from memory/NVMe.
