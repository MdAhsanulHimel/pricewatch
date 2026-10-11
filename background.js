/*
 * background.js  (MV3 service worker, classic so it can importScripts)
 *
 * Owns: the schedule, the ways of reading a page, change detection,
 * notifications and the toolbar badge.
 *
 * v1.1: checks are silent. Nothing ever opens a window, and nothing takes
 * focus. Pages are read, in order of cost:
 *
 *   fetch   download the HTML and parse it in the offscreen document
 *   render  load the page in a hidden, sandboxed iframe inside the
 *           offscreen document and read it once JavaScript has run
 *   tab     (off by default) a muted background tab in an existing window,
 *           only when you are away from the keyboard or pressed Check now
 *
 * v1.2: stock watching, a CSV price database, smarter alerts with quiet
 * hours, Telegram and webhook alerts, per-item intervals with backoff for
 * pages that keep failing, and re-picking a price without losing history.
 */
importScripts("lib/pw-core.js");

const DEFAULT_SETTINGS = {
  intervalMinutes: 60,
  notify: true,
  sound: false,
  badge: true,
  historyLimit: 240,
  tabSettleMs: 2000,
  maxParallel: 4,
  tabFallback: false,
  // Smarter alerts
  alertMode: "all", // "all" | "drops"
  minChangePct: 0, // ignore smaller moves (history still records them)
  notifyStock: true,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  // Remote alerts
  telegram: { enabled: false, token: "", chatId: "" },
  webhook: { enabled: false, url: "" },
  // Price database
  logLimit: 20000,
};

// After PW.BACKOFF_AFTER failures in a row an item is checked less often,
// and after FAIL_ALERT_AT you are told once that it needs attention.
// (The backoff itself lives in PW.effectiveInterval, shared with the popup.)
const FAIL_ALERT_AT = 6;

const ALARM = "pw-check";
const CATCHUP_ALARM = "pw-catchup";
const QUIET_ALARM = "pw-quiet-end";
const FETCH_TIMEOUT_MS = 20000;
const RENDER_TIMEOUT_MS = 25000;
const FRAME_SCRIPT_ID = "pw-frame";
const NET_RULE_ID = 1;

// =========================================================================
// Storage helpers. Every read-modify-write goes through one queue so that
// parallel checks and popup edits can never overwrite each other.
// =========================================================================

let storageChain = Promise.resolve();
function locked(fn) {
  const run = storageChain.then(fn, fn);
  storageChain = run.catch(() => {});
  return run;
}

function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  // Nested groups merge field by field so new defaults reach old installs.
  for (const k of ["quietHours", "telegram", "webhook"]) {
    s[k] = { ...DEFAULT_SETTINGS[k], ...((saved && saved[k]) || {}) };
  }
  return s;
}

async function getState() {
  const { items = [], settings = {}, unseen = 0 } =
    await chrome.storage.local.get(["items", "settings", "unseen"]);
  return { items, settings: mergeSettings(settings), unseen };
}

function patchItem(id, patch) {
  return locked(async () => {
    const { items } = await getState();
    let found = null;
    const next = items.map((it) => {
      if (it.id !== id) return it;
      found = { ...it, ...(typeof patch === "function" ? patch(it) : patch) };
      return found;
    });
    if (found) await chrome.storage.local.set({ items: next });
    return found;
  });
}

function mutateItems(fn) {
  return locked(async () => {
    const { items } = await getState();
    const next = await fn(items);
    await chrome.storage.local.set({ items: next });
    return next;
  });
}

// =========================================================================
// Badge
// =========================================================================

async function refreshBadge() {
  const { settings, unseen } = await getState();
  if (!settings.badge || !unseen) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#e24031" });
  await chrome.action.setBadgeText({ text: String(Math.min(unseen, 99)) });
}

async function bumpUnseen(n) {
  await locked(async () => {
    const { unseen = 0 } = await chrome.storage.local.get("unseen");
    await chrome.storage.local.set({ unseen: unseen + n });
  });
  await refreshBadge();
}

// =========================================================================
// Small concurrency helpers
// =========================================================================

function semaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

const renderSlot = semaphore(2); // hidden iframes rendering at once
const tabSlot = semaphore(1); // background tabs at once (fallback only)

// =========================================================================
// Offscreen document: DOMParser for fetched HTML, and the hidden renderer
// =========================================================================

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["DOM_PARSER", "IFRAME_SCRIPTING"],
        justification:
          "Parse fetched product pages and render JavaScript pages invisibly to read the tracked price.",
      })
      .catch((e) => {
        // A parallel caller may have created it first.
        if (!/single offscreen/i.test(String(e && e.message))) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

// Let the hidden iframe load pages that normally refuse to be framed. The
// rule only touches frames that this extension itself creates outside any
// tab (tabId -1), so your normal browsing is never affected.
async function setupNetRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [NET_RULE_ID],
      addRules: [
        {
          id: NET_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "x-frame-options", operation: "remove" },
              { header: "content-security-policy", operation: "remove" },
            ],
          },
          condition: {
            resourceTypes: ["sub_frame"],
            tabIds: [chrome.tabs.TAB_ID_NONE],
            initiatorDomains: [chrome.runtime.id],
          },
        },
      ],
    });
  } catch (e) {
    console.warn("Price Watch: could not set frame rule", e);
  }
}

// The reader script for the hidden iframe is registered only while a check
// run needs it, so it costs nothing during normal browsing.
async function registerFrameScript() {
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [FRAME_SCRIPT_ID],
  });
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: FRAME_SCRIPT_ID,
      matches: ["http://*/*", "https://*/*"],
      js: ["lib/pw-core.js", "render/frame.js"],
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: false,
    },
  ]);
}

async function unregisterFrameScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [FRAME_SCRIPT_ID] });
  } catch (e) {
    /* not registered */
  }
}

// =========================================================================
// Reading a page, method 1: plain fetch
// =========================================================================

function decodeHtml(buf, contentType) {
  let charset = (/charset=["']?([\w-]+)/i.exec(contentType || "") || [])[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch (e) {
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function readByFetch(item) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let html;
  try {
    const resp = await fetch(item.url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      signal: ctrl.signal,
      headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    if (!resp.ok) {
      const err = new Error("HTTP " + resp.status);
      // The page is gone; rendering it would not help, so fail fast.
      err.final = resp.status === 404 || resp.status === 410;
      throw err;
    }
    html = decodeHtml(await resp.arrayBuffer(), resp.headers.get("content-type"));
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const result = await toOffscreen({ type: "parse", html, selectors: item.selectors });
  if (!result || !result.ok) {
    throw new Error((result && result.reason) || "Not found in the fetched HTML");
  }
  return { ...result, method: "fetch" };
}

// =========================================================================
// Reading a page, method 2: hidden render inside the offscreen document
// =========================================================================

async function readByRender(item, settings) {
  return renderSlot(async () => {
    const result = await toOffscreen({
      type: "render",
      token: PW.uid(),
      url: item.url,
      selectors: item.selectors,
      waitMs: Math.max(settings.tabSettleMs, 1000) + 6000,
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (!result || !result.ok) {
      throw new Error((result && result.reason) || "Element not found in the rendered page");
    }
    return { ...result, method: "render" };
  });
}

// =========================================================================
// Reading a page, method 3 (opt-in): a muted, inactive background tab.
// Never creates a window, never takes focus, and on a schedule only runs
// while you are away from the keyboard.
// =========================================================================

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.status === "complete") finish(true);
      })
      .catch(() => finish(false));
  });
}

async function tabFallbackAllowed(settings, manual) {
  if (!settings.tabFallback) return "background tabs are turned off in settings";
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (!wins.length) return "no browser window is open";
  if (!manual) {
    const state = await chrome.idle.queryState(120);
    if (state === "active") return "you are using the computer; will retry later";
  }
  return null;
}

async function readByTab(item, settings) {
  return tabSlot(async () => {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const win = wins.find((w) => w.focused) || wins[0];
    const tab = await chrome.tabs.create({ url: item.url, active: false, windowId: win.id });
    try {
      chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
      await waitForLoad(tab.id, 25000);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["lib/pw-core.js"],
      });
      const deadline = Date.now() + Math.max(settings.tabSettleMs, 1000) + 6000;
      let last = null;
      while (Date.now() < deadline) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => globalThis.PW.read(document, sel),
          args: [item.selectors],
        });
        last = res && res.result;
        if (last && last.ok) return { ...last, method: "tab" };
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error((last && last.reason) || "Element not found in the loaded page");
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  });
}

// =========================================================================
// Choosing a method
// =========================================================================

async function readItem(item, settings, manual) {
  const mode = item.mode || "auto";
  const errors = [];

  if (mode === "auto" || mode === "fetch") {
    try {
      return await readByFetch(item);
    } catch (e) {
      errors.push("fetch: " + e.message);
      if (mode === "fetch" || e.final) throw new Error(errors.join(" | "));
    }
  }

  try {
    return await readByRender(item, settings);
  } catch (e) {
    errors.push("hidden render: " + e.message);
  }

  const blocked = await tabFallbackAllowed(settings, manual);
  if (blocked) {
    errors.push("tab: skipped, " + blocked);
    throw new Error(errors.join(" | "));
  }
  try {
    return await readByTab(item, settings);
  } catch (e) {
    errors.push("tab: " + e.message);
    throw new Error(errors.join(" | "));
  }
}


// =========================================================================
// Scheduling helpers: per-item intervals and backoff for failing pages
// =========================================================================

function periodOf(settings) {
  return Math.max(15, Number(settings.intervalMinutes) || 60);
}

function effectiveInterval(item, settings) {
  return PW.effectiveInterval(item, settings);
}

function isDue(item, settings, now) {
  if (!item.lastChecked) return true;
  // Two minutes of slack so an item is not skipped because the alarm fired
  // a few seconds early.
  return now - item.lastChecked >= effectiveInterval(item, settings) * 60000 - 120000;
}

// =========================================================================
// Price database (CSV). One row per meaningful event only: the first
// reading, a price change, or a switch between in stock and out of stock.
// =========================================================================

function logRow(item, t, price, stock) {
  return {
    t,
    id: item.id,
    name: item.label || item.pageTitle || item.host || "",
    url: item.url,
    price: price === undefined ? null : price,
    stock: stock || "",
  };
}

async function appendLog(rows, settings) {
  if (!rows.length) return;
  await locked(async () => {
    const { log = [] } = await chrome.storage.local.get("log");
    const next = log.concat(rows);
    const limit = Math.max(1000, Number(settings.logLimit) || 20000);
    if (next.length > limit) next.splice(0, next.length - limit);
    await chrome.storage.local.set({ log: next });
  });
}

// =========================================================================
// Checking
// =========================================================================

function targetMet(item, value) {
  const t = item.target;
  if (value === null || value === undefined) return false;
  if (!t || !t.enabled || t.value === null || t.value === undefined) return false;
  return t.direction === "above" ? value >= t.value : value <= t.value;
}

async function hasPermission(url) {
  const origin = PW.originOf(url);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin + "/*"] });
}

/**
 * Fold one reading into an item. Returns the storage patch, the events it
 * produced (for alerts) and the database rows it produced.
 */
function applyReading(cur, read, now, settings) {
  const events = [];
  const rows = [];
  const hasValue = read.value !== null && read.value !== undefined;
  const previous = cur.lastValue;
  const priceChanged =
    hasValue &&
    previous !== null &&
    previous !== undefined &&
    Math.abs(previous - read.value) > 0.004;

  const prevStock = cur.stock || "";
  const newStock = read.stock || "";
  const stockChanged = !!prevStock && !!newStock && prevStock !== newStock;

  const history = (cur.history || []).slice();
  if (hasValue) {
    history.push({ t: now, v: read.value });
    while (history.length > settings.historyLimit) history.shift();
  }

  const patch = {
    lastChecked: now,
    error: null,
    failCount: 0,
    failNotified: false,
    history,
    matchedBy: read.matchedBy,
    loose: !!read.loose,
    lastMethod: read.method,
  };
  if (hasValue) {
    patch.lastValue = read.value;
    patch.lastText = read.text;
  }
  if (newStock) {
    patch.stock = newStock;
    patch.stockBy = read.stockBy;
  }
  if (priceChanged) {
    patch.lastChanged = now;
    patch.previousValue = previous;
    events.push({ type: "price", id: cur.id, oldValue: previous, newValue: read.value });
  }
  if (stockChanged) {
    patch.stockChanged = now;
    events.push({ type: "stock", id: cur.id, from: prevStock, to: newStock });
  }
  if (priceChanged || stockChanged) {
    rows.push(logRow(cur, now, hasValue ? read.value : null, newStock || prevStock));
  }

  const value = hasValue ? read.value : null;
  const met = targetMet(cur, value);
  if (met && (priceChanged || !cur.targetNotified)) {
    events.push({ type: "target", id: cur.id, newValue: value });
  }
  patch.targetNotified = hasValue ? (met ? true : false) : !!cur.targetNotified;

  return { patch, events, rows };
}

async function checkItem(item, settings, manual) {
  const outcome = {
    id: item.id,
    label: item.label,
    url: item.url,
    changed: false,
    stockChanged: false,
    hitTarget: false,
    error: null,
    oldValue: item.lastValue,
    newValue: null,
    stock: item.stock || "",
    method: null,
    events: [],
  };

  if (!(await hasPermission(item.url))) {
    outcome.error =
      "No permission for " + PW.hostOf(item.url) + ". Open the popup and press Re-authorise.";
    await patchItem(item.id, { error: outcome.error, lastChecked: Date.now() });
    return outcome;
  }

  let read;
  try {
    read = await readItem(item, settings, manual);
  } catch (e) {
    outcome.error = e.message;
    await patchItem(item.id, (cur) => {
      const failCount = (cur.failCount || 0) + 1;
      const patch = {
        error: e.message,
        lastChecked: Date.now(),
        failCount,
        failingSince: cur.failingSince || Date.now(),
      };
      if (failCount >= FAIL_ALERT_AT && !cur.failNotified) {
        patch.failNotified = true;
        outcome.events.push({ type: "failing", id: cur.id, error: e.message, failCount });
      }
      return patch;
    });
    return outcome;
  }

  outcome.newValue = read.value;
  outcome.stock = read.stock || outcome.stock;
  outcome.method = read.method;
  const now = Date.now();
  let rows = [];

  await patchItem(item.id, (cur) => {
    const res = applyReading(cur, read, now, settings);
    rows = res.rows;
    outcome.events.push(...res.events);
    outcome.oldValue = cur.lastValue;
    // Once a page proves it needs rendering, skip the wasted fetch later.
    let mode = cur.mode || "auto";
    if (mode === "auto" && read.method !== "fetch") mode = "render";
    return { ...res.patch, mode, failingSince: null };
  });

  outcome.changed = outcome.events.some((e) => e.type === "price");
  outcome.stockChanged = outcome.events.some((e) => e.type === "stock");
  outcome.hitTarget = outcome.events.some((e) => e.type === "target");
  await appendLog(rows, settings);
  return outcome;
}

let currentRun = null;

/**
 * ids: only these items. manual: you pressed a button, so everything asked
 * for is checked now; a scheduled run only checks the items that are due.
 */
async function runCheck(ids, manual) {
  if (currentRun) return { skipped: true, busy: true };
  currentRun = (async () => {
    // Keep the worker alive during a long run (MV3 stops idle workers).
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
    let usedRender = false;
    try {
      const { items, settings } = await getState();
      const now = Date.now();
      const due = items.filter(
        (it) =>
          !it.paused &&
          (!ids || ids.includes(it.id)) &&
          (manual || isDue(it, settings, now))
      );
      if (!due.length) return { outcomes: [] };

      if (due.some((it) => (it.mode || "auto") !== "fetch")) {
        await registerFrameScript();
        usedRender = true;
      }

      const pool = semaphore(Math.max(1, Math.min(8, settings.maxParallel || 4)));
      const outcomes = await Promise.all(
        due.map((item) =>
          pool(() =>
            checkItem(item, settings, manual).catch((e) => ({
              id: item.id,
              label: item.label,
              error: String(e && e.message),
              changed: false,
              hitTarget: false,
              events: [],
            }))
          )
        )
      );

      await chrome.storage.local.set({ lastRun: Date.now() });
      await announce(outcomes.flatMap((o) => o.events || []), settings);
      return { outcomes };
    } finally {
      clearInterval(keepAlive);
      if (usedRender) await unregisterFrameScript();
    }
  })();
  try {
    return await currentRun;
  } finally {
    currentRun = null;
  }
}

// =========================================================================
// Alerts: filtering, quiet hours, and delivery to Windows / Telegram / webhook
// =========================================================================

function pctMove(oldV, newV) {
  if (!oldV) return 100;
  return Math.abs(((newV - oldV) / oldV) * 100);
}

/** Should this event reach you, given the alert settings? */
function worthAlerting(ev, settings) {
  if (ev.type === "price") {
    if (settings.alertMode === "drops" && ev.newValue > ev.oldValue) return false;
    const min = Number(settings.minChangePct) || 0;
    if (min > 0 && pctMove(ev.oldValue, ev.newValue) < min) return false;
    return true;
  }
  if (ev.type === "stock") return !!settings.notifyStock;
  return true; // targets and failing items always matter
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60) : null;
}

function inQuietHours(settings, date) {
  const q = settings.quietHours || {};
  if (!q.enabled) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function nextQuietEnd(settings, date) {
  const end = minutesOf(settings.quietHours.end);
  const d = new Date(date);
  d.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (d <= date) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function moveText(oldV, newV, currency) {
  const from = PW.formatValue(oldV, currency);
  const to = PW.formatValue(newV, currency);
  if (oldV === null || oldV === undefined) return to;
  const diff = newV - oldV;
  return `${from} to ${to}  (${diff < 0 ? "DOWN" : "UP"} ${pctMove(oldV, newV).toFixed(1)}%)`;
}

/** Turn an event into words, using the item as it is stored now. */
function describe(ev, item) {
  const it = item || {};
  const name = it.label || it.host || "Item";
  const cur = it.currency;
  switch (ev.type) {
    case "price":
      return {
        title: ev.newValue < ev.oldValue ? "Price dropped" : "Price changed",
        line: moveText(ev.oldValue, ev.newValue, cur),
        name,
      };
    case "stock":
      return {
        title: ev.to === "in" ? "Back in stock" : "Out of stock",
        line:
          ev.to === "in"
            ? "Available again" +
              (it.lastValue !== null && it.lastValue !== undefined
                ? " at " + PW.formatValue(it.lastValue, cur)
                : "")
            : "No longer available",
        name,
      };
    case "target": {
      const t = it.target || {};
      return {
        title: "Target price reached",
        line: `${PW.formatValue(ev.newValue, cur)}  (target ${
          t.direction === "above" ? "at or above" : "at or below"
        } ${PW.formatValue(t.value, cur)})`,
        name,
      };
    }
    case "failing":
      return {
        title: "Price Watch can't read this page",
        line: `Failed ${ev.failCount} times in a row. Open the popup and use Re-pick.`,
        name,
      };
    default:
      return { title: "Price Watch", line: "", name };
  }
}

async function announce(events, settings) {
  const wanted = events.filter((e) => worthAlerting(e, settings));
  if (!wanted.length) return;
  await bumpUnseen(wanted.length);

  // Quiet hours: hold everything and deliver one summary when they end.
  if (inQuietHours(settings, new Date())) {
    await locked(async () => {
      const { held = [] } = await chrome.storage.local.get("held");
      await chrome.storage.local.set({ held: held.concat(wanted).slice(-200) });
    });
    await chrome.alarms.create(QUIET_ALARM, { when: nextQuietEnd(settings, new Date()) });
    return;
  }
  await deliver(wanted, settings);
}

async function releaseHeld() {
  let held = [];
  await locked(async () => {
    held = (await chrome.storage.local.get("held")).held || [];
    await chrome.storage.local.set({ held: [] });
  });
  if (held.length) {
    const { settings } = await getState();
    await deliver(held, settings, true);
  }
}

async function deliver(events, settings, afterQuiet) {
  const { items } = await getState();
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const msgs = events.map((ev) => ({ ev, item: byId[ev.id], ...describe(ev, byId[ev.id]) }));

  if (settings.notify) {
    if (msgs.length <= 2 && !afterQuiet) {
      for (const m of msgs) {
        notify(
          "pw:" + m.ev.id + ":" + m.ev.type + ":" + Date.now(),
          { type: "basic", title: m.title, message: `${m.name}\n${m.line}` },
          settings
        );
      }
    } else {
      notify(
        "pw:many:" + Date.now(),
        {
          type: "list",
          title: afterQuiet
            ? `${msgs.length} update(s) during quiet hours`
            : `${msgs.length} price updates`,
          message: "Open Price Watch to see the details.",
          items: msgs.slice(0, 5).map((m) => ({
            title: (m.title + ": " + m.name).slice(0, 60),
            message: m.line,
          })),
        },
        settings
      );
    }
  }

  await sendRemote(msgs, settings);
}

function notify(id, opts, settings) {
  chrome.notifications.create(
    id,
    {
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      silent: !settings.sound,
      requireInteraction: false,
      priority: 0,
      ...opts,
    },
    () => void chrome.runtime.lastError
  );
}

// Clicking a notification is your own action, so opening the page is fine.
chrome.notifications.onClicked.addListener(async (nid) => {
  const id = nid.split(":")[1];
  chrome.notifications.clear(nid);
  const { items } = await getState();
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const tab = await chrome.tabs.create({ url: item.url });
  if (tab && tab.windowId !== undefined) {
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
});

// ------------------------------------------------------------- remote alerts

async function postWithTimeout(url, body, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 15000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      credentials: "omit",
    });
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 200);
      } catch (e) {
        /* ignore */
      }
      throw new Error("HTTP " + resp.status + (detail ? ": " + detail : ""));
    }
    return resp;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function plainText(msgs) {
  return msgs
    .map((m) => `${m.title}: ${m.name}\n${m.line}${m.item ? "\n" + m.item.url : ""}`)
    .join("\n\n");
}

async function sendTelegram(text, tg) {
  await postWithTimeout(`https://api.telegram.org/bot${encodeURIComponent(tg.token).replace(/%3A/gi, ":")}/sendMessage`, {
    chat_id: tg.chatId,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  });
}

async function sendWebhook(msgs, text, hook) {
  await postWithTimeout(hook.url, {
    source: "price-watch",
    text, // Slack and most chat tools
    content: text.slice(0, 1900), // Discord
    events: msgs.map((m) => ({
      type: m.ev.type,
      title: m.title,
      product: m.name,
      url: m.item ? m.item.url : "",
      oldPrice: m.ev.oldValue === undefined ? null : m.ev.oldValue,
      newPrice:
        m.ev.newValue !== undefined
          ? m.ev.newValue
          : m.item
          ? m.item.lastValue
          : null,
      currency: m.item ? m.item.currency || "" : "",
      stock: m.item ? m.item.stock || "" : "",
      time: new Date().toISOString(),
    })),
  });
}

async function sendRemote(msgs, settings) {
  const text = plainText(msgs);
  const status = {};
  const tg = settings.telegram || {};
  if (tg.enabled && tg.token && tg.chatId) {
    try {
      await sendTelegram(text, tg);
      status.telegram = { ok: true, t: Date.now() };
    } catch (e) {
      status.telegram = { ok: false, t: Date.now(), error: e.message };
    }
  }
  const hook = settings.webhook || {};
  if (hook.enabled && /^https?:\/\//.test(hook.url || "")) {
    try {
      await sendWebhook(msgs, text, hook);
      status.webhook = { ok: true, t: Date.now() };
    } catch (e) {
      status.webhook = { ok: false, t: Date.now(), error: e.message };
    }
  }
  if (Object.keys(status).length) {
    const { remoteStatus = {} } = await chrome.storage.local.get("remoteStatus");
    await chrome.storage.local.set({ remoteStatus: { ...remoteStatus, ...status } });
  }
  return status;
}

// =========================================================================
// Re-picking the price of an existing item (keeps its history)
// =========================================================================

async function startRepick(id) {
  const { items } = await getState();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error("Item not found");

  // Reuse a tab that already shows the page, otherwise open it. You asked
  // for this, so the tab comes to the front.
  let [tab] = await chrome.tabs.query({ url: item.url.split("#")[0] });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    // Reload so you pick from the current price, not a stale page.
    await chrome.tabs.reload(tab.id);
    await new Promise((r) => setTimeout(r, 300));
  } else {
    tab = await chrome.tabs.create({ url: item.url, active: true });
  }
  await waitForLoad(tab.id, 30000);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (job) => {
      globalThis.__pwRepick = job;
    },
    args: [{ id: item.id, label: item.label }],
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["lib/pw-core.js", "picker/picker.js"],
  });
  return { ok: true, tabId: tab.id };
}

async function finishRepick(msg) {
  const { settings } = await getState();
  const now = Date.now();
  let rows = [];
  const item = await patchItem(msg.id, (cur) => {
    const res = applyReading(
      cur,
      {
        value: msg.value,
        text: msg.text,
        stock: msg.stock,
        stockBy: "picker",
        matchedBy: "css",
        loose: false,
        method: "picker",
      },
      now,
      settings
    );
    rows = res.rows;
    return {
      ...res.patch,
      selectors: msg.selectors,
      currency: msg.currency || cur.currency,
      label: msg.label || cur.label,
      mode: "auto",
      failingSince: null,
      repickedAt: now,
    };
  });
  await appendLog(rows, settings);
  return item;
}

// =========================================================================
// Schedule
// =========================================================================

// The alarm ticks at the shortest interval in use; each tick checks only the
// items that are due. Only (re)created when that period changes, so a
// browser restart or a settings tweak does not trigger a burst of checks.
async function ensureAlarm(firstDelay) {
  const { settings, items } = await getState();
  const custom = items.map((i) => Number(i.intervalMinutes) || 0).filter((n) => n > 0);
  const period = Math.max(15, Math.min(periodOf(settings), ...custom));
  const existing = await chrome.alarms.get(ALARM);
  if (existing && existing.periodInMinutes === period) return;
  await chrome.alarms.create(ALARM, {
    periodInMinutes: period,
    delayInMinutes: firstDelay || period,
  });
}

// v1.0 kept a minimised "worker" window around. Close it once on update.
async function closeLegacyWorkerWindows() {
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    for (const w of wins) {
      const tabs = w.tabs || [];
      if (
        w.state === "minimized" &&
        tabs.length === 1 &&
        /^about:blank/.test(tabs[0].url || tabs[0].pendingUrl || "")
      ) {
        await chrome.windows.remove(w.id);
      }
    }
  } catch (e) {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await getState();
  await chrome.storage.local.set({ settings });

  if (details.reason === "update") {
    // Items that v1.0 marked "tab" now use the hidden renderer.
    await mutateItems((items) =>
      items.map((it) => (it.mode === "tab" ? { ...it, mode: "render" } : it))
    );
    if (/^1\.0/.test(details.previousVersion || "")) await closeLegacyWorkerWindows();
  }

  await ensureAlarm(details.reason === "install" ? 1 : 0);
  await setupNetRules();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await refreshBadge();
  // Catch up if the browser was closed over a whole interval. Done with an
  // alarm, not setTimeout, because the worker may be stopped in between.
  const { settings } = await getState();
  const { lastRun = 0 } = await chrome.storage.local.get("lastRun");
  if (Date.now() - lastRun > periodOf(settings) * 60000) {
    chrome.alarms.create(CATCHUP_ALARM, { delayInMinutes: 3 });
  }
  // Quiet hours may have ended while the browser was closed.
  const { held = [] } = await chrome.storage.local.get("held");
  if (held.length && !inQuietHours(settings, new Date())) releaseHeld();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM || alarm.name === CATCHUP_ALARM) runCheck(null, false);
  if (alarm.name === QUIET_ALARM) releaseHeld();
});

// Every time the worker wakes up.
setupNetRules();
unregisterFrameScript();

// =========================================================================
// Messages from the popup, the options page and the picker
// =========================================================================

const HANDLED = new Set([
  "addItem",
  "checkNow",
  "deleteItem",
  "updateItem",
  "saveSettings",
  "clearUnseen",
  "replaceAll",
  "repick",
  "repickItem",
  "exportCsv",
  "clearLog",
  "testRemote",
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen traffic and hidden-frame results are not ours to answer.
  if (!msg || msg.target === "offscreen" || !HANDLED.has(msg.type)) return;

  (async () => {
    switch (msg.type) {
      case "addItem": {
        const now = Date.now();
        const item = {
          id: PW.uid(),
          url: msg.url,
          origin: PW.originOf(msg.url),
          host: PW.hostOf(msg.url),
          label: msg.label || msg.pageTitle || PW.hostOf(msg.url),
          pageTitle: msg.pageTitle || "",
          selectors: msg.selectors,
          currency: msg.currency || "",
          mode: "auto",
          paused: false,
          intervalMinutes: null,
          lastValue: msg.value,
          lastText: msg.text,
          stock: msg.stock || "",
          lastChecked: now,
          lastChanged: null,
          previousValue: null,
          target: { enabled: false, direction: "below", value: null },
          history: [{ t: now, v: msg.value }],
          error: null,
          failCount: 0,
        };
        await mutateItems((items) => items.concat([item]));
        const { settings } = await getState();
        // The first reading is the starting point of the database.
        await appendLog([logRow(item, now, msg.value, item.stock)], settings);
        await ensureAlarm();
        sendResponse({ ok: true, item });
        break;
      }
      case "checkNow":
        sendResponse(await runCheck(msg.ids || null, msg.manual !== false));
        break;
      case "deleteItem":
        await mutateItems((items) => items.filter((i) => i.id !== msg.id));
        await ensureAlarm();
        sendResponse({ ok: true });
        break;
      case "updateItem": {
        const item = await patchItem(msg.id, msg.patch);
        if (msg.patch && "intervalMinutes" in msg.patch) await ensureAlarm();
        sendResponse({ ok: true, item });
        break;
      }
      case "saveSettings": {
        await locked(async () => {
          const { settings } = await getState();
          const next = { ...settings, ...msg.settings };
          for (const k of ["quietHours", "telegram", "webhook"]) {
            if (msg.settings && msg.settings[k]) next[k] = { ...settings[k], ...msg.settings[k] };
          }
          await chrome.storage.local.set({ settings: next });
        });
        await ensureAlarm();
        await refreshBadge();
        const { settings } = await getState();
        const { held = [] } = await chrome.storage.local.get("held");
        if (held.length && !inQuietHours(settings, new Date())) await releaseHeld();
        sendResponse({ ok: true });
        break;
      }
      case "clearUnseen":
        await locked(() => chrome.storage.local.set({ unseen: 0 }));
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      case "replaceAll":
        await mutateItems(() =>
          (msg.items || []).map((it) => (it.mode === "tab" ? { ...it, mode: "render" } : it))
        );
        if (Array.isArray(msg.log)) await locked(() => chrome.storage.local.set({ log: msg.log }));
        await ensureAlarm();
        sendResponse({ ok: true });
        break;
      case "repick":
        sendResponse(await startRepick(msg.id));
        break;
      case "repickItem":
        sendResponse({ ok: true, item: await finishRepick(msg) });
        break;
      case "exportCsv": {
        const { log = [] } = await chrome.storage.local.get("log");
        sendResponse({ ok: true, rows: log.length, csv: PW.logToCsv(log) });
        break;
      }
      case "clearLog":
        await locked(() => chrome.storage.local.set({ log: [] }));
        sendResponse({ ok: true });
        break;
      case "testRemote": {
        const { settings } = await getState();
        const msgs = [
          {
            ev: { type: "test", id: "" },
            item: null,
            title: "Price Watch test",
            name: "Connection works",
            line: "You will get price alerts here.",
          },
        ];
        sendResponse({ ok: true, status: await sendRemote(msgs, settings) });
        break;
      }
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));

  return true; // keep the channel open for the async reply
});
