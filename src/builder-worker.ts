/**
 * pagedb-builder: runs the dataset builder in a Cloudflare Container so a 100 GB base is
 * written straight into R2 (a laptop uploads at ~11 MB/s; this doesn't).
 *   POST /start?db=db100g&projects=2710&comments=6.8   (Bearer ADMIN_TOKEN)
 *   GET  /status?db=db100g
 * When done, the manifest is written as db/<db>/manifest-<base>.json; promote it to
 * db/<db>/manifest.json once checked (POST /promote?db=…&base=…).
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  BUCKET: R2Bucket;
  BOX: DurableObjectNamespace<BuilderBox>;
  ADMIN_TOKEN?: string;
}

/** The container's only egress: PUT http://r2.internal/put/<key> → R2. */
export class R2Put extends WorkerEntrypoint<Env> {
  override async fetch(req: Request) {
    const url = new URL(req.url);
    if (req.method === "HEAD" && url.pathname.startsWith("/put/")) {
      // Resume support: parts are deterministic, so one that already exists is skipped.
      const head = await this.env.BUCKET.head(decodeURIComponent(url.pathname.slice(5)));
      return new Response(null, { status: head ? 200 : 404 });
    }
    if (req.method !== "PUT" || !url.pathname.startsWith("/put/")) return new Response("no", { status: 403 });
    await this.env.BUCKET.put(decodeURIComponent(url.pathname.slice(5)), req.body);
    return new Response("ok");
  }
}

export class BuilderBox extends DurableObject<Env> {
  async start(db: string, projects: number, comments: number, resumeBase?: string) {
    const c = this.ctx.container!;
    if (c.running) return { running: true, base: this.ctx.storage.kv.get("base") };
    // Resuming reuses a base id: the builder is deterministic, so parts already in R2 are skipped.
    const base = resumeBase || `b${Date.now().toString(36)}`;
    this.ctx.storage.kv.put("base", base);
    c.start({
      image: c.images.builder,
      enableInternet: false,
      instance: { vcpu: 4, memoryMib: 12288, diskMb: 20000 },
      env: { DB: db, PROJECTS: String(projects), COMMENTS: String(comments), BASE: base },
    } as any);
    await c.interceptOutboundHttp("r2.internal", (this.ctx.exports as any).R2Put({ props: {} }));
    // A container lives and dies with its object, and the container's uploads never touch the
    // object, so it would look idle and be evicted. Waiting on the container's monitor and a
    // short alarm keep it resident for the whole build.
    this.ctx.waitUntil(c.monitor().catch(() => {}));
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
    return { started: true, base };
  }

  /** The outbound route belongs to the object instance: after any reset (e.g. a deploy) the
   *  running container's uploads have nowhere to go until it's registered again. */
  async reattach() {
    const c = this.ctx.container;
    if (!c?.running) return { running: false };
    await c.interceptOutboundHttp("r2.internal", (this.ctx.exports as any).R2Put({ props: {} }));
    this.ctx.waitUntil(c.monitor().catch(() => {}));
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
    return { running: true, reattached: true };
  }

  async alarm() {
    await this.reattach();
  }

  async stop() {
    this.ctx.container?.destroy();
    return { stopped: true };
  }

  async info() {
    return { running: !!this.ctx.container?.running, base: this.ctx.storage.kv.get("base") };
  }

  async logs() {
    // Tail of the build log, read through the container's own exec.
    const c = this.ctx.container as any;
    if (!c?.running || typeof c.exec !== "function") return { error: "not running or no exec" };
    const r = await c.exec(["sh", "-c", "tail -5 /data/build.log; ls /data/out/parts | wc -l; df -h /data | tail -1"]);
    return { out: typeof r?.stdout === "string" ? r.stdout : JSON.stringify(r) };
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return new Response("unauthorized", { status: 401 });
    const db = url.searchParams.get("db") ?? "db100g";
    // (RPC return types are deep; a narrow view keeps the checker fast.)
    const box = env.BOX.getByName(db) as unknown as {
      start(db: string, p: number, c: number, base?: string): Promise<unknown>;
      info(): Promise<unknown>;
      stop(): Promise<unknown>;
      reattach(): Promise<unknown>;
      logs(): Promise<unknown>;
    };
    if (url.pathname === "/start" && req.method === "POST")
      return Response.json(await box.start(db, Number(url.searchParams.get("projects") ?? 2710), Number(url.searchParams.get("comments") ?? 6.8), url.searchParams.get("base") ?? undefined));
    if (url.pathname === "/status") {
      const s = await env.BUCKET.get(`db/${db}/build-status.json`);
      return Response.json({ box: await box.info(), status: s ? await s.json() : null });
    }
    if (url.pathname === "/count") {
      // Parts that have actually landed in R2 for a base (and their total size).
      const prefix = `db/${db}/base/${url.searchParams.get("base")}/`;
      let n = 0, bytes = 0, cursor: string | undefined, last = "";
      do {
        const page = await env.BUCKET.list({ prefix, cursor });
        for (const o of page.objects) (n++, (bytes += o.size), (last = o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return Response.json({ parts: n, gb: +(bytes / 1e9).toFixed(2), last });
    }
    if (url.pathname === "/delete-base" && req.method === "POST") {
      // Remove an abandoned base's parts. Refuses the base the live manifest points at.
      const base = url.searchParams.get("base") ?? "";
      if (!/^b[a-z0-9]+$/.test(base)) return new Response("bad base", { status: 400 });
      const live = await env.BUCKET.get(`db/${db}/manifest.json`);
      if (live && (JSON.parse(await live.text()) as { base?: string }).base === base) return new Response("that base is live", { status: 409 });
      let deleted = 0, cursor: string | undefined;
      do {
        const page = await env.BUCKET.list({ prefix: `db/${db}/base/${base}/`, cursor, limit: 1000 });
        if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
        deleted += page.objects.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return Response.json({ deleted });
    }
    if (url.pathname === "/reattach" && req.method === "POST") return Response.json(await box.reattach().catch((e) => ({ error: String(e?.message ?? e) })));
    if (url.pathname === "/logs") return Response.json(await box.logs().catch((e) => ({ error: String(e?.message ?? e) })));
    if (url.pathname === "/stop" && req.method === "POST") return Response.json(await box.stop());
    if (url.pathname === "/promote" && req.method === "POST") {
      const base = url.searchParams.get("base");
      const m = await env.BUCKET.get(`db/${db}/manifest-${base}.json`);
      if (!m) return new Response("no such manifest", { status: 404 });
      await env.BUCKET.put(`db/${db}/manifest.json`, await m.text());
      return Response.json({ promoted: `db/${db}/manifest-${base}.json` });
    }
    return new Response("not found", { status: 404 });
  },
};
