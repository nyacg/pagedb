# Compare pg_regress runs (from run.py): which tests pass where, and why the rest fail.
#   python3 test/regress/report.py native=<dir> pglite=<dir> do=<dir>
import json, os, re, sys

runs = dict(a.split("=", 1) for a in sys.argv[1:])
res = {k: json.load(open(os.path.join(v, "results.json"))) for k, v in runs.items()}
tests = list(next(iter(res.values())).keys())

# Causes, tried in order on a failing test's diff (lines it added).
CAUSES = [
    ("hang", None),
    ("C test library (regress.so can't load into wasm)", r"regress\.(so|dylib)|could not access file .*regress"),
    ("non-UTF8 encoding conversion", r"conversion|encoding|LATIN|EUC_|SJIS"),
    ("tablespaces / server filesystem", r"tablespace|could not (create|open) (directory|file)"),
    ("event triggers / login hooks", r"event trigger"),
    ("parallel query / workers off", r"parallel|Gather|worker"),
    ("ICU / collations", r"collation|icu"),
    ("statistics / autovacuum timing", r"pg_stat|stats|autovacuum|vacuum"),
    ("large objects", r"large object|lo_"),
    ("roles / privileges", r"permission denied|must be (superuser|owner)|role"),
]

def cause(run, t):
    r = res[run][t]
    if r["status"] == "hang": return "hang"
    p = os.path.join(runs[run], "diffs", f"{t}.diff")
    if not os.path.exists(p): return "other"
    added = "\n".join(l for l in open(p, errors="replace").read().splitlines() if l.startswith("+") and not l.startswith("+++"))
    for name, rx in CAUSES[1:]:
        if re.search(rx, added, re.I): return name
    return "other"

def first_diff(run, t, n=2):
    p = os.path.join(runs[run], "diffs", f"{t}.diff")
    if not os.path.exists(p): return ""
    lines = [l for l in open(p, errors="replace").read().splitlines() if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---"))]
    return " | ".join(lines[:n])[:160]

print("| run | pass | fail | hang |\n|---|---|---|---|")
for k in runs:
    c = {"ok": 0, "fail": 0, "hang": 0, "error": 0}
    for t in tests:
        c[res[k].get(t, {"status": "error"})["status"]] += 1
    print(f"| {k} | {c['ok']} | {c['fail'] + c['error']} | {c['hang']} |")

if "pglite" in res:
    print("\nFailures under PGlite (Node), by likely cause:")
    by = {}
    for t in tests:
        if res["pglite"][t]["status"] != "ok": by.setdefault(cause("pglite", t), []).append(t)
    for k, v in sorted(by.items(), key=lambda kv: -len(kv[1])): print(f"- {k} ({len(v)}): {' '.join(v)}")

if "do" in res and "pglite" in res:
    only = [t for t in tests if t in res["do"] and res["do"][t]["status"] != "ok" and res["pglite"][t]["status"] == "ok"]
    fixed = [t for t in tests if t in res["do"] and res["do"][t]["status"] == "ok" and res["pglite"][t]["status"] != "ok"]
    print(f"\nFail in the Durable Object but pass under PGlite in Node ({len(only)}):")
    for t in only: print(f"- {t} [{res['do'][t]['status']}]: {first_diff('do', t)}")
    print(f"\nPass in the Durable Object but fail under PGlite in Node ({len(fixed)}): {' '.join(fixed)}")
