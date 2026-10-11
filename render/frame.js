/*
 * render/frame.js
 *
 * Runs only inside the hidden <iframe> that the offscreen document uses to
 * render JavaScript-heavy product pages. It is registered for the length of a
 * check run and removed again afterwards, and it does nothing at all in any
 * frame that is not one of ours.
 *
 * It waits for the tracked element to appear, then reports the reading back.
 */
(function () {
  "use strict";

  // 1. Only in a sub-frame, 2. only in a frame we named, 3. only when the
  //    outermost ancestor is this extension. Anything else: leave instantly.
  if (window.top === window) return;
  const name = String(window.name || "");
  if (name.indexOf("pw-render:") !== 0) return;
  const anc = location.ancestorOrigins;
  const me = "chrome-extension://" + chrome.runtime.id;
  if (!anc || !anc.length || anc[anc.length - 1] !== me) return;
  if (globalThis.__pwFrameRan) return;
  globalThis.__pwFrameRan = true;

  let job;
  try {
    job = JSON.parse(name.slice("pw-render:".length));
  } catch (e) {
    return;
  }

  // Keep the hidden page quiet. Dialogs and pop-ups are already blocked by
  // the iframe sandbox; this stops any audio or video that starts playing.
  const hush = () => {
    for (const m of document.querySelectorAll("audio,video")) {
      try {
        m.muted = true;
        m.pause();
      } catch (e) {
        /* ignore */
      }
    }
  };

  const deadline = Date.now() + Math.max(1500, job.waitMs || 8000);
  let last = null;

  function send(result) {
    try {
      chrome.runtime.sendMessage({ type: "frameResult", token: job.token, result });
    } catch (e) {
      /* extension reloaded; nothing to report to */
    }
  }

  function tick() {
    hush();
    try {
      last = globalThis.PW.resolve(document, job.selectors);
    } catch (e) {
      last = { ok: false, reason: "Read failed: " + e.message };
    }
    if (last && last.ok) return send(last);
    if (Date.now() >= deadline) {
      return send(last || { ok: false, reason: "Element not found in the rendered page" });
    }
    setTimeout(tick, 400);
  }

  tick();
})();
