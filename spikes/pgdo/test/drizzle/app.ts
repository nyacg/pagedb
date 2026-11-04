// An ordinary Drizzle app, unchanged: only DATABASE_URL points at the Durable Object.
//   DATABASE_URL=postgres://postgres:<token>@localhost:6543/<db> node --experimental-strip-types app.ts
import { and, arrayContains, eq, sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";
import * as schema from "./schema.ts";
import { posts, users } from "./schema.ts";

const url = process.env.DATABASE_URL!;
let failed = 0;
async function check(name: string, f: () => Promise<unknown>) {
  const t0 = Date.now();
  if (process.env.TRACE) console.log(`...  ${name}`);
  try {
    const r = await f();
    console.log(`ok   ${name} (${Date.now() - t0} ms)${r === undefined ? "" : ` ${JSON.stringify(r).slice(0, 120)}`}`);
  } catch (e) {
    failed++;
    const c = (e as { cause?: { message?: string; code?: string } }).cause;
    console.log(`FAIL ${name}: ${(e as Error).message.split("\n")[0]}${c ? ` — cause: ${c.code ?? ""} ${c.message}` : ""}`);
  }
}
const expect = (cond: boolean, what: string) => {
  if (!cond) throw new Error(what);
};

const pool = new pg.Pool({ connectionString: url, max: 10 });
const db = drizzlePg(pool, { schema });

await check("node-postgres: clean slate", () => db.execute(sql`truncate ${users} restart identity cascade`));
await check("insert … returning (jsonb, text[], enum)", async () => {
  const r = await db.insert(users).values([
    { email: "ada@x.com", role: "admin", tags: ["math", "eng"], profile: { city: "London", langs: ["en"] } },
    { email: "linus@x.com", tags: ["kernel"], profile: { city: "Portland", langs: ["en", "fi"] } },
  ]).returning({ id: users.id, role: users.role });
  expect(r.length === 2 && r[0].role === "admin", "returning");
  return r;
});
await check("upsert (onConflictDoUpdate)", async () => {
  await db.insert(users).values({ email: "ada@x.com", balance: 5 }).onConflictDoUpdate({ target: users.email, set: { balance: sql`${users.balance} + 5` } });
  const [u] = await db.select().from(users).where(eq(users.email, "ada@x.com"));
  expect(u.balance === 5, `balance ${u.balance}`);
});
await check("jsonb ->> and @> filters, array contains", async () => {
  const a = await db.select({ email: users.email }).from(users).where(sql`${users.profile}->>'city' = 'Portland'`);
  const b = await db.select({ email: users.email }).from(users).where(sql`${users.profile} @> ${JSON.stringify({ langs: ["fi"] })}::jsonb`);
  const c = await db.select({ email: users.email }).from(users).where(arrayContains(users.tags, ["math"]));
  expect(a[0]?.email === "linus@x.com" && b[0]?.email === "linus@x.com" && c[0]?.email === "ada@x.com", "filters");
});
await check("relational query (with posts)", async () => {
  const [ada] = await db.select().from(users).where(eq(users.email, "ada@x.com"));
  await db.insert(posts).values([{ userId: ada.id, title: "Notes on the engine", meta: { likes: 3 } }, { userId: ada.id, title: "Bernoulli", meta: { likes: 9 } }]);
  const r = await db.query.users.findMany({ with: { posts: { orderBy: (p, { desc }) => [desc(sql`(${p.meta}->>'likes')::int`)] } }, where: eq(users.email, "ada@x.com") });
  expect(r[0].posts.length === 2 && r[0].posts[0].title === "Bernoulli", "relations");
  return r[0].posts.map((p) => p.title);
});
await check("transaction commits; rollback discards", async () => {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ balance: sql`${users.balance} + 100` }).where(eq(users.email, "linus@x.com"));
  });
  await db.transaction(async (tx) => {
    await tx.update(users).set({ balance: sql`${users.balance} + 1000` }).where(eq(users.email, "linus@x.com"));
    tx.rollback();
  }).catch(() => {});
  const [u] = await db.select().from(users).where(eq(users.email, "linus@x.com"));
  expect(u.balance === 100, `balance ${u.balance}`);
});
await check("named prepared statement, used from every pooled connection", async () => {
  const q = db.select().from(users).where(eq(users.email, sql.placeholder("email"))).prepare("user_by_email");
  const r = await Promise.all(Array.from({ length: 30 }, (_, i) => q.execute({ email: i % 2 ? "ada@x.com" : "linus@x.com" })));
  expect(r.every((x) => x.length === 1), "prepared");
});
await check("200 concurrent inserts over a pool of 10", async () => {
  await Promise.all(Array.from({ length: 200 }, (_, i) => db.insert(users).values({ email: `u${i}@x.com`, tags: [`t${i % 5}`], profile: { city: `c${i % 7}` } })));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  expect(n === 202, `count ${n}`);
  return { users: n };
});
await check("concurrent transfers: transactions stay isolated, money is conserved", async () => {
  await db.update(users).set({ balance: 1000 });
  const ids = (await db.select({ id: users.id }).from(users)).map((r) => r.id);
  await Promise.all(Array.from({ length: 100 }, (_, i) => db.transaction(async (tx) => {
    const from = ids[i % 50], to = ids[(i * 7) % 50 + 50];
    const [a] = await tx.select({ b: users.balance }).from(users).where(eq(users.id, from)).for("update");
    await tx.update(users).set({ balance: a.b - 10 }).where(eq(users.id, from));
    await tx.update(users).set({ balance: sql`${users.balance} + 10` }).where(eq(users.id, to));
  })));
  const [{ total }] = await db.select({ total: sql<number>`sum(${users.balance})::int` }).from(users);
  expect(total === 202 * 1000, `total ${total}`);
  return { total };
});
await check("a session setting stays on its own connection", async () => {
  const c1 = await pool.connect(), c2 = await pool.connect();
  await c1.query("set timezone = 'Asia/Tokyo'");
  const [a, b] = [(await c1.query("show timezone")).rows[0].TimeZone, (await c2.query("show timezone")).rows[0].TimeZone];
  await c1.query("reset timezone");
  c1.release(); c2.release();
  expect(a === "Asia/Tokyo" && b !== "Asia/Tokyo", `${a} / ${b}`);
  return { c1: a, c2: b };
});
await pool.end();

const client = postgres(url, { max: 5 });
const dbjs = drizzlePostgresJs(client, { schema });
await check("postgres.js: query with its own prepared statements", async () => {
  const r = await Promise.all(Array.from({ length: 20 }, () => dbjs.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "member")))));
  expect(r.every((x) => x[0].n === 201), `count ${r[0][0].n}`);
});
await check("postgres.js: transaction + relational query", async () => {
  const titles = await dbjs.transaction(async (tx) => {
    await tx.insert(posts).values({ userId: 2, title: "Just for fun", meta: { likes: 1 } });
    return (await tx.query.posts.findMany({ with: { author: true }, where: eq(posts.userId, 2) })).map((p) => `${p.title} by ${p.author.email}`);
  });
  expect(titles.length === 1, "titles");
  return titles;
});
await client.end();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
