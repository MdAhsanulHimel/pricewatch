/*
 * offscreen.js
 *
 * The offscreen document is an invisible extension page. It never appears on
 * screen, in the taskbar or in the tab strip. Two jobs happen here:
 *
 *   parse   fetched HTML is parsed with DOMParser (a service worker has none)
 *   render  a page that paints its price with JavaScript is loaded in a
 *           sandboxed, hidden <iframe>; render/frame.js reads it and reports
 *           back. This replaces the old "minimised window" approach, which
 *           could pop Edge up over whatever you were doing.
 */
const pending = new Map(); // token -> { finish }

function renderPage(msg, sendResponse) {
  const token = msg.token;
  const frame = document.createElement("iframe");

  // No top navigation, no pop-ups, no dialogs, no downloads.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  frame.setAttribute(
    "allow",
    "autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'; " +
      "fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'"
  );
  frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
  frame.style.cssText = "position:absolute;left:-10000px;top:0;width:1280px;height:900px;border:0";
  frame.name =
    "pw-render:" +
    JSON.stringify({ token, selectors: msg.selectors, waitMs: msg.waitMs });

  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending.delete(token);
    try {
      frame.src = "about:blank";
      frame.remove();
    } catch (e) {
      /* ignore */
    }
    sendResponse(result);
  };
  const timer = setTimeout(
    () =>
      finish({
        ok: false,
        reason: "Timed out rendering the page (the site may refuse to load inside the checker)",
      }),
    msg.timeoutMs || 25000
  );
  pending.set(token, { finish });

  frame.src = msg.url;
  document.body.appendChild(frame);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Reply from render/frame.js inside one of our hidden iframes.
  if (msg.type === "frameResult") {
    const p = pending.get(msg.token);
    if (p) p.finish(msg.result || { ok: false, reason: "Empty result" });
    return;
  }

  if (msg.target !== "offscreen") return;

  if (msg.type === "parse") {
    try {
      const doc = new DOMParser().parseFromString(msg.html, "text/html");
      sendResponse(globalThis.PW.resolve(doc, msg.selectors));
    } catch (e) {
      sendResponse({ ok: false, reason: "Parse failed: " + e.message });
    }
    return;
  }

  if (msg.type === "render") {
    renderPage(msg, sendResponse);
    return true; // async
  }

  if (msg.type === "ping") {
    sendResponse({ ok: true, rendering: pending.size });
    return;
  }
});
