// S0a: R2 ranged-GET latency from inside a Durable Object, by size and concurrency.
// GET /seed            writes the 64 MiB test object (once)
// GET /run?sizes=65536,262144&conc=1,6&n=24   → latency percentiles per (size, concurrency)
import { DurableObject } from "cloudflare:workers";

interface Env { BUCKET: R2Bucket; KV: KVNamespace; PROBE: DurableObjectNamespace<Probe> }
const KEY = "spike/blob-64m";
const BLOB = 64 * 1024 * 1024;

export class Probe extends DurableObject<Env> {
  async seed() {
    const head = await this.env.BUCKET.head(KEY);
    if (head?.size === BLOB) return { existed: true };
    const buf = new Uint8Array(BLOB);
    for (let i = 0; i < BLOB; i += 65536) crypto.getRandomValues(buf.subarray(i, i + 65536));
    await this.env.BUCKET.put(KEY, buf);
    return { written: BLOB };
  }

  /** Same ranges through other immutable-data tiers: the colo's Cache API and Workers KV. */
  async tiers(size: number, n: number) {
    const cache = await caches.open("pages");
    const res: Record<string, unknown> = { colo: (await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text()).match(/colo=(\w+)/)?.[1] };
    const time = async (label: string, f: (i: number) => Promise<unknown>) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const s = performance.now();
        await f(i);
        ms.push(performance.now() - s);
      }
      ms.sort((a, b) => a - b);
      res[label] = { p50: +ms[n >> 1].toFixed(1), p90: +ms[Math.floor(n * 0.9)].toFixed(1), min: +ms[0].toFixed(1) };
    };
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes.subarray(0, Math.min(size, 65536)));
    const url = (i: number) => `https://pages.internal/${size}/${i}`;
    await time("cachePut", (i) => cache.put(url(i), new Response(bytes, { headers: { "cache-control": "max-age=86400" } })));
    await time("cacheHit", async (i) => { const r = await cache.match(url(i)); if (!r) throw new Error("cache miss"); await r.arrayBuffer(); });
    await time("kvPut", (i) => this.env.KV.put(`spike/${size}/${i}`, bytes));
    await time("kvGetFirst", async (i) => { await this.env.KV.get(`spike/${size}/${i}`, "arrayBuffer"); });
    await time("kvGetAgain", async (i) => { await this.env.KV.get(`spike/${size}/${i}`, "arrayBuffer"); });
    await time("r2Get", async (i) => { const o = await this.env.BUCKET.get(KEY, { range: { offset: (i % 1000) * 65536, length: size } }); await o!.arrayBuffer(); });
    return res;
  }

  async run(sizes: number[], concs: number[], n: number) {
    const out = [];
    for (const size of sizes)
      for (const conc of concs) {
        const ms: number[] = [];
        let next = 0;
        const t0 = performance.now();
        const worker = async () => {
          while (next < n) {
            next++;
            const offset = Math.floor(Math.random() * ((BLOB - size) / 65536)) * 65536;
            const s = performance.now();
            const obj = await this.env.BUCKET.get(KEY, { range: { offset, length: size } });
            await obj!.arrayBuffer();
            ms.push(performance.now() - s);
          }
        };
        await Promise.all(Array.from({ length: conc }, worker));
        const wall = performance.now() - t0;
        ms.sort((a, b) => a - b);
        const p = (q: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * q))]);
        out.push({ size, conc, n, p50: p(0.5), p90: p(0.9), p99: p(0.99), min: Math.round(ms[0]), mbps: +((size * n) / 1e6 / (wall / 1000)).toFixed(1) });
      }
    return out;
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const stub = env.PROBE.getByName(url.searchParams.get("obj") ?? "probe");
    if (url.pathname === "/seed") return Response.json(await stub.seed());
    if (url.pathname === "/tiers") return Response.json(await stub.tiers(Number(url.searchParams.get("size") ?? 65536), Number(url.searchParams.get("n") ?? 20)));
    if (url.pathname === "/run") {
      const list = (k: string, d: string) => (url.searchParams.get(k) ?? d).split(",").map(Number);
      return Response.json(await stub.run(list("sizes", "65536,262144,1048576,4194304"), list("conc", "1,6"), Number(url.searchParams.get("n") ?? 24)));
    }
    return new Response("pagedb r2-matrix spike: /seed, /run");
  },
};
