# S0c: engine.wasm microbenchmarks (V8 / node 22, M-series laptop; 2026-10-19)

1,000,000 issue-like rows in `issue_by_project_created` (projectId, createdAt desc, id → row),
2,367 pages of 64 KiB (155 MB), height 3. `bench/wasm-micro.mjs`.

| op | µs/op |
|---|---|
| list 50 rows → JSON (RAM tier) | 14.0 |
| list 500 rows → JSON (RAM tier) | 133.2 |
| count a project's rows (counted branches) | 3.6 |

- wasm module 87 KB; linear memory 22.8 MB with ~300 resident pages.
- Cold list: 3 fault rounds = tree height (root, level-1, leaves) with nothing resident; with
  interior pages pinned it is 1 round (all leaves of the scan requested together).
- Gates (≤ 5 µs point lookup, ≤ 1 ms for 500 rows) met with ~7× headroom on the scan.
- TODO: the host/SQLite-tier number here is not meaningful (budget change didn't evict); measure
  in a deployed DO. Expect ~4× slower CPU on Cloudflare than on an M-series core (do-pool finding).
