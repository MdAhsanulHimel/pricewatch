# Contributing to Price Watch

Thanks for helping. Bug reports with a product URL are the most useful thing
you can send: almost every reading problem is specific to one shop's markup.

## Run it from source

1. Clone the repo.
2. Open `edge://extensions` (or `chrome://extensions`), turn on
   **Developer mode**, click **Load unpacked** and pick the repo folder.
3. After editing code, press **Reload** on the Price Watch card. Changes to
   `background.js` also need the service worker to restart, which Reload does.

There is no build step. The extension runs exactly the files in the repo.

## Tests

```bash
npm install
npx playwright install chromium   # once
npm run test:unit                 # price parsing, selectors, stock, CSV (jsdom)
npm run test:e2e                  # the real extension in Chromium
```

The end-to-end test needs a visible browser because extensions do not load
headless. On Linux without a screen, run it with `xvfb-run -a npm run test:e2e`.
CI does this on every push and pull request.

## Ground rules for changes

- **Background work stays invisible.** Nothing may open a window, take focus,
  show a dialog or make a sound during a scheduled check. The e2e test counts
  tabs and windows; keep it passing.
- **No new required permissions without a reason** written in the PR.
  Host access stays per-site and opt-in.
- **No servers, no telemetry.** Data stays in the browser unless the user turns
  on Telegram or a webhook.
- `lib/pw-core.js` is loaded in four places (service worker, offscreen
  document, hidden frame, the page itself), so it stays a plain classic script
  with no imports and no DOM assumptions outside functions that take a
  document.
- Add a test for anything that parses a page. Real-world HTML snippets are
  welcome in `test/unit.mjs`.
- Note user-visible changes in `CHANGELOG.md` under **Unreleased**.

## Making a release

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `manifest.json` and `package.json`.
3. Commit, then tag and push:

   ```bash
   git tag v1.2.0
   git push origin HEAD --tags
   ```

The **Release** workflow runs the tests, builds `price-watch-v1.2.0.zip` with
`npm run package` and publishes it on the GitHub Releases page with the notes
from the changelog.
