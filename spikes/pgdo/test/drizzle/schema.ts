import { relations, sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const role = pgEnum("role", ["member", "admin"]);

export const users = pgTable("users", {
  id: serial().primaryKey(),
  email: text().notNull().unique(),
  role: role().notNull().default("member"),
  tags: text().array().notNull().default(sql`'{}'::text[]`),
  profile: jsonb().$type<{ city?: string; langs?: string[] }>().notNull().default({}),
  balance: bigint({ mode: "number" }).notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("users_profile_gin").using("gin", t.profile), index("users_tags_gin").using("gin", t.tags)]);

export const posts = pgTable("posts", {
  id: uuid().primaryKey().defaultRandom(),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text().notNull(),
  meta: jsonb().$type<{ likes: number }>().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
export const postsRelations = relations(posts, ({ one }) => ({ author: one(users, { fields: [posts.userId], references: [users.id] }) }));
