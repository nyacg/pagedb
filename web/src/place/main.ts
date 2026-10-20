/**
 * r/place 2022, live: the canvas as it stood before the whiteout, every pixel's history (all
 * ~160M placements), each user's pixels, a timelapse, and painting with everyone watching.
 */
import { Sync, type Row } from "../sync";

declare global {
  interface Window {
    __BOOT?: { meta?: { rows: Row[] }; leases?: any[]; build?: string; ms?: number; base?: { bytes: number; rows: Record<string, number> } };
  }
}
const boot = window.__BOOT ?? {};
const meta = JSON.parse(boot.meta?.rows?.[0]?.info ?? "{}") as { size: number; tile: number; palette: string[]; start: number; end: number; cut: number; snapEvery: number; snaps: number; placements: number };
const SIZE = meta.size ?? 2000;
const TILE = meta.tile ?? 128;
const PALETTE = meta.palette ?? [];
const RGB = PALETTE.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const charIndex = (ch: number) => (ch >= 97 ? ch - 97 + 26 : ch - 65);

let me = localStorage.getItem("pagedb.place.user");
if (!me || !/^[a-z0-9-]{3,20}$/.test(me)) {
  me = `guest-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("pagedb.place.user", me);
}

const sync = new Sync(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/socket?app=place`, boot.leases ?? [], "place");
sync.build = boot.build;
sync.onStale = () => {
  if (Date.now() - Number(sessionStorage.getItem("pagedb-reloaded") ?? 0) < 60_000) return;
  sessionStorage.setItem("pagedb-reloaded", String(Date.now()));
  location.reload();
};

// ---------------------------------------------------------------- canvas

const cv = $("#cv") as HTMLCanvasElement;
cv.width = SIZE;
cv.height = SIZE;
const ctx = cv.getContext("2d")!;
const live = ctx.createImageData(SIZE, SIZE);
const overlay = $("#ov") as HTMLCanvasElement;
overlay.width = SIZE;
overlay.height = SIZE;
const octx = overlay.getContext("2d")!;
let mode: "live" | "history" = "live";
let loaded = false;
/** Each tile's last update (a tile row includes every paint up to its `t`). */
const tileT = new Map<string, number>();
const applied = new Set<string>();

function setPixel(img: ImageData, pos: number, c: number) {
  const [r, g, b] = RGB[c] ?? [255, 255, 255];
  const o = pos * 4;
  img.data[o] = r;
  img.data[o + 1] = g;
  img.data[o + 2] = b;
  img.data[o + 3] = 255;
}
function drawLive(pos?: number) {
  if (mode !== "live") return;
  if (pos === undefined) ctx.putImageData(live, 0, 0);
  else ctx.putImageData(live, 0, 0, pos % SIZE, Math.floor(pos / SIZE), 1, 1);
}

sync.sub("tiles", { name: "tiles" });
sync.sub("recent", { name: "recent" });

function onTiles() {
  const s = sync.get("tiles");
  if (loaded || !s?.ready) return;
  const t0 = performance.now();
  for (const t of s.rows.values()) {
    const px: string = t.px;
    for (let i = 0; i < px.length; i++) {
      const x = t.tx * TILE + (i % TILE);
      const y = t.ty * TILE + Math.floor(i / TILE);
      if (x < SIZE && y < SIZE) setPixel(live, y * SIZE + x, charIndex(px.charCodeAt(i)));
    }
    tileT.set(t.id, t.t ?? 0);
  }
  loaded = true;
  drawLive();
  // The tiles were a snapshot; from here on, paints arrive through the feed (16 KB tile rows
  // needn't be pushed to everyone on every paint).
  sync.unsub("tiles");
  $("#status").textContent = `canvas: ${s.rows.size} tiles in ${Math.round(s.firstMs ?? 0)} ms (+${Math.round(performance.now() - t0)} ms to draw)`;
}

/** Visitors' paints from the live feed (newest placements), applied once, oldest first, if
 *  newer than their tile (2022's own last placements are the whiteout: never applied). */
function onRecent() {
  if (!loaded) return;
  const rows = sync.view("recent").sort((a, b) => a.t - b.t);
  let n = 0;
  for (const r of rows) {
    const tile = `${Math.floor((r.pos % SIZE) / TILE)}:${Math.floor(Math.floor(r.pos / SIZE) / TILE)}`;
    if (applied.has(r.id) || !r.id.startsWith("u-") || r.t <= (tileT.get(tile) ?? 0)) continue;
    applied.add(r.id);
    setPixel(live, r.pos, r.c);
    drawLive(r.pos);
    n++;
  }
  if (n) feed(rows);
}

function feed(rows: Row[]) {
  const recent = rows.filter((r) => r.id.startsWith("u-")).slice(-8).reverse();
  $("#feed").innerHTML = recent.length
    ? recent.map((r) => `<div><span class="sw" style="background:${PALETTE[r.c]}"></span> ${esc(r.u)} at ${r.pos % SIZE},${Math.floor(r.pos / SIZE)} <span class="t">${ago(r.t)}</span></div>`).join("")
    : `<div class="t">No one has painted yet today. Be the first.</div>`;
}

function ago(t: number) {
  const s = Math.max(1, (Date.now() - t) / 1000);
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toUTCString().slice(5, 22) + " UTC";
}

// ---------------------------------------------------------------- pan, zoom, select

const view = { x: 0, y: 0, z: 1 };
const stage = $("#stage");
const wrap = $("#wrap");
function applyView() {
  wrap.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  if (sel) placeCursor();
}
function fit() {
  const r = stage.getBoundingClientRect();
  view.z = Math.min(r.width, r.height) / SIZE;
  view.x = (r.width - SIZE * view.z) / 2;
  view.y = (r.height - SIZE * view.z) / 2;
  applyView();
}
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  const z = Math.min(40, Math.max(0.2, view.z * Math.exp(-e.deltaY * 0.0015)));
  view.x = mx - ((mx - view.x) * z) / view.z;
  view.y = my - ((my - view.y) * z) / view.z;
  view.z = z;
  applyView();
}, { passive: false });
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
stage.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  view.x = drag.vx + dx;
  view.y = drag.vy + dy;
  applyView();
});
stage.addEventListener("pointerup", (e) => {
  const d = drag;
  drag = null;
  if (d && !d.moved) {
    const r = stage.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - view.x) / view.z);
    const y = Math.floor((e.clientY - r.top - view.y) / view.z);
    if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) select(x, y);
  }
});
window.addEventListener("resize", fit);

let sel: { x: number; y: number } | null = null;
function placeCursor() {
  const c = $("#cursor");
  c.style.display = sel ? "block" : "none";
  if (!sel) return;
  c.style.left = `${view.x + sel.x * view.z}px`;
  c.style.top = `${view.y + sel.y * view.z}px`;
  c.style.width = c.style.height = `${Math.max(view.z, 4)}px`;
}
function select(x: number, y: number) {
  sel = { x, y };
  placeCursor();
  sync.sub("pixel", { name: "pixel", args: { pos: y * SIZE + x } });
  panel();
}

// ---------------------------------------------------------------- the side panel

let color = 27;
let cooldownUntil = 0;
let highlight: string | null = null;

function panel() {
  if (!sel) {
    $("#pixel").innerHTML = `<p class="hint">Click any pixel to see everyone who ever placed it, and to paint it.</p>`;
    return;
  }
  const pos = sel.y * SIZE + sel.x;
  const hist = sync.view("pixel").filter((r) => r.pos === pos).sort((a, b) => b.t - a.t);
  const s = sync.get("pixel");
  const wait = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  $("#pixel").innerHTML = `<h3>Pixel ${sel.x}, ${sel.y}</h3>
    <div class="palette">${PALETTE.map((p, i) => `<button class="${i === color ? "on" : ""}" data-c="${i}" style="background:${p}" title="${p}"></button>`).join("")}</div>
    <button class="primary" data-paint ${wait || mode !== "live" ? "disabled" : ""}>${mode !== "live" ? "Back to live to paint" : wait ? `Wait ${wait}s` : "Place pixel"}</button>
    <h4>History ${s?.ready ? `· ${hist.length}${hist.length >= 50 ? "+" : ""} placements` : ""} ${s?.firstMs !== undefined ? `<span class="t">(${Math.round(s.firstMs)} ms)</span>` : ""}</h4>
    <div class="hist">${hist
      .map((r) => `<div><span class="sw" style="background:${PALETTE[r.c]}"></span><a data-user="${esc(r.u)}" class="${highlight === r.u ? "on" : ""}">${esc(r.u)}</a> <span class="t">${ago(r.t)}</span></div>`)
      .join("") || (s?.ready ? `<div class="t">Never painted.</div>` : `<div class="t">Loading…</div>`)}</div>`;
}

function userPanel() {
  if (!highlight) {
    $("#user").innerHTML = "";
    octx.clearRect(0, 0, SIZE, SIZE);
    return;
  }
  const rows = sync.view("user");
  const n = sync.count("userCount");
  $("#user").innerHTML = `<h3>${esc(highlight)} <a data-unuser class="x">×</a></h3><p>${n !== undefined ? `${n.toLocaleString()} pixels placed` : "Counting…"}${rows.length ? ` · showing the latest ${rows.length}` : ""}</p>`;
  octx.clearRect(0, 0, SIZE, SIZE);
  if (!rows.length) return;
  octx.fillStyle = "rgba(0,0,0,0.55)";
  octx.fillRect(0, 0, SIZE, SIZE);
  for (const r of rows) octx.clearRect(r.pos % SIZE, Math.floor(r.pos / SIZE), 1, 1);
}

document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.c) {
    color = Number(t.dataset.c);
    return panel();
  }
  if (t.closest("[data-paint]") && sel && mode === "live" && Date.now() >= cooldownUntil) {
    const { x, y } = sel;
    const pos = y * SIZE + x;
    setPixel(live, pos, color);
    drawLive(pos);
    cooldownUntil = Date.now() + 5000;
    const tick = setInterval(() => (Date.now() >= cooldownUntil ? (clearInterval(tick), panel()) : panel()), 1000);
    try {
      await sync.mutate("paint", { x, y, c: color }, {}, me!);
    } catch (err) {
      alert(String((err as Error).message));
    }
    return panel();
  }
  if (t.dataset.user) {
    highlight = t.dataset.user;
    sync.sub("user", { name: "user", args: { u: highlight } });
    sync.sub("userCount", { name: "userCount", args: { u: highlight } });
    return userPanel();
  }
  if (t.closest("[data-unuser]")) {
    highlight = null;
    sync.unsub("user");
    sync.unsub("userCount");
    return userPanel();
  }
  if (t.closest("[data-live]")) return toLive();
  if (t.closest("[data-play]")) return play();
});

// ---------------------------------------------------------------- timelapse

const slider = $("#slider") as HTMLInputElement;
slider.max = String(Math.max(0, (meta.snaps ?? 1) - 1));
slider.value = slider.max;
let playing: ReturnType<typeof setTimeout> | null = null;
const images = new Map<string, HTMLImageElement>();

function snapTime(k: number) {
  return meta.start + (k + 1) * meta.snapEvery;
}
function label() {
  $("#when").textContent = mode === "live" ? "live: the final canvas (before the whiteout), plus today's paints" : new Date(snapTime(Number(slider.value))).toUTCString().replace("GMT", "UTC");
}

async function showSnap(k: number) {
  const id = `snap:${k}`;
  sync.sub(id, { name: "snap", args: { k } });
  await new Promise<void>((res) => {
    const check = () => (sync.get(id)?.ready ? res() : setTimeout(check, 30));
    check();
  });
  const rows = sync.view(id);
  await Promise.all(
    rows.map(
      (r) =>
        new Promise<void>((res) => {
          const img = images.get(r.id) ?? new Image();
          images.set(r.id, img);
          img.onload = () => res();
          img.onerror = () => res();
          img.src = `data:image/png;base64,${r.png}`;
        }),
    ),
  );
  if (mode !== "history" || Number(slider.value) !== k) return;
  for (const r of rows) ctx.drawImage(images.get(r.id)!, r.tx * TILE, r.ty * TILE);
  for (const s of sync.all()) if (s.id.startsWith("snap:") && s.id !== id) sync.unsub(s.id);
}

slider.addEventListener("input", () => {
  mode = "history";
  label();
  panel();
  showSnap(Number(slider.value));
});

function toLive() {
  if (playing) clearTimeout(playing);
  playing = null;
  mode = "live";
  slider.value = slider.max;
  drawLive();
  label();
  panel();
}

function play() {
  if (playing) return toLive();
  mode = "history";
  let k = 0;
  const step = async () => {
    slider.value = String(k);
    label();
    await showSnap(k);
    k++;
    playing = k < Number(slider.max) + 1 ? setTimeout(step, 120) : null;
    if (!playing) toLive();
  };
  step();
}

// ---------------------------------------------------------------- go

sync.onChange(() => {
  onTiles();
  onRecent();
  panel();
  userPanel();
  $("#live").className = `dot ${sync.state}`;
});
$("#count").textContent = (boot.base?.rows?.placement ?? meta.placements ?? 0).toLocaleString();
if (boot.base?.bytes) $("#size").textContent = `${(boot.base.bytes / 1e9).toFixed(1)} GB`;
$("#me").textContent = me;
fit();
label();
panel();
