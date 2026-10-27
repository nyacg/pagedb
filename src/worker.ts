/**
 * pagedb edge Worker: the apps' pages (server-rendered first paint), leases, sockets and
 * mutations, plus admin routes.
 *   POST /api/lease?app=  {list:[{name,args}]}   → signed queries for the app's object
 *   GET  /api/socket?app=                        → the app's object (subscriptions need leases)
 *   POST /api/mutate?app= {name,args,user}       → a named mutator → the object's write
 *   POST /api/query {db, ast, obj?}  POST /api/write {db, ops, obj?}   (admin: raw ASTs / ops)
 *   PUT|HEAD|GET /api/admin/r2/<key>   GET /api/admin/info?db&obj   POST /api/admin/{reset,reset-overlay,evict,prewarm,compact,fold}
 */
import { DbObject, type Env } from "./do";
import { HnTail } from "./hn-tail";
import { APPS, appFor, type App, type Ref } from "./apps";
import { canon, signLease } from "./lease";
import { embed, packVector, storyText, type EmbedEnv } from "./embed";
import { VEC } from "./apps/hn";
export { DbObject, HnTail };

const admin = (req: Request, env: Env) => !!env.ADMIN_TOKEN && req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
const vars = (env: Env) => env as unknown as Record<string, unknown>;
type QueryStub = {
  query(db: string, ast: unknown): Promise<{ result: { rows?: unknown[]; count?: number; ann?: unknown }; stats: unknown }>;
  baseStats(db: string): Promise<{ bytes: number; rows: Record<string, number>; pages: number }>;
};

async function lease(env: Env, app: App, d: Ref) {
  const key = canon({ name: d.name, args: d.args ?? {} });
  try {
    const ast = await app.namedQuery(d.name, d.args ?? {}, vars(env));
    const { token, exp } = await signLease(env.LEASE_SECRET!, { ast, db: app.db(vars(env)), obj: app.obj(vars(env)) });
    return { key, token, exp, ast };
  } catch (e) {
    return { key, error: (e as Error).message };
  }
}

/** First paint without a socket: the page's first queries run here and are inlined, with the
 *  leases its subscriptions will need (so the socket needs no lease round trip). */
async function ssr(req: Request, env: Env, url: URL, app: App): Promise<Response> {
  const fp = app.firstPaint(url)!;
  const page = await env.ASSETS.fetch(new Request(new URL(fp.asset, url), req));
  let html = await page.text();
  const db = app.db(vars(env));
  const obj = app.obj(vars(env));
  const boot: Record<string, unknown> = { ...fp.boot, app: app.name, db, obj, build: env.CF_VERSION_METADATA?.id };
  const t0 = Date.now();
  try {
    const stub = env.DB.getByName(obj) as unknown as QueryStub;
    const [results, base] = await Promise.all([Promise.all(fp.prefetch.map(async (p) => stub.query(db, await app.namedQuery(p.name, p.args ?? {}, vars(env))))), stub.baseStats(db).catch(() => null)]);
    if (base) boot.base = base;
    fp.prefetch.forEach((p, i) => {
      const r = results[i].result;
      boot[p.key] = r.rows === undefined && r.count !== undefined ? r.count : r;
    });
    if (results.length) boot.ms = Date.now() - t0;
    if (results.length) boot.stats = results[0].stats;
    if (env.LEASE_SECRET) boot.leases = await Promise.all([...fp.prefetch, ...fp.leases].map((d) => lease(env, app, d)));
  } catch {}
  html = html.replace("<!--BOOT-->", `<script>window.__BOOT=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // A retired deployment (the old semantic-search-only Worker) sends visitors to the live site.
    const to = (env as unknown as { REDIRECT_TO?: string }).REDIRECT_TO;
    if (to && !url.pathname.startsWith("/api/admin/")) return Response.redirect(`${to}${url.pathname}${url.search}`, 301);
    const app = appFor(url);
    try {
      if (url.pathname === "/api/lease" && req.method === "POST") {
        if (!env.LEASE_SECRET) return Response.json({ error: "leases are not configured" }, { status: 500 });
        const { list } = (await req.json()) as { list: Ref[] };
        if (!Array.isArray(list) || list.length > 64) return Response.json({ error: "1 to 64 queries per request" }, { status: 400 });
        return Response.json({ leases: await Promise.all(list.map((d) => lease(env, app, d))) });
      }
      // Raw queries and writes: admin only (pages use leases and named mutators).
      if ((url.pathname === "/api/query" || url.pathname === "/api/write") && !admin(req, env)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/api/query" && req.method === "POST") {
        const { db, ast, obj, salt } = (await req.json()) as { db: string; ast: unknown; obj?: string; salt?: string };
        // workerMs: the Worker's round trip to the object, its CPU included (Workers clocks only
        // advance across I/O, so the object can't time its own synchronous engine run).
        const t0 = Date.now();
        const r = await env.DB.getByName(obj ?? db).query(db, ast, { salt });
        return Response.json({ ...r, workerMs: Date.now() - t0 });
      }
      if (url.pathname === "/api/mutate" && req.method === "POST") {
        const { name, args, user } = (await req.json()) as { name: string; args: Record<string, unknown>; user?: string };
        let built;
        try {
          built = app.mutate(name, args ?? {}, app.user(user));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        const ops = app.enrich ? await app.enrich(built.ops, vars(env)) : built.ops;
        const r = await env.DB.getByName(app.obj(vars(env))).write(app.db(vars(env)), { ops });
        return Response.json({ ...r, created: built.created }, { status: "error" in r ? 400 : 200 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") return ssr(req, env, url, APPS.tracker);
      if (url.pathname === "/hn" || url.pathname === "/hn/") {
        // Keep the live tail running while anyone is looking.
        (env.HN_TAIL.getByName("hn") as unknown as { kick(): Promise<unknown> }).kick().catch(() => {});
        return ssr(req, env, url, APPS.hn);
      }
      if (url.pathname === "/place" || url.pathname === "/place/") return ssr(req, env, url, APPS.place);
      if (url.pathname === "/sheet" || url.pathname === "/sheet/") return ssr(req, env, url, APPS.taxi);
      if (url.pathname === "/api/socket") {
        // Only the Worker decides who is admin; anything a client sends in this header is dropped.
        const isAdmin = admin(req, env) || (!!env.ADMIN_TOKEN && url.searchParams.get("token") === env.ADMIN_TOKEN);
        const headers = new Headers(req.headers);
        headers.delete("x-pagedb-admin");
        if (isAdmin) headers.set("x-pagedb-admin", "1");
        // Visitors always reach their app's object; admins may name any object (benchmarks).
        const db = isAdmin ? (url.searchParams.get("db") ?? app.db(vars(env))) : app.db(vars(env));
        const obj = isAdmin ? (url.searchParams.get("obj") ?? db) : app.obj(vars(env));
        const u = new URL(req.url);
        u.searchParams.set("db", db);
        u.searchParams.delete("token");
        return env.DB.getByName(obj).fetch(new Request(u, { headers, method: req.method }));
      }
      if (url.pathname === "/api/write" && req.method === "POST") {
        const { db, ops, obj } = (await req.json()) as { db: string; ops: unknown; obj?: string };
        const r = await env.DB.getByName(obj ?? db).write(db, ops);
        return Response.json(r, { status: "error" in r ? 400 : 200 });
      }
      if (url.pathname.startsWith("/api/admin/")) {
        if (!admin(req, env)) return new Response("unauthorized", { status: 401 });
        if (url.pathname.startsWith("/api/admin/r2/")) {
          const key = decodeURIComponent(url.pathname.slice("/api/admin/r2/".length));
          const bucket = env.BUCKET as R2Bucket;
          if (req.method === "PUT") {
            await bucket.put(key, req.body);
            return Response.json({ ok: true, key });
          }
          if (req.method === "HEAD") return new Response(null, { status: (await bucket.head(key)) ? 200 : 404 });
          const obj = await bucket.get(key);
          return obj ? new Response(obj.body) : new Response("not found", { status: 404 });
        }
        if (url.pathname === "/api/admin/hn-tail") {
          const tail = env.HN_TAIL.getByName("hn") as unknown as { kick(): Promise<unknown>; status(): Promise<unknown>; rewind(): Promise<unknown> };
          if (req.method === "POST" && url.searchParams.has("rewind")) return Response.json(await tail.rewind());
          return Response.json(req.method === "POST" ? await tail.kick() : await tail.status());
        }
        const db = url.searchParams.get("db") ?? "db1g";
        const stub = env.DB.getByName(url.searchParams.get("obj") ?? db);
        if (url.pathname === "/api/admin/reset") return Response.json(await stub.reset(db));
        if (url.pathname === "/api/admin/info") return Response.json(await stub.info());
        if (url.pathname === "/api/admin/remanifest") return Response.json(await stub.remanifest(db));
        if (url.pathname === "/api/admin/drop-pages")
          return Response.json(await stub.dropPages(Number(url.searchParams.get("from") ?? 0), Number(url.searchParams.get("to") ?? 2 ** 53), Number(url.searchParams.get("limit") ?? 2000)));
        if (url.pathname === "/api/admin/prewarm") {
          const n = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
          return Response.json(await stub.prewarm(db, n("from"), n("to")));
        }
        if (url.pathname === "/api/admin/sqlite-bench") return Response.json(await stub.sqliteBench(Number(url.searchParams.get("n") ?? 100), (url.searchParams.get("how") ?? "one") as "one"));
        if (url.pathname === "/api/admin/reset-overlay") return Response.json(await stub.resetOverlay(db));
        if (url.pathname === "/api/admin/fold") return Response.json(await (stub as unknown as { foldNow(db: string): Promise<unknown> }).foldNow(db));
        if (url.pathname === "/api/admin/compact") return Response.json(await (stub as unknown as { compactOverlay(): Promise<unknown> }).compactOverlay());
        // Vectors for stories written since the vector index was built (newest first, a page of
        // up to 100 per call): ?since=<ms>&start={"time":…,"id":"…"}. Same text and model as the
        // live tail's (apps/hn withVectors).
        if (url.pathname === "/api/admin/vec-backfill" && req.method === "POST") {
          const since = Number(url.searchParams.get("since") ?? Date.now());
          const start = url.searchParams.get("start");
          const q = { table: "story", orderBy: [["time", "desc"], ["id", "asc"]], limit: 100, ...(start ? { start: { row: JSON.parse(start) } } : {}) };
          const page = (await (stub as unknown as { query(db: string, ast: unknown): Promise<{ result: { rows: Record<string, any>[] } }> }).query(db, q)).result.rows;
          const rows = page.filter((r) => r.time >= since);
          if (rows.length) {
            const vecs = await embed(env as unknown as EmbedEnv, rows.map((r) => storyText(r) || "(untitled)"));
            const ops = rows.map((r, i) => ({ op: "vec_put", index: VEC.index, id: r.id, vec: packVector(vecs[i], VEC.dims) }));
            const w = await (stub as unknown as { write(db: string, ops: unknown): Promise<{ error?: string }> }).write(db, { ops });
            if (w.error) return Response.json({ error: w.error }, { status: 500 });
          }
          const last = page.at(-1);
          return Response.json({ n: rows.length, oldest: rows.at(-1)?.time, next: rows.length === page.length && last ? { time: last.time, id: last.id } : null });
        }
        if (url.pathname === "/api/admin/evict") return Response.json(await stub.evict().then(() => ({ ok: true }), () => ({ ok: true, aborted: true })));
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
    }
  },
  /** Every minute: keep HN's live tail alive. 09:00 UTC: apps with a nightly reset go back to
   *  their published base (two writes, not 100 GB). */
  async scheduled(c: ScheduledController, env: Env) {
    if (c.cron === "* * * * *") {
      await (env.HN_TAIL.getByName("hn") as unknown as { kick(): Promise<unknown> }).kick();
      return;
    }
    for (const app of Object.values(APPS)) {
      if (!app.nightlyReset) continue;
      await (env.DB.getByName(app.obj(vars(env))) as unknown as { resetOverlay(db: string): Promise<unknown> }).resetOverlay(app.db(vars(env)));
    }
  },
} satisfies ExportedHandler<Env>;
