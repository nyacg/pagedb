# V4: pagevec vs turbopuffer vs Vectorize, same vectors (2026-10-20)

turbopuffer namespace `hn-stories-1024` in gcp-us-west1 (Oregon; the closest region to the laptop
the benchmarks ran from, 46 ms connect; pagevec's Worker ran in Cloudflare's SJC colo). Same
1024-d Qwen3 vectors (f16 in turbopuffer's schema, cosine), loaded from the same PVEC shards
(`bench/tpuf.mjs`). Same queries and exact ground truth as `v3-vs-vectorize.md`.

| | pagevec | turbopuffer | Vectorize |
|---|---|---|---|
| recall@10 vs exact (100 queries, all 4.85M) | 0.895 | **0.990** | 0.786 |
| warm search, client p50 (laptop) | 59 ms | **41 ms** (server 12 ms) | 506 ms |
| first query (cache cold/warm mix) | 91–193 ms (SQLite tier) | 221 ms (48% "cold") | — |
| filtered (time < 2011, ~8%), p50 / recall | 149 ms / 0.79 | **43 ms / 0.91** | 10.8 s / 0.72 |
| write → searchable | next search, **121 ms ack** | next search (strong), 1,015 ms ack | 14 s p50 (1–66 s) |
| live result updates | **yes** | no | no |
| load 4.85M vectors | **~7 min** (offline build + upload) | ~14 min (6.7k rows/s from a laptop + 2 min indexing) | ≥ 81 min (~1,000/s, then async) |
| per 1M searches | **~$0.31** (DO request + duration, estimate) | $10.03 (10.03 GB billed per query, measured, at $1/PB) | $10.24 |
| per month before queries | **~$0.75** | $16 plan minimum (storage ~$3.31) | ~$52 |
| one-time load | — | ~20 GB logical written (≤ $2/GB, batch discounts apply) | — |

turbopuffer's lead on recall comes from a full-precision rerank of candidates (RaBitQ codes +
f16 vectors); pagevec ranks on its 4-bit codes alone (99.9% of its results are in the true top
100). A rerank tier is the next step (see v1-hn-recall.md).
