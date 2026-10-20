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
