// A local Postgres endpoint for a database in a Durable Object: accepts Postgres connections on
// TCP and carries each one over a WebSocket to the Worker's /wire route (Workers can't accept
// TCP). The database name in the connection picks the object; the password is the token.
//   node scripts/pgdo-proxy.mjs [port] [wss://…/wire]
//   psql postgres://postgres:$PGDO_TOKEN@localhost:6543/mydb
import { createServer } from "node:net";

const port = Number(process.argv[2] ?? 6543);
const url = process.argv[3] ?? "wss://pagedb-pg-spike.do-pool-lab.workers.dev/wire";

createServer((sock) => {
  sock.setNoDelay(true);
  let ws;
  let head = Buffer.alloc(0);
  const early = [];
  sock.on("data", (d) => {
    if (ws) return ws.readyState === WebSocket.OPEN ? ws.send(d) : early.push(d);
    head = Buffer.concat([head, d]);
    for (;;) {
      if (head.length < 8) return;
      const len = head.readInt32BE(0), code = head.readInt32BE(4);
      if (code === 80877103 || code === 80877104) {
        // SSL/GSS request: no (the hop to Cloudflare is TLS; this end is local)
        sock.write("N");
        head = head.subarray(8);
        continue;
      }
      if (code === 80877102) return sock.end(); // cancel requests aren't supported
      if (head.length < len) return;
      const kv = head.subarray(8, len).toString("utf8").split("\0");
      const get = (k) => (kv.indexOf(k) >= 0 ? kv[kv.indexOf(k) + 1] : undefined);
      const db = get("database") || get("user") || "postgres";
      early.push(head);
      ws = new WebSocket(`${url}?db=${encodeURIComponent(db)}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        for (const b of early.splice(0)) ws.send(b);
      };
      ws.onmessage = (e) => sock.write(Buffer.from(e.data));
      ws.onclose = () => sock.end();
      ws.onerror = () => sock.destroy();
      return;
    }
  });
  const close = () => {
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  };
  sock.on("close", close);
  sock.on("error", close);
}).listen(port, () => console.log(`Postgres on localhost:${port} → ${url}`));
