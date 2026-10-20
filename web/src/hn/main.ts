/**
 * Hacker News, live: every story and comment since 2006 served by one Durable Object, with new
 * items streaming in from the HN API. Pages are news.ycombinator.com's; every list and thread
 * is a live query (new stories and replies appear as they're posted).
 */
import { Sync, type Row } from "../sync";

declare global {
  interface Window {
    __BOOT?: { p: string; list?: { rows: Row[] }; ms?: number; stats?: any; leases?: any[]; build?: string; base?: { bytes: number; rows: Record<string, number> } };
  }
}

const boot = window.__BOOT ?? { p: "news" };
const params = new URLSearchParams(location.search);
const page = params.get("p") ?? "news";
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const PER_PAGE = 30;

let me = localStorage.getItem("pagedb.hn.user");
if (!me || !/^[a-z0-9-]{3,20}$/.test(me)) {
  me = `guest-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("pagedb.hn.user", me);
}
const voted = new Set<string>(JSON.parse(localStorage.getItem("pagedb.hn.voted") ?? "[]"));

const sync = new Sync(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/socket?app=hn`, boot.leases ?? [], "hn");
sync.build = boot.build;
sync.onStale = () => {
  if (Date.now() - Number(sessionStorage.getItem("pagedb-reloaded") ?? 0) < 60_000) return;
  const go = () => (!sync.pendingOps().length && !document.activeElement?.matches("textarea, input") ? (sessionStorage.setItem("pagedb-reloaded", String(Date.now())), location.reload()) : setTimeout(go, 2000));
  go();
};

// ---------------------------------------------------------------- helpers

function ago(t: number) {
  const s = Math.max(1, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)} seconds ago`;
  if (s < 3600) return `${Math.floor(s / 60)} minute${s < 120 ? "" : "s"} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${s < 7200 ? "" : "s"} ago`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400)} day${s < 172800 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** HN's markup (p, i, a, pre, code) kept; everything else reduced to text. */
function clean(html: string | null | undefined): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<div>${html.replace(/<p>/g, "</p><p>")}</div>`, "text/html");
  // (Depth-capped: some comments' markup nests absurdly deep; past that, plain text.)
  const walk = (n: Node, depth = 0): string => {
    if (n.nodeType === Node.TEXT_NODE) return esc(n.textContent);
    if (!(n instanceof Element)) return "";
    if (depth > 40) return esc(n.textContent);
    const inner = [...n.childNodes].map((c) => walk(c, depth + 1)).join("");
    const tag = n.tagName.toLowerCase();
    if (tag === "a") {
      const href = n.getAttribute("href") ?? "";
      return /^https?:\/\//.test(href) ? `<a href="${esc(href)}" rel="nofollow noreferrer" target="_blank">${inner}</a>` : inner;
    }
    if (["p", "i", "pre", "code", "b"].includes(tag)) return `<${tag}>${inner}</${tag}>`;
    return inner;
  };
  return [...doc.body.firstChild!.childNodes].map((c) => walk(c)).join("").replace(/<p><\/p>/g, "");
}

const itemLink = (id: string, text: string) => `<a href="?p=item&id=${esc(id)}">${text}</a>`;
const userLink = (by: string) => (by ? `<a href="?p=user&id=${esc(by)}" class="hnuser">${esc(by)}</a>` : "[deleted]");

/** Rows shown before: anything new since gets a highlight (a live arrival). */
const seen = new Set<string>();
let primed = false;
function fresh(id: string) {
  const isNew = primed && !seen.has(id);
  seen.add(id);
  return isNew ? " fresh" : "";
}

// ---------------------------------------------------------------- subscriptions

type Cursor = Record<string, number | string>;
const next: Cursor | undefined = params.get("next") ? JSON.parse(params.get("next")!) : undefined;
const offset = Number(params.get("n") ?? 0);
// Title words as the index has them (src/apps/hn.ts titleWords: stopwords aren't indexed).
const STOP = new Set(
  ("the and for with from your you are how why what when who this that its into about show ask hn of to in on is an at by as it be or my we not can do does " +
    "vs via was will has have than but just our all out so if no up new").split(" "),
);
const words = [...new Set((params.get("q") ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w)))].slice(0, 4);

function subscribe() {
  const id = params.get("id") ?? "";
  const seed = boot.list ? { rows: (boot.list as any).rows ?? [boot.list] } : undefined;
  switch (page) {
    case "news":
      return sync.sub("list", { name: "top" }, seed);
    case "newest":
      return sync.sub("list", { name: "new", args: next ? { start: next } : {} }, next ? undefined : seed);
    case "best":
      return sync.sub("list", { name: "best", args: next ? { start: next } : {} }, next ? undefined : seed);
    case "ask":
    case "show":
    case "jobs":
      return sync.sub("list", { name: "kind", args: { kind: page === "jobs" ? "job" : page, ...(next ? { start: next } : {}) } });
    case "from":
      return sync.sub("list", { name: "from", args: { domain: params.get("site") ?? "", ...(next ? { start: next } : {}) } });
    case "search":
      return words.length ? sync.sub("list", { name: "search", args: { words, ...(next ? { start: next } : {}) } }) : undefined;
    case "semantic":
      return semanticArgs().q.length >= 2 ? sync.sub("list", { name: "semantic", args: semanticArgs() }, seed) : undefined;
    case "user":
      sync.sub("ustories", { name: "userStories", args: { by: id, limit: 30 } });
      return sync.sub("ucomments", { name: "userComments", args: { by: id, limit: 30 } });
    case "comments":
      return sync.sub("list", { name: "newComments", args: { limit: 30 } });
    case "item":
      return sync.sub("item", { name: "item", args: { id } }, seed);
  }
}
subscribe();

/** The semantic search in the URL: ?q= (meaning, not words), &since=, &kind=. */
function semanticArgs(): Record<string, string> {
  const a: Record<string, string> = { q: (params.get("q") ?? "").trim().slice(0, 200) };
  const since = params.get("since") ?? "";
  if (["day", "week", "month", "year"].includes(since)) a.since = since;
  const kind = params.get("kind") ?? "";
  if (["story", "ask", "show", "job", "poll"].includes(kind)) a.kind = kind;
  return a;
}

// ---------------------------------------------------------------- views

function storyRows(rows: Row[], start: number, scores = false) {
  // Similarity bars span the scores on screen (good matches all sit in a narrow band).
  const ss = rows.map((r) => r._score ?? 0);
  const [lo, hi] = [Math.min(...ss), Math.max(...ss)];
  return rows
    .map((r, i) => {
      const w = hi > lo ? 20 + (80 * ((r._score ?? 0) - lo)) / (hi - lo) : 100;
      const sim = scores && r._score !== undefined ? `<span class="sim" title="cosine similarity ${r._score.toFixed(3)}"><i style="width:${w.toFixed(0)}%"></i></span>` : "";
      const dom = r.domain ? ` <span class="sitebit">(<a href="?p=from&site=${esc(r.domain)}">${esc(r.domain)}</a>)</span>` : "";
      const href = r.url ? esc(r.url) : `?p=item&id=${esc(r.id)}`;
      const job = r.kind === "job";
      const meta = job
        ? itemLink(r.id, ago(r.time))
        : `<span class="score">${r.score} point${r.score === 1 ? "" : "s"}</span> by ${userLink(r.by)} ${itemLink(r.id, ago(r.time))} | ${itemLink(r.id, r.descendants ? `${r.descendants}&nbsp;comment${r.descendants === 1 ? "" : "s"}` : "discuss")}`;
      return `<tr class="athing${fresh(r.id)}"><td class="rank">${start + i + 1}.</td><td class="votelinks">${job ? "" : `<a class="votearrow${voted.has(r.id) ? " voted" : ""}" data-vote="${esc(r.id)}" title="upvote"></a>`}</td>
        <td class="titleline">${sim}<a href="${href}" ${r.url ? 'rel="nofollow noreferrer" target="_blank"' : ""}>${esc(r.title)}</a>${dom}</td></tr>
        <tr><td colspan="2"></td><td class="subtext">${meta}</td></tr><tr class="spacer"></tr>`;
    })
    .join("");
}

function semanticView() {
  const a = semanticArgs();
  const opt = (name: string, v: string, label: string) => `<option value="${v}"${(params.get(name) ?? "") === v ? " selected" : ""}>${label}</option>`;
  const form = `<form class="semform" action="">
    <input type="hidden" name="p" value="semantic">
    <input type="search" name="q" value="${esc(a.q)}" placeholder="Describe what you're looking for…" ${a.q ? "" : "autofocus"} maxlength="200" aria-label="Search by meaning">
    <select name="since" aria-label="When">${opt("since", "", "Any time")}${opt("since", "year", "Past year")}${opt("since", "month", "Past month")}${opt("since", "week", "Past week")}${opt("since", "day", "Past day")}</select>
    <select name="kind" aria-label="Kind">${opt("kind", "", "All stories")}${opt("kind", "story", "Links")}${opt("kind", "ask", "Ask HN")}${opt("kind", "show", "Show HN")}${opt("kind", "job", "Jobs")}</select>
    <button>Search</button></form>`;
  const examples = ["running a database on object storage", "burnout as a solo founder", "why is my rust code slow", "learning to draw as an adult"];
  if (a.q.length < 2)
    return `${form}<div class="semintro"><p>Search every HN story by meaning, not keywords. Each story's title (and Ask HN text) is an embedding in a vector index that lives in the same Durable Object as the rest of HN, so new stories are searchable the moment they're posted.</p>
      <p class="semtry">Try: ${examples.map((x) => `<a href="?p=semantic&q=${encodeURIComponent(x)}">${esc(x)}</a>`).join("")}</p></div>`;
  const s = sync.get("list");
  if (!s?.ready && !s?.rows.size) return `${form}<p class="note">Embedding your query and searching…</p>`;
  const rows = sync.view("list").sort((x, y) => (y._score ?? 0) - (x._score ?? 0));
  if (!rows.length) return `${form}<p class="note">Nothing found.</p>`;
  const st = s?.stats;
  const tier = st ? (st.r2Gets ? "from R2" : st.cacheHits ? "from the city cache" : st.sqliteHits ? "from the object's SQLite" : "in memory") : "";
  const ann = s?.ann;
  const line = ann ? `<p class="semstats">${ann.scanned.toLocaleString()} story vectors compared in ${ann.clusters} clusters (${ann.pages} pages, ${tier})${s?.firstMs !== undefined ? `, ${Math.round(s.firstMs)} ms including the query's embedding` : ""}</p>` : "";
  return `${form}${line}<table class="items">${storyRows(rows, 0, true)}</table>`;
}

function moreLink(rows: Row[], key: "time" | "score") {
  if (rows.length < PER_PAGE) return "";
  const last = rows[rows.length - 1];
  const p = new URLSearchParams(params);
  p.set("next", JSON.stringify({ [key]: last[key], id: last.id }));
  return `<tr><td colspan="2"></td><td class="morelink"><a href="?${p}">More</a></td></tr>`;
}

function listView() {
  if (page === "search" && !words.length) return `<p class="note">Search titles: words of two or more letters (common words like "the" aren't indexed).</p>`;
  const s = sync.get("list");
  if (!s?.ready && !s?.rows.size) return `<p class="note">Loading…</p>`;
  let rows = sync.view("list");
  if (page === "news") {
    rows = rows.sort((a, b) => (a.topRank ?? 999) - (b.topRank ?? 999));
    const more = offset + PER_PAGE < rows.length ? `<tr><td colspan="2"></td><td class="morelink"><a href="?p=news&n=${offset + PER_PAGE}">More</a></td></tr>` : "";
    if (!rows.length) return `<p class="note">The front page fills in within a minute of the live tail starting.</p>`;
    return `<table class="items">${storyRows(rows.slice(offset, offset + PER_PAGE), offset)}${more}</table>`;
  }
  const byScore = page === "best";
  rows = rows.sort((a, b) => (byScore ? b.score - a.score : b.time - a.time) || (a.id < b.id ? -1 : 1)).slice(0, PER_PAGE);
  if (!rows.length) return `<p class="note">Nothing here.</p>`;
  return `<table class="items">${storyRows(rows, 0)}${moreLink(rows, byScore ? "score" : "time")}</table>`;
}

function commentLine(c: Row, withStory = true) {
  return `<div class="cmt${fresh(c.id)}"><div class="comhead">${userLink(c.by)} ${itemLink(c.id, ago(c.time))}${withStory ? ` | on: ${itemLink(c.storyId, "thread")}` : ""}</div><div class="commtext">${clean(c.text)}</div></div>`;
}

function commentsView() {
  const rows = sync.view("list").sort((a, b) => b.time - a.time);
  return rows.length ? rows.map((c) => commentLine(c)).join("") : `<p class="note">Loading…</p>`;
}

function userView() {
  const id = params.get("id") ?? "";
  if (!sync.get("ustories")?.ready || !sync.get("ucomments")?.ready) return `<h2 class="uh">${esc(id)}</h2><p class="note">Loading…</p>`;
  const st = sync.view("ustories").sort((a, b) => b.time - a.time);
  const cm = sync.view("ucomments").sort((a, b) => b.time - a.time);
  return `<h2 class="uh">${esc(id)}</h2><h3>Submissions</h3>${st.length ? `<table class="items">${storyRows(st, 0)}</table>` : `<p class="note">None loaded.</p>`}
    <h3>Comments</h3>${cm.map((c) => commentLine(c)).join("") || `<p class="note">None loaded.</p>`}`;
}

// Thread state: folded comments, open reply boxes, the comment to scroll to.
const folded = new Set<string>();
let replying: string | null = null;
let focusId = params.get("focus");
let extra: Row[] = []; // comments past the first 1000, loaded on demand
let lookedUpComment = false;

function threadView() {
  const s = sync.get("item");
  const story = sync.view("item")[0];
  if (!story) {
    if (s?.ready && !lookedUpComment) {
      // Not a story: maybe a comment's id. Find its thread.
      lookedUpComment = true;
      sync.sub("lookup", { name: "comment", args: { id: params.get("id") ?? "" } });
    }
    const c = sync.view("lookup")[0];
    if (c) location.replace(`?p=item&id=${encodeURIComponent(c.storyId)}&focus=${encodeURIComponent(c.id)}`);
    return `<p class="note">${s?.ready && sync.get("lookup")?.ready ? "No such item." : "Loading…"}</p>`;
  }
  // Big threads: the first 1000 come with the story; the newest (and new replies, live) from
  // "latest"; anything between, on demand.
  if ((story.descendants ?? 0) > (story.comments?.length ?? 0) && !sync.get("latest")) sync.sub("latest", { name: "latest", args: { story: story.id } });
  const byId = new Map<string, Row>();
  for (const c of [...(story.comments ?? []), ...extra, ...sync.view("latest")]) byId.set(c.id, c);
  const comments: Row[] = [...byId.values()];
  const kids = new Map<string, Row[]>();
  const ids = new Set(comments.map((c) => c.id));
  for (const c of comments) {
    const p = ids.has(c.parent) ? c.parent : story.id; // parent dropped (dead/deleted): show at the top
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(c);
  }
  // Replies under each comment, counted once (the data has a few odd parent links: a comment is
  // placed at most once, so a cycle can't recurse forever).
  const placed = new Set<string>();
  const counts = new Map<string, number>();
  const countAll = (id: string, seen = new Set<string>()): number => {
    if (counts.has(id)) return counts.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = (kids.get(id) ?? []).reduce((acc, k) => acc + 1 + countAll(k.id, seen), 0);
    counts.set(id, n);
    return n;
  };
  const out: string[] = [];
  const walk = (pid: string, depth: number) => {
    for (const c of (kids.get(pid) ?? []).sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1))) {
      if (placed.has(c.id) || depth > 200) continue;
      placed.add(c.id);
      const n = countAll(c.id);
      const isFolded = folded.has(c.id);
      out.push(`<div class="cmt${fresh(c.id)}${focusId === c.id ? " focus" : ""}${c.id.startsWith("u-") && sync.pendingOps().some((p) => p.child?.row.id === c.id) ? " pend" : ""}" id="c-${esc(c.id)}" style="margin-left:${depth * 40}px">
        <div class="comhead">${userLink(c.by)} ${itemLink(c.id, ago(c.time))} <a class="togg" data-fold="${esc(c.id)}">${isFolded ? `[${n + 1} more]` : "[–]"}</a></div>
        ${isFolded ? "" : `<div class="commtext">${clean(c.text)}</div><div class="reply"><a data-reply="${esc(c.id)}">reply</a></div>${replying === c.id ? replyBox(c.id) : ""}`}</div>`);
      if (!isFolded) walk(c.id, depth + 1);
    }
  };
  walk(story.id, 0);
  const dom = story.domain ? ` <span class="sitebit">(<a href="?p=from&site=${esc(story.domain)}">${esc(story.domain)}</a>)</span>` : "";
  const loaded = comments.length;
  const more = loaded < (story.descendants ?? 0) && (story.comments?.length ?? 0) >= 1000 ? `<p><a data-more class="morelink">Load more comments (${loaded} of ${story.descendants})</a></p>` : "";
  return `<table class="items fatitem"><tr class="athing"><td class="votelinks"><a class="votearrow${voted.has(story.id) ? " voted" : ""}" data-vote="${esc(story.id)}"></a></td>
      <td class="titleline"><a href="${story.url ? esc(story.url) : "#"}" rel="nofollow noreferrer" target="_blank">${esc(story.title)}</a>${dom}</td></tr>
      <tr><td></td><td class="subtext"><span class="score">${story.score} points</span> by ${userLink(story.by)} ${ago(story.time)} | ${story.descendants ?? 0} comments</td></tr>
      ${story.text ? `<tr><td></td><td class="toptext">${clean(story.text)}</td></tr>` : ""}
      <tr><td></td><td>${replyBox(story.id, true)}</td></tr></table>
    <div class="comments">${out.join("")}</div>${more}`;
}

function replyBox(parent: string, top = false) {
  return `<form class="replyform" data-parent="${esc(parent)}"><textarea name="text" rows="${top ? 6 : 4}" placeholder="${top ? "add a comment" : "reply"} as ${esc(me)}"></textarea><br><button>${top ? "add comment" : "reply"}</button></form>`;
}

function submitView() {
  return `<form class="submit" data-submit><table>
    <tr><td>title</td><td><input name="title" maxlength="80" size="50" required></td></tr>
    <tr><td>url</td><td><input name="url" size="50"></td></tr>
    <tr><td>text</td><td><textarea name="text" rows="4" cols="49"></textarea></td></tr>
    <tr><td></td><td><button>submit</button> <span class="note">as ${esc(me)}, on this copy of HN</span></td></tr></table></form>`;
}

function footer() {
  const s = sync.get(page === "user" ? "ustories" : page === "item" ? "item" : "list");
  const st = s?.stats;
  const where = st ? (st.r2Gets ? "from R2" : st.cacheHits ? "from the city cache" : "resident") : "";
  return `<span class="live ${sync.state}">●</span> ${sync.state === "live" ? "live" : sync.state} · ${s?.firstMs !== undefined ? `this page's query: ${Math.round(s.firstMs)} ms, ${where}` : boot.ms !== undefined ? `server-rendered in ${boot.ms} ms` : ""}${s?.updates ? ` · ${s.updates} live update${s.updates === 1 ? "" : "s"}` : ""}`;
}

// ---------------------------------------------------------------- render

const shown = new Map<string, string>();
function put(sel: string, html: string) {
  if (shown.get(sel) === html) return;
  shown.set(sel, html);
  $(sel).innerHTML = html;
}

function render() {
  const active = document.activeElement as HTMLTextAreaElement | null;
  const typing = active?.matches("textarea, input") ? { form: active.closest("form")?.getAttribute("data-parent") ?? (active.closest("[data-submit]") ? "submit" : null), name: active.name, value: active.value, a: active.selectionStart, b: active.selectionEnd } : null;
  const views: Record<string, () => string> = { comments: commentsView, user: userView, item: threadView, submit: submitView, semantic: semanticView };
  put("#main", (views[page] ?? listView)());
  put("#me", esc(me));
  put("#foot", footer());
  if (typing?.form && !active!.isConnected) {
    const sel = typing.form === "submit" ? `[data-submit] [name="${typing.name}"]` : `form[data-parent="${CSS.escape(typing.form)}"] [name="${typing.name}"]`;
    const el = document.querySelector(sel) as HTMLTextAreaElement | null;
    if (el) {
      el.value = typing.value;
      el.focus();
      if (typing.a !== null) el.setSelectionRange(typing.a, typing.b);
    }
  }
  for (const a of document.querySelectorAll(".pagetop a[data-page]")) a.classList.toggle("on", (a as HTMLElement).dataset.page === page);
  if (focusId && document.getElementById(`c-${focusId}`)) {
    document.getElementById(`c-${focusId}`)!.scrollIntoView({ block: "center" });
    focusId = null;
  }
  // Everything on screen now counts as seen; later arrivals flash.
  if (!primed && (sync.get("list")?.ready || sync.get("item")?.ready || sync.get("ustories")?.ready)) primed = true;
}

if (boot.base?.bytes) {
  const n = (boot.base.rows.story ?? 0) + (boot.base.rows.comment ?? 0);
  $("#basesize").textContent = `${(n / 1e6).toFixed(1)} million items, ${(boot.base.bytes / 1e9).toFixed(1)} GB`;
}
const qBox = document.querySelector("#q") as HTMLInputElement | null;
if (qBox && page === "search") qBox.value = params.get("q") ?? "";
sync.onChange(render);
render();

// ---------------------------------------------------------------- actions

async function run(name: string, args: Row, predicted: Parameters<Sync["mutate"]>[2]) {
  try {
    return await sync.mutate(name, args, predicted, me!);
  } catch (e) {
    alert(String((e as Error).message));
  }
}

document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const v = t.closest("[data-vote]") as HTMLElement | null;
  if (v) {
    const id = v.dataset.vote!;
    if (voted.has(id)) return;
    voted.add(id);
    localStorage.setItem("pagedb.hn.voted", JSON.stringify([...voted].slice(-500)));
    const row = sync.findRow(id);
    run("upvote", { id }, { patch: { id, set: { score: (row?.score ?? 0) + 1 } } });
    return;
  }
  const f = t.closest("[data-fold]") as HTMLElement | null;
  if (f) {
    const id = f.dataset.fold!;
    folded.has(id) ? folded.delete(id) : folded.add(id);
    return render();
  }
  const r = t.closest("[data-reply]") as HTMLElement | null;
  if (r) {
    replying = replying === r.dataset.reply ? null : r.dataset.reply!;
    render();
    (document.querySelector(`form[data-parent="${CSS.escape(replying ?? "")}"] textarea`) as HTMLTextAreaElement | null)?.focus();
    return;
  }
  if (t.closest("[data-more]")) {
    // Comments past the first 1000: a live page of the thread after the last one shown.
    const story = sync.view("item")[0];
    const all = [...(story?.comments ?? []), ...extra].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    const last = all[all.length - 1];
    const sub = sync.sub(`more:${last.id}`, { name: "thread", args: { story: story.id, start: { time: last.time, id: last.id } } });
    const poll = setInterval(() => {
      if (!sub.ready) return;
      clearInterval(poll);
      extra = [...extra, ...sync.view(`more:${last.id}`)];
      render();
    }, 100);
  }
});

// Back to a page from the back/forward cache: its filters may still be disabled from the submit.
addEventListener("pageshow", () => document.querySelectorAll<HTMLSelectElement>(".semform select").forEach((el) => (el.disabled = false)));

document.addEventListener("submit", async (e) => {
  const form = e.target as HTMLFormElement;
  // Search forms navigate (GET) as usual, minus empty filters (no "&since=&kind=").
  if (form.matches(".semform")) {
    for (const el of form.querySelectorAll("select")) el.disabled = !el.value;
    return;
  }
  if (!form.matches("[data-parent], [data-submit]")) return; // the search box is a plain GET form
  e.preventDefault();
  if (form.matches("[data-parent]")) {
    const ta = form.querySelector("textarea")!;
    const text = ta.value.trim();
    if (!text) return;
    const story = sync.view("item")[0];
    const id = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const parent = form.dataset.parent!;
    ta.value = "";
    replying = null;
    const row = { id, storyId: story.id, parent, by: me, time: Date.now(), text: text.split(/\n\s*\n/).map((p) => esc(p.trim())).join("<p>") };
    await run("comment", { id, storyId: story.id, parent, text }, { child: { parent: story.id, list: "comments", count: "descendants", row } });
  }
  if (form.matches("[data-submit]")) {
    const d = new FormData(form);
    const res = (await run("submit", { title: d.get("title"), url: d.get("url"), text: d.get("text") }, {})) as { created?: string } | undefined;
    if (res?.created) location.href = `?p=item&id=${res.created}`;
  }
});
