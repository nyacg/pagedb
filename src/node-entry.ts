/**
 * Entry worker inside the pagedb container (workerd). The same DbObject as on Cloudflare,
 * with GBs of RAM tier and a local disk cache; R2 is reached through the node's bridge.
 */
import { DbObject, type Env } from "./do";
export { DbObject };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/health") return new Response("ok");
      if (url.pathname === "/api/debug2") {
        const key = "db/db1g/base/" + url.searchParams.get("base") + "/part-000000";
        const len = Number(url.searchParams.get("len") ?? 1048576);
        const n = Number(url.searchParams.get("n") ?? 1);
        const one = async (i: number) => {
          try {
            const r = await fetch(`http://r2.internal/get?key=${encodeURIComponent(key)}&offset=${i * len}&length=${len}`);
            return `${r.status}:${(await r.arrayBuffer()).byteLength}`;
          } catch (e) {
            return `throws ${String((e as Error).message ?? e)}`;
          }
        };
        const fromWorker = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
        const fromDo = await (env.DB.getByName("debug") as any).debugFetch(key, len, n);
        return Response.json({ env: { R2_URL: (env as any).R2_URL ?? null, token: !!(env as any).R2_TOKEN, RAM_PAGES: (env as any).RAM_PAGES }, fromWorker, fromDo });
      }
      if (url.pathname === "/api/debug") {
        const out: Record<string, string> = {};
        const target = "http://r2.internal/get?key=db/db1g/manifest.json";
        for (const [name, f] of [
          ["global", () => fetch(target)],
          ["binding", () => (env.BUCKET as Fetcher).fetch(target)],
        ] as const) {
          try {
            const r = await f();
            out[name] = `${r.status} ${(await r.text()).slice(0, 60)}`;
          } catch (e) {
            out[name] = `throws: ${String((e as Error).message ?? e)}`;
          }
        }
        return Response.json(out);
      }
      if (url.pathname === "/api/socket") {
        const db = url.searchParams.get("db") ?? "db1g";
        return env.DB.getByName(url.searchParams.get("obj") ?? db).fetch(req);
      }
      if (url.pathname === "/api/query" && req.method === "POST") {
        const { db, ast, obj } = (await req.json()) as { db: string; ast: unknown; obj?: string };
        return Response.json(await (env.DB.getByName(obj ?? db) as any).query(db, ast, {}));
      }
      if (url.pathname === "/api/write" && req.method === "POST") {
        const { db, ops, obj } = (await req.json()) as { db: string; ops: unknown; obj?: string };
        const r = await (env.DB.getByName(obj ?? db) as any).write(db, ops);
        return Response.json(r, { status: "error" in r ? 400 : 200 });
      }
      if (url.pathname === "/api/admin/info") {
        const db = url.searchParams.get("db") ?? "db1g";
        return Response.json(await (env.DB.getByName(url.searchParams.get("obj") ?? db) as any).info());
      }
      return new Response("pagedb node", { status: 404 });
    } catch (e) {
      return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
    }
  },
};
