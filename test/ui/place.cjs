const { chromium } = require("playwright");
const B = (process.env.B || "https://pagedb-preview.do-pool-lab.workers.dev") + "/place";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const open = async () => {
    const p = await ctx.newPage();
    p.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !m.text().includes("willReadFrequently")) errors.push(m.text().slice(0, 160)); });
    p.on("pageerror", (e) => errors.push("pageerror " + e.message));
    p.on("websocket", (ws) => ws.on("framereceived", (f) => { if (String(f.payload).includes('"t":"error"')) errors.push("ws " + String(f.payload).slice(0, 160)); }));
    const t0 = Date.now();
    await p.goto(B);
    await p.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("canvas"), null, { timeout: 60000 });
    return { p, ms: Date.now() - t0 };
  };
  const { p, ms } = await open();
  console.log("canvas loaded in", ms, "ms |", await p.locator("#status").textContent());
  // click a pixel in the middle of the stage
  const box = await p.locator("#stage").boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForFunction(() => !document.querySelector(".hist")?.textContent?.includes("Loading"), null, { timeout: 20000 });
  console.log("pixel:", (await p.locator("#pixel h3").textContent()), "|", (await p.locator("#pixel h4").textContent()).replace(/\s+/g, " "));
  const firstUser = await p.locator(".hist a").first().textContent().catch(() => null);
  if (firstUser) {
    await p.locator(".hist a").first().click();
    await p.waitForFunction(() => document.querySelector("#user p")?.textContent?.includes("pixels placed"), null, { timeout: 20000 }).catch(() => {});
    console.log("user:", (await p.locator("#user").textContent()).replace(/\s+/g, " "));
  }
  // second tab sees a paint
  const { p: p2 } = await open();
  await p2.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const sel = await p.locator("#pixel h3").textContent();
  const [x, y] = sel.match(/(\d+), (\d+)/).slice(1).map(Number);
  const pix = (pg) => pg.evaluate(([x, y]) => [...document.querySelector("#cv").getContext("2d").getImageData(x, y, 1, 1).data].slice(0, 3).join(","), [x, y]);
  const before = await pix(p2);
  // A colour different from the pixel's current one (earlier runs may have painted it already).
  const pick = before === "109,0,26" ? 27 : 12;
  await p.locator(`.palette button[data-c="${pick}"]`).click();
  const t0 = Date.now();
  await p.locator("[data-paint]").click();
  await p2.waitForFunction(([x, y, b]) => [...document.querySelector("#cv").getContext("2d").getImageData(x, y, 1, 1).data].slice(0, 3).join(",") !== b, [x, y, before], { timeout: 10000 }).then(() => console.log("paint reached other tab in", Date.now() - t0, "ms:", before, "→"), () => console.log("paint NOT seen in other tab"));
  console.log("   now", await pix(p2), "| feed:", (await p2.locator("#feed").textContent()).trim().slice(0, 80));
  // timelapse
  await p.locator("#slider").evaluate((s) => { s.value = "0"; s.dispatchEvent(new Event("input")); });
  await p.waitForTimeout(3000);
  console.log("timelapse:", await p.locator("#when").textContent());
  await p.screenshot({ path: require("path").join(require("os").tmpdir(), "pagedb-" + require("path").basename(__filename, ".cjs") + ".png") });
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
