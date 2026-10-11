# Price Watch

A Microsoft Edge extension that watches a price you point at, on any website,
and tells you when it moves.

You open a product page, press one button, and click the price. Price Watch
remembers where that number lives, re-reads it on a schedule, and raises a
Windows notification when it changes or hits a target you set.

---

## 1. Install it in Edge

There is no store listing, so it loads as an unpacked extension. This is a
supported, permanent way to run your own extensions.

1. Unzip this folder somewhere it can stay, for example
   `C:\Tools\PriceWatch`. **Do not delete or move it afterwards**, Edge loads
   the extension from that folder every time it starts.

   *Updating from an older version:* replace the files in that same folder,
   then press **Reload** on the Price Watch card in `edge://extensions`. Your
   items and history are kept.
2. Open Edge and go to `edge://extensions`.
3. Turn on **Developer mode** (toggle on the left).
4. Click **Load unpacked** and choose the folder that contains
   `manifest.json`.
5. Pin the icon: click the puzzle-piece in the toolbar, then the eye or pin
   next to Price Watch.

The same folder also works in Chrome via `chrome://extensions`, unchanged.

---

## 2. Track your first price

1. Open a product page, any shop, `startech.com.bd`, Daraz, Amazon, anything.
2. Click the Price Watch icon, then **Track a price on this page**.
3. Edge asks whether Price Watch may read that site. Say yes.
   *The first time on a new site the popup sometimes closes when that prompt
   appears. Just click the button again, the permission is already granted and
   it goes straight through.*
4. The page dims into picking mode. Move the mouse: whatever is under the
   cursor is outlined in green and the detected number is shown next to the
   pointer. Click the price.
5. Confirm the value, give the item a name, press **Watch it**.

`Esc` cancels picking at any time.

**Pick tightly.** Click the element that holds the price itself, not a big
block that happens to contain it. The confirm card warns you when the
selection carries a lot of extra text.

---

## 3. What happens after that

Every 60 minutes by default, Price Watch re-reads each tracked page. In the
popup each item shows the current value, the size of the last move, a
sparkline of its history, and when it was last checked.

- **Windows notification** whenever a value changes. Click it to open the page.
- **Target alerts.** Open an item's menu (the ⋮ or click its name) and set
  "alert when at or below 70000". It fires once when the condition is met, and
  arms itself again after the price goes back out of range.
- **Badge count** on the toolbar icon showing unseen changes. Opening the
  popup clears it.
- **Pause** an item to keep its history without checking it.

Settings, backup and the full item table live behind the gear icon.

---

## 4. How a page gets read

Checks are silent. Price Watch never opens a window, never takes focus and
never interrupts what you are doing. Three methods, tried cheapest first:

**Fetch.** The extension downloads the page in the background and reads the
price out of the HTML. Fast and invisible. This works for server-rendered
shops, Star Tech among them.

**Hidden render.** If the price is not in the raw HTML, because the site
paints it with JavaScript, the page is loaded inside a sandboxed, invisible
frame in the extension's own offscreen document, given a few seconds to
render, read and thrown away. Nothing appears on screen, in the taskbar or in
your tab strip. The frame cannot open pop-ups, show dialogs or play sound.

**Background tab (off by default).** A few sites refuse both. If you turn this
on in settings, those pages are opened in a muted, inactive tab in an existing
window, only while you have been away from the keyboard for two minutes or
when you press Check now yourself. It never creates a new window.

Every item starts on `auto`. The first time one needs rendering it is
remembered, so later checks skip the wasted download. The popup labels those
items "rendered".

Up to four items are checked in parallel, and every read has a time limit, so
one slow site cannot hold up the rest.

### What changed in 1.1.0

- Removed the minimised "worker window". In 1.0 it could pop Edge up over
  other apps, especially when Edge was running in the background with no
  window open. It is closed automatically the first time 1.1.0 starts.
- New hidden renderer for JavaScript pages, including sites that block
  framing.
- Checks run in parallel with timeouts, so a full check is much faster.
- Notifications are silent by default (sound can be turned on in settings).
- Fixed: every browser start used to reset the timer and fire a check within
  a minute; the catch-up check could be lost when the worker went to sleep;
  parallel edits could overwrite each other's data.

## 5. When a site redesigns

The picker does not store one brittle CSS path. It records several ways to
find the element and tries them in order:

1. the exact CSS path
2. a nearby stable anchor (an element with an `id` or a `data-product-id`)
   plus a path relative to it
3. the `itemprop` attribute, which shops tend to preserve
4. an XPath
5. a scan for the same tag and class combination, accepted only if exactly one
   candidate on the page looks like a price
6. as a last resort, the one number on the page in the right ballpark

Steps 1 to 5 are structural, so a reading from them is trusted. Step 6 is a
guess: the reading is used but flagged in the popup as a loose match, with a
note telling you to pick the price again. If two candidates are equally
plausible, Price Watch reports a failure rather than inventing an answer.

---

## 6. Limits worth knowing before you rely on it

- **Edge must be running.** Extension timers do not fire when the browser is
  closed. If Edge was shut for longer than one interval, a catch-up check runs
  shortly after you next open it.
- **15 minutes is the floor.** Edge will not run extension alarms more often.
- **Sites can block it.** Aggressive bot protection may serve a challenge page
  to the background fetch. The hidden renderer often gets through; for the
  rest you can allow the background tab fallback in settings.
- **Login-gated prices** usually work because your session cookies are sent,
  but a site that logs you out often will produce read errors.
- **Edge running in the background.** If Edge's "Continue running background
  extensions and apps when Microsoft Edge is closed" setting is on, checks
  keep running with no Edge window open. They stay invisible either way.
- **Per-site permissions.** Nothing is read until you grant that specific
  site, and you can revoke any of them from `edge://extensions` at any time.

---

## 7. Files

| Path | What it is |
|---|---|
| `manifest.json` | Extension definition, MV3 |
| `background.js` | Service worker: schedule, reading, change detection, alerts |
| `lib/pw-core.js` | Price parsing and selector capture/replay, shared by all three contexts |
| `picker/picker.js` | The point-and-click overlay, in a shadow root so page CSS cannot break it |
| `offscreen/` | Parses fetched HTML and hosts the hidden renderer frame |
| `render/frame.js` | Reads the price inside the hidden frame (active only during a check) |
| `popup/` | The list, sparklines, target editor |
| `options/` | Settings, item table, JSON backup |
| `test/unit.mjs` | Price parsing and selector resilience, under jsdom |
| `test/e2e.mjs` | Loads the real extension in Chromium and drives the whole flow |

---

## 8. Running the tests (optional)

Only needed if you change the code.

```
npm install
node test/unit.mjs
node test/e2e.mjs
```

The end-to-end test spins up two fake shops on localhost, one server-rendered
and one JavaScript-rendered that refuses framing, drives the picker with a
real mouse, drops the prices, and asserts that both reading paths notice
without a single tab or window being opened.

---

## 9. Data and privacy

Everything stays in Edge's local extension storage on your PC. There is no
server, no account, no telemetry. **Backup** in the settings page writes a
JSON file you can carry to another machine. Site permissions are not part of
that file, so after importing you press **Re-authorise** on each item once.
