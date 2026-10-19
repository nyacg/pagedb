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
    if (req.method !== "PUT" || !url.pathname.startsWith("/put/")) return new Response("no", { status: 403 });
    await this.env.BUCKET.put(decodeURIComponent(url.pathname.slice(5)), req.body);
    return new Response("ok");
  }
}

export class BuilderBox extends DurableObject<Env> {
  async start(db: string, projects: number, comments: number) {
    const c = this.ctx.container!;
    if (c.running) return { running: true, base: this.ctx.storage.kv.get("base") };
    const base = `b${Date.now().toString(36)}`;
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

  async alarm() {
    if (this.ctx.container?.running) {
      this.ctx.waitUntil(this.ctx.container.monitor().catch(() => {}));
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }

  async stop() {
    this.ctx.container?.destroy();
    return { stopped: true };
  }

  async info() {
    return { running: !!this.ctx.container?.running, base: this.ctx.storage.kv.get("base") };
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return new Response("unauthorized", { status: 401 });
    const db = url.searchParams.get("db") ?? "db100g";
    const box = env.BOX.getByName(db);
    if (url.pathname === "/start" && req.method === "POST")
      return Response.json(await box.start(db, Number(url.searchParams.get("projects") ?? 2710), Number(url.searchParams.get("comments") ?? 6.8)));
    if (url.pathname === "/status") {
      const s = await env.BUCKET.get(`db/${db}/build-status.json`);
      return Response.json({ box: await box.info(), status: s ? await s.json() : null });
    }
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
