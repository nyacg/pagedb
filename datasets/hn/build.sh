#!/bin/bash
# All of Hacker News → a pagedb base (parts + manifest in $OUT).
#
# Texts are cut at 16,000 characters (a row must fit a page cell; a few dozen items are longer).
# Source: open-index/hacker-news on Hugging Face (monthly parquet, ODC-By), read remotely by
# DuckDB, plus items newer than the dump straight from the official API. Deleted, dead and
# poll-option items are dropped; comments under a dropped item go with it.
#
#   FIRST=2006-10 LAST=2026-08 BACKFILL=1 OUT=/data/out WORK=/data/work datasets/hn/build.sh
#
# Rows are never stored: DuckDB streams them through named pipes into the builder. Only the
# id → story map (for each comment's thread) is materialized.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DUCKDB="${DUCKDB:-duckdb}"
BUILDER="${BUILDER:-pagedb-builder}"
FIRST="${FIRST:-2006-10}"
LAST="${LAST:-2026-08}"
OUT="${OUT:-/data/out}"
WORK="${WORK:-/data/work}"
MEM="${MEM:-5000}"
DUCK_MEM="${DUCK_MEM:-4GB}"
mkdir -p "$WORK" "$OUT"
DB="$WORK/hn.duckdb"
rm -f "$DB" "$DB.wal"

# Parquet URLs, one per month.
files=""
y=${FIRST%-*}; m=$((10#${FIRST#*-}))
while :; do
  ym=$(printf "%04d-%02d" "$y" "$m")
  files+="'https://huggingface.co/datasets/open-index/hacker-news/resolve/main/data/$y/$ym.parquet',"
  [ "$ym" = "$LAST" ] && break
  m=$((m + 1)); if [ $m = 13 ]; then m=1; y=$((y + 1)); fi
done
files="[${files%,}]"

duck() { "$DUCKDB" "$DB" -c "SET memory_limit='$DUCK_MEM'; SET threads=4; SET preserve_insertion_order=false; SET temp_directory='$WORK/duck-tmp'; LOAD httpfs; $1"; }
"$DUCKDB" -c "INSTALL httpfs;" >/dev/null

# Items newer than the dump, from the API.
: > "$WORK/backfill.ndjson"
if [ "${BACKFILL:-1}" = 1 ]; then
  from=$(duck "COPY (SELECT max(id) + 1 FROM read_parquet($files)) TO '/dev/stdout' (HEADER false);")
  to=$(curl -s https://hacker-news.firebaseio.com/v0/maxitem.json)
  echo "backfill $from..$to from the API" >&2
  "$BUILDER" fetch-hn --from "$from" --to "$to" --threads "${FETCH_THREADS:-64}" > "$WORK/backfill.ndjson"
fi

# Every item in one shape: type 1 story, 2 comment, 3 poll, 5 job; time in ms.
duck "
CREATE VIEW raw AS
  SELECT id::UBIGINT AS id, type::INTEGER AS type, \"by\", epoch_ms(time) AS time, text, deleted::INTEGER AS deleted, dead::INTEGER AS dead,
         parent::UBIGINT AS parent, url, score::INTEGER AS score, title
  FROM read_parquet($files)
  UNION ALL
  SELECT id, CASE type WHEN 'story' THEN 1 WHEN 'comment' THEN 2 WHEN 'poll' THEN 3 WHEN 'pollopt' THEN 4 WHEN 'job' THEN 5 END,
         \"by\", time * 1000, text, coalesce(deleted, false)::INTEGER, coalesce(dead, false)::INTEGER, parent, url, score, title
  FROM read_json('$WORK/backfill.ndjson', format = 'newline_delimited', columns = {id: 'UBIGINT', type: 'VARCHAR', \"by\": 'VARCHAR', time: 'BIGINT',
       text: 'VARCHAR', deleted: 'BOOLEAN', dead: 'BOOLEAN', parent: 'UBIGINT', url: 'VARCHAR', score: 'INTEGER', title: 'VARCHAR'});
CREATE TABLE ip AS SELECT id, parent, type FROM raw WHERE deleted = 0 AND dead = 0 AND type IN (1, 2, 3, 5);
CREATE TABLE known AS SELECT id, id AS root FROM ip WHERE type <> 2;
CREATE TABLE pending AS SELECT id, parent FROM ip WHERE type = 2;
"
# Each comment's story: walk up one level per pass until nothing more resolves.
for pass in $(seq 1 400); do
  n=$(duck "
CREATE OR REPLACE TABLE step AS SELECT p.id, k.root FROM pending p JOIN known k ON p.parent = k.id;
INSERT INTO known SELECT id, root FROM step;
DELETE FROM pending WHERE id IN (SELECT id FROM step);
COPY (SELECT count(*) FROM step) TO '/dev/stdout' (HEADER false);")
  echo "thread pass $pass: $n comments placed" >&2
  [ "$n" = 0 ] && break
done
duck "
CREATE TABLE threads AS SELECT k.id, k.root FROM known k JOIN ip USING (id) WHERE ip.type = 2;
CREATE TABLE counts AS SELECT root AS id, count(*) AS n FROM threads GROUP BY root;
DROP TABLE pending; DROP TABLE step; DROP TABLE known;
COPY (SELECT (SELECT count(*) FROM ip WHERE type <> 2) AS stories, (SELECT count(*) FROM threads) AS comments) TO '/dev/stdout' (HEADER true);
" >&2

STORIES="
  SELECT r.id::VARCHAR AS id, r.\"by\", r.time, r.title, nullif(r.url, '') AS url, nullif(left(r.text, 16000), '') AS text, coalesce(r.score, 0) AS score,
         coalesce(c.n, 0) AS descendants,
         CASE r.type WHEN 5 THEN 'job' WHEN 3 THEN 'poll' ELSE
           CASE WHEN r.title ILIKE 'Ask HN%' THEN 'ask' WHEN r.title ILIKE 'Show HN%' THEN 'show' ELSE 'story' END END AS kind,
         list_distinct(list_filter(regexp_split_to_array(lower(coalesce(r.title, '')), '[^a-z0-9]+'),
           lambda w: length(w) >= 2 AND NOT list_contains(['the','and','for','with','from','your','you','are','how','why','what','when','who','this','that',
           'its','into','about','show','ask','hn','of','to','in','on','is','an','at','by','as','it','be','or','my','we','not','can','do','does',
           'vs','via','was','will','has','have','than','but','just','our','all','out','so','if','no','up','new'], w)))[1:16] AS words,
         nullif(lower(regexp_extract(r.url, '^[a-zA-Z]+://(www\.)?([^/:?#]+)', 2)), '') AS domain
  FROM raw r LEFT JOIN counts c ON c.id = r.id
  WHERE r.deleted = 0 AND r.dead = 0 AND r.type IN (1, 3, 5)"
COMMENTS="
  SELECT r.id::VARCHAR AS id, t.root::VARCHAR AS storyId, r.parent::VARCHAR AS parent, r.\"by\", r.time, left(r.text, 16000) AS text
  FROM raw r JOIN threads t ON t.id = r.id
  WHERE r.type = 2"

# Stream into the builder: stories, then comments in two passes (so only some of the comment
# indexes' spill runs are on disk at once).
for f in stories c1 c2; do rm -f "$WORK/$f"; mkfifo "$WORK/$f"; done
(
  duck "COPY ($STORIES) TO '$WORK/stories' (FORMAT JSON);"
  duck "COPY ($COMMENTS) TO '$WORK/c1' (FORMAT JSON);"
  duck "COPY ($COMMENTS) TO '$WORK/c2' (FORMAT JSON);"
) &
DUCK_PID=$!
"$BUILDER" ingest --schema "$HERE/schema.json" --mem "$MEM" --tmp "$WORK/runs" --out "$OUT" \
  --input "story=$WORK/stories" \
  --input "comment=$WORK/c1@comment_by_id,comment_by_story,comment_by_time" \
  --input "comment=$WORK/c2@comment_by_user"
wait $DUCK_PID
rm -f "$WORK"/stories "$WORK"/c1 "$WORK"/c2
