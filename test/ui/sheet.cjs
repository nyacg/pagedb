const { chromium } = require("playwright");
const B = (process.env.B || "https://pagedb-preview.do-pool-lab.workers.dev") + "/sheet";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  const open = async () => {
    const p = await ctx.newPage();
    p.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(m.text().slice(0, 160)); });
    p.on("pageerror", (e) => errors.push("pageerror " + e.message));
    p.on("websocket", (ws) => ws.on("framereceived", (f) => { if (String(f.payload).includes('"t":"error"')) errors.push("ws " + String(f.payload).slice(0, 200)); }));
    const t0 = Date.now();
    await p.goto(B);
    await p.waitForSelector(".row:not(.loading)");
    return { p, ms: Date.now() - t0 };
  };
  const firstRow = (p) => p.locator(".row:not(.loading)").first().evaluate((r) => [...r.children].map((c) => c.textContent).join(" | "));
  const waitRows = (p) => p.waitForFunction(() => document.querySelectorAll(".row.loading").length === 0 && document.querySelectorAll(".row").length > 5, null, { timeout: 30000 });
  const { p, ms } = await open();
  console.log("first paint", ms, "ms |", await firstRow(p));
  console.log("footer:", (await p.locator("#foot").textContent()).trim());
  // jump to a deep row
  await p.fill("#jump", "1500000"); await p.press("#jump", "Enter");
  let t0 = Date.now(); await p.waitForTimeout(200); await waitRows(p);
  console.log("jump to 1,500,000:", Date.now() - t0, "ms |", (await firstRow(p)).slice(0, 80));
  // sort by tip desc
  await p.click('[data-sort="tip"]'); t0 = Date.now(); await p.waitForTimeout(100); await waitRows(p);
  const tips = await p.locator(".row:not(.loading)").evaluateAll((rs) => rs.slice(0, 8).map((r) => r.children[10].textContent));
  console.log("sort tip desc:", Date.now() - t0, "ms |", tips.join(" "));
  await p.click('[data-sort="tip"]'); await p.waitForTimeout(100); await waitRows(p);
  console.log("sort tip asc:", (await p.locator(".row:not(.loading)").evaluateAll((rs) => rs.slice(0, 5).map((r) => r.children[10].textContent))).join(" "));
  // group counts + filter
  await p.waitForFunction(() => ![...document.querySelectorAll(".g b")].some((b) => b.textContent === "…"), null, { timeout: 20000 });
  console.log("groups:", (await p.locator(".g").evaluateAll((gs) => gs.slice(0, 6).map((g) => g.textContent.replace(/\s+/g, " ")))).join(" / "));
  await p.click('[data-group="payment"][data-v="2"]'); await p.waitForTimeout(100); await waitRows(p);
  console.log("filter cash:", (await p.locator(".row:not(.loading)").evaluateAll((rs) => [...new Set(rs.map((r) => r.children[8].textContent))])).join(","), "|", (await p.locator("#foot").textContent()).trim());
  await p.click('[data-group="payment"][data-v="2"]'); await p.waitForTimeout(100); await waitRows(p);
  // edit a note; a second tab sees it
  const { p: p2 } = await open();
  const id = await p.locator(".row:not(.loading) [data-cell=note]").first().getAttribute("data-id");
  await p.locator(`[data-cell=note][data-id="${id}"]`).dblclick();
  const note = `edited live ${Date.now() % 100000}`;
  await p.fill("input[data-edit]", note);
  t0 = Date.now(); await p.press("input[data-edit]", "Enter");
  await p2.waitForFunction(([id, note]) => document.querySelector(`[data-cell=note][data-id="${id}"]`)?.textContent === note, [id, note], { timeout: 10000 }).then(() => console.log("note reached other tab in", Date.now() - t0, "ms"), () => console.log("note NOT seen"));
  // tip edit
  await p.locator(`[data-cell=tip][data-id="${id}"]`).dblclick();
  const tip = (1 + Math.floor(Math.random() * 9000) / 100).toFixed(2);
  await p.fill("input[data-edit]", tip);
  t0 = Date.now(); await p.press("input[data-edit]", "Enter");
  await p2.waitForFunction(([id, tip]) => document.querySelector(`[data-cell=tip][data-id="${id}"]`)?.textContent === `$${tip}`, [id, tip], { timeout: 10000 }).then(() => console.log("tip reached other tab in", Date.now() - t0, "ms"), () => console.log("tip NOT seen"));
  await p.screenshot({ path: require("path").join(require("os").tmpdir(), "pagedb-" + require("path").basename(__filename, ".cjs") + ".png") });
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
