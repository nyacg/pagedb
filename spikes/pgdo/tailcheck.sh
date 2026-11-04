#!/bin/sh
# Tail the spike Worker while running one request: tailcheck.sh "<curl args…>"
cd "$(dirname "$0")"
(./deploy.sh tail --format json > /tmp/vf/pgtail.jsonl 2>/dev/null &)
sleep 8
TOKEN=$(grep -E '^PGDO_TOKEN=' ../../.env | cut -d= -f2-)
curl -s -m 180 -H "Authorization: Bearer $TOKEN" "$@" | head -c 400; echo
sleep 8
pkill -f "wrangler tail"
python3 - <<'PY'
import json
dec=json.JSONDecoder(); txt=open("/tmp/vf/pgtail.jsonl").read(); i=0
while i<len(txt):
    while i<len(txt) and txt[i] in " \n\r\t": i+=1
    if i>=len(txt): break
    try: o,j=dec.raw_decode(txt,i)
    except Exception: break
    i=j
    print("outcome:",o.get("outcome"), "cpu", o.get("cpuTime"), "wall", o.get("wallTime"))
    for e in o.get("exceptions",[]): print(" EXC", e.get("name"), (e.get("message") or "")[:600])
    for l in o.get("logs",[])[-8:]: print(" LOG", str(l.get("message"))[:400])
PY
