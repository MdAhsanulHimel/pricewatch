(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const DEFAULTS = {
    intervalMinutes: 60,
    notify: true,
    sound: false,
    badge: true,
    historyLimit: 240,
    tabFallback: false,
    alertMode: "all",
    minChangePct: 0,
    notifyStock: true,
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    telegram: { enabled: false, token: "", chatId: "" },
    webhook: { enabled: false, url: "" },
  };

  function send(msg) {
    return new Promise((r) => chrome.runtime.sendMessage(msg, r));
  }

  function merged(saved) {
    const s = Object.assign({}, DEFAULTS, saved || {});
    for (const k of ["quietHours", "telegram", "webhook"]) {
      s[k] = Object.assign({}, DEFAULTS[k], (saved && saved[k]) || {});
    }
    return s;
  }

  function setStatus(el, text, good) {
    el.textContent = text;
    el.className = "status " + (good === true ? "good" : good === false ? "bad" : "");
  }

  function fmtMinutes(m) {
    if (!m) return "default";
    return m >= 1440 ? m / 1440 + " d" : m >= 60 ? m / 60 + " h" : m + " min";
  }

  // ------------------------------------------------------------------ load

  async function load() {
    const state = await chrome.storage.local.get(["items", "settings", "log", "remoteStatus"]);
    const items = state.items || [];
    const s = merged(state.settings);

    $("#interval").value = String(s.intervalMinutes);
    $("#notify").checked = !!s.notify;
    $("#sound").checked = !!s.sound;
    $("#badge").checked = !!s.badge;
    $("#tabFallback").checked = !!s.tabFallback;
    $("#historyLimit").value = s.historyLimit;
    $("#alertMode").value = s.alertMode;
    $("#minChangePct").value = s.minChangePct;
    $("#notifyStock").checked = !!s.notifyStock;
    $("#quietOn").checked = !!s.quietHours.enabled;
    $("#quietStart").value = s.quietHours.start;
    $("#quietEnd").value = s.quietHours.end;
    $("#tgOn").checked = !!s.telegram.enabled;
    $("#tgToken").value = s.telegram.token;
    $("#tgChat").value = s.telegram.chatId;
    $("#hookOn").checked = !!s.webhook.enabled;
    $("#hookUrl").value = s.webhook.url;

    const rs = state.remoteStatus || {};
    if (rs.telegram && rs.telegram.ok === false) setStatus($("#tgStatus"), "Last send failed: " + rs.telegram.error, false);
    if (rs.webhook && rs.webhook.ok === false) setStatus($("#hookStatus"), "Last send failed: " + rs.webhook.error, false);

    const rows = (state.log || []).length;
    $("#csvCount").textContent = rows + " row(s) recorded";

    const tbody = $("#items tbody");
    tbody.textContent = "";
    $("#noitems").hidden = items.length > 0;
    for (const it of items) {
      const tr = document.createElement("tr");
      const cells = [
        it.label || "(no name)",
        it.host || PW.hostOf(it.url),
        PW.formatValue(it.lastValue, it.currency),
        it.stock ? PW.stockLabel(it.stock) : "-",
        it.mode === "render" || it.mode === "tab" ? "hidden render" : "fetch",
        fmtMinutes(it.intervalMinutes),
        String((it.history || []).length),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i === 2 || i === 6) td.className = "num";
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  // ------------------------------------------------------------------ save

  function collect() {
    return {
      intervalMinutes: parseInt($("#interval").value, 10),
      notify: $("#notify").checked,
      sound: $("#sound").checked,
      badge: $("#badge").checked,
      tabFallback: $("#tabFallback").checked,
      historyLimit: Math.max(20, parseInt($("#historyLimit").value, 10) || 240),
      alertMode: $("#alertMode").value,
      minChangePct: Math.max(0, parseFloat($("#minChangePct").value) || 0),
      notifyStock: $("#notifyStock").checked,
      quietHours: {
        enabled: $("#quietOn").checked,
        start: $("#quietStart").value || "22:00",
        end: $("#quietEnd").value || "08:00",
      },
      telegram: {
        enabled: $("#tgOn").checked,
        token: $("#tgToken").value.trim(),
        chatId: $("#tgChat").value.trim(),
      },
      webhook: {
        enabled: $("#hookOn").checked,
        url: $("#hookUrl").value.trim(),
      },
    };
  }

  // Sending to Telegram or a webhook needs permission for that address.
  // Must be asked from a click, so it runs before anything is awaited.
  function remoteOrigins(s) {
    const origins = [];
    if (s.telegram.enabled) origins.push("https://api.telegram.org/*");
    if (s.webhook.enabled) {
      const o = PW.originOf(s.webhook.url);
      if (o) origins.push(o + "/*");
    }
    return origins;
  }

  function askPermission(origins) {
    if (!origins.length) return Promise.resolve(true);
    return chrome.permissions.request({ origins }).catch(() => false);
  }

  async function save() {
    await send({ type: "saveSettings", settings: collect() });
    flash("Saved");
  }

  // Called straight from a click, before anything is awaited, so the
  // browser accepts the permission prompt.
  async function saveWithPermission() {
    const s = collect();
    const granted = await askPermission(remoteOrigins(s));
    if (!granted) {
      if (s.telegram.enabled) setStatus($("#tgStatus"), "Permission for api.telegram.org was not given.", false);
      if (s.webhook.enabled) setStatus($("#hookStatus"), "Permission for that address was not given.", false);
    }
    await save();
    return granted;
  }

  function flash(text) {
    $("#msg").textContent = text;
    setTimeout(() => ($("#msg").textContent = ""), 1800);
  }

  [
    "#interval", "#notify", "#sound", "#badge", "#tabFallback", "#historyLimit",
    "#alertMode", "#minChangePct", "#notifyStock", "#quietOn", "#quietStart", "#quietEnd",
    "#tgToken", "#tgChat",
  ].forEach((sel) => $(sel).addEventListener("change", save));
  ["#tgOn", "#hookOn", "#hookUrl"].forEach((sel) =>
    $(sel).addEventListener("change", saveWithPermission)
  );

  // ------------------------------------------------------------- telegram

  $("#tgFind").addEventListener("click", async () => {
    const token = $("#tgToken").value.trim();
    const st = $("#tgStatus");
    if (!token) return setStatus(st, "Paste the bot token first.", false);
    if (!(await askPermission(["https://api.telegram.org/*"]))) {
      return setStatus(st, "Permission for api.telegram.org is needed.", false);
    }
    setStatus(st, "Looking...");
    try {
      const resp = await fetch("https://api.telegram.org/bot" + token + "/getUpdates");
      const data = await resp.json();
      if (!data.ok) throw new Error(data.description || "Telegram said no");
      const chats = (data.result || [])
        .map((u) => (u.message || u.channel_post || u.my_chat_member || {}).chat)
        .filter(Boolean);
      if (!chats.length) {
        return setStatus(st, "No messages yet. Send your bot a message in Telegram, then try again.", false);
      }
      const chat = chats[chats.length - 1];
      $("#tgChat").value = String(chat.id);
      await save();
      setStatus(st, "Found chat " + (chat.username ? "@" + chat.username : chat.first_name || chat.title || chat.id) + ".", true);
    } catch (e) {
      setStatus(st, "Could not reach Telegram: " + e.message, false);
    }
  });

  async function testRemote(which) {
    const st = which === "telegram" ? $("#tgStatus") : $("#hookStatus");
    if (which === "telegram") $("#tgOn").checked = true;
    else $("#hookOn").checked = true;
    await saveWithPermission();
    setStatus(st, "Sending...");
    const res = await send({ type: "testRemote" });
    const r = res && res.status && res.status[which];
    if (!r) return setStatus(st, "Fill in the details above first.", false);
    setStatus(st, r.ok ? "Test sent. Check your " + (which === "telegram" ? "Telegram" : "webhook") + "." : "Failed: " + r.error, r.ok);
  }
  $("#tgTest").addEventListener("click", () => testRemote("telegram"));
  $("#hookTest").addEventListener("click", () => testRemote("webhook"));

  // ------------------------------------------------------------- database

  function downloadText(text, name, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  $("#csvDownload").addEventListener("click", async () => {
    const res = await send({ type: "exportCsv" });
    if (res && res.ok) {
      downloadText(
        res.csv,
        "price-watch-database-" + PW.localDateTime(Date.now()).slice(0, 10) + ".csv",
        "text/csv;charset=utf-8"
      );
    }
  });

  $("#csvClear").addEventListener("click", async () => {
    const btn = $("#csvClear");
    // Two clicks instead of a confirm() dialog.
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to clear";
      setTimeout(() => {
        btn.dataset.armed = "";
        btn.textContent = "Clear database";
      }, 4000);
      return;
    }
    btn.dataset.armed = "";
    btn.textContent = "Clear database";
    await send({ type: "clearLog" });
    load();
  });

  // --------------------------------------------------------------- backup

  $("#export").addEventListener("click", async () => {
    const { items = [], settings = {}, log = [] } = await chrome.storage.local.get(["items", "settings", "log"]);
    const safe = merged(settings);
    // Secrets stay on this PC.
    safe.telegram = { ...safe.telegram, token: "" };
    safe.webhook = { ...safe.webhook, url: "" };
    downloadText(
      JSON.stringify({ version: chrome.runtime.getManifest().version, items, settings: safe, log }, null, 2),
      "price-watch-backup.json",
      "application/json"
    );
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.items)) throw new Error("No items array in that file");
      await send({ type: "replaceAll", items: data.items, log: Array.isArray(data.log) ? data.log : undefined });
      if (data.settings) {
        const s = { ...data.settings };
        // Keep the secrets already on this PC; the backup never has them.
        delete s.telegram;
        delete s.webhook;
        await send({ type: "saveSettings", settings: s });
      }
      flash("Imported " + data.items.length + " item(s)");
      load();
    } catch (err) {
      flash("Import failed: " + err.message);
    }
    e.target.value = "";
  });

  load();
})();
