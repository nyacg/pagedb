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

/** A PVEC shard's (row, vector) pairs, truncated to DIMS and normalized, `n` at a time (a whole
 *  1024-d shard as JS arrays wouldn't fit a Worker's 128 MB). */
function* batches(buf: ArrayBuffer, n: number): Generator<{ row: any; vec: Float32Array }[]> {
  const dv = new DataView(buf);
  const dims = dv.getUint32(8, true);
  const count = dv.getUint32(12, true);
  const dec = new TextDecoder();
  let p = 16;
  let out: { row: any; vec: Float32Array }[] = [];
  for (let i = 0; i < count; i++) {
    const jl = dv.getUint32(p, true);
    p += 4;
    const row = JSON.parse(dec.decode(new Uint8Array(buf, p, jl)));
    p += jl;
    const vec = new Float32Array(DIMS);
    let s = 0;
    for (let d = 0; d < DIMS; d++) {
      const x = f16(dv.getUint16(p + 2 * d, true));
      vec[d] = x;
      s += x * x;
    }
    s = Math.sqrt(s) || 1;
    for (let d = 0; d < DIMS; d++) vec[d] /= s;
    p += 2 * dims;
    out.push({ row: { id: row.id, time: row.time, kind: row.kind }, vec });
    if (out.length === n) {
      yield out;
      out = [];
    }
  }
  if (out.length) yield out;
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
      let mutation = "";
      let vectors = 0;
      for (const b of batches(await obj.arrayBuffer(), 500)) {
        const items = b.map(({ row, vec }) => ({ id: String(row.id), values: vec, metadata: { time: Number(row.time) || 0, kind: String(row.kind ?? "story") } }));
        // Vectorize throttles mutations ("Too Many Requests"): back off and retry.
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await env.VEC.upsert(items);
            mutation = (r as any).mutationId ?? mutation;
            break;
          } catch (e) {
            if (!/Too Many Requests|40041/.test(String(e)) || attempt >= 8) throw e;
            await new Promise((res) => setTimeout(res, 2000 * 2 ** Math.min(attempt, 4)));
          }
        }
        vectors += b.length;
      }
      return Response.json({ key, vectors, mutation });
    }
    if (url.pathname === "/has" && req.method === "POST") {
      // Which of these ids the index holds.
      const { ids } = (await req.json()) as { ids: string[] };
      const found = await env.VEC.getByIds(ids.slice(0, 20));
      return Response.json({ has: found.map((v) => v.id) });
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
