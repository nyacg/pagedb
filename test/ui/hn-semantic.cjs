// Hacker News semantic search: results by meaning, filters, and a live arrival (a story a
// visitor submits shows up in another tab's semantic results, embedded on write).
//   B=https://pagedb-vec.do-pool-lab.workers.dev node test/ui/hn-semantic.cjs [screenshot dir]
const { chromium } = require("playwright");
const B = process.env.B || "https://pagedb-vec.do-pool-lab.workers.dev";
const shots = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  const watch = (p, tag) => {
    p.on("console", (m) => { if (m.type() === "error") errors.push(`${tag} console: ${m.text()}`); });
    p.on("websocket", (ws) => ws.on("framereceived", (f) => { if (String(f.payload).includes('"t":"error"')) errors.push(`${tag} ws: ${String(f.payload).slice(0, 200)}`); }));
  };
  const q = "burnout as a solo founder";
  const a = await ctx.newPage();
  watch(a, "A");
  const t0 = Date.now();
  await a.goto(`${B}/hn?p=semantic&q=${encodeURIComponent(q)}`);
  await a.waitForSelector("tr.athing", { timeout: 20000 });
  const titles = await a.locator("td.titleline > a").allTextContents();
  console.log(`A: ${titles.length} results in ${Date.now() - t0} ms; top: ${titles.slice(0, 3).join(" | ")}`);
  console.log("stats:", (await a.locator(".semstats").textContent().catch(() => "")) || "(server-rendered)");
  if (shots) await a.screenshot({ path: `${shots}/hn-semantic.png`, fullPage: false });

  // Filters: past year + Ask HN (signed into the lease; results all Ask HN).
  const f = await ctx.newPage();
  watch(f, "F");
  await f.goto(`${B}/hn?p=semantic&q=${encodeURIComponent("how do I find a cofounder")}&kind=ask`);
  await f.waitForSelector("tr.athing", { timeout: 20000 });
  const asks = await f.locator("td.titleline > a").allTextContents();
  console.log(`F (kind=ask): ${asks.length} results, all Ask: ${asks.every((t) => /^ask/i.test(t))}; top: ${asks[0]}`);

  // Live: another tab submits a related story; A's results gain it without a reload.
  const b = await ctx.newPage();
  watch(b, "B");
  await b.goto(`${B}/hn?p=submit`);
  const title = `Show HN: What helped me recover from founder burnout (${Date.now().toString(36)})`;
  await b.fill('[data-submit] input[name="title"]', title);
  await b.fill('[data-submit] textarea[name="text"]', "I ran my company alone for three years and burned out. Notes on sleep, saying no, and finding peers.");
  const t1 = Date.now();
  await b.click("[data-submit] button");
  const seen = await a
    .waitForFunction((t) => [...document.querySelectorAll("td.titleline > a")].some((e) => e.textContent === t), title, { timeout: 20000 })
    .then(() => Date.now() - t1, () => "NOT SEEN");
  const rank = await a.evaluate((t) => [...document.querySelectorAll("td.titleline > a")].findIndex((e) => e.textContent === t), title);
  console.log(`A sees the submitted story after ${seen} ms, at rank ${rank + 1}`);
  if (shots && seen !== "NOT SEEN") await a.screenshot({ path: `${shots}/hn-semantic-live.png`, fullPage: false });
  console.log(errors.length ? `errors:\n${errors.join("\n")}` : "no errors");
  await browser.close();
})();
