# Changelog

All notable changes to Price Watch. Dates are YYYY-MM-DD.

## [Unreleased]

## [1.2.0] - 2026-10-11

### Added
- **Stock watching.** Each check also reads whether the product is in stock,
  from the shop's structured data (schema.org / JSON-LD, `itemprop`, meta
  tags) or from words near the price ("Out of stock", "Sold out", "স্টকে নেই"
  and similar). You get an alert when an item goes out of stock or comes back.
  A shop that hides the price while out of stock is no longer reported as an
  error.
- **Price database (CSV).** A lightweight log with the columns Product name,
  Product Link, Date, Price and Stock. A row is written only for the first
  reading, a price change, or a switch between in stock and out of stock.
  Download it from the popup or the settings page; opens in Excel with ৳ and
  Bangla text intact.
- **Smarter alerts.** "Price drops only" mode, a minimum change in percent,
  and quiet hours that hold alerts and send one summary when they end.
- **Telegram and webhook alerts**, with a "Find my chat ID" helper and test
  buttons. The webhook payload works with Slack, Discord, ntfy, Home
  Assistant, n8n and Zapier. Secrets are left out of backups.
- **Re-pick** an item's price on the page without losing its history.
- **Per-item check interval.**
- **Backoff for failing pages.** After 3 failures in a row an item is checked
  less often (up to once a day); after 6 you get one alert asking you to
  re-pick it.
- Backups now include the price database.

### Changed
- The schedule ticks at the shortest interval in use and checks only the
  items that are due.

## [1.1.0] - 2026-09-25

### Changed
- **Checks are silent.** Pages that need JavaScript are rendered in a hidden,
  sandboxed frame inside the extension instead of a minimised browser window,
  which could pop Edge up over other apps. The old window is closed on update.
- Up to four items are checked in parallel, each with a time limit.
- Notifications are silent by default (sound is a setting).

### Added
- Optional muted background-tab fallback for sites that refuse both other
  methods. Off by default; only runs while you are away from the keyboard or
  when you press Check now.

### Fixed
- Every browser start reset the timer and fired a check within a minute.
- The catch-up check after a restart could be lost when the worker slept.
- Parallel edits could overwrite each other's data.
- Pages in non-UTF-8 encodings were decoded wrongly.

## [1.0.0] - 2026-09-07

- First version: point-and-click picker, scheduled checks, notifications,
  target prices, sparklines, JSON backup.
