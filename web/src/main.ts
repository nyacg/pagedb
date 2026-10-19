/** pagedb demo: a Linear-style tracker where every list, column and thread is a live query. */
import { Sync, type Row } from "./sync";

declare global {
  interface Window {
    __BOOT?: { project: string; db: string; obj: string; list?: { rows: Row[] }; count?: number; ms?: number; stats?: any };
  }
}

const STATUSES = ["backlog", "todo", "in-progress", "review", "done"];
const STATUS_LABEL: Record<string, string> = { backlog: "Backlog", todo: "Todo", "in-progress": "In progress", review: "In review", done: "Done" };
const PRIORITIES = ["urgent", "high", "medium", "low"];
const PRI_LABEL: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

// ---------------------------------------------------------------- queries (mirror src/app.ts)
const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const cond = (op: string, c: string, v: unknown) => ({ type: "simple", op, left: { type: "column", name: c }, right: { type: "literal", value: v } });
const ORDER = [["createdAt", "desc"], ["id", "asc"]];
const CARD = [
  { alias: "project", correlation: { parentField: ["projectId"], childField: ["id"] }, subquery: { table: "project" } },
  { alias: "owner", correlation: { parentField: ["ownerId"], childField: ["id"] }, subquery: { table: "user" } },
  { alias: "commentCount", correlation: { parentField: ["id"], childField: ["issueId"] }, subquery: { table: "comment", aggregate: "count" } },
];
interface Filter {
  status: string[];
  priority: string[];
  owner?: string;
  ownerName?: string;
  tag?: string;
  title?: string;
}
function issuesQuery(project: string, f: Filter, limit: number, status?: string) {
  const c: unknown[] = [eq("projectId", project)];
  const st = status ? [status] : f.status;
  if (st.length === 1) c.push(eq("status", st[0]));
  else if (st.length) c.push(cond("IN", "status", st));
  if (f.priority.length) c.push(cond("IN", "priority", f.priority));
  if (f.owner) c.push(eq("ownerId", f.owner));
  if (f.tag) c.push(cond("HAS", "tags", f.tag));
  if (f.title) c.push(cond("ILIKE", "title", `%${f.title}%`));
  return { table: "issue", where: c.length === 1 ? c[0] : { type: "and", conditions: c }, orderBy: ORDER, limit, related: CARD };
}
const countQuery = (project: string, status?: string) => ({
  table: "issue",
  where: status ? { type: "and", conditions: [eq("projectId", project), eq("status", status)] } : eq("projectId", project),
  aggregate: "count",
});
const detailQuery = (id: string) => ({
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
});
const feedQuery = () => ({ table: "comment", orderBy: ORDER, limit: 30, related: [{ alias: "author", correlation: { parentField: ["authorId"], childField: ["id"] }, subquery: { table: "user" } }] });
const projectsQuery = (s: string) => ({ table: "project", where: s ? cond("ILIKE", "name", `%${s}%`) : undefined, orderBy: [["id", "asc"]], limit: 60 });
const usersQuery = (s: string) => ({ table: "user", where: s ? cond("ILIKE", "name", `%${s}%`) : undefined, orderBy: [["id", "asc"]], limit: 12 });
const userQuery = (id: string) => ({ table: "user", where: eq("id", id), one: true });

// ---------------------------------------------------------------- state
const boot = window.__BOOT ?? { project: "p0003", db: "db1g", obj: "demo" };
const params = new URLSearchParams(location.search);
const state = {
  project: params.get("project") ?? boot.project,
  view: (params.get("view") ?? "list") as "list" | "board" | "activity",
  issue: params.get("issue") ?? "",
  limit: 50,
  filter: { status: [], priority: [] } as Filter,
  creating: false,
  popover: null as null | { kind: string; id?: string; x: number; y: number; search?: string },
};
let me = localStorage.getItem("pagedb.user");
if (!me || !/^u\d{5}$/.test(me)) {
  me = `u${String(Math.floor(Math.random() * 5000)).padStart(5, "0")}`;
  localStorage.setItem("pagedb.user", me);
}
const sync = new Sync(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/socket?db=${boot.db}&obj=${boot.obj}`);
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const initials = (n?: string) => (n ?? "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (u?: Row, size = "") => `<span class="av ${size}" style="--h:${hue(u?.id ?? "?")}" title="${esc(u?.name ?? "Unassigned")}">${esc(initials(u?.name))}</span>`;
const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: s > 86400 * 300 ? "numeric" : undefined });
};
const keyOf = (r: Row) => `${r.project?.key ?? "ISS"}-${r.id.startsWith("u-") ? "new" : Number(r.id.slice(5)) + 1}`;
const byCreated = (a: Row, b: Row) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1);
function matches(r: Row, f: Filter, status?: string) {
  if (r.projectId !== state.project) return false;
  const st = status ? [status] : f.status;
  if (st.length && !st.includes(r.status)) return false;
  if (f.priority.length && !f.priority.includes(r.priority)) return false;
  if (f.owner && r.ownerId !== f.owner) return false;
  if (f.tag && !(r.tags ?? []).includes(f.tag)) return false;
  if (f.title && !String(r.title).toLowerCase().includes(f.title.toLowerCase())) return false;
  return true;
}
function url() {
  const p = new URLSearchParams();
  p.set("project", state.project);
  if (state.view !== "list") p.set("view", state.view);
  if (state.issue) p.set("issue", state.issue);
  history.replaceState(null, "", `/?${p}`);
}

// ---------------------------------------------------------------- subscriptions per view
function subscribeView() {
  const keep = new Set(["me", "project", "count"]);
  sync.sub("me", userQuery(me!));
  sync.sub("project", { table: "project", where: eq("id", state.project), one: true });
  sync.sub("count", countQuery(state.project), boot.project === state.project && boot.count !== undefined ? { count: boot.count } : undefined);
  if (state.view === "list") {
    const seed = boot.project === state.project && boot.list && !state.filter.status.length ? { rows: boot.list.rows } : undefined;
    sync.sub("list", issuesQuery(state.project, state.filter, state.limit), state.limit === 50 ? seed : undefined);
    keep.add("list");
  } else if (state.view === "board") {
    for (const st of STATUSES) {
      if (state.filter.status.length && !state.filter.status.includes(st)) continue;
      sync.sub(`col:${st}`, issuesQuery(state.project, state.filter, 25, st));
      sync.sub(`n:${st}`, countQuery(state.project, st));
      keep.add(`col:${st}`).add(`n:${st}`);
    }
  } else {
    sync.sub("feed", feedQuery());
    keep.add("feed");
  }
  if (state.issue) {
    sync.sub("detail", detailQuery(state.issue));
    keep.add("detail");
  }
  if (state.popover?.kind === "project") {
    sync.sub("pick", projectsQuery(state.popover.search ?? ""));
    keep.add("pick");
  }
  if (state.popover?.kind === "owner" || state.popover?.kind === "filter-owner") {
    sync.sub("pick", usersQuery(state.popover.search ?? ""));
    keep.add("pick");
  }
  for (const s of sync.all()) if (!keep.has(s.id)) sync.unsub(s.id);
  url();
}

// ---------------------------------------------------------------- mutations (optimistic)
async function run(name: string, args: Row, predicted: Parameters<Sync["mutate"]>[2]) {
  try {
    await sync.mutate(name, args, predicted, me!);
  } catch (e) {
    toast(String((e as Error).message));
  }
}
const setField = (id: string, name: string, field: string, value: unknown) =>
  run(name, { id, [field === "ownerId" ? "owner" : field]: value }, { patch: { id, set: { [field]: value, ...(field === "ownerId" ? { owner: popUsers().find((u) => u.id === value) } : {}), updatedAt: Date.now() } } });
const popUsers = () => sync.view("pick");

function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  setTimeout(() => t.classList.remove("on"), 3500);
}

// ---------------------------------------------------------------- render
const statusIcon = (s: string) => `<span class="st st-${s}" title="${STATUS_LABEL[s]}"></span>`;
const priIcon = (p: string) => `<span class="pri pri-${p}" title="${PRI_LABEL[p]}"><i></i><i></i><i></i></span>`;
const tagChips = (tags: string[] = []) => tags.map((t) => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join("");

function rowHtml(r: Row) {
  const pend = sync.pendingOps().some((p) => p.patch?.id === r.id || p.insert?.id === r.id);
  return `<div class="row ${state.issue === r.id ? "sel" : ""} ${pend ? "pend" : ""}" data-open="${esc(r.id)}">
    <button class="cell pri-btn" data-pop="priority" data-id="${esc(r.id)}">${priIcon(r.priority)}</button>
    <span class="key">${esc(keyOf(r))}</span>
    <button class="cell st-btn" data-pop="status" data-id="${esc(r.id)}">${statusIcon(r.status)}</button>
    <span class="title">${esc(r.title)}</span>
    <span class="tags">${tagChips(r.tags)}</span>
    <span class="cc">${r.commentCount ? `<svg viewBox="0 0 16 16"><path d="M2 3h12v8H6l-3 3v-3H2z"/></svg>${r.commentCount}` : ""}</span>
    <span class="date">${ago(r.createdAt)}</span>
    <button class="cell" data-pop="owner" data-id="${esc(r.id)}">${avatar(r.owner)}</button>
  </div>`;
}

function listView() {
  const rows = sync.view("list", (r) => matches(r, state.filter), byCreated, state.limit);
  const s = sync.get("list");
  if (!s?.ready) return `<div class="empty">Loading…</div>`;
  if (!rows.length) return `<div class="empty">No issues match.</div>`;
  const more = s.complete === false && state.limit < 500 ? `<button class="more" data-more>Load 50 more</button>` : s.complete === false ? `<div class="empty small">The window stops at 500. Filter to narrow it.</div>` : "";
  return `<div class="list">${rows.map(rowHtml).join("")}</div>${more}`;
}

function boardView() {
  const cols = STATUSES.filter((st) => !state.filter.status.length || state.filter.status.includes(st));
  return `<div class="board">${cols
    .map((st) => {
      const cards = sync.view(`col:${st}`, (r) => matches(r, state.filter, st), byCreated, 25);
      const n = sync.count(`n:${st}`, (p) => (p.patch?.set.status === st ? 1 : 0) - (p.patch && sync.findRow(p.patch.id)?.status === st && p.patch.set.status && p.patch.set.status !== st ? 1 : 0));
      return `<div class="col" data-drop="${st}"><div class="col-h">${statusIcon(st)} ${STATUS_LABEL[st]} <span class="n">${n ?? ""}</span></div>
        <div class="cards">${cards
          .map(
            (r) => `<div class="card ${sync.pendingOps().some((p) => p.patch?.id === r.id) ? "pend" : ""}" draggable="true" data-drag="${esc(r.id)}" data-open="${esc(r.id)}">
          <div class="card-top"><span class="key">${esc(keyOf(r))}</span>${avatar(r.owner, "sm")}</div>
          <div class="card-title">${esc(r.title)}</div>
          <div class="card-meta">${priIcon(r.priority)}${tagChips(r.tags?.slice(0, 3))}${r.commentCount ? `<span class="cc">${r.commentCount}</span>` : ""}</div></div>`,
          )
          .join("")}${(n ?? 0) > 25 ? `<div class="empty small">${(n ?? 0) - 25} more</div>` : ""}</div></div>`;
    })
    .join("")}</div>`;
}

function activityView() {
  const rows = sync.view("feed", undefined, byCreated, 30);
  if (!sync.get("feed")?.ready) return `<div class="empty">Loading…</div>`;
  return `<div class="feed">${rows
    .map(
      (c) => `<div class="fi" data-open="${esc(c.issueId)}" data-project="${esc(c.projectId)}">${avatar(c.author)}<div><div class="fi-h"><b>${esc(c.author?.name ?? "Someone")}</b> commented on <span class="fi-t">${esc(c.issueTitle)}</span> <span class="date">${ago(c.createdAt)}</span></div><div class="fi-b">${esc(c.body)}</div></div></div>`,
    )
    .join("")}</div>`;
}

function detailView() {
  if (!state.issue) return "";
  const r = sync.view("detail")[0];
  if (!r) return `<aside class="detail"><div class="empty">Loading…</div></aside>`;
  const comments: Row[] = r.comments ?? [];
  return `<aside class="detail">
    <div class="d-top"><span class="key">${esc(keyOf(r))}</span><span class="grow"></span>
      ${r.id.startsWith("u-") ? `<button class="ghost" data-delete="${esc(r.id)}">Delete</button>` : ""}
      <button class="ghost" data-close>✕</button></div>
    <input class="d-title" value="${esc(r.title)}" data-title="${esc(r.id)}" maxlength="180">
    <div class="d-props">
      <label>Status</label><button class="prop" data-pop="status" data-id="${esc(r.id)}">${statusIcon(r.status)} ${STATUS_LABEL[r.status]}</button>
      <label>Priority</label><button class="prop" data-pop="priority" data-id="${esc(r.id)}">${priIcon(r.priority)} ${PRI_LABEL[r.priority]}</button>
      <label>Assignee</label><button class="prop" data-pop="owner" data-id="${esc(r.id)}">${avatar(r.owner, "sm")} ${esc(r.owner?.name ?? "Unassigned")}</button>
      <label>Tags</label><div class="prop tags-edit">${(r.tags ?? []).map((t: string) => `<span class="tag">${esc(t)}<b data-untag="${esc(t)}" data-id="${esc(r.id)}">×</b></span>`).join("")}<input placeholder="add tag" data-addtag="${esc(r.id)}" size="8"></div>
      <label>Created</label><span class="prop plain">${ago(r.createdAt)}</span>
    </div>
    <div class="thread">${comments
      .map(
        (c, i) => `<div class="cm ${i === 0 ? "desc" : ""} ${c.id.startsWith("u-c") && sync.pendingOps().some((p) => p.comment?.id === c.id) ? "pend" : ""}">${avatar(c.author)}<div class="cm-b"><div class="cm-h"><b>${esc(c.author?.name ?? "You")}</b> <span class="date">${ago(c.createdAt)}</span>${i === 0 ? ` <span class="badge">description</span>` : ""}${c.id.startsWith("u-c") ? ` <button class="link" data-uncomment="${esc(c.id)}">delete</button>` : ""}</div><div class="cm-text">${esc(c.body)}</div></div></div>`,
      )
      .join("")}</div>
    <form class="composer" data-comment="${esc(r.id)}"><textarea placeholder="Leave a comment…  (⌘↵ to send)" rows="3" maxlength="2000"></textarea><button class="primary">Comment</button></form>
  </aside>`;
}

function popoverView() {
  const p = state.popover;
  if (!p) return "";
  let items = "";
  if (p.kind === "status") items = STATUSES.map((s) => `<button data-set="status" data-v="${s}">${statusIcon(s)} ${STATUS_LABEL[s]}</button>`).join("");
  if (p.kind === "priority") items = PRIORITIES.map((s) => `<button data-set="priority" data-v="${s}">${priIcon(s)} ${PRI_LABEL[s]}</button>`).join("");
  if (p.kind === "owner" || p.kind === "filter-owner" || p.kind === "project") {
    const rows = sync.view("pick");
    items =
      `<input class="pop-search" placeholder="Search…" value="${esc(p.search ?? "")}" data-popsearch autofocus>` +
      rows
        .map((u) =>
          p.kind === "project"
            ? `<button data-project="${esc(u.id)}"><span class="pk">${esc(u.key)}</span> ${esc(u.name)}</button>`
            : `<button data-set="${p.kind === "owner" ? "ownerId" : "filter-owner"}" data-v="${esc(u.id)}" data-name="${esc(u.name)}">${avatar(u, "sm")} ${esc(u.name)}</button>`,
        )
        .join("");
  }
  return `<div class="pop" style="left:${p.x}px;top:${p.y}px">${items}</div>`;
}

function hudView() {
  const subs = sync.all().filter((s) => !["me", "pick"].includes(s.id));
  const label = (s: { id: string; q: any }) => {
    const w = JSON.stringify(s.q.where ?? {});
    if (s.q.aggregate) return `count(${s.q.table})${w.includes("status") ? ` · ${s.id.replace("n:", "")}` : ""}`;
    if (s.id === "detail") return "issue + thread";
    if (s.id === "feed") return "activity feed";
    if (s.id === "project") return "project";
    return `${s.q.table} · limit ${s.q.limit}`;
  };
  return `<div class="hud-h"><b>${subs.length} live queries</b> <span class="dot ${sync.state}"></span> v${sync.version}</div>
    ${subs
      .map((s) => {
        const st = s.stats;
        const tier = !st ? (s.ready ? "server-rendered" : "…") : st.rounds === 0 ? "resident" : `${st.rounds} round${st.rounds > 1 ? "s" : ""} · ${st.r2Gets ? "R2" : "cache"}`;
        return `<div class="hq"><span class="hq-l">${esc(label(s))}</span><span class="hq-r">${st ? `${Math.round(s.firstMs ?? 0)}ms` : ""} <i>${tier}</i>${s.updates ? ` · ${s.updates}↻` : ""}</span></div>`;
      })
      .join("")}
    ${sync.lastWrite ? `<div class="hq w"><span class="hq-l">last write: ${esc(sync.lastWrite.name)}</span><span class="hq-r">${Math.round(sync.lastWrite.ms)}ms</span></div>` : ""}`;
}

function filtersView() {
  const f = state.filter;
  const chip = (kind: string, v: string, label: string) => `<button class="fchip ${(f as any)[kind].includes(v) ? "on" : ""}" data-fchip="${kind}" data-v="${v}">${label}</button>`;
  return `<div class="filters">
    ${state.view === "list" ? STATUSES.map((s) => chip("status", s, `${statusIcon(s)} ${STATUS_LABEL[s]}`)).join("") : ""}
    <span class="sep"></span>${PRIORITIES.map((p) => chip("priority", p, `${priIcon(p)} ${PRI_LABEL[p]}`)).join("")}
    <span class="sep"></span><button class="fchip ${f.owner ? "on" : ""}" data-pop="filter-owner">${f.owner ? `${esc(f.ownerName)} ×` : "Assignee"}</button>
    ${f.tag ? `<button class="fchip on" data-cleartag>#${esc(f.tag)} ×</button>` : ""}
    <input class="search" placeholder="Search titles" value="${esc(f.title ?? "")}" data-search>
  </div>`;
}

function render() {
  const project = sync.view("project")[0];
  const meRow = sync.view("me")[0];
  const count = sync.count("count", (p) => (p.insert?.projectId === state.project ? 1 : 0) - (p.remove ? 1 : 0));
  $("#side-project").innerHTML = `<span class="pk">${esc(project?.key ?? "…")}</span> ${esc(project?.name ?? state.project)} <span class="caret">▾</span>`;
  $("#me").innerHTML = `${avatar(meRow)} <span>${esc(meRow?.name ?? me)}</span>`;
  for (const v of ["list", "board", "activity"]) $(`[data-view="${v}"]`).classList.toggle("on", state.view === v);
  $("#head").innerHTML = `<h1>${state.view === "activity" ? "Activity" : esc(project?.name ?? "Issues")}</h1>
    <span class="count">${state.view === "activity" ? "across every project" : count !== undefined ? `${count.toLocaleString()} issues` : ""}</span>
    <span class="grow"></span>${state.view !== "activity" ? `<button class="primary" data-new>New issue</button>` : ""}`;
  $("#filters").innerHTML = state.view === "activity" ? "" : filtersView();
  $("#view").innerHTML = state.view === "list" ? listView() : state.view === "board" ? boardView() : activityView();
  $("#detail").innerHTML = detailView();
  $("#pop").innerHTML = popoverView();
  $("#hud").innerHTML = hudView();
  $("#create").innerHTML = state.creating ? createView() : "";
  const ps = document.querySelector("[data-popsearch]") as HTMLInputElement | null;
  if (ps && document.activeElement !== ps) {
    ps.focus();
    ps.setSelectionRange(ps.value.length, ps.value.length);
  }
}

function createView() {
  return `<div class="modal-bg" data-closecreate><form class="modal" data-create>
    <div class="modal-h">New issue in <b>${esc(sync.view("project")[0]?.name ?? state.project)}</b></div>
    <input name="title" placeholder="Issue title" maxlength="180" required autofocus>
    <textarea name="description" placeholder="Description (optional)" rows="4" maxlength="2000"></textarea>
    <div class="row-f"><select name="status">${STATUSES.map((s) => `<option value="${s}" ${s === "todo" ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select>
    <select name="priority">${PRIORITIES.map((s) => `<option value="${s}" ${s === "medium" ? "selected" : ""}>${PRI_LABEL[s]}</option>`).join("")}</select>
    <input name="tags" placeholder="tags, comma separated"></div>
    <div class="modal-f"><span class="note">Try a title with the word “spam”: the server refuses it.</span><button type="button" class="ghost" data-closecreate>Cancel</button><button class="primary">Create issue</button></div>
  </form></div>`;
}

// ---------------------------------------------------------------- events
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const el = (sel: string) => t.closest(sel) as HTMLElement | null;
  if (el("[data-view]")) {
    state.view = el("[data-view]")!.dataset.view as typeof state.view;
    state.limit = 50;
    subscribeView();
    return render();
  }
  if (el("#side-project")) {
    const r = el("#side-project")!.getBoundingClientRect();
    state.popover = { kind: "project", x: r.left, y: r.bottom + 4, search: "" };
    subscribeView();
    return render();
  }
  if (el("[data-project]") && state.popover?.kind === "project") {
    state.project = el("[data-project]")!.dataset.project!;
    state.popover = null;
    state.issue = "";
    state.limit = 50;
    subscribeView();
    return render();
  }
  if (el("[data-pop='filter-owner']") && state.filter.owner) {
    state.filter.owner = undefined;
    subscribeView();
    return render();
  }
  if (el("[data-pop]")) {
    e.stopPropagation();
    const b = el("[data-pop]")!;
    const r = b.getBoundingClientRect();
    state.popover = { kind: b.dataset.pop!, id: b.dataset.id, x: Math.min(r.left, innerWidth - 240), y: r.bottom + 4, search: "" };
    subscribeView();
    return render();
  }
  if (el("[data-set]") && state.popover) {
    const b = el("[data-set]")!;
    const p = state.popover;
    state.popover = null;
    if (b.dataset.set === "filter-owner") {
      state.filter.owner = b.dataset.v;
      state.filter.ownerName = b.dataset.name;
      subscribeView();
    } else if (p.id) {
      const name = { status: "setStatus", priority: "setPriority", ownerId: "setOwner" }[b.dataset.set!]!;
      setField(p.id, name, b.dataset.set!, b.dataset.v);
    }
    subscribeView();
    return render();
  }
  if (state.popover && !el(".pop")) {
    state.popover = null;
    subscribeView();
    render();
  }
  if (el("[data-fchip]")) {
    const b = el("[data-fchip]")!;
    const list = (state.filter as any)[b.dataset.fchip!] as string[];
    const v = b.dataset.v!;
    (state.filter as any)[b.dataset.fchip!] = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
    state.limit = 50;
    subscribeView();
    return render();
  }
  if (el("[data-pop='filter-owner']") && state.filter.owner) {
    state.filter.owner = undefined;
    subscribeView();
    return render();
  }
  if (el("[data-cleartag]")) {
    state.filter.tag = undefined;
    subscribeView();
    return render();
  }
  if (el(".tag[data-tag]") && !el("[data-untag]")) {
    e.stopPropagation();
    state.filter.tag = el(".tag[data-tag]")!.dataset.tag;
    state.view = state.view === "activity" ? "list" : state.view;
    subscribeView();
    return render();
  }
  if (el("[data-more]")) {
    state.limit = Math.min(500, state.limit + 50);
    subscribeView();
    return render();
  }
  if (el("[data-close]")) {
    state.issue = "";
    subscribeView();
    return render();
  }
  if (el("[data-untag]")) {
    const b = el("[data-untag]")!;
    const row = sync.findRow(b.dataset.id!);
    const tags = (row?.tags ?? []).filter((x: string) => x !== b.dataset.untag);
    run("setTags", { id: b.dataset.id, tags }, { patch: { id: b.dataset.id!, set: { tags } } });
    return;
  }
  if (el("[data-uncomment]")) {
    const id = el("[data-uncomment]")!.dataset.uncomment!;
    run("deleteComment", { id }, { uncomment: id });
    return;
  }
  if (el("[data-delete]")) {
    const id = el("[data-delete]")!.dataset.delete!;
    state.issue = "";
    run("deleteIssue", { id }, { remove: id });
    subscribeView();
    return render();
  }
  if (el("[data-new]")) {
    state.creating = true;
    render();
    (document.querySelector("[data-create] input") as HTMLInputElement)?.focus();
    return;
  }
  if (t.matches("[data-closecreate]")) {
    state.creating = false;
    return render();
  }
  if (el("[data-open]") && !el("button") && !el(".detail")) {
    const o = el("[data-open]")!;
    if (o.dataset.project && o.dataset.project !== state.project) state.project = o.dataset.project;
    state.issue = o.dataset.open!;
    subscribeView();
    return render();
  }
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.matches("[data-search]")) {
    clearTimeout((t as any)._d);
    (t as any)._d = setTimeout(() => {
      state.filter.title = t.value.trim() || undefined;
      state.limit = 50;
      subscribeView();
      render();
      const s = document.querySelector("[data-search]") as HTMLInputElement;
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }, 200);
  }
  if (t.matches("[data-popsearch]") && state.popover) {
    clearTimeout((t as any)._d);
    (t as any)._d = setTimeout(() => {
      state.popover!.search = t.value;
      subscribeView();
    }, 120);
  }
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.matches("[data-title]") && t.value.trim()) setField(t.dataset.title!, "editTitle", "title", t.value.trim());
});

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("[data-addtag]") && e.key === "Enter") {
    const input = t as HTMLInputElement;
    const v = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!v) return;
    const row = sync.findRow(input.dataset.addtag!);
    const tags = [...new Set([...(row?.tags ?? []), v])].sort();
    input.value = "";
    run("setTags", { id: input.dataset.addtag, tags }, { patch: { id: input.dataset.addtag!, set: { tags } } });
  }
  if (t.matches(".composer textarea") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) (t.closest("form") as HTMLFormElement).requestSubmit();
  if (e.key === "Escape") {
    state.popover = null;
    state.creating = false;
    if (!t.matches("input,textarea")) state.issue = "";
    subscribeView();
    render();
  }
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  if (form.matches("[data-comment]")) {
    const ta = form.querySelector("textarea")!;
    const body = ta.value.trim();
    if (!body) return;
    const id = `u-c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    ta.value = "";
    run("addComment", { id, issueId: form.dataset.comment, body }, { comment: { id, issueId: form.dataset.comment, body, createdAt: Date.now(), authorId: me, author: sync.view("me")[0] } });
  }
  if (form.matches("[data-create]")) {
    const d = new FormData(form);
    const id = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tags = String(d.get("tags") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const now = Date.now();
    const row = {
      id,
      projectId: state.project,
      title: String(d.get("title")),
      status: String(d.get("status")),
      priority: String(d.get("priority")),
      ownerId: me,
      owner: sync.view("me")[0],
      project: sync.view("project")[0],
      createdAt: now,
      updatedAt: now,
      tags,
      commentCount: d.get("description") ? 1 : 0,
    };
    state.creating = false;
    run("createIssue", { id, project: state.project, title: row.title, status: row.status, priority: row.priority, tags, description: String(d.get("description") ?? "") }, { insert: row });
    render();
  }
});

// Board drag & drop → setStatus.
document.addEventListener("dragstart", (e) => {
  const c = (e.target as HTMLElement).closest("[data-drag]") as HTMLElement | null;
  if (c) e.dataTransfer!.setData("text/plain", c.dataset.drag!);
});
document.addEventListener("dragover", (e) => {
  if ((e.target as HTMLElement).closest("[data-drop]")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const col = (e.target as HTMLElement).closest("[data-drop]") as HTMLElement | null;
  const id = e.dataTransfer?.getData("text/plain");
  if (col && id) {
    e.preventDefault();
    setField(id, "setStatus", "status", col.dataset.drop);
  }
});

sync.onChange(render);
subscribeView();
render();
if (boot.ms !== undefined) console.log(`server-rendered first page in ${boot.ms} ms`, boot.stats);
