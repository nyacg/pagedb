#!/bin/bash
# Download embedding shards from R2 (skipping ones already here): scripts/fetch-shards.sh PREFIX DIR COUNT [PAR]
set -u
PREFIX=$1; DIR=$2; COUNT=$3; PAR=${4:-8}
mkdir -p "$DIR"
set -a; . ./.env; set +a
one() {
  local f; f=$(printf "shard-%06d.bin" "$1")
  [ -s "$DIR/$f" ] && return 0
  npx wrangler r2 object get "pagedb/$PREFIX/$f" --remote --file "$DIR/$f.tmp" >/dev/null 2>&1 && [ -s "$DIR/$f.tmp" ] && mv "$DIR/$f.tmp" "$DIR/$f" || rm -f "$DIR/$f.tmp"
}
for ((i = 0; i < COUNT; i++)); do
  one "$i" &
  (( (i + 1) % PAR == 0 )) && wait
done
wait
ls "$DIR"/*.bin 2>/dev/null | wc -l
