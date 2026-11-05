# pgbench -i for a database in a Durable Object, in chunks a request can finish (each chunk is one
# INSERT … SELECT generate_series; the tables and primary keys are created first).
#   python3 scripts/pginit.py <db> <scale> [rows per chunk] [first aid]
import json, os, re, subprocess, sys, time
U = "https://pagedb-pg-spike.do-pool-lab.workers.dev"
TOKEN = re.search(r"^PGDO_TOKEN=(.*)$", open(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env")).read(), re.M).group(1).strip()
db, scale = sys.argv[1], int(sys.argv[2])
chunk = int(sys.argv[3]) if len(sys.argv) > 3 else 500000
start = int(sys.argv[4]) if len(sys.argv) > 4 else 1
total = 100000 * scale
t0 = time.time()
for a in range(start, total + 1, chunk):
    b = min(total, a + chunk - 1)
    for attempt in range(5):
        out = subprocess.run(["curl", "-s", "-m", "900", "-H", f"Authorization: Bearer {TOKEN}", f"{U}/pginit?db={db}&scale={scale}&from={a}&to={b}"], capture_output=True, text=True).stdout
        try:
            r = json.loads(out)
            if all(x == "ok" for x in r["results"]): break
            print("  retry", a, r["results"][-1][:200], flush=True)
        except ValueError:
            print("  retry", a, out[:200], flush=True)
        time.sleep(3)
    else:
        sys.exit(f"chunk {a} failed")
    print(f"{b}/{total} rows, {time.time() - t0:.0f} s", flush=True)
print(json.dumps({"db": db, "scale": scale, "seconds": round(time.time() - t0)}))
