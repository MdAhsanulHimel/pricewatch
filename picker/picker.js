/*
 * picker.js - the point-and-click part.
 *
 * Injected on demand. Puts a shadow-DOM overlay on the page, highlights
 * whatever is under the cursor, and on click captures a set of selectors for
 * that element plus the price it currently shows.
 */
(function () {
  "use strict";

  if (globalThis.__pwPickerActive) {
    globalThis.__pwPickerRestart && globalThis.__pwPickerRestart();
    return;
  }
  globalThis.__pwPickerActive = true;

  const PW = globalThis.PW;
  const host = document.createElement("div");
  host.id = "pw-picker-host";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);

  shadow.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .box {
        position: fixed; border: 2px solid #12b886; background: rgba(18,184,134,.12);
        border-radius: 3px; pointer-events: none; transition: all .04s linear;
        display: none;
      }
      .tip {
        position: fixed; pointer-events: none; display: none;
        background: #0f2137; color: #fff; font: 12px/1.4 "Segoe UI", system-ui, sans-serif;
        padding: 5px 8px; border-radius: 5px; max-width: 320px;
        box-shadow: 0 4px 14px rgba(0,0,0,.3);
      }
      .tip b { color: #6ee7b7; }
      .bar {
        position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
        pointer-events: auto; background: #0f2137; color: #fff;
        font: 13px/1.5 "Segoe UI", system-ui, sans-serif;
        padding: 10px 14px; border-radius: 10px; display: flex; gap: 14px;
        align-items: center; box-shadow: 0 8px 26px rgba(0,0,0,.35);
      }
      .bar button, .card button {
        font: inherit; border: 0; border-radius: 6px; padding: 6px 12px;
        cursor: pointer;
      }
      .card button[disabled] { opacity: .45; cursor: not-allowed; }
      .bar button { background: #33507a; color: #fff; }
      .bar button:hover { background: #43628f; }
      .card {
        position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
        pointer-events: auto; background: #fff; color: #16233a;
        font: 13px/1.5 "Segoe UI", system-ui, sans-serif; width: 380px;
        padding: 16px; border-radius: 12px; display: none;
        box-shadow: 0 12px 40px rgba(0,0,0,.35); border: 1px solid #d7dee8;
      }
      .card h3 { margin: 0 0 10px; font-size: 14px; }
      .val { font-size: 26px; font-weight: 700; color: #0b7a4b; margin: 2px 0 4px; }
      .raw { color: #667; font-size: 12px; word-break: break-word; margin-bottom: 12px; }
      .card label { display: block; font-size: 12px; color: #566; margin-bottom: 4px; }
      .card input[type=text] {
        width: 100%; padding: 7px 9px; border: 1px solid #c3cddb; border-radius: 6px;
        font: inherit; margin-bottom: 12px;
      }
      .row { display: flex; gap: 8px; justify-content: flex-end; }
      .primary { background: #12b886; color: #fff; }
      .primary:hover { background: #0ca678; }
      .ghost { background: #eef2f7; color: #33465e; }
      .ghost:hover { background: #e2e8f0; }
      .warn { color: #b4451f; font-size: 12px; margin-bottom: 10px; }
    </style>
    <div class="box"></div>
    <div class="tip"></div>
    <div class="bar">
      <span id="bartext">Click the price you want to watch. <b>Esc</b> to cancel.</span>
      <button id="cancel">Cancel</button>
    </div>
    <div class="card">
      <h3 id="ctitle">Watch this value?</h3>
      <div class="warn" id="warn"></div>
      <div class="val" id="cval"></div>
      <div class="raw" id="craw"></div>
      <label for="lab">Name for this item</label>
      <input type="text" id="lab">
      <div class="row">
        <button class="ghost" id="again">Pick again</button>
        <button class="ghost" id="close">Cancel</button>
        <button class="primary" id="save">Watch it</button>
      </div>
    </div>
  `;

  const box = shadow.querySelector(".box");
  const tip = shadow.querySelector(".tip");
  const bar = shadow.querySelector(".bar");
  const card = shadow.querySelector(".card");
  let current = null;
  let frozen = false;

  function inOverlay(e) {
    return e.composedPath().includes(host);
  }

  function highlight(el) {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left - 2 + "px";
    box.style.top = r.top - 2 + "px";
    box.style.width = r.width + 4 + "px";
    box.style.height = r.height + 4 + "px";
  }

  function onMove(e) {
    if (frozen || inOverlay(e)) return;
    const el = e.target;
    if (!el || el.nodeType !== 1 || el === document.documentElement) return;
    current = el;
    highlight(el);

    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const value = PW.parsePrice(text);
    tip.style.display = "block";
    tip.innerHTML =
      value === null
        ? "No number here: " + escapeHtml(text.slice(0, 50))
        : "<b>" + PW.formatValue(value, PW.detectCurrency(text)) + "</b> &nbsp;" +
          escapeHtml(text.slice(0, 40));
    const pad = 16;
    tip.style.left = Math.min(e.clientX + pad, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = Math.min(e.clientY + pad, innerHeight - tip.offsetHeight - 8) + "px";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  function swallow(e) {
    if (inOverlay(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (inOverlay(e)) return;
    swallow(e);
    if (frozen) return;
    freeze(e.target);
  }

  function freeze(el) {
    frozen = true;
    current = el;
    highlight(el);
    tip.style.display = "none";
    bar.style.display = "none";
    card.style.display = "block";

    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    const value = PW.parsePrice(text);
    const currency = PW.detectCurrency(text);
    shadow.getElementById("cval").textContent =
      value === null ? "No number found" : PW.formatValue(value, currency);
    shadow.getElementById("craw").textContent = '"' + text.slice(0, 160) + '"';
    shadow.getElementById("warn").textContent =
      value === null
        ? "Price Watch compares numbers. Pick an element that contains the price itself."
        : text.length > 60
        ? "That element holds a lot of text. A tighter element is more reliable."
        : "";
    shadow.getElementById("save").disabled = value === null;
    const repick = globalThis.__pwRepick;
    shadow.getElementById("ctitle").textContent = repick
      ? "Use this as the new price location?"
      : "Watch this value?";
    shadow.getElementById("save").textContent = repick ? "Update item" : "Watch it";
    shadow.getElementById("lab").value = repick ? repick.label || guessLabel(el) : guessLabel(el);
    shadow.getElementById("lab").focus();
    shadow.getElementById("lab").select();
  }

  function guessLabel(el) {
    const h = document.querySelector("h1");
    const fromH1 = h && h.textContent.trim();
    if (fromH1 && fromH1.length > 2) return fromH1.slice(0, 90);
    const t = (document.title || "").split(/[|–-]/)[0].trim();
    return (t || location.hostname).slice(0, 90);
  }

  function unfreeze() {
    frozen = false;
    card.style.display = "none";
    bar.style.display = "flex";
    box.style.display = "none";
  }

  function teardown() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("keydown", onKey, true);
    host.remove();
    globalThis.__pwPickerActive = false;
    globalThis.__pwRepick = null;
  }

  function onKey(e) {
    if (e.key === "Escape") {
      swallow(e);
      teardown();
    }
  }

  shadow.getElementById("cancel").addEventListener("click", teardown);
  shadow.getElementById("close").addEventListener("click", teardown);
  shadow.getElementById("again").addEventListener("click", unfreeze);
  shadow.getElementById("save").addEventListener("click", () => {
    const el = current;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    const value = PW.parsePrice(text);
    if (value === null) return;
    const repick = globalThis.__pwRepick;
    chrome.runtime.sendMessage(
      {
        type: repick ? "repickItem" : "addItem",
        id: repick ? repick.id : undefined,
        stock: PW.detectStock(document, el).stock,
        url: location.href,
        pageTitle: document.title,
        label: shadow.getElementById("lab").value.trim() || document.title,
        selectors: PW.buildSelectors(el),
        value,
        text,
        currency: PW.detectCurrency(text),
      },
      () => {
        const ok = document.createElement("div");
        ok.textContent = repick ? "Price location updated, history kept" : "Added to Price Watch";
        ok.style.cssText =
          "all:initial;position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
          "z-index:2147483647;background:#12b886;color:#fff;padding:10px 18px;" +
          'border-radius:9px;font:13px "Segoe UI",system-ui,sans-serif;' +
          "box-shadow:0 8px 24px rgba(0,0,0,.3)";
        document.documentElement.appendChild(ok);
        setTimeout(() => ok.remove(), 2200);
        teardown();
      }
    );
  });

  globalThis.__pwPickerRestart = unfreeze;
  if (globalThis.__pwRepick) {
    shadow.getElementById("bartext").innerHTML =
      "Re-pick: click the price for this item. History is kept. <b>Esc</b> to cancel.";
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("keydown", onKey, true);
})();
