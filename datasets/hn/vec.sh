#!/bin/bash
# The stories' vector index, built from the embedding shards (embed.sh) as a segment that any
# HN base can attach (pagedb-builder vec-merge): its pages start at 2^40, past any base.
#
#   JOB=hn/vec on db hnvec: parts upload to db/hnvec/base/<BASE>/, the segment's manifest to
#   db/hnvec/manifest-<BASE>.json. Settings: VEC_CONFIG (default datasets/hn/vectors.json),
#   VEC_PREFIX (where the shards are), FIRST_PAGE.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILDER="${BUILDER:-pagedb-builder}"
OUT="${OUT:-/data/out}"
WORK="${WORK:-/data/work}"
CONFIG="${VEC_CONFIG:-$HERE/vectors.json}"
PREFIX="${VEC_PREFIX:-vec/qwen3-embedding-0.6b/stories}"
FIRST_PAGE="${FIRST_PAGE:-1099511627776}"
mkdir -p "$WORK" "$OUT"
curl -sf "http://r2.internal/get/$PREFIX/index.json" > "$WORK/index.json"
shards=$(sed -E 's/.*"shards":([0-9]+).*/\1/' "$WORK/index.json")
rows=$(sed -E 's/.*"rows":([0-9]+).*/\1/' "$WORK/index.json")
echo "$shards shards, $rows rows" >&2
for ((i = 0; i < shards; i++)); do printf "http://r2.internal/get/%s/shard-%06d.bin\n" "$PREFIX" "$i"; done > "$WORK/shards.txt"
"$BUILDER" vec-build --schema "$HERE/schema.json" --config "$CONFIG" --shards "$WORK/shards.txt" --rows "$rows" \
  --first-page "$FIRST_PAGE" --mem "${MEM:-5000}" --out "$OUT"
