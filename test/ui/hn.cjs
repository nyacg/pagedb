const { chromium } = require("playwright");
const B = (process.env.B || "https://pagedb-preview.do-pool-lab.workers.dev") + "/hn";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  const open = async (q) => {
    const p = await ctx.newPage();
    p.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(`${q} ${m.text().slice(0, 160)}`); });
    p.on("pageerror", (e) => errors.push(`${q} pageerror ${e.message} @ ${(e.stack || "").split("\n").slice(1, 9).join(" <- ")}`));
    p.on("websocket", (ws) => ws.on("framereceived", (f) => { if (String(f.payload).includes('"t":"error"')) errors.push(`${q} ws ${String(f.payload).slice(0, 160)}`); }));
    const t0 = Date.now();
    await p.goto(`${B}?${q}`);
    await p.waitForFunction(() => !document.querySelector("#main")?.textContent?.includes("Loading"), null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(600);
    return { p, ms: Date.now() - t0 };
  };
  for (const q of ["p=news", "p=newest", "p=best", "p=comments", "p=ask", "p=user&id=dang", "p=search&q=rust+async", "p=from&site=github.com"]) {
    const { p, ms } = await open(q);
    const stories = await p.locator("tr.athing").count();
    const cmts = await p.locator(".cmt").count();
    const first = (await p.locator("td.titleline a, .commtext").first().textContent().catch(() => ""))?.slice(0, 60);
    console.log(`${q.padEnd(24)} ${ms}ms  stories ${stories}  comments ${cmts}  | ${first}  | ${(await p.locator("#foot").textContent()).trim().slice(0, 80)}`);
    await p.close();
  }
  // a thread: the best story
  const best = await open("p=best");
  const itemHref = await best.p.locator("td.subtext a[href*='p=item']").last().getAttribute("href");
  await best.p.close();
  const { p, ms } = await open(itemHref.replace("?", ""));
  console.log(`thread ${itemHref} ${ms}ms: ${await p.locator(".cmt").count()} comments shown | ${(await p.locator(".fatitem .subtext").textContent()).trim()}`);
  // second tab on the same thread to watch a reply arrive live
  const { p: p2 } = await open(itemHref.replace("?", ""));
  const reply = `Testing pagedb's live HN mirror (${Date.now() % 100000}): this reply should show up in the other tab.`;
  await p.locator("form.replyform textarea").first().fill(reply);
  const t0 = Date.now();
  await p.locator("form.replyform button").first().click();
  await p2.waitForFunction((t) => [...document.querySelectorAll(".commtext")].some((e) => e.textContent.includes(t)), reply, { timeout: 10000 }).then(() => console.log("reply reached the other tab in", Date.now() - t0, "ms"), () => console.log("reply NOT seen in other tab"));
  console.log("fresh highlight in other tab:", await p2.locator(".cmt.fresh").count());
  // upvote
  const s0 = await p.locator(".fatitem .score").textContent();
  await p.locator(".fatitem .votearrow").click();
  await p2.waitForFunction((s) => document.querySelector(".fatitem .score")?.textContent !== s, s0, { timeout: 8000 }).then(() => 0, () => 0);
  console.log("score", s0, "→", await p2.locator(".fatitem .score").textContent(), "(other tab)");
  await p.screenshot({ path: require("path").join(require("os").tmpdir(), "pagedb-" + require("path").basename(__filename, ".cjs") + ".png") });
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
