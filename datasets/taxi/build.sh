#!/bin/bash
# Every NYC yellow-cab trip of a year (2015: ~146M) → a pagedb base.
#   YEAR=2015 OUT=/data/out WORK=/data/work datasets/taxi/build.sh   (MONTHS="01" LIMIT=n for a sample)
# Source: NYC TLC trip records (parquet over HTTPS) and the taxi zone lookup. DuckDB numbers
# the trips in pickup order once (the primary key, so row N is trip N), keeps them in a local
# table (month by month, so it's in id order), and streams them through named pipes into the
# builder: the primary tree straight
# from the sorted stream, then one pass per covering sort index (so its spill fits the disk)
# and one for the group indexes (pointers: a group's rows sit close together in pickup order).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DUCKDB="${DUCKDB:-duckdb}"
BUILDER="${BUILDER:-pagedb-builder}"
YEAR="${YEAR:-2015}"
OUT="${OUT:-/data/out}"
WORK="${WORK:-/data/work}"
MEM="${MEM:-5000}"
mkdir -p "$WORK" "$OUT"
DB="$WORK/taxi.duckdb"
rm -f "$DB" "$DB.wal"
duck() { "$DUCKDB" "$DB" -c "SET memory_limit='${DUCK_MEM:-5GB}'; SET threads=4; SET preserve_insertion_order=true; SET temp_directory='$WORK/duck-tmp'; LOAD httpfs; $1"; }
"$DUCKDB" -c "INSTALL httpfs;" >/dev/null
files=$(for m in 01 02 03 04 05 06 07 08 09 10 11 12; do printf "'https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_%s-%s.parquet'," "$YEAR" "$m"; done)
duck "CREATE TABLE zone AS SELECT LocationID::VARCHAR AS id, Borough AS borough, Zone AS zone, service_zone AS service
  FROM read_csv('https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv', header = true);"
# Month by month: each month's trips sorted by pickup (then every column, so the numbering is
# deterministic and a resumed build makes identical parts) and numbered on from the last month, so
# the table is in id (= pickup) order without sorting the whole year at once.
offset=0
for m in ${MONTHS:-01 02 03 04 05 06 07 08 09 10 11 12}; do
  [ "$offset" = 0 ] && create="CREATE TABLE trip AS" || create="INSERT INTO trip"
  n=$(duck "
$create
  SELECT lpad(($offset + row_number() OVER (ORDER BY tpep_pickup_datetime, tpep_dropoff_datetime, PULocationID, DOLocationID, total_amount, fare_amount, tip_amount, tolls_amount, trip_distance, passenger_count, payment_type, VendorID))::VARCHAR, 9, '0') AS id,
         epoch_ms(tpep_pickup_datetime) AS pickup, epoch_ms(tpep_dropoff_datetime) AS dropoff,
         greatest(0, date_diff('second', tpep_pickup_datetime, tpep_dropoff_datetime)) AS duration,
         VendorID AS vendor, passenger_count AS passengers, round(trip_distance, 2) AS distance,
         PULocationID AS pu, DOLocationID AS \"do\", coalesce(z.borough, 'Unknown') AS borough, payment_type AS payment,
         round(fare_amount, 2) AS fare, round(tip_amount, 2) AS tip, round(tolls_amount, 2) AS tolls, round(total_amount, 2) AS total
  FROM read_parquet('https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_$YEAR-$m.parquet') t LEFT JOIN zone z ON z.id = t.PULocationID::VARCHAR
  WHERE year(tpep_pickup_datetime) = $YEAR AND month(tpep_pickup_datetime) = ${m#0}
  ORDER BY 1 ${LIMIT:+LIMIT $LIMIT};
COPY (SELECT count(*) FROM trip) TO '/dev/stdout' (HEADER false);")
  echo "month $m: $n trips so far" >&2
  offset=$n
done
for f in t1 t2 t3 t4 t5 t6 zones; do rm -f "$WORK/$f"; mkfifo "$WORK/$f"; done
(
  duck "COPY (SELECT * FROM trip) TO '$WORK/t1' (FORMAT JSON);"
  duck "COPY (SELECT * FROM trip) TO '$WORK/t2' (FORMAT JSON);"
  duck "COPY (SELECT * FROM trip) TO '$WORK/t3' (FORMAT JSON);"
  duck "COPY (SELECT * FROM trip) TO '$WORK/t4' (FORMAT JSON);"
  duck "COPY (SELECT * FROM trip) TO '$WORK/t5' (FORMAT JSON);"
  duck "COPY (SELECT * FROM trip) TO '$WORK/t6' (FORMAT JSON);"
  duck "COPY (SELECT * FROM zone) TO '$WORK/zones' (FORMAT JSON);"
) &
DUCK_PID=$!
"$BUILDER" ingest --schema "$HERE/schema.json" --mem "$MEM" --tmp "$WORK/runs" --out "$OUT" \
  --input "trip=$WORK/t1@trip_by_id:sorted" \
  --input "trip=$WORK/t2@trip_by_total" \
  --input "trip=$WORK/t3@trip_by_tip" \
  --input "trip=$WORK/t4@trip_by_distance" \
  --input "trip=$WORK/t5@trip_by_duration" \
  --input "trip=$WORK/t6@trip_by_payment,trip_by_borough,trip_by_passengers" \
  --input "zone=$WORK/zones"
wait $DUCK_PID
rm -f "$WORK"/t1 "$WORK"/t2 "$WORK"/t3 "$WORK"/t4 "$WORK"/t5 "$WORK"/t6 "$WORK"/zones
