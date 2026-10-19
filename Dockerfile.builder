# The dataset builder, run in a Cloudflare Container so 100 GB goes straight into R2.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY engine /src/engine
RUN cd engine && cargo build --release -p pagedb-builder

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/engine/target/release/pagedb-builder /usr/local/bin/pagedb-builder
COPY builder-container/run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
