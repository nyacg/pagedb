/**
 * Hacker News: every story and comment (49M+ items from the open-index dump), kept live from
 * the official API by HnTail. The named queries are news.ycombinator.com's pages; mutators let
 * visitors comment, submit and upvote on this copy (their items' ids start with "u-").
 */

const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const cond = (op: string, c: string, v: unknown) => ({ type: "simple", op, left: { type: "column", name: c }, right: { type: "literal", value: v } });
const and = (...c: unknown[]) => (c.length === 1 ? c[0] : { type: "and", conditions: c });
import { queryVector, type EmbedEnv } from "../embed";

const BY_TIME = [["time", "desc"], ["id", "asc"]];
const THREAD = [["time", "asc"], ["id", "asc"]];

export const KINDS = ["story", "ask", "show", "job", "poll"] as const;
const ID = /^(\d{1,10}|u-[a-z0-9]{6,24})$/;
const USER = /^[A-Za-z0-9_-]{2,20}$/;
const DOMAIN = /^[a-z0-9.-]{3,80}$/;
const WORD = /^[a-z0-9]{2,30}$/;

// ------------------------------------------------------------------ derived story columns
// Must match datasets/hn/build.sh, which computes the same for the base.

const STOP = new Set(
  ("the and for with from your you are how why what when who this that its into about show ask hn of to in on is an at by as it be or my we not can do does " +
    "vs via was will has have than but just our all out so if no up new").split(" "),
);

export function storyKind(type: string, title: string): string {
  if (type === "job") return "job";
  if (type === "poll") return "poll";
  const t = title.toLowerCase();
  return t.startsWith("ask hn") ? "ask" : t.startsWith("show hn") ? "show" : "story";
}

export function titleWords(title: string): string[] {
  const out: string[] = [];
  for (const w of title.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 2 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out.slice(0, 16);
}

export function domainOf(url?: string | null): string | null {
  const m = /^[a-zA-Z]+:\/\/(www\.)?([^/:?#]+)/.exec(url ?? "");
  return m ? m[2].toLowerCase() : null;
}

/** An item from the HN API (or a visitor's submission) as a story row. */
export function storyRow(it: { id: number | string; by?: string; time: number; title?: string; url?: string; text?: string; score?: number; type: string }) {
  const title = it.title ?? "";
  return {
    id: String(it.id),
    by: it.by ?? null,
    time: it.time,
    title,
    url: it.url || null,
    text: it.text || null,
    score: it.score ?? 0,
    kind: storyKind(it.type, title),
    words: titleWords(title),
    domain: domainOf(it.url),
  };
}

// ------------------------------------------------------------------ named queries

function need<T>(ok: boolean, v: T, what: string): T {
  if (!ok) throw new Error(`bad ${what}`);
  return v;
}
const limit = (v: unknown, dflt: number, max: number) => need(v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max), (v as number) ?? dflt, "limit");
/** Keyset cursor: rows after `start` (the last row shown), in the list's order. */
function after(q: Record<string, unknown>, start: unknown, cols: string[]) {
  if (start === undefined) return q;
  const s = start as Record<string, unknown>;
  const ok = !!s && cols.every((c) => (c === "id" ? typeof s.id === "string" && ID.test(s.id) : typeof s[c] === "number" && Number.isFinite(s[c])));
  need(ok, 0, "cursor");
  return { ...q, start: { row: Object.fromEntries(cols.map((c) => [c, s[c]])) } };
}
const stories = (where: unknown, a: Record<string, any>, dflt = 30) =>
  after({ table: "story", ...(where ? { where } : {}), orderBy: BY_TIME, limit: limit(a.limit, dflt, 100) }, a.start, ["time", "id"]);

/** The stories' vector index (datasets/hn/vectors.json). */
export const VEC = { index: "story_vec", dims: 512 };
const SINCE: Record<string, number> = { day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

/** A semantic search's arguments from a page URL (?q=…&since=…&kind=…). */
export function semanticArgs(p: URLSearchParams): Record<string, string> {
  const a: Record<string, string> = { q: (p.get("q") ?? "").trim() };
  if (SINCE[p.get("since") ?? ""]) a.since = p.get("since")!;
  if (KINDS.includes(p.get("kind") as any)) a.kind = p.get("kind")!;
  return a;
}

/** Stories closest in meaning to a text: its embedding, then the object's vector index. */
async function semantic(a: Record<string, any>, env?: Record<string, unknown>) {
  const q = need(typeof a.q === "string" && a.q.trim().length >= 2 && a.q.length <= 200, a.q as string, "query");
  const k = limit(a.limit, 30, 50);
  const conds: unknown[] = [];
  if (a.since !== undefined) {
    need(SINCE[a.since] !== undefined, 0, "since");
    // Rounded to the hour, so the same search signs the same AST for a while.
    conds.push(cond(">=", "time", Math.floor((Date.now() - SINCE[a.since]) / 3600e3) * 3600e3));
  }
  if (a.kind !== undefined) conds.push(eq("kind", need(KINDS.includes(a.kind), a.kind, "kind")));
  if (!env) throw new Error("semantic search needs the Worker's embedding model");
  const { vec } = await queryVector(env as EmbedEnv, q, VEC.dims);
  return { table: "story", ann: { index: VEC.index, vec, k }, ...(conds.length ? { where: and(...conds) } : {}) };
}

export function namedQuery(name: string, a: Record<string, any> = {}, env?: Record<string, unknown>): unknown {
  switch (name) {
    case "semantic":
      return semantic(a, env);
    case "top":
      return { table: "story", where: cond("IS NOT", "topRank", null), orderBy: [["topRank", "asc"], ["id", "asc"]], limit: limit(a.limit, 90, 120) };
    case "new":
      return stories(undefined, a);
    case "best":
      return after({ table: "story", orderBy: [["score", "desc"], ["id", "asc"]], limit: limit(a.limit, 30, 100) }, a.start, ["score", "id"]);
    case "kind":
      return stories(eq("kind", need(KINDS.includes(a.kind), a.kind, "kind")), a);
    case "search": {
      const words: string[] = need(Array.isArray(a.words) && a.words.length >= 1 && a.words.length <= 4 && a.words.every((w: unknown) => typeof w === "string" && WORD.test(w)), a.words, "search");
      return stories(and(...words.map((w) => cond("HAS", "words", w))), a);
    }
    case "from":
      return stories(eq("domain", need(typeof a.domain === "string" && DOMAIN.test(a.domain), a.domain, "site")), a);
    case "userStories":
      return stories(eq("by", need(typeof a.by === "string" && USER.test(a.by), a.by, "user")), a);
    case "userComments":
      return after({ table: "comment", where: eq("by", need(typeof a.by === "string" && USER.test(a.by), a.by, "user")), orderBy: BY_TIME, limit: limit(a.limit, 30, 100) }, a.start, ["time", "id"]);
    case "newComments":
      return { table: "comment", orderBy: BY_TIME, limit: limit(a.limit, 30, 60) };
    case "item":
      // The story and the first 1000 comments of its thread (the rest via "thread").
      return {
        table: "story",
        where: eq("id", need(typeof a.id === "string" && ID.test(a.id), a.id, "item")),
        one: true,
        related: [{ alias: "comments", correlation: { parentField: ["id"], childField: ["storyId"] }, subquery: { table: "comment", orderBy: THREAD, limit: 1000 } }],
      };
    case "thread":
      return after(
        { table: "comment", where: eq("storyId", need(typeof a.story === "string" && ID.test(a.story), a.story, "story")), orderBy: THREAD, limit: limit(a.limit, 1000, 1000) },
        a.start,
        ["time", "id"],
      );
    case "latest":
      // The newest comments of a thread (big threads: the first 1000 are in "item"; new replies
      // arrive here, live).
      return { table: "comment", where: eq("storyId", need(typeof a.story === "string" && ID.test(a.story), a.story, "story")), orderBy: [["time", "desc"], ["id", "desc"]], limit: limit(a.limit, 200, 500) };
    case "comment":
      return { table: "comment", where: eq("id", need(typeof a.id === "string" && ID.test(a.id), a.id, "comment")), one: true };
  }
  throw new Error(`unknown query ${name}`);
}

// ------------------------------------------------------------------ mutators

const rid = () => `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Visitors write plain text; stored as HN does (escaped HTML, paragraphs as <p>). */
const html = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => esc(p.trim()))
    .join("<p>");
const str = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
  if (v.length > max) throw new Error(`${what} is limited to ${max} characters`);
  return v.trim();
};

export function visitor(user?: string) {
  return typeof user === "string" && /^[a-z0-9-]{3,20}$/.test(user) ? user : "guest";
}

export function mutate(name: string, a: Record<string, unknown>, user: string): { ops: unknown[]; created?: string } {
  const now = Date.now();
  switch (name) {
    case "comment": {
      const story = need(typeof a.storyId === "string" && ID.test(a.storyId), a.storyId as string, "story");
      const parent = need(typeof a.parent === "string" && ID.test(a.parent), a.parent as string, "parent");
      const id = typeof a.id === "string" && /^u-[a-z0-9]{6,24}$/.test(a.id) ? a.id : rid();
      const text = str(a.text, "comment", 2000);
      return { ops: [{ op: "insert", table: "comment", row: { id, storyId: story, parent, by: visitor(user), time: now, text: html(text) } }], created: id };
    }
    case "submit": {
      const title = str(a.title, "title", 80);
      const url = typeof a.url === "string" && a.url.trim() ? a.url.trim() : undefined;
      if (url && !/^https?:\/\/[^\s]{3,500}$/.test(url)) throw new Error("that url doesn't look right");
      const text = typeof a.text === "string" && a.text.trim() ? html(str(a.text, "text", 2000)) : undefined;
      if (!url && !text) throw new Error("a url or some text is required");
      const id = typeof a.id === "string" && /^u-[a-z0-9]{6,24}$/.test(a.id) ? a.id : rid();
      const row = storyRow({ id, by: visitor(user), time: now, title, url, text, score: 1, type: "story" });
      return { ops: [{ op: "insert", table: "story", row }], created: id };
    }
    case "upvote":
      return { ops: [{ op: "update", table: "story", id: need(typeof a.id === "string" && ID.test(a.id), a.id as string, "story"), add: { score: 1 } }] };
  }
  throw new Error(`unknown mutator ${name}`);
}
