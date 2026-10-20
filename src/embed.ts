/**
 * Embeddings in the Worker: document text for writes, query vectors for searches.
 *
 * The model is Workers AI through the `AI` binding (default @cf/qwen/qwen3-embedding-0.6b), or
 * any OpenAI-compatible /embeddings endpoint (EMBED_URL, e.g. EmbeddingGemma behind AI Gateway).
 * Vectors are truncated to the index's dims (Matryoshka) and L2-normalized, then sent to the
 * object as base64 f32. Query vectors are cached per isolate and in the colo cache.
 *
 * `storyText` must match the builder's (engine/builder/src/embed.rs): base vectors and vectors
 * embedded on write have to come from the same text. datasets/hn/embed-fixture.json pins both.
 */

export interface EmbedEnv {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  EMBED_MODEL?: string;
  EMBED_URL?: string;
  EMBED_KEY?: string;
}

export const DEFAULT_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
/** Qwen3 embeddings are asymmetric: queries carry a task instruction, documents don't. */
export const QUERY_INSTRUCTION = "Instruct: Given a search query, retrieve relevant Hacker News stories\nQuery: ";

export function stripHtml(s: string): string {
  let out = "";
  const cs = Array.from(s);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === "<") {
      let tag = "";
      for (i++; i < cs.length && cs[i] !== ">"; i++) tag += cs[i];
      const t = tag.replace(/^\/+/, "").toLowerCase();
      if (t.startsWith("p") || t.startsWith("br") || t.startsWith("pre")) out += "\n";
    } else if (c === "&") {
      let ent = "";
      while (i + 1 < cs.length && cs[i + 1] !== ";" && ent.length <= 8) ent += cs[++i];
      const semi = cs[i + 1] === ";";
      if (semi) i++;
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (semi && ent in named) out += named[ent];
      else if (semi && /^#[xX]/.test(ent)) out += fromCode(parseInt(ent.slice(2), 16), ent.slice(2), 16);
      else if (semi && ent.startsWith("#")) out += fromCode(parseInt(ent.slice(1), 10), ent.slice(1), 10);
      else out += "&" + ent + (semi ? ";" : "");
    } else out += c;
  }
  return out;
}

function fromCode(n: number, digits: string, radix: number): string {
  // Matches Rust: unparseable digits or an invalid scalar value produce nothing.
  const valid = radix === 16 ? /^\+?[0-9a-fA-F]+$/.test(digits) : /^\+?[0-9]+$/.test(digits);
  if (!valid || !Number.isFinite(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "";
  return String.fromCodePoint(n);
}

/** The text embedded for an HN story (title, site, start of the text). */
export function storyText(row: { title?: string | null; domain?: string | null; text?: string | null }): string {
  let s = (row.title ?? "").trim();
  if (row.domain) s += ` (${row.domain})`;
  if (row.text) {
    const t = stripHtml(row.text).trim();
    if (t) s += "\n" + Array.from(t).slice(0, 2000).join("");
  }
  return s;
}

/** Truncate to `dims`, L2-normalize, base64 of the f32 bytes. */
export function packVector(v: ArrayLike<number>, dims: number): string {
  const f = new Float32Array(dims);
  let n = 0;
  for (let i = 0; i < dims; i++) {
    f[i] = v[i] ?? 0;
    n += f[i] * f[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dims; i++) f[i] /= n;
  const b = new Uint8Array(f.buffer);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Embed texts with the configured model (full dims, as returned). */
export async function embed(env: EmbedEnv, texts: string[]): Promise<number[][]> {
  const model = env.EMBED_MODEL ?? DEFAULT_MODEL;
  if (env.EMBED_URL) {
    const r = await fetch(env.EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.EMBED_KEY ? { authorization: `Bearer ${env.EMBED_KEY}` } : {}) },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!r.ok) throw new Error(`embedding endpoint: ${r.status}`);
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    return j.data.map((d) => d.embedding);
  }
  if (!env.AI) throw new Error("no embedding model configured (AI binding or EMBED_URL)");
  const out = (await env.AI.run(model, { text: texts })) as { data: number[][] };
  if (!out?.data || out.data.length !== texts.length) throw new Error("the embedding model returned no vectors");
  return out.data;
}

const memo = new Map<string, string>();

/** A search query's vector (packed), cached in the isolate and the colo cache for 30 days. */
export async function queryVector(env: EmbedEnv, q: string, dims: number): Promise<{ vec: string; ms: number; cached: boolean }> {
  const t0 = Date.now();
  const text = q.trim().replace(/\s+/g, " ");
  const model = env.EMBED_MODEL ?? DEFAULT_MODEL;
  const id = `${model}|${dims}|${text}`;
  const hit = memo.get(id);
  if (hit) return { vec: hit, ms: Date.now() - t0, cached: true };
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const url = `https://pagedb.cache/emb/${digest}`;
  const cache = typeof caches !== "undefined" ? await caches.open("pagedb-emb").catch(() => null) : null;
  const c = await cache?.match(url).catch(() => undefined);
  let vec: string;
  let cached = false;
  if (c) {
    vec = await c.text();
    cached = true;
  } else {
    const [v] = await embed(env, [QUERY_INSTRUCTION + text]);
    vec = packVector(v, dims);
    await cache?.put(url, new Response(vec, { headers: { "cache-control": "public, max-age=2592000" } })).catch(() => {});
  }
  if (memo.size > 2000) memo.clear();
  memo.set(id, vec);
  return { vec, ms: Date.now() - t0, cached };
}
