/**
 * pagedb edge Worker.
 *   POST /api/query {db, ast, obj?, salt?}     → {result, stats}
 *   PUT  /api/admin/r2/<key>   (Bearer ADMIN_TOKEN) → R2 put (base upload)
 *   POST /api/admin/reset {db, obj?}           → drop an object's page cache
 *   GET  /api/admin/info?db&obj
 */
import { DbObject, type Env } from "./do";
import { issuesQuery, countQuery, mutate, namedQuery } from "./app";
import { canon, signLease } from "./lease";
export { DbObject };

/** The demo's database and object (all visitors share one object, like r2db's demo).
 *  DEMO_DB is a var so the demo can move from the 1 GB to the 100 GB base without a code change. */
let DEMO_DB = "db1g";
let DEMO_OBJ = "demo";

const admin = (req: Request, env: Env) => !!env.ADMIN_TOKEN && req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;

/** First paint without a socket: the issue list for the requested project, inlined. */
async function ssr(req: Request, env: Env, url: URL): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL("/app", url), req));
  let html = await page.text();
  const project = /^p\d{4}$/.test(url.searchParams.get("project") ?? "") ? url.searchParams.get("project")! : "p0003";
  const view = url.searchParams.get("view") ?? "list";
  let boot: Record<string, unknown> = { project, db: DEMO_DB, obj: DEMO_OBJ, build: env.CF_VERSION_METADATA?.id };
  if (view === "list" && !url.searchParams.get("q")) {
    const t0 = Date.now();
    try {
      // (RPC result types are deep; a narrow view keeps the type checker happy.)
      const stub = env.DB.getByName(DEMO_OBJ) as unknown as { query(db: string, ast: unknown): Promise<{ result: { rows?: unknown[]; count?: number }; stats: unknown }> };
      const [list, count] = await Promise.all([stub.query(DEMO_DB, issuesQuery(project)), stub.query(DEMO_DB, countQuery(project))]);
      boot = { ...boot, list: list.result, count: count.result.count, ms: Date.now() - t0, stats: list.stats };
      // The first view's subscriptions arrive pre-signed, so the socket needs no lease round trip.
      if (env.LEASE_SECRET) {
        boot.leases = await Promise.all(
          [
            { name: "issues", args: { project, filter: {}, limit: 50 } },
            { name: "count", args: { project } },
            { name: "project", args: { id: project } },
          ].map((d) => lease(env, d)),
        );
      }
    } catch {}
  }
  html = html.replace("<!--BOOT-->", `<script>window.__BOOT=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function lease(env: Env, d: { name: string; args?: Record<string, unknown> }) {
  const key = canon({ name: d.name, args: d.args ?? {} });
  try {
    const ast = namedQuery(d.name, d.args ?? {});
    const { token, exp } = await signLease(env.LEASE_SECRET!, { ast, db: DEMO_DB, obj: DEMO_OBJ });
    return { key, token, exp, ast };
  } catch (e) {
    return { key, error: (e as Error).message };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    DEMO_DB = (env as Env & { DEMO_DB?: string }).DEMO_DB ?? DEMO_DB;
    DEMO_OBJ = (env as Env & { DEMO_OBJ?: string }).DEMO_OBJ ?? DEMO_OBJ;
    try {
      if (url.pathname === "/api/lease" && req.method === "POST") {
        if (!env.LEASE_SECRET) return Response.json({ error: "leases are not configured" }, { status: 500 });
        const { list } = (await req.json()) as { list: { name: string; args?: Record<string, unknown> }[] };
        if (!Array.isArray(list) || list.length > 64) return Response.json({ error: "1 to 64 queries per request" }, { status: 400 });
        return Response.json({ leases: await Promise.all(list.map((d) => lease(env, d))) });
      }
      // Raw queries and writes: admin only (pages use leases and named mutators).
      if ((url.pathname === "/api/query" || url.pathname === "/api/write") && !admin(req, env)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/api/query" && req.method === "POST") {
        const { db, ast, obj, salt } = (await req.json()) as { db: string; ast: unknown; obj?: string; salt?: string };
        return Response.json(await env.DB.getByName(obj ?? db).query(db, ast, { salt }));
      }
      if (url.pathname === "/api/mutate" && req.method === "POST") {
        const { name, args, user } = (await req.json()) as { name: string; args: Record<string, unknown>; user?: string };
        const actor = typeof user === "string" && /^u\d{5}$/.test(user) ? user : "u00000";
        let built;
        try {
          built = mutate(name, args ?? {}, actor);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        const r = await env.DB.getByName(DEMO_OBJ).write(DEMO_DB, { ops: built.ops });
        return Response.json({ ...r, created: built.created }, { status: "error" in r ? 400 : 200 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") return ssr(req, env, url);
      if (url.pathname === "/api/socket") {
        // Only the Worker decides who is admin; anything a client sends in this header is dropped.
        const isAdmin = admin(req, env) || (!!env.ADMIN_TOKEN && url.searchParams.get("token") === env.ADMIN_TOKEN);
        const headers = new Headers(req.headers);
        headers.delete("x-pagedb-admin");
        if (isAdmin) headers.set("x-pagedb-admin", "1");
        // Visitors always reach the demo database; admins may name any object (benchmarks).
        const db = isAdmin ? (url.searchParams.get("db") ?? DEMO_DB) : DEMO_DB;
        const obj = isAdmin ? (url.searchParams.get("obj") ?? db) : DEMO_OBJ;
        const u = new URL(req.url);
        u.searchParams.set("db", db);
        u.searchParams.delete("token");
        return env.DB.getByName(obj).fetch(new Request(u, { headers, method: req.method }));
      }
      if (url.pathname === "/api/write" && req.method === "POST") {
        // Raw row ops (the demo app's named mutators build these; see app.ts later).
        const { db, ops, obj } = (await req.json()) as { db: string; ops: unknown; obj?: string };
        const r = await env.DB.getByName(obj ?? db).write(db, ops);
        return Response.json(r, { status: "error" in r ? 400 : 200 });
      }
      if (url.pathname.startsWith("/api/admin/")) {
        if (!admin(req, env)) return new Response("unauthorized", { status: 401 });
        if (url.pathname.startsWith("/api/admin/r2/") && req.method === "PUT") {
          const key = decodeURIComponent(url.pathname.slice("/api/admin/r2/".length));
          await (env.BUCKET as R2Bucket).put(key, req.body);
          return Response.json({ ok: true, key });
        }
        const db = url.searchParams.get("db") ?? "db1g";
        const stub = env.DB.getByName(url.searchParams.get("obj") ?? db);
        if (url.pathname === "/api/admin/reset") return Response.json(await stub.reset());
        if (url.pathname === "/api/admin/info") return Response.json(await stub.info());
        if (url.pathname === "/api/admin/reset-overlay") return Response.json(await stub.resetOverlay(db));
        if (url.pathname === "/api/admin/evict") return Response.json(await stub.evict().then(() => ({ ok: true }), () => ({ ok: true, aborted: true })));
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
    }
  },
  /** 09:00 UTC: the public demo goes back to the published base (two writes, not 100 GB). */
  async scheduled(_c: ScheduledController, env: Env) {
    DEMO_DB = (env as Env & { DEMO_DB?: string }).DEMO_DB ?? DEMO_DB;
    DEMO_OBJ = (env as Env & { DEMO_OBJ?: string }).DEMO_OBJ ?? DEMO_OBJ;
    await (env.DB.getByName(DEMO_OBJ) as unknown as { resetOverlay(db: string): Promise<unknown> }).resetOverlay(DEMO_DB);
  },
} satisfies ExportedHandler<Env>;
