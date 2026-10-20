/**
 * 146M NYC taxi trips as a live spreadsheet: every page of rows is a live query at an offset
 * (row N is found from the B+tree's counts), sorts are indexes, group counts are O(tree height),
 * and cell edits reach everyone.
 */
import { Sync, type Row } from "../sync";

declare global {
  interface Window {
    __BOOT?: { rows?: { rows: Row[] }; count?: number; zones?: { rows: Row[] }; leases?: any[]; build?: string; ms?: number; base?: { bytes: number } };
  }
}
const boot = window.__BOOT ?? {};
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ROW_H = 26;
const PAGE = 100;
const MAX_PX = 12_000_000; // browsers cap element heights; past this the scrollbar is proportional
const PAYMENT: Record<number, string> = { 0: "—", 1: "Card", 2: "Cash", 3: "No charge", 4: "Dispute", 5: "Unknown", 6: "Voided" };
const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "EWR", "Unknown"];
const zones = new Map<string, Row>((boot.zones?.rows ?? []).map((z) => [String(z.id), z]));

let me = localStorage.getItem("pagedb.sheet.user");
if (!me || !/^[a-z0-9-]{3,20}$/.test(me)) {
  me = `guest-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("pagedb.sheet.user", me);
}
const sync = new Sync(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/socket?app=taxi`, boot.leases ?? [], "taxi");
sync.build = boot.build;
sync.onStale = () => {
  if (Date.now() - Number(sessionStorage.getItem("pagedb-reloaded") ?? 0) < 60_000) return;
  sessionStorage.setItem("pagedb-reloaded", String(Date.now()));
  location.reload();
};

// ---------------------------------------------------------------- state

type Sort = "pickup" | "total" | "tip" | "distance" | "duration";
const state = {
  sort: "pickup" as Sort,
  dir: "asc" as "asc" | "desc",
  filter: null as null | { key: "payment" | "borough" | "passengers"; value: number | string },
  top: 0,
  editing: null as null | { id: string; col: "note" | "tip" },
};
const filterArgs = () => (state.filter ? { [state.filter.key]: state.filter.value } : {});
const viewKey = () => `${state.sort}:${state.dir}:${state.filter ? `${state.filter.key}=${state.filter.value}` : ""}`;
const total = () => sync.count("n") ?? (state.filter ? undefined : boot.count) ?? 0;

const COLS: { key: string; label: string; w: number; sort?: Sort; fmt: (r: Row) => string; edit?: "note" | "tip" }[] = [
  { key: "id", label: "Trip", w: 92, fmt: (r) => r.id },
  { key: "pickup", label: "Pickup", w: 150, sort: "pickup", fmt: (r) => new Date(r.pickup).toISOString().slice(0, 19).replace("T", " ") },
  { key: "duration", label: "Duration", w: 78, sort: "duration", fmt: (r) => `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, "0")}` },
  { key: "passengers", label: "Pax", w: 44, fmt: (r) => r.passengers ?? "" },
  { key: "distance", label: "Miles", w: 66, sort: "distance", fmt: (r) => (r.distance ?? 0).toFixed(2) },
  { key: "pu", label: "From", w: 170, fmt: (r) => zones.get(String(r.pu))?.zone ?? r.pu },
  { key: "do", label: "To", w: 170, fmt: (r) => zones.get(String(r.do))?.zone ?? r.do },
  { key: "payment", label: "Payment", w: 80, fmt: (r) => PAYMENT[r.payment] ?? r.payment },
  { key: "fare", label: "Fare", w: 70, fmt: (r) => `$${(r.fare ?? 0).toFixed(2)}` },
  { key: "tip", label: "Tip", w: 70, sort: "tip", edit: "tip", fmt: (r) => `$${(r.tip ?? 0).toFixed(2)}` },
  { key: "total", label: "Total", w: 80, sort: "total", fmt: (r) => `$${(r.total ?? 0).toFixed(2)}` },
  { key: "note", label: "Note (editable)", w: 220, edit: "note", fmt: (r) => r.note ?? "" },
];
const template = `56px ${COLS.map((c) => `${c.w}px`).join(" ")}`;

// ---------------------------------------------------------------- data: pages of rows at offsets

function pageRef(i: number) {
  return { name: "rows", args: { sort: state.sort, dir: state.dir, ...filterArgs(), offset: i * PAGE, limit: PAGE } };
}
function subscribe() {
  const first = Math.floor(state.top / PAGE);
  const want = new Set([first, first + 1].filter((i) => i * PAGE < Math.max(total(), PAGE)).map((i) => `p:${viewKey()}:${i}`));
  for (const s of sync.all()) if (s.id.startsWith("p:") && !want.has(s.id)) sync.unsub(s.id);
  const seed = boot.rows && viewKey() === "pickup:asc:" ? { rows: boot.rows.rows } : undefined;
  for (const id of want) {
    const i = Number(id.split(":").pop());
    sync.sub(id, pageRef(i), i === 0 ? seed : undefined);
  }
  sync.sub("n", { name: "count", args: filterArgs() }, !state.filter && boot.count !== undefined ? { count: boot.count } : undefined);
}

const cmp = (a: Row, b: Row) => {
  const d = state.dir === "desc" ? -1 : 1;
  if (state.sort === "pickup") return (a.id < b.id ? -1 : 1) * d;
  const x = a[state.sort] - b[state.sort];
  return x ? x * d : (a.id < b.id ? -1 : 1) * -d;
};
function rowAt(n: number): Row | undefined {
  const i = Math.floor(n / PAGE);
  const rows = sync.view(`p:${viewKey()}:${i}`).sort(cmp);
  return rows[n - i * PAGE];
}

// ---------------------------------------------------------------- the grid

const grid = $("#grid");
const spacer = $("#spacer");
const body = $("#rows");
function visible() {
  return Math.ceil(grid.clientHeight / ROW_H) + 1;
}
function syncScroll() {
  const n = total();
  const h = Math.min(n * ROW_H, MAX_PX);
  spacer.style.height = `${h + ROW_H}px`;
  const span = Math.max(1, h - grid.clientHeight);
  const rows = Math.max(0, n - visible() + 1);
  state.top = n * ROW_H <= MAX_PX ? Math.floor(grid.scrollTop / ROW_H) : Math.round((Math.min(grid.scrollTop, span) / span) * rows);
}
function scrollToRow(n: number) {
  const t = total();
  const h = Math.min(t * ROW_H, MAX_PX);
  const span = Math.max(1, h - grid.clientHeight);
  grid.scrollTop = t * ROW_H <= MAX_PX ? n * ROW_H : (n / Math.max(1, t - visible() + 1)) * span;
}

function header() {
  return `<div class="hrow" style="grid-template-columns:${template}"><div class="num">#</div>${COLS.map(
    (c) => `<div class="${c.sort ? "sortable" : ""}${c.sort === state.sort ? " on" : ""}" ${c.sort ? `data-sort="${c.sort}"` : ""}>${c.label}${c.sort === state.sort ? (state.dir === "desc" ? " ↓" : " ↑") : ""}</div>`,
  ).join("")}</div>`;
}

function rowsHtml() {
  const out: string[] = [];
  const n = total();
  for (let k = 0; k < visible() && state.top + k < n; k++) {
    const i = state.top + k;
    const r = rowAt(i);
    if (!r) {
      out.push(`<div class="row loading" style="grid-template-columns:${template}"><div class="num">${(i + 1).toLocaleString()}</div><div class="skel"></div></div>`);
      continue;
    }
    out.push(
      `<div class="row${sync.pendingOps().some((p) => p.patch?.id === r.id) ? " pend" : ""}" style="grid-template-columns:${template}"><div class="num">${(i + 1).toLocaleString()}</div>${COLS.map((c) => {
        if (c.edit && state.editing?.id === r.id && state.editing?.col === c.edit)
          return `<div class="cell editing"><input data-edit="${c.edit}" data-id="${r.id}" value="${esc(c.edit === "tip" ? (r.tip ?? 0).toFixed(2) : (r.note ?? ""))}" maxlength="200"></div>`;
        return `<div class="cell${c.edit ? " editable" : ""}${c.key === "note" && r.note ? " noted" : ""}" ${c.edit ? `data-cell="${c.edit}" data-id="${r.id}"` : ""}>${esc(c.fmt(r))}</div>`;
      }).join("")}</div>`,
    );
  }
  return out.join("");
}

function sidebar() {
  const group = (key: "payment" | "borough" | "passengers", values: (number | string)[], label: (v: any) => string) =>
    values
      .map((v) => {
        const n = sync.count(`g:${key}:${v}`);
        const on = state.filter?.key === key && state.filter.value === v;
        return `<button class="g${on ? " on" : ""}" data-group="${key}" data-v="${v}"><span>${esc(label(v))}</span><b>${n === undefined ? "…" : n.toLocaleString()}</b></button>`;
      })
      .join("");
  return `<h4>Payment</h4>${group("payment", [1, 2, 3, 4], (v) => PAYMENT[v])}<h4>Pickup borough</h4>${group("borough", BOROUGHS.slice(0, 6), (v) => v)}
    <h4>Passengers</h4>${group("passengers", [1, 2, 3, 4, 5, 6], (v) => `${v} passenger${v === 1 ? "" : "s"}`)}
    <p class="t">Each count is a live query answered from the B+tree's branch counts: no rows are read.</p>`;
}
for (const [key, values] of [["payment", [1, 2, 3, 4]], ["borough", BOROUGHS.slice(0, 6)], ["passengers", [1, 2, 3, 4, 5, 6]]] as const)
  for (const v of values) sync.sub(`g:${key}:${v}`, { name: "count", args: { [key]: v } });

function footer() {
  const page = sync.get(`p:${viewKey()}:${Math.floor(state.top / PAGE)}`);
  const st = page?.stats;
  const where = st ? (st.r2Gets ? "from R2" : st.cacheHits ? "from the city cache" : "resident") : "";
  return `<span class="dot ${sync.state}">●</span> ${sync.state} · rows ${(state.top + 1).toLocaleString()}–${Math.min(total(), state.top + visible()).toLocaleString()} of ${total().toLocaleString()}${page?.firstMs !== undefined ? ` · this page: ${Math.round(page.firstMs)} ms ${where}` : ""}`;
}

const shown = new Map<string, string>();
function put(sel: string, html: string) {
  if (shown.get(sel) === html) return;
  shown.set(sel, html);
  $(sel).innerHTML = html;
}
function render() {
  syncScroll();
  body.style.transform = `translateY(${grid.scrollTop}px)`;
  put("#head", header());
  const active = document.activeElement as HTMLInputElement | null;
  const typing = active?.matches("input[data-edit]") ? { value: active.value, a: active.selectionStart } : null;
  put("#rows", rowsHtml());
  if (typing) {
    const el = document.querySelector("input[data-edit]") as HTMLInputElement | null;
    if (el && el !== active) {
      el.value = typing.value;
      el.focus();
      el.setSelectionRange(typing.a, typing.a);
    }
  }
  put("#side", sidebar());
  put("#foot", footer());
  $("#total").textContent = (boot.count ?? 0).toLocaleString();
  $("#view").textContent = state.filter ? `${state.filter.key} = ${state.filter.key === "payment" ? PAYMENT[state.filter.value as number] : state.filter.value}` : "all trips";
}

let pending: ReturnType<typeof setTimeout> | null = null;
grid.addEventListener("scroll", () => {
  render();
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    subscribe();
    render();
  }, 60);
});
window.addEventListener("resize", render);
sync.onChange(render);

// ---------------------------------------------------------------- actions

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const s = t.closest("[data-sort]") as HTMLElement | null;
  if (s) {
    const sort = s.dataset.sort as Sort;
    state.dir = state.sort === sort ? (state.dir === "desc" ? "asc" : "desc") : sort === "pickup" ? "asc" : "desc";
    state.sort = sort;
    if (sort !== "pickup") state.filter = null;
    grid.scrollTop = 0;
    subscribe();
    return render();
  }
  const g = t.closest("[data-group]") as HTMLElement | null;
  if (g) {
    const key = g.dataset.group as "payment" | "borough" | "passengers";
    const value = key === "borough" ? g.dataset.v! : Number(g.dataset.v);
    state.filter = state.filter?.key === key && state.filter.value === value ? null : { key, value };
    state.sort = "pickup";
    state.dir = "asc";
    grid.scrollTop = 0;
    subscribe();
    return render();
  }
});

document.addEventListener("dblclick", (e) => {
  const c = (e.target as HTMLElement).closest("[data-cell]") as HTMLElement | null;
  if (!c) return;
  state.editing = { id: c.dataset.id!, col: c.dataset.cell as "note" | "tip" };
  render();
  (document.querySelector("input[data-edit]") as HTMLInputElement | null)?.select();
});

async function commit(input: HTMLInputElement) {
  const id = input.dataset.id!;
  const col = input.dataset.edit as "note" | "tip";
  state.editing = null;
  const row = sync.findRow(id);
  try {
    if (col === "note") await sync.mutate("edit", { id, note: input.value }, { patch: { id, set: { note: input.value.trim() || null } } }, me!);
    else {
      const tip = Math.round(Number(input.value) * 100) / 100;
      if (!Number.isFinite(tip) || tip < 0) throw new Error("a tip is a number");
      const d = Math.round((tip - (row?.tip ?? 0)) * 100) / 100;
      if (d) await sync.mutate("edit", { id, tipDelta: d }, { patch: { id, set: { tip, total: Math.round(((row?.total ?? 0) + d) * 100) / 100 } } }, me!);
    }
  } catch (err) {
    alert(String((err as Error).message));
  }
  render();
}
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.matches("input[data-edit]")) {
    if (e.key === "Enter") commit(t);
    if (e.key === "Escape") {
      state.editing = null;
      render();
    }
  }
  if (t.matches("#jump") && e.key === "Enter") {
    const n = Number(t.value.replace(/[^0-9]/g, ""));
    if (n >= 1) {
      scrollToRow(Math.min(n, total()) - 1);
      t.blur();
    }
  }
});
document.addEventListener("focusout", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.matches?.("input[data-edit]") && state.editing) commit(t);
});

$("#me").textContent = me;
if (boot.base?.bytes) $("#size").textContent = `${(boot.base.bytes / 1e9).toFixed(1)} GB`;
subscribe();
render();
