# Postgres's regression suite (pg_regress), one test at a time, against a wire endpoint.
#   python3 test/regress/run.py local|do|native <outdir> [first-test]
# local: PGlite over the wire in Node (scripts/local-wire.ts, data on disk), started here.
# do:    a Durable Object through scripts/pgdo-proxy.mjs on :6543 (start it first).
# native: a real Postgres 18.6 on :6545 (the baseline: what fails here fails anywhere).
# A test that runs past the timeout is killed and recorded as "hang"; the backend is restarted
# (it recovers from its storage) and the run continues. Results: <outdir>/results.json, diffs/.
import json, os, re, shutil, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SPIKE = os.path.dirname(os.path.dirname(HERE))
REGRESS = "/private/tmp/pgsrc/postgresql-18.6/src/test/regress"
BIN = "/tmp/pg18/bin"
mode, out = sys.argv[1], os.path.abspath(sys.argv[2])
start_at = sys.argv[3] if len(sys.argv) > 3 else None
env_file = open(os.path.join(SPIKE, "..", "..", ".env")).read()
TOKEN = re.search(r"^PGDO_TOKEN=(.*)$", env_file, re.M).group(1).strip()
TIMEOUT = 90 if mode != "do" else 420
port, password = {"local": (6544, "local"), "do": (6543, TOKEN), "native": (6545, "")}[mode]
DB = "regression" if mode == "local" else os.environ.get("REGRESS_DB", "regression")

os.makedirs(os.path.join(out, "results"), exist_ok=True)
os.makedirs(os.path.join(out, "diffs"), exist_ok=True)
server = None

def start_local():
    global server
    if server: os.killpg(server.pid, signal.SIGKILL); server.wait()
    server = subprocess.Popen(["node", "--experimental-strip-types", "--no-warnings", "scripts/local-wire.ts", str(port), password, os.path.join(REGRESS, "data"), out],
        cwd=SPIKE, env={**os.environ, "PGDATA_ROOT": os.path.join(out, "pgdata")}, stdout=open(os.path.join(out, "server.log"), "a"), stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(2)

def restart():
    if mode == "local": return start_local()
    subprocess.run(["curl", "-s", "-m", "60", "-H", f"Authorization: Bearer {TOKEN}", f"https://pagedb-pg-spike.do-pool-lab.workers.dev/evict?db={DB}"], capture_output=True)
    time.sleep(3)

tests = []
for line in open(os.path.join(HERE, "schedule")):
    if line.startswith("test:"): tests += line.split()[1:]
if start_at: tests = tests[tests.index(start_at):]

results = json.load(open(os.path.join(out, "results.json"))) if os.path.exists(os.path.join(out, "results.json")) else {}
if mode == "local" and not start_at: shutil.rmtree(os.path.join(out, "pgdata"), ignore_errors=True)
if mode == "local": start_local()
env = {**os.environ, "PGPASSWORD": password, "PATH": f"{BIN}:{os.environ['PATH']}"}
for t in tests:
    t0 = time.time()
    p = subprocess.Popen(["./pg_regress", "--use-existing", "--host=localhost", f"--port={port}", "--user=postgres", f"--dbname={DB}", "--inputdir=.",
        f"--bindir={BIN}", f"--outputdir={out}", "--max-connections=1", t], cwd=REGRESS, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        so, _ = p.communicate(timeout=TIMEOUT)
        status = "ok" if re.search(r"^ok ", so, re.M) else "fail" if re.search(r"^not ok ", so, re.M) else "error"
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.wait(); status = "hang"; so = ""
        restart()
    d = os.path.join(out, "regression.diffs")
    if status != "ok" and os.path.exists(d): shutil.copy(d, os.path.join(out, "diffs", f"{t}.diff"))
    results[t] = {"status": status, "s": round(time.time() - t0, 1)}
    if status == "error": results[t]["output"] = so[-500:]
    json.dump(results, open(os.path.join(out, "results.json"), "w"), indent=1)
    print(f"{status:5} {t} ({results[t]['s']} s)", flush=True)
if server: os.killpg(server.pid, signal.SIGKILL)
c = {}
for r in results.values(): c[r["status"]] = c.get(r["status"], 0) + 1
print(json.dumps(c))
