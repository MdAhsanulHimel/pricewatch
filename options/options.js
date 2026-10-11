(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  function send(msg) {
    return new Promise((r) => chrome.runtime.sendMessage(msg, r));
  }

  async function load() {
    const { items = [], settings = {} } = await chrome.storage.local.get(["items", "settings"]);
    const s = Object.assign(
      { intervalMinutes: 60, notify: true, sound: false, badge: true, historyLimit: 240, tabFallback: false },
      settings
    );
    $("#interval").value = String(s.intervalMinutes);
    $("#notify").checked = !!s.notify;
    $("#badge").checked = !!s.badge;
    $("#sound").checked = !!s.sound;
    $("#tabFallback").checked = !!s.tabFallback;
    $("#historyLimit").value = s.historyLimit;

    const tbody = $("#items tbody");
    tbody.textContent = "";
    $("#noitems").hidden = items.length > 0;
    for (const it of items) {
      const tr = document.createElement("tr");
      const cells = [
        it.label || "(no name)",
        it.host || PW.hostOf(it.url),
        PW.formatValue(it.lastValue, it.currency),
        it.mode === "render" || it.mode === "tab" ? "hidden render" : "fetch",
        String((it.history || []).length),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i === 2 || i === 4) td.className = "num";
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  async function save() {
    await send({
      type: "saveSettings",
      settings: {
        intervalMinutes: parseInt($("#interval").value, 10),
        notify: $("#notify").checked,
        badge: $("#badge").checked,
        sound: $("#sound").checked,
        tabFallback: $("#tabFallback").checked,
        historyLimit: Math.max(20, parseInt($("#historyLimit").value, 10) || 240),
      },
    });
    flash("Saved");
  }

  function flash(text) {
    $("#msg").textContent = text;
    setTimeout(() => ($("#msg").textContent = ""), 1800);
  }

  ["#interval", "#notify", "#sound", "#badge", "#tabFallback", "#historyLimit"].forEach((sel) =>
    $(sel).addEventListener("change", save)
  );

  $("#export").addEventListener("click", async () => {
    const { items = [], settings = {} } = await chrome.storage.local.get(["items", "settings"]);
    const blob = new Blob([JSON.stringify({ items, settings }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "price-watch-backup.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.items)) throw new Error("No items array in that file");
      await send({ type: "replaceAll", items: data.items });
      if (data.settings) await send({ type: "saveSettings", settings: data.settings });
      flash("Imported " + data.items.length + " item(s)");
      load();
    } catch (err) {
      flash("Import failed: " + err.message);
    }
    e.target.value = "";
  });

  load();
})();
