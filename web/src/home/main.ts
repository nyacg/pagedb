// The homepage: a pagedb client of the Hacker News object (a live feed of what's arriving and a
// semantic search box), plus the animated architecture walkthrough.
import { Sync, type Row } from "../sync";

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

// ---------------------------------------------------------------- live HN

const sync = new Sync(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/socket?app=hn`, [], "hn");
sync.sub("stories", { name: "new", args: { limit: 12 } });
sync.sub("comments", { name: "newComments", args: { limit: 12 } });

const seen = new Set<string>();
let primed = false;
function renderFeed() {
  const st = sync.get("stories"), cm = sync.get("comments");
  if (!st?.ready && !cm?.ready) return;
  const items: { id: string; time: number; html: string }[] = [];
  for (const r of sync.view("stories")) items.push({ id: r.id, time: r.time, html: `<i>story</i>${esc(r.title)}` });
  for (const r of sync.view("comments")) {
    const text = String(r.text ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    items.push({ id: r.id, time: r.time, html: `<i>comment</i>${esc(r.by)}: ${esc(text.slice(0, 120))}` });
  }
  items.sort((a, b) => b.time - a.time);
  $("#feed").innerHTML = items
    .slice(0, 10)
    .map((it) => {
      const fresh = primed && !seen.has(it.id);
      seen.add(it.id);
      return `<li class="${fresh ? "fresh" : ""}" data-t="${it.time}"><a class="t" href="/hn?p=item&id=${esc(it.id)}">${it.html}</a><span class="a">${ago(it.time)}</span></li>`;
    })
    .join("");
  if (!primed) items.forEach((it) => seen.add(it.id));
  primed = true;
  const ms = st?.firstMs ?? cm?.firstMs;
  $("#feedmeta").textContent = `live query · ${st?.updates ?? 0} pushes so far${ms ? ` · first answer ${Math.round(ms)} ms` : ""}`;
}
setInterval(() => document.querySelectorAll<HTMLElement>("#feed .a").forEach((el) => (el.textContent = ago(Number(el.parentElement!.dataset.t)))), 5000);

// ---------------------------------------------------------------- semantic search

let semQ = "";
function search(q: string) {
  q = q.trim();
  if (q.length < 2) return;
  semQ = q;
  ($("#q") as HTMLInputElement).value = q;
  $("#semstats").textContent = "Embedding your query and searching 4.85M stories…";
  $("#res").innerHTML = "";
  sync.sub("sem", { name: "semantic", args: { q, limit: 6 } });
}
function renderSearch() {
  const s = sync.get("sem");
  if (!s || !s.ready) return;
  const rows = sync.view("sem").sort((a, b) => (b._score ?? 0) - (a._score ?? 0)).slice(0, 6);
  const scores = rows.map((r) => r._score ?? 0);
  const hi = Math.max(...scores), lo = Math.min(...scores);
  $("#res").innerHTML = rows
    .map((r: Row) => {
      const w = hi > lo ? 25 + (75 * ((r._score ?? 0) - lo)) / (hi - lo) : 100;
      const href = r.url ? esc(r.url) : `/hn?p=item&id=${esc(r.id)}`;
      return `<li><span class="sim"><i style="width:${w.toFixed(0)}%"></i></span><span><a href="${href}" target="_blank" rel="noopener">${esc(r.title)}</a> <span class="d">${r.domain ? esc(r.domain) + " · " : ""}${new Date(r.time).getFullYear()} · ${r.score} points</span></span></li>`;
    })
    .join("");
  const a = s.ann, st = s.stats;
  const tier = st ? (st.r2Gets ? "from R2" : st.cacheHits ? "from the city cache" : st.sqliteHits ? "from the object's SQLite" : "in memory") : "";
  $("#semstats").innerHTML = a
    ? `<b>${a.scanned.toLocaleString()}</b> stories compared in ${a.clusters} clusters (${a.pages} pages, ${tier})${s.firstMs !== undefined ? ` · <b>${Math.round(s.firstMs)} ms</b> including embedding the query` : ""} · <a href="/hn?p=semantic&q=${encodeURIComponent(semQ)}">all results →</a>`
    : "";
}
$("#semform").addEventListener("submit", (e) => {
  e.preventDefault();
  search(($("#q") as HTMLInputElement).value);
});
document.querySelectorAll<HTMLButtonElement>("#chips button").forEach((b) => b.addEventListener("click", () => search(b.textContent ?? "")));

sync.onChange(() => {
  renderFeed();
  renderSearch();
  $("#livedot").classList.toggle("on", !!sync.get("stories")?.ready);
});
search("running a database on object storage");

// ---------------------------------------------------------------- walkthrough

type Step = { hot: string[]; wires: string[]; back?: string[]; tags: string[]; cap: string };
const STEPS: Step[] = [
  { hot: ["n-tabs", "n-worker"], wires: ["w-lease"], tags: ["t-lease"], cap: "Every list, board column and search is a <b>named query</b>. The page asks the Worker for a lease: the Worker checks the arguments, builds the query (embedding it, for a semantic search) and signs it with an HMAC. Nobody can send a query that scans 100 GB." },
  { hot: ["n-tabs", "n-do", "n-views"], wires: ["w-socket"], tags: [], cap: "The tab opens a WebSocket to <b>one Durable Object</b> and subscribes with its leases. The object keeps every open view as a window of keys, so it knows exactly who is looking at what." },
  { hot: ["n-ram", "n-sqlite"], wires: ["w-ram-sql"], tags: ["t-ram"], cap: "The engine (Rust compiled to WebAssembly) reads 64 KB B+tree pages from its <b>40 MiB of RAM</b>, then from the object's own <b>SQLite</b>, synchronously. Interior pages are pinned, so only leaves are ever missing." },
  { hot: ["n-cache", "n-r2"], wires: ["w-cache", "w-r2"], back: ["w-cache", "w-r2"], tags: ["t-fault"], cap: "A missing page doesn't stall the query: the engine <b>records it and keeps going</b>, collecting every page the query needs, then the object fetches them all at once from the city cache or R2. One round trip, however many leaves." },
  { hot: ["n-writer", "n-overlay"], wires: ["w-write"], tags: ["t-write"], cap: "Writes never touch the base. They land in an <b>overlay</b> of index entries, durable in SQLite when acknowledged; reads merge base ⊕ overlay, and counts stay exact." },
  { hot: ["n-views", "n-tabs"], wires: ["w-push"], tags: ["t-push"], cap: "For each write the engine works out, per open view, which rows <b>enter, leave or change</b>, and pushes just those to every tab. 1,000 tabs at 5 writes a second: median 174 ms, and outgoing messages are free." },
  { hot: ["n-overlay", "n-r2"], wires: ["w-fold"], tags: ["t-fold"], cap: "At 4 MB the overlay <b>folds into a layer</b>: new B+trees uploaded to R2 as 4 MiB parts, swapped in with one SQLite transaction. Writes leave the object's memory; reads see base ⊕ layer ⊕ overlay." },
  { hot: ["n-vec", "n-sqlite"], wires: ["w-vec", "w-ram-sql"], back: ["w-vec"], tags: ["t-vec"], cap: "Vector search uses the same machinery. The <b>14,276 centroids</b> are pinned; a search picks ~180 clusters, fetches their 1-bit pages in one round, scores ~70k stories with popcounts, then reranks the best 100 with 8-bit codes. ~140 ms, all inside the object." },
];
const DWELL = 5200;
let cur = 0, t0 = performance.now(), paused = false;
const lis = [...document.querySelectorAll<HTMLLIElement>("#steps li")];
function show(i: number) {
  cur = (i + STEPS.length) % STEPS.length;
  t0 = performance.now();
  const s = STEPS[cur];
  lis.forEach((li, j) => li.classList.toggle("on", j === cur));
  document.querySelectorAll("#dg g[id^=n-]").forEach((g) => g.classList.toggle("hot", s.hot.includes(g.id)));
  document.querySelectorAll("#dg .wire").forEach((w) => {
    w.classList.toggle("on", s.wires.includes(w.id));
    w.classList.toggle("back", !!s.back?.includes(w.id));
  });
  document.querySelectorAll("#dg .tag").forEach((t) => t.classList.toggle("on", s.tags.includes(t.id)));
  $("#cap").innerHTML = s.cap;
}
lis.forEach((li, i) => li.addEventListener("click", () => show(i)));
const stage = $(".walk");
stage.addEventListener("mouseenter", () => (paused = true));
stage.addEventListener("mouseleave", () => ((paused = false), (t0 = performance.now())));
function tick(now: number) {
  if (paused) t0 = now - Math.min(now - t0, DWELL - 1);
  const p = (now - t0) / DWELL;
  const bar = lis[cur]?.querySelector<HTMLElement>(".bar i");
  if (bar) bar.style.width = `${Math.min(100, p * 100)}%`;
  if (p >= 1) show(cur + 1);
  requestAnimationFrame(tick);
}
show(0);
requestAnimationFrame(tick);

// ---------------------------------------------------------------- videos play when visible

const io = new IntersectionObserver((es) => {
  for (const e of es) {
    const v = e.target as HTMLVideoElement;
    if (e.isIntersecting) {
      v.preload = "auto";
      void v.play().catch(() => {});
    } else v.pause();
  }
}, { threshold: 0.35 });
document.querySelectorAll("video[data-autoplay]").forEach((v) => io.observe(v));
