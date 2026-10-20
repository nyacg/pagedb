# V0: vector search on pages, synthetic data (2026-10-19)

2M synthetic 512-d vectors (3,000 topics × 8 sub-topics, unit-norm, noisy copies) in a `doc`
table: `pagedb-builder vec-synth --n 2000000 --gt 200` → 2,500 clusters (median 721 vectors),
SQ8 residual codes + the row (id, title, time, kind) in each entry: 18,254 leaf pages (1.2 GB),
centroids 22 pages (pinned). Built in 21 s on a laptop (k-means on a 400k sample, then 2M
assignments in 4 s).

## Recall and cost, offline (`pagedb-builder vec-eval`, the engine's own search, native)

| nprobe | recall@10 | (in true top 100) | clusters | pages | 1 MiB chunks | GETs (runs) | vectors scored |
|---|---|---|---|---|---|---|---|
| 8 | 0.949 | 1.000 | 8 | 67 | 11.5 | 8.7 | 6.5k |
| 16 | 0.953 | 1.000 | 16 | 133 | 22.7 | 17.1 | 12.9k |
| 32 | 0.959 | 1.000 | 30 | 251 | 42.7 | 31.6 | 24.4k |
| 64 (512 pages) | 0.964 | 1.000 | 61 | 507 | 84.6 | 60.8 | 49.3k |

Misses are near-ties lost to 8-bit residuals (every hit is in the true top 100). Synthetic
clusters are easy: recall saturates by nprobe 8. Real embeddings decide nprobe.

## Deployed, per tier (`node bench/vec-query.mjs vecsynth2m data/vs2m/gt.json`, nprobe 32)

| tier | rounds | pages | R2 GETs | server ms p50 / p90 | client ms p50 / p90 |
|---|---|---|---|---|---|
| R2 (nothing resident) | 1 | 252 | 32 | 1,459 / 1,963 | 1,835 / 2,228 |
| colo cache | 1 | 252 | 0 (43 hits) | 672 / 979 | 1,060 / 1,339 |
| SQLite (object evicted) | 0 | — | — | (sync) | 212 / 234 |
| RAM | 0 | — | — | (sync) | 51 / 65 |

Point lookup on the same object (RAM): 54 / 86 ms client, so a search in RAM costs ~7 ms of
engine time for 24k vectors (SIMD128 i8 dot products; the object's clock doesn't advance
during synchronous work, so this is client-side).

## What the numbers say

1. **One fault round** holds (every cold search, any tier). Recall in the object equals the
   native eval (same engine, compiled to wasm with simd128).
2. **Cold tiers are bandwidth-bound, not latency-bound.** A search moved 44.7 MB: whole 1 MiB
   chunks for 252 scattered 64 KiB pages (16 MB needed). R2 GETs were 181 ms p50 / 374 p90
   each, 6 at a time; the city cache delivered ~67 MB/s. "Over-fetch up to 1 MiB is free"
   (S0a) holds for one GET, not for 40 in parallel. Vector segments now use 256 KiB chunks
   (`chunkPages: 4`).
3. **The SQLite tier costs ~0.25–0.4 ms per 64 KiB page** (`/api/admin/sqlite-bench`: 753
   pages read one by one +200–300 ms, batched +150–200 ms, i.e. ~200 MB/s). So a warm search
   is bytes-bound too: ~250 pages ≈ 100–150 ms.
4. Therefore the lever on every tier is **bytes scanned per search**: smaller codes (SQ4 or
   fewer Matryoshka dims halve it), fewer probes (real-data recall curves), and keeping the
   index resident (prewarm into SQLite; RAM for the hottest pages).
