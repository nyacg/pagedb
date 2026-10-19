# pagedb

A database whose immutable base lives in R2 as 4 MiB parts of 64 KiB B+tree pages, served by a
single Durable Object that keeps only what queries touch, with live queries pushed to every tab.
Our take on [r2db](https://demo.r2db.dev), built to be benchmarked. Engine in Rust (WASM in the DO,
native in containers); shell, sync and UI in TypeScript.

Status: Phase 0 (spikes). See `bench/results/`.

```sh
cd engine && cargo test -p pagedb-core --release          # codec, pages, B+tree with fault injection
cargo build --release -p pagedb-wasm --target wasm32-unknown-unknown
cargo run --release -p pagedb-builder -- bench-tree ../data/bench 1000000
cd .. && node bench/wasm-micro.mjs data/bench               # S0c microbenchmarks
```
