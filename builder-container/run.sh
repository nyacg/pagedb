#!/bin/bash
# Build the base and stream it into R2 (via http://r2.internal, routed to a Worker with the
# R2 binding). A part is complete once the next one exists (or the builder has exited); each
# is uploaded and deleted, so the disk only ever holds the in-flight parts + tag temp files.
set -u
OUT=/data/out
mkdir -p "$OUT"
status() { curl -s -X PUT --data "$1" "http://r2.internal/put/db/$DB/build-status.json" >/dev/null || true; }
status "{\"phase\":\"building\",\"uploaded\":0,\"base\":\"$BASE\"}"
pagedb-builder build --projects "$PROJECTS" --comments "${COMMENTS:-5.0}" --out "$OUT" > /data/build.log 2>&1 &
BPID=$!
up() {
  for i in 1 2 3 4 5 6; do
    if curl -sf -X PUT --data-binary @"$1" "http://r2.internal/put/db/$DB/base/$BASE/$(basename "$1")" >/dev/null; then rm -f "$1"; return 0; fi
    sleep $((i * 2))
  done
  echo "upload failed: $1" >> /data/build.log
}
export -f up
export DB BASE
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
  if [ ${#ready[@]} -gt 0 ]; then
    printf '%s\n' "${ready[@]}" | xargs -P 12 -I{} bash -c 'up "$@"' _ {}
    n=$((n + ${#ready[@]}))
  fi
  last=$(grep -E "rows|issues" /data/build.log | tail -1 | tr -d '"\\' | cut -c1-160)
  status "{\"phase\":\"building\",\"uploaded\":$n,\"finished\":$finished,\"secs\":$(( $(date +%s) - t0 )),\"base\":\"$BASE\",\"last\":\"$last\"}"
  if [ $finished = 1 ] && [ ${#ready[@]} = 0 ]; then break; fi
  sleep 3
done
wait $BPID
rc=$?
if [ $rc = 0 ] && [ -f "$OUT/manifest.json" ]; then
  sed "s/^{/{\"base\":\"$BASE\",/" "$OUT/manifest.json" > /data/manifest.json
  curl -sf -X PUT --data-binary @/data/manifest.json "http://r2.internal/put/db/$DB/manifest-$BASE.json" >/dev/null
  status "{\"phase\":\"done\",\"uploaded\":$n,\"secs\":$(( $(date +%s) - t0 )),\"base\":\"$BASE\",\"manifest\":\"db/$DB/manifest-$BASE.json\"}"
else
  status "{\"phase\":\"failed\",\"rc\":$rc,\"uploaded\":$n,\"log\":\"$(tail -3 /data/build.log | tr -d '"\\\n' | cut -c1-300)\"}"
fi
sleep infinity
