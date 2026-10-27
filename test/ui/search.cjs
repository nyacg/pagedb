const { chromium } = require("playwright");
const B = process.env.B || "https://pagedb-preview.do-pool-lab.workers.dev";
const TOKEN = require("fs").readFileSync(".env", "utf8").match(/ADMIN_TOKEN=(\S+)/)[1];
const eq = (c, v) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const p = await ctx.newPage();
  if (process.env.LOCAL) await p.route("**/app.js*", (r) => r.fulfill({ contentType: "text/javascript", body: require("fs").readFileSync("/Users/robertchandler/conductor/repos/pagedb/web/public/app.js", "utf8") }));
  const errors = [];
  p.on("websocket", (ws) => ws.on("framereceived", (f) => { if (String(f.payload).includes('"t":"error"')) errors.push(String(f.payload).slice(0, 200)); }));
  await p.goto(B + `/tracker?project=${process.env.P || "p0003"}`);
  await p.waitForFunction(() => window.__pagedb && window.__pagedb.listRows().length >= 50, null, { timeout: 30000 });
  const listReady = async () => {
    const t0 = Date.now();
    await p.waitForFunction(() => { const l = window.__pagedb.subs().find((s) => s.id === "list:0"); return l && l.ready; }, null, { timeout: 30000, polling: 50 });
    return { wait: Date.now() - t0, ...(await p.evaluate(() => window.__pagedb.subs().find((s) => s.id === "list:0"))) };
  };
  const add = async (text) => { await p.click("[data-search]"); await p.keyboard.type(text); await p.keyboard.press("Enter"); await p.waitForTimeout(50); return listReady(); };
  for (const [text, check] of [
    ["priority:high", (r) => r.priority === "high"],
    ["tag:bug", (r) => r.tags.includes("bug")],
    ["comment:retry", null],
    ["status:todo", (r) => r.status === "todo"],
  ]) {
    const st = await add(text);
    const rows = await p.evaluate(() => window.__pagedb.listRows());
    console.log(`+ ${text}: ${rows.length} rows; server ${Math.round(st.ms)} ms, ${st.rounds} rounds; ok: ${check ? rows.every(check) : "see below"}`);
  }
  const rows = await p.evaluate(() => window.__pagedb.listRows());
  for (const x of rows.slice(0, 4)) {
    const res = await fetch(`${B}/api/query`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ db: "db100g", obj: "demo100g", ast: { table: "comment", where: eq("issueId", x.id), orderBy: [["createdAt", "asc"], ["id", "asc"]], limit: 200 } }) }).then((r) => r.json());
    console.log("  ", x.id, x.priority, x.status, x.tags.join(","), "| comment has 'retry':", res.result.rows.some((c) => /retry/i.test(c.body)));
  }
  console.log("chips:", (await p.locator(".tok").allInnerTexts()).map((x) => x.replace(/\s+/g, " ")).join(" | "));
  await p.screenshot({ path: require("path").join(require("os").tmpdir(), "pagedb-" + require("path").basename(__filename, ".cjs") + ".png") });
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
