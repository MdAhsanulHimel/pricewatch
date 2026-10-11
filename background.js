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
};

const ALARM = "pw-check";
const CATCHUP_ALARM = "pw-catchup";
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

async function getState() {
  const { items = [], settings = {}, unseen = 0 } =
    await chrome.storage.local.get(["items", "settings", "unseen"]);
  return { items, settings: { ...DEFAULT_SETTINGS, ...settings }, unseen };
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
          func: (sel) => globalThis.PW.resolve(document, sel),
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
// Checking
// =========================================================================

function targetMet(item, value) {
  const t = item.target;
  if (!t || !t.enabled || t.value === null || t.value === undefined) return false;
  return t.direction === "above" ? value >= t.value : value <= t.value;
}

async function hasPermission(url) {
  const origin = PW.originOf(url);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin + "/*"] });
}

async function checkItem(item, settings, manual) {
  const outcome = {
    id: item.id,
    label: item.label,
    url: item.url,
    changed: false,
    hitTarget: false,
    error: null,
    oldValue: item.lastValue,
    newValue: null,
    method: null,
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
    await patchItem(item.id, (cur) => ({
      error: e.message,
      lastChecked: Date.now(),
      failCount: (cur.failCount || 0) + 1,
    }));
    return outcome;
  }

  outcome.newValue = read.value;
  outcome.method = read.method;
  const now = Date.now();

  await patchItem(item.id, (cur) => {
    const previous = cur.lastValue;
    const changed =
      previous !== null && previous !== undefined && Math.abs(previous - read.value) > 0.004;
    const history = (cur.history || []).concat([{ t: now, v: read.value }]);
    while (history.length > settings.historyLimit) history.shift();

    const met = targetMet(cur, read.value);
    const hitTarget = met && (changed || !cur.targetNotified);

    outcome.changed = changed;
    outcome.oldValue = previous;
    outcome.hitTarget = hitTarget;

    // Remember when a page needs rendering so later checks skip the wasted
    // fetch and go straight to the hidden renderer.
    let mode = cur.mode || "auto";
    if (mode === "auto" && read.method !== "fetch") mode = "render";

    const patch = {
      lastValue: read.value,
      lastText: read.text,
      lastChecked: now,
      error: null,
      failCount: 0,
      history,
      matchedBy: read.matchedBy,
      loose: !!read.loose,
      lastMethod: read.method,
      mode,
      targetNotified: met ? cur.targetNotified || hitTarget : false,
    };
    if (changed) {
      patch.lastChanged = now;
      patch.previousValue = previous;
    }
    return patch;
  });

  return outcome;
}

let currentRun = null;

async function runCheck(ids, manual) {
  if (currentRun) return { skipped: true, busy: true };
  currentRun = (async () => {
    // Keep the worker alive during a long run (MV3 stops idle workers).
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
    let usedRender = false;
    try {
      const { items, settings } = await getState();
      const due = items.filter((it) => !it.paused && (!ids || ids.includes(it.id)));

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
            }))
          )
        )
      );

      await chrome.storage.local.set({ lastRun: Date.now() });
      await announce(outcomes, settings);
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
// Notifications (quiet: no sound unless you turn it on, never steal focus)
// =========================================================================

function moveText(o) {
  const from = PW.formatValue(o.oldValue, o.currency);
  const to = PW.formatValue(o.newValue, o.currency);
  if (o.oldValue === null || o.oldValue === undefined) return to;
  const diff = o.newValue - o.oldValue;
  const pct = o.oldValue ? Math.abs((diff / o.oldValue) * 100).toFixed(1) : "0";
  return `${from} to ${to}  (${diff < 0 ? "DOWN" : "UP"} ${pct}%)`;
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

async function announce(outcomes, settings) {
  const changed = outcomes.filter((o) => o.changed);
  const targets = outcomes.filter((o) => o.hitTarget);
  const interesting = changed.length + targets.filter((t) => !t.changed).length;
  if (interesting) await bumpUnseen(interesting);
  if (!settings.notify) return;

  const { items } = await getState();
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  for (const o of targets) {
    const it = byId[o.id] || {};
    const t = it.target || {};
    notify(
      "pw:" + o.id + ":" + Date.now(),
      {
        type: "basic",
        title: "Target price reached",
        message: `${o.label}\n${PW.formatValue(o.newValue, it.currency)}  (target ${
          t.direction === "above" ? "at or above" : "at or below"
        } ${PW.formatValue(t.value, it.currency)})`,
      },
      settings
    );
  }

  const plainChanges = changed.filter((c) => !targets.includes(c));
  if (plainChanges.length === 1) {
    const o = plainChanges[0];
    o.currency = (byId[o.id] || {}).currency;
    notify(
      "pw:" + o.id + ":" + Date.now(),
      {
        type: "basic",
        title: o.newValue < o.oldValue ? "Price dropped" : "Price changed",
        message: `${o.label}\n${moveText(o)}`,
      },
      settings
    );
  } else if (plainChanges.length > 1) {
    notify(
      "pw:many:" + Date.now(),
      {
        type: "list",
        title: `${plainChanges.length} prices changed`,
        message: "Open Price Watch to see the details.",
        items: plainChanges.slice(0, 5).map((o) => {
          o.currency = (byId[o.id] || {}).currency;
          return { title: (o.label || "").slice(0, 40), message: moveText(o) };
        }),
      },
      settings
    );
  }
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

// =========================================================================
// Scheduling
// =========================================================================

function periodOf(settings) {
  return Math.max(15, Number(settings.intervalMinutes) || 60);
}

// Only (re)create the alarm when it is missing or the interval changed, so a
// browser restart or a settings tweak does not trigger a burst of checks.
async function ensureAlarm(firstDelay) {
  const { settings } = await getState();
  const period = periodOf(settings);
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
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });

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
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM || alarm.name === CATCHUP_ALARM) runCheck(null, false);
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
          lastValue: msg.value,
          lastText: msg.text,
          lastChecked: now,
          lastChanged: null,
          previousValue: null,
          target: { enabled: false, direction: "below", value: null },
          history: [{ t: now, v: msg.value }],
          error: null,
          failCount: 0,
        };
        await mutateItems((items) => items.concat([item]));
        sendResponse({ ok: true, item });
        break;
      }
      case "checkNow":
        sendResponse(await runCheck(msg.ids || null, msg.manual !== false));
        break;
      case "deleteItem":
        await mutateItems((items) => items.filter((i) => i.id !== msg.id));
        sendResponse({ ok: true });
        break;
      case "updateItem":
        sendResponse({ ok: true, item: await patchItem(msg.id, msg.patch) });
        break;
      case "saveSettings": {
        await locked(async () => {
          const { settings } = await getState();
          await chrome.storage.local.set({ settings: { ...settings, ...msg.settings } });
        });
        await ensureAlarm();
        await refreshBadge();
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
        sendResponse({ ok: true });
        break;
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));

  return true; // keep the channel open for the async reply
});
