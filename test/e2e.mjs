/*
 * End-to-end test in a real Chromium with the unpacked extension loaded.
 *
 *   node test/e2e.mjs
 *
 * It serves two fake shops on localhost:
 *   /static   price is in the HTML          -> the fetch path should handle it
 *   /spa      price is painted by JS later, and the page refuses to be
 *             framed (X-Frame-Options + CSP)  -> must use the hidden renderer
 *
 * Then it drives the actual picker with a real mouse, changes the prices, and
 * asserts the extension notices, without ever opening a window or a tab.
 */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../manifest.json", import.meta.url)));
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(got)}` +
    (ok ? "" : ` (expected ${JSON.stringify(want)})`));
};

// ---------------------------------------------------------------- fake shop

let staticPrice = "81,000৳";
let spaPrice = "13,200৳";
let staticStock = "In Stock";
let hidePrice = false;
const hookBodies = [];

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.url.startsWith("/hook") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        hookBodies.push(JSON.parse(body));
      } catch (e) {
        hookBodies.push({ bad: body });
      }
      res.end("ok");
    });
    return;
  }
  if (req.url.startsWith("/static")) {
    res.end(`<!doctype html><html><head><title>Laptop | FakeShop</title></head>
      <body><div id="content"><div class="product" data-product-id="p-77">
      <h1 class="product-name">Test Laptop 15 inch</h1>
      <table class="product-info-table"><tbody><tr>
        <td class="product-info-label">Price</td>
        <td class="product-info-data product-price">${hidePrice ? "" : `<ins id="price">${staticPrice}</ins><del>86,000৳</del>`}</td>
      </tr><tr><td class="product-info-label">Status</td>
        <td class="product-info-data product-status">${staticStock}</td>
      </tr></tbody></table></div></div></body></html>`);
  } else if (req.url.startsWith("/spa")) {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.end(`<!doctype html><html><head><title>Mouse | FakeShop</title></head>
      <body><div id="app"><h1 class="product-name">Test Wireless Mouse</h1>
      <div class="price-box"><span class="now" id="price">loading...</span></div></div>
      <script>
        setTimeout(function(){
          document.getElementById('price').textContent = ${JSON.stringify(spaPrice)};
        }, 1200);
      </script></body></html>`);
  } else {
    res.statusCode = 404;
    res.end("no");
  }
});

// ---------------------------------------------------------------- harness

// The real extension asks for host permission through a user gesture, which a
// headless run cannot supply. Grant the test origin up front in a throwaway
// copy of the manifest so the rest of the flow is exercised unmodified.
function makeTestCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ext-"));
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => !/node_modules|\.git|[\\/]test$/.test(src),
  });
  const mf = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  mf.host_permissions = [`${BASE}/*`];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(mf, null, 2));
  return dir;
}

async function swEval(context, fn, ...args) {
  const [sw] = context.serviceWorkers();
  return sw.evaluate(fn, ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const extDir = makeTestCopy();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.PW_CHROME || undefined,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-sandbox",
      "--disable-gpu",
    ],
  });

  try {
    // The service worker registers a moment after launch.
    for (let i = 0; i < 60 && !context.serviceWorkers().length; i++) await sleep(250);
    const [sw] = context.serviceWorkers();
    if (!sw) throw new Error("The extension service worker never started.");
    const extId = new URL(sw.url()).host;
    console.log("  extension id:", extId);

    console.log("\n1. the picker, driven with a real mouse");
    const page = await context.newPage();
    await page.goto(`${BASE}/static`);

    const tabId = await swEval(context, async (base) => {
      const tabs = await chrome.tabs.query({ url: base + "/*" });
      return tabs[0] ? tabs[0].id : null;
    }, BASE);
    eq("found the tab", typeof tabId, "number");

    await swEval(context, async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["lib/pw-core.js", "picker/picker.js"],
      });
    }, tabId);

    await page.waitForSelector("#pw-picker-host", { state: "attached", timeout: 5000 });
    eq("overlay injected", await page.locator("#pw-picker-host").count(), 1);

    await page.hover("#price");
    await sleep(150);
    await page.click("#price");
    await sleep(200);

    const shown = await page.evaluate(() => {
      const sr = document.getElementById("pw-picker-host").shadowRoot;
      return {
        card: sr.querySelector(".card").style.display,
        value: sr.getElementById("cval").textContent,
        label: sr.getElementById("lab").value,
      };
    });
    eq("confirm card opened", shown.card, "block");
    eq("detected the right value", shown.value, "81,000৳");
    eq("guessed a label from the h1", shown.label, "Test Laptop 15 inch");

    await page.evaluate(() => {
      document.getElementById("pw-picker-host").shadowRoot.getElementById("save").click();
    });
    await sleep(600);

    let items = await swEval(context, async () => (await chrome.storage.local.get("items")).items);
    eq("one item stored", items.length, 1);
    eq("stored value", items[0].lastValue, 81000);
    eq("stored currency", items[0].currency, "৳");
    eq("stored label", items[0].label, "Test Laptop 15 inch");

    console.log("\n2. a scheduled check with no change");
    // A message sent from the worker to itself is never delivered back, so
    // drive checks from an extension page, exactly the way the popup does.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    const call = (msg) =>
      popup.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);

    // Count every tab and window the extension opens from here on.
    await swEval(context, () => {
      globalThis.__opened = { tabs: 0, windows: 0 };
      chrome.tabs.onCreated.addListener(() => globalThis.__opened.tabs++);
      chrome.windows.onCreated.addListener(() => globalThis.__opened.windows++);
    });
    const opened = () => swEval(context, () => globalThis.__opened);

    let res = await call({ type: "checkNow" });
    eq("checked one item", res.outcomes.length, 1);
    eq("nothing changed", res.outcomes[0].changed, false);
    eq("no error", res.outcomes[0].error, null);
    eq("read over plain fetch", (await call({ type: "checkNow" })).outcomes[0].error, null);

    console.log("\n3. the shop drops the price");
    staticPrice = "74,500৳";
    res = await call({ type: "checkNow" });
    eq("change detected", res.outcomes[0].changed, true);
    eq("new value", res.outcomes[0].newValue, 74500);
    eq("old value remembered", res.outcomes[0].oldValue, 81000);

    items = await swEval(context, async () => (await chrome.storage.local.get("items")).items);
    // one reading from the add, plus the three checks run so far
    eq("history accumulates every reading", items[0].history.length, 4);
    eq("matched structurally, not loosely", items[0].loose, false);
    eq("still using the cheap fetch path", items[0].mode, "auto");

    console.log("\n4. target price alert");
    await call({
      type: "updateItem",
      id: items[0].id,
      patch: { target: { enabled: true, direction: "below", value: 70000 }, targetNotified: false },
    });
    staticPrice = "68,900৳";
    res = await call({ type: "checkNow" });
    eq("target fired", res.outcomes[0].hitTarget, true);
    staticPrice = "68,900৳";
    res = await call({ type: "checkNow" });
    eq("target does not re-fire while it stays below", res.outcomes[0].hitTarget, false);

    console.log("\n5. a JavaScript-rendered, frame-blocking page is read invisibly");
    const spaPage = await context.newPage();
    await spaPage.goto(`${BASE}/spa`);
    await spaPage.waitForFunction(() => document.getElementById("price").textContent !== "loading...");
    const spaTabId = await swEval(context, async (base) => {
      const tabs = await chrome.tabs.query({ url: base + "/spa*" });
      return tabs[0].id;
    }, BASE);
    await swEval(context, async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["lib/pw-core.js", "picker/picker.js"],
      });
    }, spaTabId);
    await spaPage.waitForSelector("#pw-picker-host", { state: "attached" });
    await spaPage.hover("#price");
    await sleep(150);
    await spaPage.click("#price");
    await sleep(200);
    await spaPage.evaluate(() => {
      document.getElementById("pw-picker-host").shadowRoot.getElementById("save").click();
    });
    await sleep(600);
    await spaPage.close();

    items = await swEval(context, async () => (await chrome.storage.local.get("items")).items);
    const spaItem = items.find((i) => i.url.includes("/spa"));
    eq("spa item added", spaItem ? spaItem.lastValue : null, 13200);

    const before = await opened();
    spaPrice = "11,900৳";
    let t0 = Date.now();
    res = await call({ type: "checkNow", ids: [spaItem.id] });
    console.log(`        first spa check took ${Date.now() - t0} ms`);
    eq("spa change detected", [res.outcomes[0].changed, res.outcomes[0].newValue], [true, 11900]);
    eq("read by the hidden renderer", res.outcomes[0].method, "render");

    items = await swEval(context, async () => (await chrome.storage.local.get("items")).items);
    const spaAfter = items.find((i) => i.url.includes("/spa"));
    eq("remembers it needs rendering", spaAfter.mode, "render");

    spaPrice = "11,500৳";
    t0 = Date.now();
    res = await call({ type: "checkNow", ids: [spaItem.id] });
    console.log(`        second spa check took ${Date.now() - t0} ms`);
    eq("second spa check", res.outcomes[0].newValue, 11500);

    const after = await opened();
    eq("no tabs opened while checking", after.tabs - before.tabs, 0);
    eq("no windows opened while checking", after.windows - before.windows, 0);
    eq("reader script removed after the run", (await swEval(context, async () =>
      (await chrome.scripting.getRegisteredContentScripts()).length)), 0);

    console.log("\n5b. the frame rule leaves normal tabs alone");
    const normal = await context.newPage();
    await normal.goto(`${BASE}/spa`);
    const xfo = await normal.evaluate(async () => {
      const r = await fetch(location.href);
      return r.headers.get("x-frame-options");
    });
    eq("page's own headers intact in a normal tab", xfo, "DENY");
    await normal.close();

    console.log("\n5c. a busy run is not doubled up");
    const [r1, r2] = await Promise.all([call({ type: "checkNow" }), call({ type: "checkNow" })]);
    eq("second concurrent run skipped", [!!r1.outcomes, !!r2.skipped], [true, true]);

    console.log("\n6. a page that no longer has the element");
    const broken = items.find((i) => i.url.includes("/static"));
    await call({ type: "updateItem", id: broken.id, patch: { url: `${BASE}/gone` } });
    res = await call({ type: "checkNow", ids: [broken.id] });
    eq("error reported, not a crash", typeof res.outcomes[0].error, "string");
    eq("other items keep working", (await call({ type: "checkNow" })).outcomes.length, 2);

    console.log("\n7. the popup renders what is stored");
    await popup.reload();
    await popup.waitForSelector(".item", { timeout: 5000 });
    eq("two rows in the popup", await popup.locator(".item").count(), 2);
    const firstLabel = await popup.locator(".item .label").first().textContent();
    eq("row has a label", firstLabel.length > 0, true);
    fs.mkdirSync(path.join(ROOT, "test", "output"), { recursive: true });
    await popup.screenshot({ path: path.join(ROOT, "test", "output", "popup-shot.png"), fullPage: true });
    console.log("        popup screenshot saved");

    console.log("\n8. settings round trip");
    await call({ type: "saveSettings", settings: { intervalMinutes: 180 } });
    const alarm = await swEval(context, async () => {
      const a = await chrome.alarms.get("pw-check");
      return a ? a.periodInMinutes : null;
    });
    eq("alarm rescheduled", alarm, 180);

    // ------------------------------------------------------------------
    const getItems = () => swEval(context, async () => (await chrome.storage.local.get("items")).items);
    const getStatic = async () => (await getItems()).find((i) => i.host === "127.0.0.1" && !i.url.includes("/spa"));
    const csvRows = async () => {
      const r = await call({ type: "exportCsv" });
      return r.csv.replace(/^﻿/, "").trim().split("\r\n");
    };

    console.log("\n9. stock watching and the price database");
    let st = await getStatic();
    await call({ type: "updateItem", id: st.id, patch: { url: `${BASE}/static`, failCount: 0, error: null } });
    await call({
      type: "saveSettings",
      settings: { webhook: { enabled: true, url: `${BASE}/hook` }, intervalMinutes: 180 },
    });
    res = await call({ type: "checkNow", ids: [st.id] });
    eq("restored item reads again", [res.outcomes[0].error, res.outcomes[0].newValue], [null, 68900]);
    st = await getStatic();
    eq("stock detected from the page", st.stock, "in");
    let rows = await csvRows();
    eq("database header", rows[0], "Product name,Product Link,Date,Price,Stock");
    // two first readings + two changes on each item, nothing for no-change checks
    eq("database only holds meaningful rows", rows.length - 1, 6);

    staticStock = "Out Of Stock";
    hidePrice = true;
    res = await call({ type: "checkNow", ids: [st.id] });
    eq("out of stock with the price hidden is not an error", res.outcomes[0].error, null);
    eq("stock change reported", res.outcomes[0].stockChanged, true);
    st = await getStatic();
    eq("item marked out of stock, last price kept", [st.stock, st.lastValue], ["out", 68900]);
    rows = await csvRows();
    eq("database row for going out of stock", rows[rows.length - 1].split(",").slice(-2), ["", "Out of stock"]);

    res = await call({ type: "checkNow", ids: [st.id] });
    eq("no new row while nothing changes", (await csvRows()).length, rows.length);

    staticStock = "In Stock";
    hidePrice = false;
    staticPrice = "66,000৳";
    res = await call({ type: "checkNow", ids: [st.id] });
    eq("back in stock and a new price, both seen", [res.outcomes[0].stockChanged, res.outcomes[0].changed], [true, true]);
    rows = await csvRows();
    eq("one row for that check", rows[rows.length - 1].split(",").slice(-2), ["66000", "In stock"]);
    await sleep(300);
    eq("webhook got the stock events", hookBodies.flatMap((b) => b.events.map((e) => e.type)).filter((t) => t === "stock").length, 2);
    eq("webhook body has Slack and Discord text", typeof hookBodies[0].text + typeof hookBodies[0].content, "stringstring");

    console.log("\n10. smarter alerts");
    // The target from step 4 (alert below 70,000) would fire on its own here.
    await call({ type: "updateItem", id: st.id, patch: { target: { enabled: false, direction: "below", value: null } } });
    await call({ type: "saveSettings", settings: { minChangePct: 5, alertMode: "drops" } });
    let sent = hookBodies.length;
    staticPrice = "65,500৳"; // under 1%
    await call({ type: "checkNow", ids: [st.id] });
    staticPrice = "70,000৳"; // a rise
    await call({ type: "checkNow", ids: [st.id] });
    await sleep(300);
    eq("small moves and rises are not alerted", hookBodies.length, sent);
    eq("but they are still in the database", (await csvRows()).length, rows.length + 2);
    staticPrice = "60,000৳"; // a 14% drop
    await call({ type: "checkNow", ids: [st.id] });
    await sleep(300);
    eq("a big drop is alerted", hookBodies.length, sent + 1);
    await call({ type: "saveSettings", settings: { minChangePct: 0, alertMode: "all" } });

    console.log("\n11. quiet hours hold alerts and send one summary");
    const hhmm = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const now = new Date();
    await call({
      type: "saveSettings",
      settings: {
        quietHours: {
          enabled: true,
          start: hhmm(new Date(now - 3600e3)),
          end: hhmm(new Date(+now + 3600e3)),
        },
      },
    });
    sent = hookBodies.length;
    staticPrice = "58,000৳";
    await call({ type: "checkNow", ids: [st.id] });
    await sleep(300);
    eq("nothing sent during quiet hours", hookBodies.length, sent);
    eq("alert held for later", (await swEval(context, async () => (await chrome.storage.local.get("held")).held.length)), 1);
    eq("wake-up set for the end of quiet hours", !!(await swEval(context, async () => chrome.alarms.get("pw-quiet-end"))), true);
    await call({ type: "saveSettings", settings: { quietHours: { enabled: false } } });
    await sleep(300);
    eq("summary sent when quiet hours end", hookBodies.length, sent + 1);
    eq("held list emptied", (await swEval(context, async () => (await chrome.storage.local.get("held")).held.length)), 0);

    console.log("\n12. a failing page backs off, then asks for help once");
    await call({ type: "updateItem", id: st.id, patch: { url: `${BASE}/gone` } });
    for (let i = 0; i < 6; i++) await call({ type: "checkNow", ids: [st.id] });
    st = await getStatic();
    eq("six failures counted", st.failCount, 6);
    const eff = await swEval(context, async (id) => {
      const { items, settings } = await chrome.storage.local.get(["items", "settings"]);
      return PW.effectiveInterval(items.find((i) => i.id === id), settings);
    }, st.id);
    eq("checked far less often now", eff, 1440);
    res = await call({ type: "checkNow", manual: false });
    eq("a scheduled run skips items that are not due", res.outcomes.length, 0);
    await sleep(300);
    eq("one 'needs attention' alert", hookBodies.flatMap((b) => b.events.map((e) => e.type)).filter((t) => t === "failing").length, 1);
    await call({ type: "checkNow", ids: [st.id] });
    await sleep(300);
    eq("not repeated", hookBodies.flatMap((b) => b.events.map((e) => e.type)).filter((t) => t === "failing").length, 1);
    await call({ type: "updateItem", id: st.id, patch: { url: `${BASE}/static` } });
    await call({ type: "checkNow", ids: [st.id] });
    st = await getStatic();
    eq("recovers fully on success", [st.failCount, st.error], [0, null]);

    console.log("\n13. per-item interval");
    const spaId = (await getItems()).find((i) => i.url.includes("/spa")).id;
    await call({ type: "updateItem", id: spaId, patch: { intervalMinutes: 30 } });
    eq("alarm ticks at the shortest interval", await swEval(context, async () => (await chrome.alarms.get("pw-check")).periodInMinutes), 30);
    await call({ type: "updateItem", id: spaId, patch: { intervalMinutes: null } });
    eq("and back", await swEval(context, async () => (await chrome.alarms.get("pw-check")).periodInMinutes), 180);

    console.log("\n14. re-pick keeps the history");
    const histBefore = st.history.length;
    staticPrice = "57,000৳";
    call({ type: "repick", id: st.id });
    let rp = null;
    for (let i = 0; i < 40 && !rp; i++) {
      await sleep(250);
      for (const p of context.pages()) {
        if (p.url().startsWith(`${BASE}/static`) && (await p.locator("#pw-picker-host").count())) rp = p;
      }
    }
    eq("picker opened on the item's page", !!rp, true);
    await rp.hover("#price");
    await sleep(150);
    await rp.click("#price");
    await sleep(200);
    const title = await rp.evaluate(() =>
      document.getElementById("pw-picker-host").shadowRoot.getElementById("ctitle").textContent);
    eq("picker knows it is a re-pick", title, "Use this as the new price location?");
    await rp.evaluate(() => document.getElementById("pw-picker-host").shadowRoot.getElementById("save").click());
    await sleep(600);
    const all = await getItems();
    st = all.find((i) => i.id === st.id);
    eq("no duplicate item", all.length, 2);
    eq("history kept and extended", st.history.length, histBefore + 1);
    eq("new reading taken", st.lastValue, 57000);
    eq("re-pick recorded", typeof st.repickedAt, "number");

    console.log("\n15. Telegram alert format");
    await swEval(context, () => {
      globalThis.__tg = [];
      const real = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        if (String(url).startsWith("https://api.telegram.org/")) {
          globalThis.__tg.push({ url: String(url), body: JSON.parse(opts.body) });
          return new Response('{"ok":true}', { status: 200 });
        }
        return real(url, opts);
      };
    });
    await call({ type: "saveSettings", settings: { telegram: { enabled: true, token: "123:ABC-def", chatId: "42" } } });
    res = await call({ type: "testRemote" });
    const tg = await swEval(context, () => globalThis.__tg);
    eq("test message reported as sent", res.status.telegram.ok, true);
    eq("sent to the bot's sendMessage", tg[0] && tg[0].url, "https://api.telegram.org/bot123:ABC-def/sendMessage");
    eq("to your chat", tg[0] && tg[0].body.chat_id, "42");
    const backup = await swEval(context, async () => (await chrome.storage.local.get("settings")).settings.telegram.token);
    eq("token stored locally", backup, "123:ABC-def");
  } finally {
    await context.close();
    server.close();
  }

  console.log("\n" + "=".repeat(56));
  if (fails) {
    console.log(fails + " FAILURE(S)");
    process.exit(1);
  }
  console.log("All end-to-end checks passed.");
}

main().catch((e) => {
  console.error("\nTEST HARNESS ERROR:", e);
  server.close();
  process.exit(1);
});
