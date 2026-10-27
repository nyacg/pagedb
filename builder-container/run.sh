#!/bin/bash
# Build the base and stream it into R2 (via http://r2.internal, routed to a Worker with the
# R2 binding). A part is complete once the next one exists (or the builder has exited); each
# is uploaded and deleted, so the disk only ever holds the in-flight parts + tag temp files.
set -u
OUT=/data/out
mkdir -p "$OUT"
status() { curl -s --max-time 20 -X PUT --data "$1" "http://r2.internal/put/db/$DB/build-status.json" >/dev/null || true; }
status "{\"phase\":\"building\",\"uploaded\":0,\"base\":\"$BASE\"}"
if [ -n "${JOB:-}" ]; then
  # A dataset job: datasets/$JOB/build.sh (reads public data, streams it into `pagedb-builder
  # ingest`), or datasets/$JOB.sh for JOB=<dataset>/<step> (e.g. hn/embed, hn/vec).
  script=/datasets/$JOB/build.sh
  case "$JOB" in */*) script=/datasets/$JOB.sh ;; esac
  OUT="$OUT" WORK=/data/work "$script" > /data/build.log 2>&1 &
else
  pagedb-builder build --projects "$PROJECTS" --comments "${COMMENTS:-5.0}" --out "$OUT" > /data/build.log 2>&1 &
fi
BPID=$!
# Uploads go straight to R2's S3 API when the job has credentials (and internet), 16 at a
# time; otherwise through the intercepted http://r2.internal route (~4 connections, 3 at a time).
up() {
  local name key
  name=$(basename "$1")
  key="db/$DB/base/$BASE/$name"
  if [ -n "${R2_AK:-}" ]; then
    # (curl 7.x doesn't send the payload hash header R2 requires.)
    local s3=(--aws-sigv4 "aws:amz:auto:s3" --user "$R2_AK:$R2_SK" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD")
    # Already in R2 from an earlier (identical, deterministic) run: skip it.
    if curl -sf -I --max-time 20 "${s3[@]}" "$R2_ENDPOINT/pagedb/$key" >/dev/null; then rm -f "$1"; return 0; fi
    for i in 1 2 3 4 5 6; do
      if curl -sf --connect-timeout 10 --max-time 300 "${s3[@]}" -X PUT --data-binary @"$1" "$R2_ENDPOINT/pagedb/$key" >/dev/null; then rm -f "$1"; return 0; fi
      sleep $i
    done
  else
    if curl -sf -I --max-time 20 "http://r2.internal/put/$key" >/dev/null; then rm -f "$1"; return 0; fi
    for i in 1 2 3 4 5 6; do
      # Bounded: a hung request must not stall the whole pipeline.
      if curl -sf --connect-timeout 10 --max-time 120 -X PUT --data-binary @"$1" "http://r2.internal/put/$key" >/dev/null; then rm -f "$1"; return 0; fi
      sleep $i
    done
  fi
  echo "upload failed: $1" >> /data/build.log
}
export -f up
export DB BASE R2_AK R2_SK R2_ENDPOINT
PAR=$([ -n "${R2_AK:-}" ] && echo 16 || echo 3)
BATCH=$([ -n "${R2_AK:-}" ] && echo 256 || echo 48)
paused=0
n=0
t0=$(date +%s)
while :; do
  finished=0
  kill -0 $BPID 2>/dev/null || finished=1
  mapfile -t parts < <(ls "$OUT/parts" 2>/dev/null | sort)
  ready=()
  for ((i = 0; i < ${#parts[@]}; i++)); do
    if [ $finished = 1 ] || [ $((i + 1)) -lt ${#parts[@]} ]; then ready+=("$OUT/parts/${parts[$i]}"); fi
  done
  # Backpressure: if uploads fall behind, pause the build until the disk drains.
  if [ $paused = 0 ] && [ ${#parts[@]} -gt 1500 ]; then pkill -STOP -f "pagedb-builder" && paused=1; fi
  if [ $paused = 1 ] && [ ${#parts[@]} -lt 500 ]; then pkill -CONT -f "pagedb-builder"; paused=0; fi
  if [ ${#ready[@]} -gt 0 ]; then
    # A bounded batch per pass, so progress is reported regularly even when far behind.
    batch=("${ready[@]:0:$BATCH}")
    printf '%s\n' "${batch[@]}" | xargs -P "$PAR" -I{} bash -c 'up "$@"' _ {}
    n=$((n + ${#batch[@]}))
  fi
  last=$(grep -E "rows|issues|pass|backfill|fetched|pages|file |placements|snapshots|month|trips|sorted|GB in|embedded|vectors|clusters" /data/build.log | tail -1 | tr -d '"\\' | cut -c1-160)
  status "{\"phase\":\"building\",\"uploaded\":$n,\"pending\":${#parts[@]},\"paused\":$paused,\"finished\":$finished,\"secs\":$(( $(date +%s) - t0 )),\"base\":\"$BASE\",\"last\":\"$last\"}"
  if [ $finished = 1 ] && [ ${#ready[@]} -le $BATCH ]; then
    left=$(ls "$OUT/parts" 2>/dev/null | wc -l)
    [ "$left" = 0 ] && break
  fi
  sleep 3
done
wait $BPID
rc=$?
if [ $rc = 0 ] && [ -f "$OUT/manifest.json" ]; then
  sed "s/^{/{\"base\":\"$BASE\",/" "$OUT/manifest.json" > /data/manifest.json
  curl -sf --max-time 60 -X PUT --data-binary @/data/manifest.json "http://r2.internal/put/db/$DB/manifest-$BASE.json" >/dev/null
  status "{\"phase\":\"done\",\"uploaded\":$n,\"secs\":$(( $(date +%s) - t0 )),\"base\":\"$BASE\",\"manifest\":\"db/$DB/manifest-$BASE.json\"}"
else
  status "{\"phase\":\"failed\",\"rc\":$rc,\"uploaded\":$n,\"log\":\"$(tail -3 /data/build.log | tr -d '"\\\n' | cut -c1-300)\"}"
fi
sleep infinity
