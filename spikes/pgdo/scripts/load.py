# Drive /load from many Worker invocations at once (a Worker holds ≤6 connections, so 5 clients each).
#   python3 scripts/load.py <target do|neon> <invocations> <ops> <prefix> [hot]
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
U = "https://pagedb-pg-spike.do-pool-lab.workers.dev"
TOKEN = re.search(r"^PGDO_TOKEN=(.*)$", open(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env")).read(), re.M).group(1).strip()
target, n, ops, prefix = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
hot = "".join("&hot=1" if a == "hot" else f"&{a}" for a in sys.argv[5:])  # hot | classes=8
def one(i):
    out = subprocess.run(["curl", "-s", "-m", "900", "-H", f"Authorization: Bearer {TOKEN}", f"{U}/load?target={target}&clients=5&ops={ops}&prefix={prefix}&inv={i}{hot}"], capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except ValueError:
        return {"lat": [], "initLat": [], "errors": 5 * ops, "wallMs": 1, "firstError": out[:200]}
t0 = time.time()
with ThreadPoolExecutor(n) as ex: rs = list(ex.map(one, range(n)))
lat = sorted(l for r in rs for l in r["lat"]); init = sorted(l for r in rs for l in r["initLat"])
ops_done, errs = len(lat), sum(r["errors"] for r in rs)
wall = max(r["wallMs"] for r in rs) / 1000
pct = lambda a, q: a[min(len(a) - 1, int(q * len(a)))] if a else None
w = [x for r in rs for x in (r.get("where") or []) if x]
iso = {}
for x in w: iso[x["isolate"]] = max(iso.get(x["isolate"], 0), x["postgresInIsolate"])
extra = {"isolates": len(iso), "maxPostgresPerIsolate": max(iso.values()), "maxIsolateHeapMB": max(x["heapsMB"] for x in w)} if w else {}
print(json.dumps({**extra, "target": target, "clients": 5 * n, "opts": hot, "ops": ops_done, "errors": errs, "firstError": next((r["firstError"] for r in rs if r.get("firstError")), None),
    "opsPerSec": round(ops_done / wall), "p50": pct(lat, .5), "p90": pct(lat, .9), "p99": pct(lat, .99), "initP50": pct(init, .5), "initMax": init[-1] if init else None, "laptopS": round(time.time() - t0, 1)}))
