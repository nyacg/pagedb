# The dataset builder, run in a Cloudflare Container so 100 GB goes straight into R2.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY engine /src/engine
RUN cd engine && cargo build --release -p pagedb-builder

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/*
# DuckDB turns public datasets (parquet/CSV over HTTPS) into the builder's JSON lines.
RUN curl -sL -o /tmp/duckdb.zip https://github.com/duckdb/duckdb/releases/download/v1.5.6/duckdb_cli-linux-amd64.zip \
 && unzip -q /tmp/duckdb.zip -d /usr/local/bin && rm /tmp/duckdb.zip && duckdb -c "INSTALL httpfs; INSTALL json;"
COPY --from=build /src/engine/target/release/pagedb-builder /usr/local/bin/pagedb-builder
COPY datasets /datasets
COPY builder-container/run.sh /run.sh
RUN chmod +x /run.sh /datasets/*/build.sh
CMD ["/run.sh"]
