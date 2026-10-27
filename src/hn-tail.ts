/**
 * HnTail keeps the Hacker News base live: every 10 s it fetches items newer than the last one
 * it saw from the official API and writes them into the HN object (as any write: overlay,
 * live queries, pokes). Every minute it mirrors the front page (`topRank`) and refreshes the
 * ranked stories' scores. Kicked by the Worker (page views, and a cron every minute).
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./do";
import { storyRow, withVectors } from "./apps/hn";

const API = "https://hacker-news.firebaseio.com/v0";
const PER_TICK = 300;
const FRONT = 90;

type Item = { id: number; type: string; by?: string; time: number; title?: string; url?: string; text?: string; score?: number; parent?: number; dead?: boolean; deleted?: boolean };
type Row = Record<string, any>;
type Stub = {
  query(db: string, ast: unknown): Promise<{ result: { rows?: Row[] } }>;
  write(db: string, ops: unknown): Promise<{ version?: number; error?: string }>;
};

const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const BY_TIME = [["time", "desc"], ["id", "asc"]];

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await f(items[k]);
      }
    }),
  );
  return out;
}

async function getJson<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${API}/${path}`);
      if (r.ok) return (await r.json()) as T;
    } catch {}
  }
  return null;
}

export class HnTail extends DurableObject<Env> {
  private get dbName() {
    return ((this.env as unknown as Record<string, unknown>).HN_DB as string) ?? "hn";
  }
  private get db() {
    return this.env.DB.getByName(((this.env as unknown as Record<string, unknown>).HN_OBJ as string) ?? "hn") as unknown as Stub;
  }
  /** Comment id → its story, for comments this tail wrote (their replies arrive soon after). */
  private storyOf = new Map<string, string>();

  async kick() {
    const at = await this.ctx.storage.getAlarm();
    if (!at || at < Date.now() - 60_000) await this.ctx.storage.setAlarm(Date.now() + 100);
    return this.status();
  }

  /** Start over from the newest item in the base (after the base under the object changed). */
  async rewind() {
    this.ctx.storage.kv.delete("last");
    return this.kick();
  }

  async status() {
    const kv = this.ctx.storage.kv;
    return { last: kv.get("last"), lastRun: kv.get("lastRun"), lastFront: kv.get("lastFront"), written: kv.get("written") ?? 0, error: kv.get("error") ?? null };
  }

  async alarm() {
    try {
      await this.tick();
      this.ctx.storage.kv.delete("error");
    } catch (e) {
      this.ctx.storage.kv.put("error", `${new Date().toISOString()} ${String((e as Error).message ?? e)}`);
    }
    this.ctx.storage.kv.put("lastRun", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
  }

  private async query(ast: unknown): Promise<Row[]> {
    return (await this.db.query(this.dbName, ast)).result.rows ?? [];
  }

  /** The newest HN id already in the base (or written since): where the tail starts. */
  private async newestId(): Promise<number> {
    const ids = [
      ...(await this.query({ table: "story", orderBy: BY_TIME, limit: 20 })),
      ...(await this.query({ table: "comment", orderBy: BY_TIME, limit: 20 })),
    ]
      .map((r) => Number(r.id))
      .filter(Number.isFinite);
    return Math.max(0, ...ids);
  }

  private async tick() {
    const kv = this.ctx.storage.kv;
    let last = kv.get<number>("last") ?? (await this.newestId());
    const max = await getJson<number>("maxitem.json");
    if (max && max - last > 100_000) {
      // The base is far behind (an old or partial dump): start from the present instead.
      last = max - 1000;
    }
    if (max && max > last) {
      const to = Math.min(max, last + PER_TICK);
      const ids = Array.from({ length: to - last }, (_, i) => last + 1 + i);
      const items = (await pool(ids, 6, (id) => getJson<Item>(`item/${id}.json`))).filter((x): x is Item => !!x && !x.dead && !x.deleted);
      await this.writeAll(await this.opsFor(items), last);
      last = to;
      kv.put("last", last);
    }
    const lastFront = kv.get<number>("lastFront") ?? 0;
    if (Date.now() - lastFront > 60_000) {
      await this.front(Date.now() - (kv.get<number>("lastScores") ?? 0) > 120_000);
      kv.put("lastFront", Date.now());
    }
  }

  /** Which story a comment belongs to: its parent is a story, or a comment whose story we know. */
  private async storyFor(parent: string, batch: Map<string, string>): Promise<string | null> {
    const known = batch.get(parent) ?? this.storyOf.get(parent);
    if (known) return known;
    const [s] = await this.query({ table: "story", where: eq("id", parent), one: true });
    if (s) return parent;
    const [c] = await this.query({ table: "comment", where: eq("id", parent), one: true });
    return c ? (c.storyId as string) : null;
  }

  private async opsFor(items: Item[]): Promise<unknown[]> {
    const ops: unknown[] = [];
    const batch = new Map<string, string>(); // item id → story id, for items earlier in this batch
    for (const it of items.sort((a, b) => a.id - b.id)) {
      const id = String(it.id);
      if (it.type === "story" || it.type === "job" || it.type === "poll") {
        ops.push({ op: "insert", table: "story", row: storyRow({ ...it, text: it.text?.slice(0, 16000), time: it.time * 1000 }) });
        batch.set(id, id);
      } else if (it.type === "comment" && it.parent) {
        const story = await this.storyFor(String(it.parent), batch);
        if (!story) continue; // under a dead or deleted item
        ops.push({ op: "insert", table: "comment", row: { id, storyId: story, parent: String(it.parent), by: it.by ?? null, time: it.time * 1000, text: it.text?.slice(0, 16000) ?? null } });
        batch.set(id, story);
      }
    }
    for (const [c, s] of batch) if (c !== s) this.storyOf.set(c, s);
    if (this.storyOf.size > 50_000) this.storyOf.clear();
    // New stories' embeddings (after the inserts: a vector needs its row).
    return withVectors(ops, this.env as unknown as Record<string, unknown>);
  }

  /** Write in batches of 100; if a batch is refused, write its ops one by one. An item already
   *  written (before a restart: "story 123 exists") is skipped; any other failure (the object
   *  out of memory, say) throws, so the tick keeps its place and retries the same items next
   *  minute instead of losing them. After 5 failed tries on the same range, the rest are skipped
   *  (and the error recorded) so one bad item can't stall the tail. Score updates (no `at`) just
   *  skip failures: the next pass rewrites them anyway. */
  private async writeAll(ops: unknown[], at?: number) {
    let written = 0;
    const kv = this.ctx.storage.kv;
    const tries = at !== undefined && kv.get<number>("retryAt") === at ? (kv.get<number>("retries") ?? 0) : 0;
    for (let i = 0; i < ops.length; i += 100) {
      const chunk = ops.slice(i, i + 100);
      const r = await this.db.write(this.dbName, { ops: chunk });
      if (!r.error) {
        written += chunk.length;
        continue;
      }
      for (const op of chunk) {
        const e = (await this.db.write(this.dbName, { ops: [op] })).error;
        if (!e) written++;
        else if (at !== undefined && !/ exists$/.test(e) && tries < 5) {
          kv.put("written", (kv.get<number>("written") ?? 0) + written);
          if (at !== undefined) (kv.put("retryAt", at), kv.put("retries", tries + 1));
          throw new Error(`write failed (try ${tries + 1}): ${e}`);
        }
        else if (at !== undefined && !/ exists$/.test(e)) kv.put("error", `${new Date().toISOString()} skipped after 5 tries: ${e}`);
      }
    }
    kv.put("written", (kv.get<number>("written") ?? 0) + written);
  }

  /** Mirror HN's front page into `topRank` (and, every other minute, the ranked scores). */
  private async front(scores: boolean) {
    const top = (await getJson<number[]>("topstories.json"))?.slice(0, FRONT).map(String);
    if (!top?.length) return;
    const cur = await this.query({ table: "story", where: { type: "simple", op: "IS NOT", left: { type: "column", name: "topRank" }, right: { type: "literal", value: null } }, orderBy: [["topRank", "asc"], ["id", "asc"]], limit: 200 });
    const rankOf = new Map(cur.map((r) => [r.id as string, r.topRank as number]));
    const ops: unknown[] = [];
    for (const r of cur) if (!top.includes(r.id)) ops.push({ op: "update", table: "story", id: r.id, set: { topRank: null } });
    const fresh = scores ? await pool(top, 6, (id) => getJson<Item>(`item/${id}.json`)) : [];
    for (let i = 0; i < top.length; i++) {
      const id = top[i];
      const set: Row = {};
      if (rankOf.get(id) !== i + 1) set.topRank = i + 1;
      const it = fresh[i];
      if (it && typeof it.score === "number") set.score = it.score;
      if (!Object.keys(set).length) continue;
      if (!rankOf.has(id)) {
        // Not ranked yet: make sure we have it (a story older than the tail, or a dead one).
        const [s] = await this.query({ table: "story", where: eq("id", id), one: true });
        if (!s) {
          const item = it ?? (await getJson<Item>(`item/${id}.json`));
          if (!item || item.dead || item.deleted || item.type === "comment") continue;
          ops.push({ op: "insert", table: "story", row: { ...storyRow({ ...item, time: item.time * 1000 }), topRank: i + 1 } });
          continue;
        }
        if (s.score === set.score) delete set.score;
      }
      ops.push({ op: "update", table: "story", id, set });
    }
    await this.writeAll(ops);
    if (scores) this.ctx.storage.kv.put("lastScores", Date.now());
  }
}
