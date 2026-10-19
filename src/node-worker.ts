/**
 * pagedb-node: the same database object, run inside a Cloudflare Container (workerd) instead of
 * as a Durable Object. More RAM (GBs of page tier), a 20 GB local disk cache and a dedicated
 * CPU; R2 reached through an intercepted bridge. Same API as the pagedb Worker's /api/*.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  BUCKET: R2Bucket;
  NODE: DurableObjectNamespace<PageNode>;
  /** Shared with the container: it reads R2 through /r2 on this Worker's public URL. */
  NODE_TOKEN?: string;
}

const PORT = 8080;

/** The container's R2: GET http://r2.internal/get?key&offset&length → ranged R2 read. */
export class R2Bridge extends WorkerEntrypoint<Env> {
  override async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname !== "/get") return new Response("no", { status: 403 });
    const key = url.searchParams.get("key")!;
    const offset = url.searchParams.get("offset");
    // Base parts are immutable: the bridge (running in the container's city) gives the container
    // the same colo-cache tier a Durable Object gets. The manifest isn't cached here.
    const cacheable = offset !== null && !key.endsWith(".json");
    const cache = await caches.open("pagedb-node");
    const cacheUrl = `https://pagedb.cache/${key}/${offset}/${url.searchParams.get("length")}`;
    if (cacheable) {
      const hit = await cache.match(cacheUrl);
      if (hit) return new Response(hit.body, { headers: { "x-tier": "cache" } });
    }
    const obj = await this.env.BUCKET.get(key, offset ? { range: { offset: Number(offset), length: Number(url.searchParams.get("length")) } } : undefined);
    if (!obj) return new Response("not found", { status: 404 });
    // Buffered: streaming R2 bodies back through the container's intercepted connection drops.
    const buf = await obj.arrayBuffer();
    if (cacheable) this.ctx.waitUntil(cache.put(cacheUrl, new Response(buf.slice(0), { headers: { "cache-control": "public, max-age=31536000, immutable" } })));
    return new Response(buf, { headers: { "x-tier": "r2" } });
  }
}

export class PageNode extends DurableObject<Env> {
  private ready?: Promise<void>;

  private async ensure() {
    const c = this.ctx.container!;
    if (c.running && this.ready) return this.ready;
    this.ready = (async () => {
      if (!c.running) {
        c.start({
          image: (c as any).images.node,
          enableInternet: false,
          instance: { vcpu: 4, memoryMib: 12288, diskMb: 20000 },
          // 6 GiB of RAM tier (a DO gets 32 MiB). The intercepted route to R2 only takes ~4
          // concurrent connections (more fail with "Network connection lost"), so 3 at a time.
          env: { RAM_PAGES: "98304", FETCH_CONCURRENCY: "3" },
        } as any);
      }
      // The route belongs to this object instance: re-register after any wake or deploy.
      await c.interceptOutboundHttp("r2.internal", (this.ctx.exports as any).R2Bridge({ props: {} }));
      this.ctx.waitUntil(c.monitor().catch(() => (this.ready = undefined)));
      for (let i = 0; i < 300; i++) {
        try {
          const r = await c.getTcpPort(PORT).fetch("http://node/api/health");
          if (r.ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 10_000);
    })().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  async alarm() {
    if (this.ctx.container?.running) {
      await this.ensure();
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const t0 = Date.now();
    await this.ensure();
    const res = await this.ctx.container!.getTcpPort(PORT).fetch(req.url.replace("https:", "http:"), req);
    if (res.webSocket) return res;
    const out = new Response(res.body, res);
    out.headers.set("x-node-ms", String(Date.now() - t0));
    return out;
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === "/r2") {
      if (!env.NODE_TOKEN || req.headers.get("authorization") !== `Bearer ${env.NODE_TOKEN}`) return new Response("unauthorized", { status: 401 });
      const key = url.searchParams.get("key")!;
      const offset = url.searchParams.get("offset");
      const obj = await env.BUCKET.get(key, offset ? { range: { offset: Number(offset), length: Number(url.searchParams.get("length")) } } : undefined);
      return obj ? new Response(obj.body) : new Response("not found", { status: 404 });
    }
    if (!url.pathname.startsWith("/api/")) return new Response("pagedb-node: /api/query, /api/socket, /api/write", { status: 404 });
    return env.NODE.getByName(url.searchParams.get("node") ?? "node-1").fetch(req);
  },
};
