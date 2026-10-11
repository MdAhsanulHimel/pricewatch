/*
 * pw-core.js
 * ----------
 * Shared logic, loaded by three very different environments:
 *
 *   1. the service worker      via importScripts()
 *   2. the offscreen document  via <script src>
 *   3. the page being watched  via chrome.scripting.executeScript({files})
 *
 * So it is a plain classic script that hangs everything off globalThis.PW.
 * No imports, no exports, no DOM assumptions outside the functions that
 * explicitly take a document or an element.
 */
(function (root) {
  "use strict";

  const PW = {};

  // =======================================================================
  // Price parsing
  // =======================================================================

  // Currency words and symbols get stripped before we look for digits.
  const CURRENCY_RE =
    /[৳৲$€£¥₹₽₩₺฿₫₦₪₴]|\b(?:BDT|USD|EUR|GBP|INR|PKR|AED|SAR|JPY|CNY|Tk|TK|Rs|RS)\b\.?/g;

  // Bengali, Devanagari and Arabic-Indic digits -> ASCII.
  const DIGIT_MAP = (() => {
    const m = {};
    const sets = ["০", "०", "٠", "۰"];
    for (const start of sets) {
      const base = start.codePointAt(0);
      for (let i = 0; i < 10; i++) m[String.fromCodePoint(base + i)] = String(i);
    }
    return m;
  })();

  PW.normaliseDigits = function (text) {
    return String(text).replace(/[০-৯०-९٠-٩۰-۹]/g,
      (d) => DIGIT_MAP[d] || d);
  };

  /**
   * Turn human price text into a number.
   * Handles 81,000৳ / $1,299.00 / 1.299,00 € / ₹1,23,456 / ৮১,০০০
   * Returns null when there is no number in the text.
   */
  PW.parsePrice = function (text) {
    if (text === null || text === undefined) return null;
    let t = PW.normaliseDigits(String(text))
      .replace(/[   ]/g, " ")
      .replace(CURRENCY_RE, " ")
      .trim();

    const m = t.match(/-?\d[\d.,'’ ]*\d|-?\d/);
    if (!m) return null;

    let raw = m[0].replace(/[\s'’]/g, "");
    const lastComma = raw.lastIndexOf(",");
    const lastDot = raw.lastIndexOf(".");
    const sep = Math.max(lastComma, lastDot);

    if (sep > -1) {
      const digitsAfter = raw.length - sep - 1;
      if (digitsAfter === 1 || digitsAfter === 2) {
        // Last separator is a decimal point.
        raw = raw.slice(0, sep).replace(/[.,]/g, "") + "." + raw.slice(sep + 1);
      } else {
        // All separators are thousands grouping.
        raw = raw.replace(/[.,]/g, "");
      }
    }

    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  };

  PW.detectCurrency = function (text) {
    if (!text) return "";
    const m = String(text).match(CURRENCY_RE);
    return m ? m[0].trim() : "";
  };

  PW.formatValue = function (value, currency) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "-";
    const hasCents = Math.abs(value - Math.round(value)) > 0.004;
    const n = value.toLocaleString("en-US", {
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: 2,
    });
    if (!currency) return n;
    // Symbols that conventionally lead, everything else trails.
    return /^[$€£¥₹₽]$/.test(currency) ? currency + n : n + currency;
  };

  // =======================================================================
  // Selector generation
  // =======================================================================

  // Framework-generated class names we must not depend on.
  const UNSTABLE_CLASS =
    /^(?:css-[a-z0-9]+|sc-[a-zA-Z0-9]+|jsx-\d+|[a-zA-Z]+_[a-zA-Z0-9]{5,}|ng-[a-z-]+|svelte-[a-z0-9]+)$/;
  const UNSTABLE_ID = /^(?:[a-f0-9-]{16,}|.*\d{4,}.*|ember\d+|react-.*)$/i;

  function stableClasses(el) {
    if (!el.classList) return [];
    return Array.from(el.classList).filter(
      (c) => c && c.length < 32 && !UNSTABLE_CLASS.test(c) && !/^\d/.test(c)
    );
  }

  function isStableId(id) {
    return !!id && id.length < 40 && !UNSTABLE_ID.test(id);
  }

  function cssEscape(s) {
    if (root.CSS && root.CSS.escape) return root.CSS.escape(s);
    return String(s).replace(/([^\w-])/g, "\\$1");
  }

  function nthOfType(el) {
    let i = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) i++;
      sib = sib.previousElementSibling;
    }
    return i;
  }

  /** A CSS path from the document root down to el. */
  PW.cssPath = function (el, stopAt) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== stopAt) {
      const tag = node.tagName.toLowerCase();
      if (tag === "html" || tag === "body") {
        parts.unshift(tag);
        break;
      }
      if (isStableId(node.id)) {
        parts.unshift("#" + cssEscape(node.id));
        break;
      }
      const classes = stableClasses(node).slice(0, 3);
      let part = tag + classes.map((c) => "." + cssEscape(c)).join("");

      // Add a positional qualifier only when the parent has look-alike siblings.
      const parent = node.parentElement;
      if (parent) {
        let twins = 0;
        for (const sib of parent.children) {
          if (sib.tagName !== node.tagName) continue;
          const sc = stableClasses(sib).slice(0, 3).join(" ");
          if (sc === classes.join(" ")) twins++;
        }
        if (twins > 1) part += ":nth-of-type(" + nthOfType(node) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  /** Index-based XPath, used when the CSS path stops matching. */
  PW.xPath = function (el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let i = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) i++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + "[" + i + "]");
      node = node.parentElement;
    }
    return "/" + parts.join("/");
  };

  /** Nearest ancestor with a stable id or data attribute, used as an anchor. */
  function findAnchor(el) {
    let node = el.parentElement;
    let hops = 0;
    while (node && hops < 8 && node.tagName !== "BODY") {
      if (isStableId(node.id)) return node;
      if (node.attributes) {
        for (const a of node.attributes) {
          if (/^data-(test|testid|qa|product|item|id|sku)/i.test(a.name) && a.value) {
            return node;
          }
        }
      }
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  function anchorSelector(node) {
    if (isStableId(node.id)) return "#" + cssEscape(node.id);
    for (const a of node.attributes) {
      if (/^data-/i.test(a.name) && a.value) {
        return node.tagName.toLowerCase() + "[" + a.name + "=" + JSON.stringify(a.value) + "]";
      }
    }
    return null;
  }

  /** Everything we need to find this element again on a later visit. */
  PW.buildSelectors = function (el) {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    const anchor = findAnchor(el);
    const sel = {
      css: PW.cssPath(el),
      xpath: PW.xPath(el),
      tag: el.tagName.toLowerCase(),
      classes: stableClasses(el),
      idAttr: isStableId(el.id) ? el.id : "",
      itemprop: el.getAttribute ? el.getAttribute("itemprop") || "" : "",
      sampleText: text.slice(0, 120),
      sampleValue: PW.parsePrice(text),
      anchorCss: anchor ? anchorSelector(anchor) : "",
      anchorRelCss: anchor ? PW.cssPath(el, anchor) : "",
    };
    return sel;
  };

  // =======================================================================
  // Re-resolving a selector on a later page load
  // =======================================================================

  function cleanText(el) {
    return (el.textContent || "").trim().replace(/\s+/g, " ");
  }

  // Only consider elements that hold the price themselves rather than
  // wrapping half the page.
  function isLeafish(el) {
    if (!el || el.nodeType !== 1) return false;
    const t = cleanText(el);
    if (!t || t.length > 60) return false;
    return el.children.length <= 2;
  }

  function tryQuery(doc, selector) {
    if (!selector) return null;
    try {
      return doc.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function accept(el) {
    if (!el) return null;
    const text = cleanText(el);
    const value = PW.parsePrice(text);
    return value === null ? null : { el, text, value };
  }

  /**
   * Find the tracked value in a document.
   * Returns {ok, text, value, matchedBy} or {ok:false, reason}.
   */
  function resolveEl(doc, sel) {
    const attempts = [];

    // 1. the exact CSS path we recorded
    attempts.push(["css", () => accept(tryQuery(doc, sel.css))]);

    // 2. stable anchor plus a relative path (survives layout reshuffles)
    if (sel.anchorCss) {
      attempts.push([
        "anchor",
        () => {
          const a = tryQuery(doc, sel.anchorCss);
          if (!a) return null;
          if (!sel.anchorRelCss) return accept(a);
          try {
            return accept(a.querySelector(sel.anchorRelCss));
          } catch (e) {
            return null;
          }
        },
      ]);
    }

    // 3. itemprop, which shops tend to keep across redesigns
    if (sel.itemprop) {
      attempts.push(["itemprop", () => accept(tryQuery(doc, "[itemprop=" + JSON.stringify(sel.itemprop) + "]"))]);
    }

    // 4. the recorded XPath
    attempts.push([
      "xpath",
      () => {
        if (!sel.xpath || !doc.evaluate) return null;
        try {
          const r = doc.evaluate(sel.xpath, doc, null, 9 /* FIRST_ORDERED_NODE */, null);
          return accept(r.singleNodeValue);
        } catch (e) {
          return null;
        }
      },
    ]);

    // 5. same tag and at least one recorded class, unique price-looking match
    if (sel.classes && sel.classes.length) {
      attempts.push([
        "class-scan",
        () => {
          const q = sel.classes.map((c) => "." + cssEscape(c)).join("");
          let nodes = [];
          try {
            nodes = Array.from(doc.querySelectorAll(sel.tag + q));
          } catch (e) {
            nodes = [];
          }
          if (!nodes.length) {
            for (const c of sel.classes) {
              try {
                nodes = nodes.concat(Array.from(doc.querySelectorAll(sel.tag + "." + cssEscape(c))));
              } catch (e) {
                /* ignore */
              }
            }
          }
          const hits = nodes.filter(isLeafish).map(accept).filter(Boolean);
          return hits.length === 1 ? hits[0] : null;
        },
      ]);
    }

    // 6. last resort: a single element on the page whose text looks like the
    //    sample we recorded and whose value is in the same ballpark
    if (sel.sampleValue !== null && sel.sampleValue !== undefined) {
      attempts.push([
        "value-scan",
        () => {
          const all = doc.querySelectorAll(sel.tag || "*");
          const hits = [];
          for (const el of all) {
            if (!isLeafish(el)) continue;
            const got = accept(el);
            if (!got) continue;
            const ratio = got.value / sel.sampleValue;
            if (ratio > 0.3 && ratio < 3) hits.push(got);
            if (hits.length > 4) break;
          }
          return hits.length === 1 ? hits[0] : null;
        },
      ]);
    }

    for (const [name, fn] of attempts) {
      let got = null;
      try {
        got = fn();
      } catch (e) {
        got = null;
      }
      if (got) {
        return {
          ok: true,
          el: got.el,
          text: got.text,
          value: got.value,
          matchedBy: name,
          // "value-scan" guessed from magnitude alone. It is right often
          // enough to be worth having and wrong often enough that the result
          // must never be treated as confidently as a structural match.
          loose: name === "value-scan",
        };
      }
    }

    return {
      ok: false,
      reason:
        "The element could not be found on the page. The site layout may have " +
        "changed, or the page needs JavaScript to show the price.",
    };
  }

  /**
   * Find the tracked value in a document.
   * Returns {ok, text, value, matchedBy, loose} or {ok:false, reason}.
   * (No DOM nodes in the result, so it can cross extension messaging.)
   */
  PW.resolve = function (doc, sel) {
    const r = resolveEl(doc, sel);
    if (r.ok) delete r.el;
    return r;
  };

  // =======================================================================
  // Stock status
  // =======================================================================

  // Checked before IN_RE, so "not available" never reads as "available".
  const OUT_RE = new RegExp(
    [
      "out[\\s-]*of[\\s-]*stock",
      "sold[\\s-]*out",
      "stock[\\s-]*out",
      "currently[\\s-]+unavailable",
      "not[\\s-]+available",
      "\\bunavailable\\b",
      "discontinued",
      "notify[\\s-]+me[\\s-]+when",
      "up[\\s-]?coming",
      "coming[\\s-]+soon",
      "স্টক\\s*আউট",
      "স্টকে\\s*নেই",
      "স্টক\\s*শেষ",
    ].join("|"),
    "i"
  );
  const IN_RE = new RegExp(
    [
      "\\bin[\\s-]*stock\\b",
      "add[\\s-]+to[\\s-]+(?:cart|bag|basket)",
      "buy[\\s-]+now",
      "স্টকে\\s*আছে",
    ].join("|"),
    "i"
  );

  function stockFromSchema(value) {
    const v = String(value || "");
    if (/OutOfStock|SoldOut|Discontinued|out[\s_-]*of[\s_-]*stock/i.test(v)) return "out";
    if (/InStock|LimitedAvailability|OnlineOnly|InStoreOnly|PreOrder|PreSale|BackOrder|in[\s_-]*stock/i.test(v)) return "in";
    return "";
  }

  function jsonLdAvailability(doc) {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    const found = [];
    const walk = (node, inProduct) => {
      if (!node || typeof node !== "object" || found.length) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, inProduct));
      const type = [].concat(node["@type"] || []).join(" ");
      const isProduct = inProduct || /Product/.test(type);
      if (isProduct && node.availability) found.push(node.availability);
      for (const k of Object.keys(node)) {
        if (k === "isRelatedTo" || k === "isSimilarTo") continue;
        walk(node[k], isProduct);
      }
    };
    for (const s of scripts) {
      try {
        walk(JSON.parse(s.textContent), false);
      } catch (e) {
        /* broken JSON-LD is common, ignore it */
      }
      if (found.length) break;
    }
    return found.length ? stockFromSchema(found[0]) : "";
  }

  /**
   * Is the product in stock? Returns {stock: "in"|"out"|"", stockBy}.
   * near: the price element when known, so the text check stays local.
   */
  PW.detectStock = function (doc, near) {
    try {
      // 1. structured data the shop publishes for search engines
      const ld = jsonLdAvailability(doc);
      if (ld) return { stock: ld, stockBy: "json-ld" };

      const ip = doc.querySelector("[itemprop=availability]");
      if (ip) {
        const v = stockFromSchema(
          ip.getAttribute("href") || ip.getAttribute("content") || ip.textContent
        );
        if (v) return { stock: v, stockBy: "itemprop" };
      }

      const meta = doc.querySelector(
        'meta[property="product:availability"],meta[property="og:availability"]'
      );
      if (meta) {
        const v = stockFromSchema(meta.getAttribute("content"));
        if (v) return { stock: v, stockBy: "meta" };
      }

      // 2. words close to the price (or the product title when the shop
      //    hides the price of an unavailable product)
      let node = near || doc.querySelector("h1");
      for (let depth = 0; node && depth < 7; depth++) {
        if (node.tagName === "BODY" || node.tagName === "HTML") break;
        const text = cleanText(node);
        if (text.length > 4000) break;
        const o = text.search(OUT_RE);
        const i = text.search(IN_RE);
        // Both phrases in the same block: the one shown first is the main one.
        if (o > -1 && (i === -1 || o <= i)) return { stock: "out", stockBy: "text" };
        if (i > -1) return { stock: "in", stockBy: "text" };
        node = node.parentElement;
      }
    } catch (e) {
      /* fall through */
    }
    return { stock: "", stockBy: "" };
  };

  /**
   * Price plus stock in one go. A page that hides the price because the
   * product is out of stock still counts as a successful reading.
   */
  PW.read = function (doc, sel) {
    const r = resolveEl(doc, sel);
    const st = PW.detectStock(doc, r.ok ? r.el : null);
    if (r.ok) {
      delete r.el;
      return Object.assign(r, st);
    }
    if (st.stock === "out") {
      return Object.assign(
        { ok: true, value: null, text: "", matchedBy: "stock-only", loose: false },
        st
      );
    }
    return Object.assign(r, st);
  };

  // =======================================================================
  // Small helpers
  // =======================================================================

  // =======================================================================
  // Scheduling (shared by the service worker and the popup)
  // =======================================================================

  PW.BACKOFF_AFTER = 3;
  PW.MAX_INTERVAL_MIN = 1440;

  /** Minutes between checks for an item, stretched while it keeps failing. */
  PW.effectiveInterval = function (item, settings) {
    const global = Math.max(15, Number(settings && settings.intervalMinutes) || 60);
    const base = Math.max(15, Number(item.intervalMinutes) || global);
    const fails = item.failCount || 0;
    if (fails < PW.BACKOFF_AFTER) return base;
    const factor = Math.pow(2, Math.min(fails - PW.BACKOFF_AFTER + 1, 6));
    return Math.max(base, Math.min(base * factor, PW.MAX_INTERVAL_MIN));
  };

  PW.nextCheckAt = function (item, settings) {
    return (item.lastChecked || 0) + PW.effectiveInterval(item, settings) * 60000;
  };

  /** "2026-10-11 14:05" in the computer's local time. */
  PW.localDateTime = function (ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  };

  PW.stockLabel = function (stock) {
    return stock === "out" ? "Out of stock" : stock === "in" ? "In stock" : "Unknown";
  };

  /**
   * The price database as CSV: Product name, Product Link, Date, Price, Stock.
   * Starts with a byte-order mark so Excel shows ৳ and Bangla text correctly.
   */
  PW.logToCsv = function (rows) {
    const esc = (v) => {
      const t = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const lines = [["Product name", "Product Link", "Date", "Price", "Stock"].join(",")];
    for (const r of rows || []) {
      lines.push(
        [
          esc(r.name),
          esc(r.url),
          esc(PW.localDateTime(r.t)),
          esc(r.price === null || r.price === undefined ? "" : r.price),
          esc(PW.stockLabel(r.stock)),
        ].join(",")
      );
    }
    return "﻿" + lines.join("\r\n") + "\r\n";
  };

  PW.uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  PW.originOf = function (url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return "";
    }
  };

  PW.hostOf = function (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return url;
    }
  };

  root.PW = PW;
  if (typeof module !== "undefined" && module.exports) module.exports = PW;
})(typeof globalThis !== "undefined" ? globalThis : this);
