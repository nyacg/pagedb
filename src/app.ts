/**
 * The issue tracker's server side: named queries (what pages may ask for) and named mutators
 * (validated, turned into row ops for the engine). The engine itself has no app logic.
 */

const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const cond = (op: string, c: string, v: unknown) => ({ type: "simple", op, left: { type: "column", name: c }, right: { type: "literal", value: v } });
const ORDER = [["createdAt", "desc"], ["id", "asc"]];
const CARD = [
  { alias: "project", correlation: { parentField: ["projectId"], childField: ["id"] }, subquery: { table: "project" } },
  { alias: "owner", correlation: { parentField: ["ownerId"], childField: ["id"] }, subquery: { table: "user" } },
  { alias: "commentCount", correlation: { parentField: ["id"], childField: ["issueId"] }, subquery: { table: "comment", aggregate: "count" } },
];

export const STATUSES = ["backlog", "todo", "in-progress", "review", "done"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;

/** Search terms: values of one kind are alternatives (status, priority, owner) or all required (tag, title, comment). */
export interface Filter {
  status?: string[];
  priority?: string[];
  owner?: string[];
  tag?: string[];
  title?: string[];
  comment?: string[];
}

const hasComment = (needle: string) => ({
  type: "correlatedSubquery",
  op: "EXISTS",
  related: { correlation: { parentField: ["id"], childField: ["issueId"] }, subquery: { table: "comment", where: cond("ILIKE", "body", `%${needle}%`) } },
});

type Cursor = { createdAt: number; id: string };

export function issuesQuery(project: string, f: Filter = {}, limit = 50, status?: string, bounds: { start?: Cursor; end?: Cursor } = {}) {
  const conds: unknown[] = [eq("projectId", project)];
  const st = status ? [status] : f.status ?? [];
  if (st.length === 1) conds.push(eq("status", st[0]));
  else if (st.length) conds.push(cond("IN", "status", st));
  if (f.priority?.length) conds.push(cond("IN", "priority", f.priority));
  if (f.owner?.length === 1) conds.push(eq("ownerId", f.owner[0]));
  else if (f.owner?.length) conds.push(cond("IN", "ownerId", f.owner));
  for (const t of f.tag ?? []) conds.push(cond("HAS", "tags", t));
  for (const t of f.title ?? []) conds.push(cond("ILIKE", "title", `%${t}%`));
  for (const t of f.comment ?? []) conds.push(hasComment(t));
  const q: Record<string, unknown> = { table: "issue", where: conds.length === 1 ? conds[0] : { type: "and", conditions: conds }, orderBy: ORDER, limit: Math.min(Math.max(limit, 1), 1000), related: CARD };
  if (bounds.start) q.start = { row: bounds.start };
  if (bounds.end) q.end = { row: bounds.end };
  return q;
}

export function countQuery(project: string, status?: string) {
  const c: unknown[] = [eq("projectId", project)];
  if (status) c.push(eq("status", status));
  return { table: "issue", where: c.length === 1 ? c[0] : { type: "and", conditions: c }, aggregate: "count" };
}

export function detailQuery(id: string) {
  return {
    table: "issue",
    where: eq("id", id),
    one: true,
    related: [
      ...CARD,
      {
        alias: "comments",
        correlation: { parentField: ["id"], childField: ["issueId"] },
        subquery: { table: "comment", orderBy: [["createdAt", "asc"], ["id", "asc"]], limit: 200, related: [{ alias: "author", correlation: { parentField: ["authorId"], childField: ["id"] }, subquery: { table: "user" } }] },
      },
    ],
  };
}

export const feedQuery = () => ({
  table: "comment",
  orderBy: ORDER,
  limit: 30,
  related: [{ alias: "author", correlation: { parentField: ["authorId"], childField: ["id"] }, subquery: { table: "user" } }],
});

export const projectsQuery = (search = "") => ({ table: "project", where: search ? cond("ILIKE", "name", `%${search}%`) : undefined, orderBy: [["id", "asc"]], limit: 60 });
export const projectQuery = (id: string) => ({ table: "project", where: eq("id", id), one: true });
export const userQuery = (id: string) => ({ table: "user", where: eq("id", id), one: true });
export const usersQuery = (search = "") => ({ table: "user", where: search ? cond("ILIKE", "name", `%${search}%`) : undefined, orderBy: [["id", "asc"]], limit: 20 });

// ---------------------------------------------------------------- named queries (what may be leased)

const PROJECT = /^p\d{4}$/;
const USER = /^u\d{5}$/;
const ISSUE = /^(i\d{9}|u-[a-z0-9]{6,24})$/;
const TAG = /^[a-z0-9-]{1,28}$/;
function need<T>(ok: boolean, v: T, what: string): T {
  if (!ok) throw new Error(`bad ${what}`);
  return v;
}
const text = (v: unknown, what: string, max: number) => need(v === undefined || (typeof v === "string" && v.length <= max), v as string | undefined, what);
const cursor = (v: unknown, what: string): Cursor | undefined => {
  if (v === undefined) return undefined;
  const c = v as Cursor;
  return need(!!c && typeof c.createdAt === "number" && Number.isFinite(c.createdAt) && typeof c.id === "string" && ISSUE.test(c.id), { createdAt: c.createdAt, id: c.id }, what);
};
const list = <T extends string>(v: unknown, allowed: readonly T[], what: string): T[] =>
  need(v === undefined || (Array.isArray(v) && v.length <= allowed.length && v.every((x) => allowed.includes(x))), (v as T[] | undefined) ?? [], what);
/** Up to 8 values; a lone string is accepted as a one-value list. */
const many = (v: unknown, ok: (x: string) => boolean, what: string): string[] => {
  const a = v === undefined ? [] : typeof v === "string" ? [v] : v;
  return need(Array.isArray(a) && a.length <= 8 && a.every((x) => typeof x === "string" && ok(x)), [...new Set(a as string[])], what);
};
const words = (max: number) => (x: string) => x.trim().length > 0 && x.length <= max;

/** The only queries a page can subscribe to. Arguments are validated; the AST is built here. */
export function namedQuery(name: string, a: Record<string, any> = {}): unknown {
  switch (name) {
    case "issues": {
      const project = need(PROJECT.test(a.project), a.project as string, "project");
      const f = (a.filter ?? {}) as Record<string, unknown>;
      const filter: Filter = {
        status: list(f.status, STATUSES, "status"),
        priority: list(f.priority, PRIORITIES, "priority"),
        owner: many(f.owner, (x) => USER.test(x), "owner"),
        tag: many(f.tag, (x) => TAG.test(x), "tag"),
        title: many(f.title, words(60), "title search"),
        comment: many(f.comment, words(60), "comment search"),
      };
      const status = need(a.status === undefined || STATUSES.includes(a.status), a.status as string | undefined, "status");
      const limit = need(Number.isInteger(a.limit) && a.limit >= 1 && a.limit <= 1000, a.limit as number, "limit");
      return issuesQuery(project, filter, limit, status, { start: cursor(a.start, "start"), end: cursor(a.end, "end") });
    }
    case "count": {
      const project = need(PROJECT.test(a.project), a.project as string, "project");
      return countQuery(project, need(a.status === undefined || STATUSES.includes(a.status), a.status as string | undefined, "status"));
    }
    case "detail":
      return detailQuery(need(ISSUE.test(a.id), a.id as string, "issue id"));
    case "feed":
      return feedQuery();
    case "project":
      return projectQuery(need(PROJECT.test(a.id), a.id as string, "project"));
    case "projects":
      return projectsQuery(text(a.search, "search", 40) ?? "");
    case "user":
      return userQuery(need(USER.test(a.id), a.id as string, "user"));
    case "users":
      return usersQuery(text(a.search, "search", 40) ?? "");
  }
  throw new Error(`unknown query ${name}`);
}

// ---------------------------------------------------------------- mutators

type Args = Record<string, unknown>;
const str = (v: unknown, name: string, max: number) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  if (v.length > max) throw new Error(`${name} is limited to ${max} characters`);
  return v.trim();
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], name: string) => {
  if (!list.includes(v as T)) throw new Error(`${name} must be one of ${list.join(", ")}`);
  return v as T;
};
const tagList = (v: unknown) => {
  const tags = (Array.isArray(v) ? v : []).map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 28)).filter(Boolean);
  if (tags.length > 8) throw new Error("up to eight tags");
  return [...new Set(tags)].sort();
};
const id = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Named mutator → row ops. `user` is the acting user id (a handle, not authentication). */
export function mutate(name: string, a: Args, user: string): { ops: unknown[]; created?: string } {
  const now = Date.now();
  switch (name) {
    case "createIssue": {
      const title = str(a.title, "title", 180);
      if (/\bspam\b/i.test(title)) throw new Error("that looks like spam");
      const issueId = typeof a.id === "string" && /^u-[a-z0-9]{6,20}$/.test(a.id) ? a.id : id("u-");
      const ops: unknown[] = [
        {
          op: "insert",
          table: "issue",
          row: {
            id: issueId,
            projectId: str(a.project, "project", 16),
            title,
            status: oneOf(a.status ?? "todo", STATUSES, "status"),
            priority: oneOf(a.priority ?? "medium", PRIORITIES, "priority"),
            ownerId: typeof a.owner === "string" ? a.owner : user,
            createdAt: now,
            updatedAt: now,
            tags: tagList(a.tags),
          },
        },
      ];
      if (typeof a.description === "string" && a.description.trim()) {
        ops.push({ op: "insert", table: "comment", row: { id: id("u-c"), issueId, authorId: user, body: str(a.description, "description", 2000), createdAt: now } });
      }
      return { ops, created: issueId };
    }
    case "setStatus":
      return { ops: [{ op: "update", table: "issue", id: str(a.id, "id", 40), set: { status: oneOf(a.status, STATUSES, "status"), updatedAt: now } }] };
    case "setPriority":
      return { ops: [{ op: "update", table: "issue", id: str(a.id, "id", 40), set: { priority: oneOf(a.priority, PRIORITIES, "priority"), updatedAt: now } }] };
    case "setOwner":
      return { ops: [{ op: "update", table: "issue", id: str(a.id, "id", 40), set: { ownerId: str(a.owner, "owner", 16), updatedAt: now } }] };
    case "editTitle":
      return { ops: [{ op: "update", table: "issue", id: str(a.id, "id", 40), set: { title: str(a.title, "title", 180), updatedAt: now } }] };
    case "setTags":
      return { ops: [{ op: "update", table: "issue", id: str(a.id, "id", 40), set: { tags: tagList(a.tags), updatedAt: now } }] };
    case "addComment":
      return { ops: [{ op: "insert", table: "comment", row: { id: typeof a.id === "string" && /^u-c[a-z0-9]{6,20}$/.test(a.id) ? a.id : id("u-c"), issueId: str(a.issueId, "issueId", 40), authorId: user, body: str(a.body, "comment", 2000), createdAt: now } }] };
    case "deleteComment":
      return { ops: [{ op: "delete", table: "comment", id: str(a.id, "id", 40) }] };
    case "deleteIssue":
      // Only issues created on the demo can be deleted.
      if (typeof a.id !== "string" || !a.id.startsWith("u-")) throw new Error("only issues created here can be deleted");
      return { ops: [{ op: "delete", table: "issue", id: a.id }] };
  }
  throw new Error(`unknown mutator ${name}`);
}
