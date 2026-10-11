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
  PW.resolve = function (doc, sel) {
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
  };

  // =======================================================================
  // Small helpers
  // =======================================================================

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
