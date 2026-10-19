/**
 * pagedb edge Worker.
 *   POST /api/query {db, ast, obj?, salt?}     → {result, stats}
 *   PUT  /api/admin/r2/<key>   (Bearer ADMIN_TOKEN) → R2 put (base upload)
 *   POST /api/admin/reset {db, obj?}           → drop an object's page cache
 *   GET  /api/admin/info?db&obj
 */
import { DbObject, type Env } from "./do";
export { DbObject };

const admin = (req: Request, env: Env) => !!env.ADMIN_TOKEN && req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/query" && req.method === "POST") {
        const { db, ast, obj, salt } = (await req.json()) as { db: string; ast: unknown; obj?: string; salt?: string };
        return Response.json(await env.DB.getByName(obj ?? db).query(db, ast, { salt }));
      }
      if (url.pathname.startsWith("/api/admin/")) {
        if (!admin(req, env)) return new Response("unauthorized", { status: 401 });
        if (url.pathname.startsWith("/api/admin/r2/") && req.method === "PUT") {
          const key = decodeURIComponent(url.pathname.slice("/api/admin/r2/".length));
          await env.BUCKET.put(key, req.body);
          return Response.json({ ok: true, key });
        }
        const db = url.searchParams.get("db") ?? "db1g";
        const stub = env.DB.getByName(url.searchParams.get("obj") ?? db);
        if (url.pathname === "/api/admin/reset") return Response.json(await stub.reset());
        if (url.pathname === "/api/admin/info") return Response.json(await stub.info());
        if (url.pathname === "/api/admin/evict") return Response.json(await stub.evict().then(() => ({ ok: true }), () => ({ ok: true, aborted: true })));
      }
      return new Response("pagedb", { status: url.pathname === "/" ? 200 : 404 });
    } catch (e) {
      return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
