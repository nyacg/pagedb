const { chromium } = require("playwright");
const B = process.env.B || "https://pagedb.do-pool-lab.workers.dev";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const frames = [];
  const open = async (tag) => {
    const p = await ctx.newPage();
    if (process.env.LOCAL) await p.route("**/app.js*", (r) => r.fulfill({ contentType: "text/javascript", body: require("fs").readFileSync("/Users/robertchandler/conductor/repos/pagedb/web/public/app.js", "utf8") }));
    p.on("websocket", (ws) => { ws.on("framereceived", (f) => frames.push(`${tag} < ${String(f.payload).slice(0, 300)}`)); ws.on("framesent", (f) => frames.push(`${tag} > ${String(f.payload).slice(0, 100)}`)); });
    await p.goto(B + "/tracker?project=p0003");
    await p.waitForFunction(() => window.__pagedb && window.__pagedb.listRows().length >= 50);
    return p;
  };
  const a = await open("A"), b = await open("B");
  for (let i = 0; i < 5; i++) { await b.mouse.move(600, 500); await b.mouse.wheel(0, 4000); await b.waitForTimeout(500); }
  await b.waitForTimeout(1500);
  console.log("B pages", await b.evaluate(() => window.__pagedb.pages()), "rows", await b.evaluate(() => window.__pagedb.listRows().length));
  const c = await open("C");
  await c.click('[data-view="board"]'); await c.waitForTimeout(2000);
  const top = await b.evaluate(() => window.__pagedb.listRows().slice(0, 2).map((r) => [r.id, r.createdAt, new Date(r.createdAt).toISOString()]));
  console.log("B top rows", top, "now", new Date().toISOString());
  frames.length = 0;
  const title = `create check ${Date.now().toString(36)}`;
  // through the UI in A
  await a.click("[data-new]");
  await a.fill('[data-create] input[name="title"]', title);
  await a.click('[data-create] button.primary');
  const t0 = Date.now();
  const seen = await b.waitForFunction((t) => window.__pagedb.listRows().some((r) => r.title === t), title, { timeout: 8000 }).then(() => Date.now() - t0, () => "NOT SEEN");
  const onBoard = await c.waitForFunction((t) => [...document.querySelectorAll(".card")].some((e) => e.textContent.includes(t)), title, { timeout: 5000 }).then(() => "yes", () => "NO");
  console.log("C board shows it:", onBoard);
  console.log("A sees own:", await a.evaluate((t) => window.__pagedb.listRows().findIndex((r) => r.title === t), title), " B:", seen);
  console.log(frames.filter((f) => !f.includes("\"count\"") || true).map((f) => f.slice(0, 160)).join("\n"));
  const id = await a.evaluate((t) => window.__pagedb.listRows().find((r) => r.title === t)?.id, title);
  if (id) console.log("delete", await a.evaluate((id) => fetch("/api/mutate", { method: "POST", body: JSON.stringify({ name: "deleteIssue", args: { id } }) }).then((r) => r.status), id));
  await browser.close();
})();
