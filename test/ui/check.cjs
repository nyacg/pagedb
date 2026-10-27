const { chromium } = require("playwright");
const B = process.env.B || "https://pagedb.do-pool-lab.workers.dev";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  const watch = (p, tag) => {
    p.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(`${tag} console: ${m.text()}`); });
    p.on("websocket", (ws) => ws.on("framereceived", (f) => { if (String(f.payload).includes('"t":"error"')) errors.push(`${tag} ws: ${String(f.payload).slice(0, 200)}`); }));
  };
  const a = await ctx.newPage(); watch(a, "A");
  let leaseCalls = 0; a.on("request", (r) => { if (r.url().endsWith("/api/lease")) leaseCalls++; });
  await a.goto(B + "/tracker?project=p0003");
  await a.waitForFunction(() => window.__pagedb && window.__pagedb.listRows().length >= 50, null, { timeout: 15000 });
  console.log("list rows", await a.evaluate(() => window.__pagedb.listRows().length), "lease calls after boot", leaseCalls);
  // infinite scroll
  for (let i = 0; i < 6; i++) { await a.mouse.move(600, 500); await a.mouse.wheel(0, 4000); await a.waitForTimeout(400); }
  await a.waitForTimeout(1500);
  console.log("after scroll rows", await a.evaluate(() => window.__pagedb.listRows().length), "pages", await a.evaluate(() => window.__pagedb.pages().length ?? window.__pagedb.pages.length).catch(() => "?"));
  // filter (search box: status:todo chip, then a title word)
  await a.click("[data-search]"); await a.keyboard.type("status:todo"); await a.keyboard.press("Enter");
  await a.waitForTimeout(1500);
  const sts = await a.evaluate(() => [...new Set(window.__pagedb.listRows().map((r) => r.status))]);
  console.log("filter todo statuses", sts, "rows", await a.evaluate(() => window.__pagedb.listRows().length));
  await a.keyboard.press("Backspace");
  await a.keyboard.type("sidebar"); await a.waitForTimeout(1500);
  console.log("search 'sidebar' rows", await a.evaluate(() => window.__pagedb.listRows().length), "all match", await a.evaluate(() => window.__pagedb.listRows().every((r) => /sidebar/i.test(r.title))));
  await a.fill("[data-search]", ""); await a.keyboard.press("Escape"); await a.waitForTimeout(800);
  // assignee picker
  await a.click("[data-search]"); await a.keyboard.type("owner:a"); await a.waitForTimeout(1500);
  console.log("owner suggestions", await a.locator(".sp button").count());
  await a.fill("[data-search]", ""); await a.keyboard.press("Escape"); await a.waitForTimeout(300);
  // detail
  await a.locator(".row[data-open] .title").nth(1).click(); await a.waitForTimeout(1500);
  console.log("detail comments", await a.locator(".cm").count());
  await a.locator("[data-close]").first().click().catch(() => {});
  // board
  await a.click('[data-view="board"]'); await a.waitForTimeout(2000);
  console.log("board cards", await a.locator(".card").count(), "col counts", await a.locator(".col-h .n").allTextContents());
  // activity
  await a.click('[data-view="activity"]'); await a.waitForTimeout(2000);
  console.log("feed items", await a.locator(".fi").count());
  // two tabs: edit in A (via the mutate API), see it in B
  const b = await ctx.newPage(); watch(b, "B");
  await b.goto(B + "/tracker?project=p0003");
  await b.waitForFunction(() => window.__pagedb && window.__pagedb.listRows().length >= 50, null, { timeout: 15000 });
  const row = await b.evaluate(() => window.__pagedb.listRows()[3]);
  const mark = `lease check ${Date.now().toString(36)}`;
  const t0 = Date.now();
  await a.evaluate(async ([id, title]) => fetch("/api/mutate", { method: "POST", body: JSON.stringify({ name: "editTitle", args: { id, title } }) }).then((r) => r.status), [row.id, mark]);
  await b.waitForFunction(([id, t]) => window.__pagedb.listRows().some((r) => r.id === id && r.title === t), [row.id, mark], { timeout: 10000 });
  console.log("tab B saw edit in", Date.now() - t0, "ms");
  await a.evaluate(async ([id, title]) => fetch("/api/mutate", { method: "POST", body: JSON.stringify({ name: "editTitle", args: { id, title } }) }).then((r) => r.status), [row.id, row.title]);
  await b.waitForFunction(([id, t]) => window.__pagedb.listRows().some((r) => r.id === id && r.title === t), [row.id, row.title], { timeout: 10000 });
  console.log("reverted; lease calls total", leaseCalls);
  await a.screenshot({ path: require("path").join(require("os").tmpdir(), "pagedb-" + require("path").basename(__filename, ".cjs") + ".png") });
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
