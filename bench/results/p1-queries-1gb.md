# Phase 1: query latency in a deployed Durable Object, 1 GB base (2026-10-19)

284k issues / 1.42M comments, 14,517 pages, 227 parts. DO in LAX, R2 in WNAM.
`node bench/query.mjs db1g`. Server ms = inside the DO (Workers clocks advance only across
I/O, so pure CPU shows as 0); client ms = from a laptop in California (adds ~40–60 ms).

| query | cold, R2 (start + round) | cold object, warm colo cache | wake (evicted, SQLite intact) | warm |
|---|---|---|---|---|
| list (50 + project/owner/commentCount) | 379 + 192 = 571 ms | 26 + 18 = **44 ms** | **0 ms** server, 199 ms client | 72 ms client |
| board column (25) | 677 + 378 | 76 + 39 = 115 | 0 / 133 | 54 |
| count (project) | 773 + 225 | 39 + 20 = 59 | 0 / 114 | 60 |
| filtered (ILIKE, 28 leaves) | 345 + 216 | 40 + 34 = 74 | 0 / 141 | 57 |
| detail (issue + thread + authors) | 426 + 190 | 42 + 23 = 65 | 0 / 247 | 43 |
| feed (30 newest comments) | 422 + 183 | 44 + 22 = 66 | 0 / 150 | 44 |

- Every query is **one fault round** (pinned region = small tables + all interior pages; detail
  prefetches the comment thread with the issue).
- Colo Cache API chunk reads: 9–39 ms per 1 MiB. Fresh R2 parts: 170–370 ms per 1 MiB GET.
- "start" = engine start on a brand-new object: manifest + pinned chunk (2 sequential fetches).
  A woken object reads both from its own SQLite: no I/O.
- r2db reference (measured on demo.r2db.dev): cold object wake 3.2 s, cold list 172 ms.
