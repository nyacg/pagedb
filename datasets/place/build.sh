#!/bin/bash
# r/place 2022 → a pagedb base: every placement (~160M), the canvas as tiles, and a timelapse.
#   FILES=79 OUT=/data/out WORK=/data/work datasets/place/build.sh
# `pagedb-builder place-prep` reads Reddit's CSVs and replays them; its outputs stream through
# named pipes into the builder (placements three times: one pass per big index, so spill runs fit the disk).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILDER="${BUILDER:-pagedb-builder}"
OUT="${OUT:-/data/out}"
WORK="${WORK:-/data/work}"
MEM="${MEM:-4000}"
mkdir -p "$WORK" "$OUT"
for f in pa pb pc snaps tiles meta; do rm -f "$WORK/$f"; mkfifo "$WORK/$f"; done
"$BUILDER" place-prep --files "${FILES:-79}" --snap-mins "${SNAP_MINS:-30}" \
  --placements "$WORK/pa,$WORK/pb,$WORK/pc" --snaps "$WORK/snaps" --tiles "$WORK/tiles" --meta "$WORK/meta" &
PREP=$!
"$BUILDER" ingest --schema "$HERE/schema.json" --mem "$MEM" --tmp "$WORK/runs" --out "$OUT" \
  --input "placement=$WORK/pa@placement_by_pos" \
  --input "placement=$WORK/pb@placement_by_user" \
  --input "placement=$WORK/pc@placement_by_id,placement_by_time" \
  --input "snap=$WORK/snaps" --input "tile=$WORK/tiles" --input "meta=$WORK/meta"
wait $PREP
rm -f "$WORK"/pa "$WORK"/pb "$WORK"/pc "$WORK"/snaps "$WORK"/tiles "$WORK"/meta
