# V3: pagevec vs Cloudflare Vectorize, same vectors (2026-10-19)

Both hold the same 1024-d Qwen3-Embedding-0.6B vectors of HN stories (from the same PVEC shards;
Vectorize: cosine, f32, metadata indexes on `kind` and `time`; pagevec: SQ4 residuals in an IVF
index in the HN base's object). Queries are embedded once, the same way for both.
Scripts: `bench/vectorize.mjs` (+ `spikes/vectorize-bench`), `bench/vec-query.mjs`,
`bench/vec-visibility.mjs`.

## Write → visible

| | pagevec | Vectorize |
|---|---|---|
| write acknowledged | 121 ms p50 (client; durable in the object's SQLite) | 0.4–0.6 s (`upsert` returns a mutation id) |
| visible to search | **on the first search after the write, 10/10** | 1–66 s (6 trials, p50 14 s; idle index: 47–66 s, 2 trials ~1 s) |
| live push to open results | yes (a semantic page is a live query) | no |

## Cost at this size (4.85M × 1024 dims), list prices

| | pagevec | Vectorize |
|---|---|---|
| storage | R2 3.5 GB: $0.05/mo; the object's SQLite once prewarmed, 3.5 GB: $0.70/mo | stored dims 4.97 B: $2.48/mo |
| "queried dimensions" (Vectorize bills stored vectors in it every month) | — | (4.85M + queries) × 1024 × $0.01/M: **$49.66/mo** + $10.24 per 1M queries |
| per query | DO request + ~0.1 s of 128 MB duration: ~$0.31 per 1M queries | included above |
| embedding the corpus (both) | ~135M tokens × $0.0118/M ≈ $1.60 once | same |
| embedding queries (both) | ~$0.18 per 1M queries | same |

## Limits that decide

| | pagevec | Vectorize |
|---|---|---|
| vectors per index | bounded by R2 (the 40.9M HN comments fit one index) | 20M (the comments need 3 indexes and a merge) |
| dims / precision | any; 4- or 8-bit residual codes | ≤ 1536, f32 |
| top k | ≤ 200 | ≤ 100 (≤ 50 with values or metadata) |
| filters | any column the entries carry, numeric ranges, IN | 10 metadata indexes, 64-byte string prefixes, AND only |
| data next to the vectors | the whole HN database (rows, threads, counts) | metadata up to 10 KiB per vector |
| export | the index is files in R2 | IDs 1,000 at a time, then `getByIds` |

## Head to head, all 4.85M stories, Vectorize idle (fully indexed)

The 100 hand-written queries, recall@10 against exact search over all 4.85M vectors.

| | recall@10 vs exact | client ms p50 / p90 | in the server |
|---|---|---|---|
| **pagevec**, prewarmed object (RAM tier) | **0.895** | **59 / 116** | ~7 ms of engine time |
| **pagevec**, prewarmed object (SQLite tier) | 0.895 | 193 / 309 | |
| **Vectorize** | 0.786 | 506 / 738 | 465 / 677 ms in the Worker |

Filtered (`time < 2011-04-27`, ~8% of stories; 20 queries, recall against exact search over
the stories that pass):

| | recall@10 | client ms p50 / p90 |
|---|---|---|
| pagevec, ≤ 256 pages | 0.790 | 149 / 338 |
| Vectorize | 0.720 | 10,778 / 14,724 (10.7 s in the Worker) |

(Over all 300 queries, titles included, pagevec's recall@10 is 0.859; the 100 hand-written
queries are easier for both.)

## Search latency and recall (4.85M stories)

pagevec, `bench/vec-warm.mjs` (the app's object, index prewarmed into its SQLite) and
`bench/vec-query.mjs` (a fresh object per tier). Client numbers are from a laptop (~40–50 ms of
round trip); server numbers are inside the object.

| | recall@10 vs exact | server p50 | client p50 / p90 |
|---|---|---|---|
| pagevec, RAM tier | 0.859 (300 queries) | — (synchronous) | 49 / 111 ms |
| pagevec, prewarmed (SQLite tier) | 0.859 | — (synchronous) | 91 / 159 ms |
| pagevec, colo cache | | 366 ms | 617 / 761 ms |
| pagevec, R2 (nothing resident) | | 1,041 ms (22 GETs, 20.7 MB) | 1,100 / 1,249 ms |

### Filtered search, head to head (`bench/vec-compare.mjs`)

Same 100 queries, same filter `time < 2011-04-27` (the stories of the first 23 shards, 376,832
of 4.85M, ~8%; both systems hold every one of them), recall@10 against exact search over the
stories that pass the filter.

| | recall@10 vs exact | client ms p50 / p90 |
|---|---|---|
| pagevec (prewarmed), ≤ 256 pages | 0.823 | 89 / 174 |
| pagevec (prewarmed), ≤ 512 pages | 0.856 | 128 / 180 |
| Vectorize (in-Worker 17.2 / 20.4 s) | 0.748 | 17,298 / 20,388 |

Caveat for this table: Vectorize was ingesting the rest of the corpus during this run (~3.5M of 4.85M vectors
indexed, its indexing ~50 minutes behind its writes, upserts throttled with "Too Many
Requests" above ~1,000 vectors/s), which may inflate its latency. An unfiltered query on the
same index took 818 ms in the Worker; a filtered one 10 s, run alone.

Ingest, for reference: pagevec builds the whole index offline in ~100 s and serves it as soon as
the parts are in R2; Vectorize took the vectors at ~335–1,100/s and indexed them asynchronously.
