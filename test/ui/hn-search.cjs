const { chromium } = require("playwright");
const B = (process.env.B || "https://pagedb-preview.do-pool-lab.workers.dev") + "/hn";
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(B);
  await p.waitForSelector("tr.athing");
  for (const q of ["rust async", "the postgres", "Show HN sqlite"]) {
    await p.fill("#q", q); await p.press("#q", "Enter");
    await p.waitForURL(/p=search/); await p.waitForFunction(() => !document.querySelector("#main").textContent.includes("Loading"), null, { timeout: 30000 });
    await p.waitForTimeout(300);
    const titles = await p.locator("td.titleline > a").allTextContents();
    console.log(`"${q}" → ${p.url().split("?")[1]} | ${titles.length} results | ${titles.slice(0, 2).join(" || ")} | box: "${await p.inputValue("#q")}"`);
  }
  await p.goto(B); await p.waitForSelector("tr.athing");
  await p.locator("table.items").first().screenshot({ path: require("path").join(require("os").tmpdir(), "pagedb-hn-arrows.png"), clip: undefined });
  console.log("errors:", errors.length ? errors : "none");
  await b.close();
})();
