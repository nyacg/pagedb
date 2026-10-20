#!/bin/bash
# Every Hacker News story → an embedding (PVEC shards in R2), for the vector index.
#
#   JOB=hn-embed  (builder container; needs AI_ACCOUNT + AI_TOKEN, or EMBED_URL)
#
# Stories come from the same monthly parquet as build.sh (plus items newer than the dump from
# the API), in a stable order, so a rerun resumes: shards already in R2 are skipped. The shards
# keep each story's row (text cut to 2,000 characters) next to its vector; vec.sh builds the
# index from them.
set -euo pipefail
DUCKDB="${DUCKDB:-duckdb}"
BUILDER="${BUILDER:-pagedb-builder}"
FIRST="${FIRST:-2006-10}"
LAST="${LAST:-2026-08}"
OUT="${OUT:-/data/out}"
WORK="${WORK:-/data/work}"
MODEL="${EMBED_MODEL:-@cf/qwen/qwen3-embedding-0.6b}"
SLUG="${VEC_SLUG:-$(basename "$MODEL")}"
PREFIX="${VEC_PREFIX:-vec/$SLUG/stories}"
mkdir -p "$WORK" "$OUT"

files=""
y=${FIRST%-*}; m=$((10#${FIRST#*-}))
while :; do
  ym=$(printf "%04d-%02d" "$y" "$m")
  files+="'https://huggingface.co/datasets/open-index/hacker-news/resolve/main/data/$y/$ym.parquet',"
  [ "$ym" = "$LAST" ] && break
  m=$((m + 1)); if [ $m = 13 ]; then m=1; y=$((y + 1)); fi
done
files="[${files%,}]"
"$DUCKDB" -c "INSTALL httpfs;" >/dev/null

: > "$WORK/backfill.ndjson"
if [ "${BACKFILL:-1}" = 1 ]; then
  from=$("$DUCKDB" -c "LOAD httpfs; COPY (SELECT max(id) + 1 FROM read_parquet($files)) TO '/dev/stdout' (HEADER false);")
  to=$(curl -s https://hacker-news.firebaseio.com/v0/maxitem.json)
  echo "backfill $from..$to from the API" >&2
  "$BUILDER" fetch-hn --from "$from" --to "$to" --threads "${FETCH_THREADS:-64}" > "$WORK/backfill.ndjson"
fi

# Stories in file order (insertion order is preserved: the same rows in the same order on a rerun).
"$DUCKDB" -c "SET memory_limit='${DUCK_MEM:-3GB}'; SET threads=4; SET preserve_insertion_order=true; LOAD httpfs;
COPY (
  WITH raw AS (
    SELECT id::UBIGINT AS id, type::INTEGER AS type, \"by\", epoch_ms(time) AS time, text, deleted::INTEGER AS deleted, dead::INTEGER AS dead,
           url, score::INTEGER AS score, title, descendants::INTEGER AS descendants
    FROM read_parquet($files)
    UNION ALL
    SELECT id, CASE type WHEN 'story' THEN 1 WHEN 'comment' THEN 2 WHEN 'poll' THEN 3 WHEN 'pollopt' THEN 4 WHEN 'job' THEN 5 END,
           \"by\", time * 1000, text, coalesce(deleted, false)::INTEGER, coalesce(dead, false)::INTEGER, url, score, title, descendants
    FROM read_json('$WORK/backfill.ndjson', format = 'newline_delimited', columns = {id: 'UBIGINT', type: 'VARCHAR', \"by\": 'VARCHAR', time: 'BIGINT',
         text: 'VARCHAR', deleted: 'BOOLEAN', dead: 'BOOLEAN', url: 'VARCHAR', score: 'INTEGER', title: 'VARCHAR', descendants: 'INTEGER'})
  )
  SELECT id::VARCHAR AS id, \"by\", time, title, nullif(url, '') AS url, nullif(left(text, 2000), '') AS text, coalesce(score, 0) AS score,
         coalesce(descendants, 0) AS descendants,
         CASE type WHEN 5 THEN 'job' WHEN 3 THEN 'poll' ELSE
           CASE WHEN title ILIKE 'Ask HN%' THEN 'ask' WHEN title ILIKE 'Show HN%' THEN 'show' ELSE 'story' END END AS kind,
         nullif(lower(regexp_extract(url, '^[a-zA-Z]+://(www\.)?([^/:?#]+)', 2)), '') AS domain
  FROM raw WHERE deleted = 0 AND dead = 0 AND type IN (1, 3, 5)
) TO '/dev/stdout' (FORMAT JSON);" \
  | "$BUILDER" embed --prefix "$PREFIX" --threads "${EMBED_THREADS:-32}" --batch "${EMBED_BATCH:-100}" --rpm "${EMBED_RPM:-2800}" > "$WORK/embed.json"

# run.sh reports a job done when it leaves a manifest; this one is the shard index.
cp "$WORK/embed.json" "$OUT/manifest.json"
echo "done: $(cat "$WORK/embed.json")" >&2
