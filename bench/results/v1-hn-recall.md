# V1: recall on real embeddings (HN stories, Qwen3-Embedding-0.6B) (2026-10-19)

Embeddings: Workers AI `@cf/qwen/qwen3-embedding-0.6b` (1024 dims) of each story's
`title (domain)\ntext[:2000]` (`storyText`, the same in the builder and the Worker), PVEC shards
in R2 (`datasets/hn/embed.sh`). Queries: 100 hand-written searches (`datasets/hn/queries.txt`)
plus sampled titles, embedded with Qwen3's query instruction. Ground truth: exact cosine top 100
over every vector (`pagedb-builder vec-gt`), at the index's dims and at the full 1024.

## First subset: 115k stories (the first 7 shards, 2006–2008), ~400 vectors per cluster

`pagedb-builder vec-eval` (the engine's search, native). "vs full" = recall@10 against the
exact top 10 at all 1024 dims, i.e. against the model's best answer.

| index | pages / 115k | nprobe | pages per query | recall@10 (own dims) | recall@10 vs full |
|---|---|---|---|---|---|
| SQ8 @ 512 (Matryoshka) | 1,251 | 16 / 32 / 64 | 79 / 158 / 313 | 0.860 / 0.929 / 0.968 | 0.695 / 0.749 / 0.773 |
| SQ4 @ 512 | 799 | 16 / 32 / 64 | 54 / 107 / 211 | 0.825 / 0.889 / 0.919 | 0.682 / 0.736 / 0.758 |
| SQ8 @ 256 | 799 | 16 / 32 / 64 | 55 / 108 / 213 | 0.623 / 0.650 / 0.675 | 0.566 / 0.594 / 0.617 |
| **SQ4 @ 1024** | 1,251 | 16 / 32 / 64 | 81 / 164 / 325 | — | **0.849 / 0.897 / 0.931** |
| SQ8 @ 1024 | 2,161 | 16 / 32 / 64 | 134 / 271 / 506 | — | 0.869 / 0.921 / 0.959 |

- **Matryoshka truncation costs this model a lot on HN titles:** the exact top 10 at 512 dims
  overlaps the exact top 10 at 1024 dims only 78.5% of the time, so no 512-d index can exceed
  ~0.785 against the model's best. 256 dims is worse still.
- **4 bits × 1024 dims beats 8 bits × 512 dims at the same bytes** (512 B of code per vector):
  0.897 vs 0.749 at ~160 pages per query. It also beats SQ8 @ 1024 per page read.
- Misses are near-ties: 99.7–100% of returned results are in the true top 100.

Decision: the HN index is **SQ4 at 1024 dims** (`datasets/hn/vectors.json`). The Vectorize
comparison uses the same full 1024-d vectors (Vectorize allows up to 1536).

## All stories: 4,848,803 (every HN story through Oct 19, 2026)

Embedding: 296 shards in R2 (10.4 GB of f16 vectors + rows), ~150M tokens. Workers AI gave
one job ~200 stories/s (requests queue ~16 s at 32 in flight); nine claim-sharing jobs reached
~1,500/s, ~50 minutes for the corpus. Build (`vec-build`, laptop, 14 cores): 96–110 s for
k-means on a 410k sample, 4.85M assignments, 3.6 GB of parts.

Ground truth: 300 queries (100 hand-written + 200 titles), exact over all 4.85M at 1024 dims (34 s).

| clusters (target size) | nprobe | max pages | recall@10 | in true top 100 | clusters read | pages | vectors scored |
|---|---|---|---|---|---|---|---|
| 6,061 (800) | 8 | 128 | 0.762 | 0.994 | 8 | 93 | 7.9k |
| 6,061 (800) | 32 | 256 | 0.838 | 1.000 | 23 | 250 | 21.2k |
| 6,061 (800) | 64 | 384 | 0.854 | 1.000 | 35 | 378 | 32.1k |
| **14,276 (400)** | 16 | 256 | 0.802 | 0.997 | 16 | 94 | 7.6k |
| **14,276 (400)** | 32 | 256 | 0.843 | 0.998 | 32 | 181 | 14.5k |
| **14,276 (400)** | **64** | **256** | **0.859** | 0.999 | 46 | 253 | 20.3k |
| **14,276 (400)** | 128 | 384 | 0.879 | 1.000 | 71 | 381 | 30.7k |

Smaller clusters spend the page budget better. The deployed index: 400 per cluster, nprobe 64,
256 pages. Deployed, over the same 300 queries, recall@10 is **0.859**: the object's search
(wasm) returns exactly what the native eval does.

What limits recall now is the 4-bit codes' order among near-ties (99.9% of results are in the
true top 100), not the probing. The next lever is a rerank of the top candidates with finer
codes (SQ8 recovered 0.92+ on the subset at ~1.7× the pages).
