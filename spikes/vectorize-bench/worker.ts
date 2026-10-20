/**
 * Vectorize side of the pagevec benchmark. Admin only (Bearer ADMIN_TOKEN).
 *   POST /load?prefix=vec/…/stories&shard=N      one PVEC shard → upserts (1024-d, normalized)
 *   POST /query {vec, topK, filter?}             → matches + server ms (around env.VEC.query)
 *   POST /visibility {vec, id}                   upsert, then query until it's returned → ms
 *   GET  /info                                   the index's description
 */
interface Env {
  VEC: VectorizeIndex;
  BUCKET: R2Bucket;
  ADMIN_TOKEN?: string;
}

const DIMS = 1024;

function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Every (row, vector) of a PVEC shard, truncated to DIMS and normalized. */
function decode(buf: ArrayBuffer): { row: any; vec: number[] }[] {
  const dv = new DataView(buf);
  const dims = dv.getUint32(8, true);
  const count = dv.getUint32(12, true);
  const out: { row: any; vec: number[] }[] = [];
  const dec = new TextDecoder();
  let p = 16;
  for (let i = 0; i < count; i++) {
    const jl = dv.getUint32(p, true);
    p += 4;
    const row = JSON.parse(dec.decode(new Uint8Array(buf, p, jl)));
    p += jl;
    const vec = new Array<number>(DIMS);
    let n = 0;
    for (let d = 0; d < DIMS; d++) {
      const x = f16(dv.getUint16(p + 2 * d, true));
      vec[d] = x;
      n += x * x;
    }
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < DIMS; d++) vec[d] /= n;
    p += 2 * dims;
    out.push({ row, vec });
  }
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (e) {
      return Response.json({ error: String((e as Error).stack ?? e) }, { status: 500 });
    }
  },
};

async function handle(req: Request, env: Env): Promise<Response> {
  {
    if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return new Response("unauthorized", { status: 401 });
    const url = new URL(req.url);
    if (url.pathname === "/info") return Response.json(await env.VEC.describe());
    if (url.pathname === "/load" && req.method === "POST") {
      const key = `${url.searchParams.get("prefix")}/shard-${String(url.searchParams.get("shard")).padStart(6, "0")}.bin`;
      const obj = await env.BUCKET.get(key);
      if (!obj) return Response.json({ error: `no ${key}` }, { status: 404 });
      const items = decode(await obj.arrayBuffer());
      let mutation = "";
      for (let i = 0; i < items.length; i += 1000) {
        const r = await env.VEC.upsert(
          items.slice(i, i + 1000).map(({ row, vec }) => ({ id: String(row.id), values: vec, metadata: { time: Number(row.time) || 0, kind: String(row.kind ?? "story") } })),
        );
        mutation = (r as any).mutationId ?? mutation;
      }
      return Response.json({ key, vectors: items.length, mutation });
    }
    if (url.pathname === "/query" && req.method === "POST") {
      const { vec, topK = 10, filter } = (await req.json()) as { vec: number[]; topK?: number; filter?: VectorizeVectorMetadataFilter };
      const t0 = Date.now();
      const r = await env.VEC.query(vec, { topK, ...(filter ? { filter } : {}) });
      return Response.json({ ms: Date.now() - t0, matches: r.matches.map((m) => ({ id: m.id, score: m.score })) });
    }
    if (url.pathname === "/visibility" && req.method === "POST") {
      // Write a vector, then query for it every 250 ms until it comes back (or 10 minutes).
      const { vec, id } = (await req.json()) as { vec: number[]; id: string };
      const t0 = Date.now();
      await env.VEC.upsert([{ id, values: vec, metadata: { time: Date.now(), kind: "probe" } }]);
      const acked = Date.now() - t0;
      for (let n = 0; Date.now() - t0 < 600_000; n++) {
        const r = await env.VEC.query(vec, { topK: 3 });
        if (r.matches.some((m) => m.id === id)) return Response.json({ id, ackMs: acked, visibleMs: Date.now() - t0, polls: n + 1 });
        await new Promise((r) => setTimeout(r, 250));
      }
      return Response.json({ id, ackMs: acked, visibleMs: null });
    }
    return new Response("not found", { status: 404 });
  }
}
