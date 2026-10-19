# S0a: page fetch latency from inside a Durable Object (2026-10-19)

DO in LAX, R2 bucket `pagedb` in WNAM, 64 MiB test object, random 64 KiB-aligned offsets.
Spike: `spikes/r2-matrix` (`/run`, `/tiers`).

## R2 ranged GET (two runs, ms)
| size | conc 1 p50 | conc 6 p50 | conc 6 p90 | conc 6 throughput |
|---|---|---|---|---|
| 64 KiB | 94–245 | 89–145 | 119–197 | 2–4 MB/s |
| 256 KiB | 124–128 | 119–127 | 155–164 | 12 MB/s |
| 512 KiB | 116–128 | 105–111 | 133–143 | 26 MB/s |
| 1 MiB | 107–129 | 118–120 | 154–186 | 45–47 MB/s |
| 4 MiB | 154–169 | 199–213 | 250–253 | 108–122 MB/s |

Floor ≈ 80–90 ms per GET regardless of size up to 1 MiB.
⇒ a fault round from R2 costs ~100–120 ms; queries must be 1 round; over-fetch up to ~1 MiB is free.

## Other tiers for immutable pages (n=20, ms)
| tier | 64 KiB p50 / p90 | 1 MiB p50 / p90 |
|---|---|---|
| Cache API (`caches.open`, DO's colo), hit | 5 / 7 | 7 / 10 |
| Cache API put | 8 / 12 | 33 / 64 |
| KV get (same colo, just written) | 4 / 7 | 9 / 11 |
| KV put | 333 / 389 | 687 / 1320 |
| R2 get | 160 / 169 | 144 / 218 |

⇒ Base parts are immutable, so the colo Cache API is a safe tier between DO SQLite and R2,
~25× faster than R2. Fault path: RAM → SQLite → colo cache → R2 (then fill cache + SQLite).
