# Container variant vs Durable Object, and a side-by-side with r2db (2026-10-19)

## The same database object, two hosts (10 GB base)
`pagedb` = DbObject as a Durable Object. `pagedb-node` = the same class in workerd in a Cloudflare
Container (4 vCPU, 12 GiB, 20 GB disk, 6 GiB RAM page tier), R2 through an intercepted bridge
Worker (which also gives it the colo-cache tier).

| | Durable Object | Container |
|---|---|---|
| warm query (client, laptop) | 41–57 ms | 44–51 ms |
| engine CPU per query (real clock in workerd) | not observable (DO clocks freeze) | ~1 ms (5 ms first) |
| cold object start (no cache) | 154–615 ms | 310–480 ms |
| fan-out: 1,000 sockets, 5 writes/s, write → poke p50 / p99 | 255 / 684 ms | **128 / 296 ms** |
| 1,000 sockets subscribed in | 19.6 s | 8.5 s |
| server time per write at 1,000 subscribers | n/a | 12 ms p50 |

Platform findings while building it:
- A running container keeps its Durable Object (and so the *old code and image*) across
  deploys; a new object name gets the new image.
- The intercepted outbound route allows ~4 concurrent connections; more fail with "Network
  connection lost". The container caps fetches at 3.
- In workerd, a service binding answers *any* property with a JS-RPC stub, so feature
  detection (`typeof b.createMultipartUpload`) can't tell it from R2: say so explicitly.
- Global `fetch` from a DO inside workerd reaches the intercept; the network-service binding's
  fetch didn't.

## First load, same laptop, same method (4 samples each)
| | r2db demo | pagedb |
|---|---|---|
| HTML | 195–496 ms, no data | 85–227 ms, **50 issues inlined** |
| socket open | 279–925 ms | 86–168 ms |
| first live result over the socket | 371–1,015 ms | **114–223 ms** |

The socket number dropped from 179–617 ms to 114–223 ms by sending replies *before* writing
subscription records and page-cache rows (a DO holds outgoing messages until earlier writes are
durable — the output gate).
