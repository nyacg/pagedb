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
