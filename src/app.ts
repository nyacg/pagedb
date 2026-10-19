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

export interface Filter {
  status?: string[];
  priority?: string[];
  owner?: string;
  tag?: string;
  title?: string;
}

export function issuesQuery(project: string, f: Filter = {}, limit = 50) {
  const conds: unknown[] = [eq("projectId", project)];
  if (f.status?.length === 1) conds.push(eq("status", f.status[0]));
  else if (f.status?.length) conds.push(cond("IN", "status", f.status));
  if (f.priority?.length) conds.push(cond("IN", "priority", f.priority));
  if (f.owner) conds.push(eq("ownerId", f.owner));
  if (f.tag) conds.push(cond("HAS", "tags", f.tag));
  if (f.title) conds.push(cond("ILIKE", "title", `%${f.title}%`));
  return { table: "issue", where: conds.length === 1 ? conds[0] : { type: "and", conditions: conds }, orderBy: ORDER, limit: Math.min(Math.max(limit, 1), 500), related: CARD };
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
export const usersQuery = (search = "") => ({ table: "user", where: search ? cond("ILIKE", "name", `%${search}%`) : undefined, orderBy: [["id", "asc"]], limit: 20 });

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
