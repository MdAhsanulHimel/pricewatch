/* popup.js - the list, the sparklines, and the "track this page" flow. */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const listEl = $("#list");
  const emptyEl = $("#empty");
  const statusEl = $("#status");
  const noteEl = $("#addnote");

  let items = [];
  let settings = {};
  let activeTab = null;

  // ---------------------------------------------------------------- utils

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  function ago(ts) {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  }

  function fmtMinutes(m) {
    return m >= 1440 ? m / 1440 + " d" : m >= 60 ? m / 60 + " h" : m + " min";
  }

  function until(ts) {
    const m = Math.max(1, Math.round((ts - Date.now()) / 60000));
    if (m < 60) return "in " + m + " min";
    const h = Math.round(m / 60);
    return h < 48 ? "in " + h + " h" : "in " + Math.round(h / 24) + " d";
  }

  function sparkline(svg, history) {
    svg.textContent = "";
    const pts = (history || []).slice(-40);
    if (pts.length < 2) return;
    const vals = pts.map((p) => p.v);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const x = (i) => (i / (pts.length - 1)) * 100;
    const y = (v) => 26 - ((v - min) / span) * 24;
    const coords = pts.map((p, i) => x(i).toFixed(2) + "," + y(p.v).toFixed(2));

    const ns = "http://www.w3.org/2000/svg";
    const area = document.createElementNS(ns, "polygon");
    area.setAttribute("class", "area");
    area.setAttribute("points", "0,28 " + coords.join(" ") + " 100,28");
    svg.appendChild(area);

    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", coords.join(" "));
    svg.appendChild(line);

    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", "100");
    dot.setAttribute("cy", y(vals[vals.length - 1]).toFixed(2));
    dot.setAttribute("r", "2.2");
    svg.appendChild(dot);
  }

  // ---------------------------------------------------------------- render

  function render() {
    listEl.textContent = "";
    emptyEl.hidden = items.length > 0;

    const tpl = $("#row-tpl");
    for (const item of items) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = item.id;

      $(".label", node).textContent = item.label || item.host;

      const price = $(".price", node);
      price.textContent = PW.formatValue(item.lastValue, item.currency);
      if (item.stock === "in" || item.stock === "out") {
        const chip = document.createElement("span");
        chip.className = "stock " + item.stock;
        chip.textContent = item.stock === "in" ? "In stock" : "Out of stock";
        price.after(chip);
      }

      const delta = $(".delta", node);
      if (item.lastChanged && item.previousValue !== null && item.previousValue !== undefined) {
        const d = item.lastValue - item.previousValue;
        const pct = item.previousValue ? Math.abs((d / item.previousValue) * 100).toFixed(1) : "0";
        delta.textContent = (d < 0 ? "▼ " : "▲ ") +
          PW.formatValue(Math.abs(d), item.currency) + " (" + pct + "%)";
        delta.className = "delta " + (d < 0 ? "down" : "up");
      } else {
        delta.textContent = "";
      }

      sparkline($(".spark", node), item.history);

      const bits = [item.host, "checked " + ago(item.lastChecked)];
      if (item.paused) bits.push("paused");
      if (item.mode === "render" || item.mode === "tab") bits.push("rendered");
      if (item.intervalMinutes) bits.push("every " + fmtMinutes(item.intervalMinutes));
      if (item.target && item.target.enabled) {
        bits.push("target " + (item.target.direction === "above" ? "≥ " : "≤ ") +
          PW.formatValue(item.target.value, item.currency));
      }
      $(".meta", node).textContent = bits.join("  ·  ");

      const err = $(".err", node);
      if (item.error) {
        err.hidden = false;
        let text = item.error;
        if ((item.failCount || 0) >= PW.BACKOFF_AFTER) {
          const next = PW.nextCheckAt(item, settings);
          text =
            "Failed " + item.failCount + " times in a row, so it is checked less often" +
            (next > Date.now() ? " (next try " + until(next) + ")" : "") +
            ". Try Re-pick. Last error: " + item.error;
        }
        err.textContent = text;
      } else if (item.loose) {
        err.hidden = false;
        err.textContent =
          "The exact element was not found, so this reading was matched by " +
          "looking for a similar number on the page. Use Re-pick to make it " +
          "reliable; the history is kept.";
        err.classList.add("warn");
      }

      if (item.lastChanged && Date.now() - item.lastChanged < 36e5) node.classList.add("flash");

      wireRow(node, item);
      listEl.appendChild(node);
    }

    statusEl.textContent =
      items.length +
      " item(s), checked every " +
      settings.intervalMinutes +
      " min. " +
      (settings.notify ? "Notifications on." : "Notifications off.");
  }

  function wireRow(node, item) {
    const drawer = $(".drawer", node);
    $(".menu", node).addEventListener("click", () => {
      drawer.hidden = !drawer.hidden;
    });
    $(".label", node).addEventListener("click", () => {
      drawer.hidden = !drawer.hidden;
    });

    const on = $(".tgt-on", node);
    const dir = $(".tgt-dir", node);
    const val = $(".tgt-val", node);
    const t = item.target || { enabled: false, direction: "below", value: null };
    on.checked = !!t.enabled;
    dir.value = t.direction || "below";
    val.value = t.value === null || t.value === undefined ? "" : t.value;

    const saveTarget = async () => {
      const num = parseFloat(val.value);
      await send({
        type: "updateItem",
        id: item.id,
        patch: {
          target: {
            enabled: on.checked && Number.isFinite(num),
            direction: dir.value,
            value: Number.isFinite(num) ? num : null,
          },
          targetNotified: false,
        },
      });
      await load();
    };
    on.addEventListener("change", saveTarget);
    dir.addEventListener("change", saveTarget);
    val.addEventListener("change", saveTarget);

    const intSel = $(".int-sel", node);
    intSel.value = item.intervalMinutes ? String(item.intervalMinutes) : "";
    intSel.addEventListener("change", async () => {
      await send({
        type: "updateItem",
        id: item.id,
        patch: { intervalMinutes: intSel.value ? parseInt(intSel.value, 10) : null },
      });
      await load();
    });

    $(".act-repick", node).addEventListener("click", () => {
      // The background opens (or switches to) the page and starts the picker.
      send({ type: "repick", id: item.id });
      window.close();
    });

    $(".act-open", node).addEventListener("click", () => {
      chrome.tabs.create({ url: item.url });
    });

    $(".act-check", node).addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Checking...";
      const res = await send({ type: "checkNow", ids: [item.id], manual: true });
      if (res && res.busy) {
        noteEl.className = "note";
        noteEl.textContent = "A check is already running. Try again in a moment.";
      }
      await load();
    });

    const pause = $(".act-pause", node);
    pause.textContent = item.paused ? "Resume" : "Pause";
    pause.addEventListener("click", async () => {
      await send({ type: "updateItem", id: item.id, patch: { paused: !item.paused } });
      await load();
    });

    $(".act-del", node).addEventListener("click", async () => {
      await send({ type: "deleteItem", id: item.id });
      await load();
    });

    const reauth = $(".act-reauth", node);
    chrome.permissions.contains({ origins: [item.origin + "/*"] }, (has) => {
      reauth.hidden = has;
    });
    reauth.addEventListener("click", () => {
      chrome.permissions.request({ origins: [item.origin + "/*"] }, () => load());
    });
  }

  // ---------------------------------------------------------------- picking

  async function startPicking() {
    if (!activeTab || !/^https?:/.test(activeTab.url || "")) {
      noteEl.className = "note bad";
      noteEl.textContent = "Open a normal web page first. Browser pages cannot be tracked.";
      return;
    }
    const origin = PW.originOf(activeTab.url);
    const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
    if (!granted) {
      noteEl.className = "note bad";
      noteEl.textContent =
        "Price Watch needs permission for " + PW.hostOf(activeTab.url) +
        " so it can re-read the page later.";
      return;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          globalThis.__pwRepick = null; // a normal pick adds a new item
        },
      });
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["lib/pw-core.js", "picker/picker.js"],
      });
      window.close(); // get out of the way so the user can click the page
    } catch (e) {
      noteEl.className = "note bad";
      noteEl.textContent = "Could not start the picker here: " + e.message;
    }
  }

  // ---------------------------------------------------------------- boot

  async function load() {
    const state = await chrome.storage.local.get(["items", "settings"]);
    items = state.items || [];
    settings = Object.assign({ intervalMinutes: 60, notify: true }, state.settings || {});
    render();
  }

  $("#pick").addEventListener("click", startPicking);
  $("#csv").addEventListener("click", async () => {
    const res = await send({ type: "exportCsv" });
    if (!res || !res.ok) return;
    downloadText(res.csv, "price-watch-database-" + PW.localDateTime(Date.now()).slice(0, 10) + ".csv");
  });

  function downloadText(text, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $("#openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#checkAll").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Checking...";
    const res = await send({ type: "checkNow", manual: true });
    if (res && res.busy) {
      noteEl.className = "note";
      noteEl.textContent = "A check is already running in the background.";
    }
    e.target.disabled = false;
    e.target.textContent = "Check all";
    await load();
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = tabs[0];
    if (activeTab && !/^https?:/.test(activeTab.url || "")) {
      $("#pick").disabled = true;
      noteEl.textContent = "This page cannot be tracked. Open a product page first.";
    }
  });

  send({ type: "clearUnseen" });
  load();
})();
