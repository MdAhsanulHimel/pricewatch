/* Unit tests for lib/pw-core.js, run under jsdom.  node test/unit.mjs */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://shop.example.com/product/x",
});
const ctx = {
  window: dom.window,
  document: dom.window.document,
  CSS: dom.window.CSS,
  Node: dom.window.Node,
  console,
  URL: dom.window.URL,
  module: { exports: {} },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../lib/pw-core.js", import.meta.url), "utf8"), ctx);
const PW = ctx.PW;

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(got)}` +
    (ok ? "" : ` (expected ${JSON.stringify(want)})`));
};

console.log("1. price parsing across locales");
eq("Star Tech, symbol trailing", PW.parsePrice("81,000৳"), 81000);
eq("US dollars with cents", PW.parsePrice("$1,299.00"), 1299);
eq("European format", PW.parsePrice("1.299,00 €"), 1299);
eq("Indian grouping", PW.parsePrice("₹1,23,456"), 123456);
eq("Bengali numerals", PW.parsePrice("৳৮১,০০০"), 81000);
eq("thin space grouping", PW.parsePrice("12 500 руб"), 12500);
eq("plain decimal", PW.parsePrice("12.5"), 12.5);
eq("no thousands, real decimal", PW.parsePrice("Tk 1.50"), 1.5);
eq("three digits after dot is grouping", PW.parsePrice("6.300"), 6300);
eq("noise around the number", PW.parsePrice("Now only 74,500৳ (save 6,500৳)"), 74500);
eq("no number", PW.parsePrice("Out of Stock"), null);
eq("empty", PW.parsePrice(""), null);
eq("currency detected", PW.detectCurrency("81,000৳"), "৳");
eq("format leading symbol", PW.formatValue(1299, "$"), "$1,299");
eq("format trailing symbol", PW.formatValue(81000, "৳"), "81,000৳");
eq("format keeps cents", PW.formatValue(12.5, "$"), "$12.50");

console.log("\n2. selector capture and replay on the same page");
const shop = new JSDOM(`<!doctype html><html><body>
  <div id="content">
    <div class="product" data-product-id="p-77">
      <h1 class="title">Wireless Mouse</h1>
      <div class="price-box">
        <span class="old">3,500৳</span>
        <span class="now" itemprop="price">2,990৳</span>
      </div>
    </div>
  </div>
</body></html>`).window.document;

const target = shop.querySelector(".now");
const sel = PW.buildSelectors(target);
eq("captured value", sel.sampleValue, 2990);
eq("captured itemprop", sel.itemprop, "price");
console.log("        css:", sel.css);
console.log("        anchor:", sel.anchorCss, "+", sel.anchorRelCss);

let r = PW.resolve(shop, sel);
eq("resolves on the same document", [r.ok, r.value, r.matchedBy], [true, 2990, "css"]);

console.log("\n3. it survives realistic page changes");

function docFrom(html) {
  return new JSDOM(html).window.document;
}

// (a) price simply changed
const changed = docFrom(`<!doctype html><body><div id="content">
  <div class="product" data-product-id="p-77"><h1 class="title">Wireless Mouse</h1>
  <div class="price-box"><span class="old">3,500৳</span>
  <span class="now" itemprop="price">2,750৳</span></div></div></div></body>`);
r = PW.resolve(changed, sel);
eq("new price read", [r.ok, r.value], [true, 2750]);

// (b) a banner is inserted above, shifting every index
const shifted = docFrom(`<!doctype html><body><div id="content">
  <div class="promo">Eid sale</div>
  <div class="product" data-product-id="p-77"><h1 class="title">Wireless Mouse</h1>
  <div class="price-box"><span class="old">3,500৳</span>
  <span class="now" itemprop="price">2,600৳</span></div></div></div></body>`);
r = PW.resolve(shifted, sel);
eq("survives an inserted sibling", [r.ok, r.value], [true, 2600]);

// (c) the wrapper is renamed, so the recorded CSS path breaks
const renamed = docFrom(`<!doctype html><body><div id="content">
  <div class="product-card-v2" data-product-id="p-77"><h1>Wireless Mouse</h1>
  <div class="pricing"><span class="was">3,500৳</span>
  <span class="now" itemprop="price">2,400৳</span></div></div></div></body>`);
r = PW.resolve(renamed, sel);
eq("falls back when the path breaks", [r.ok, r.value], [true, 2400]);
console.log("        matched by:", r.matchedBy);

// (d) the element is genuinely gone
const gone = docFrom(`<!doctype html><body><h1>Page not found</h1></body>`);
r = PW.resolve(gone, sel);
eq("reports failure when truly absent", r.ok, false);

console.log("\n4. Star Tech markup specifically");
const st = docFrom(`<!doctype html><body><div class="product-short-info">
  <h1 itemprop="name" class="product-name">Lenovo IdeaPad 1 15AMN7</h1>
  <table class="product-info-table"><tbody>
  <tr class="product-info-group"><td class="product-info-label">Price</td>
  <td class="product-info-data product-price"><ins>81,000৳</ins><del>86,000৳</del></td></tr>
  <tr class="product-info-group"><td class="product-info-label">Status</td>
  <td class="product-info-data product-status">In Stock</td></tr>
  </tbody></table></div></body>`);
const stTarget = st.querySelector("td.product-price ins");
const stSel = PW.buildSelectors(stTarget);
eq("star tech value", stSel.sampleValue, 81000);
const stLater = docFrom(st.documentElement.outerHTML.replace("81,000", "74,500"));
r = PW.resolve(stLater, stSel);
eq("star tech re-read after a drop", [r.ok, r.value], [true, 74500]);

// (e) itemprop removed too, so only the class scan can save it
const noProp = docFrom(`<!doctype html><body><div id="wrapper">
  <section class="card-v3"><h1>Wireless Mouse</h1>
  <div class="pricing"><span class="was">3,500\u09f3</span>
  <span class="now">2,200\u09f3</span></div></section></div></body>`);
r = PW.resolve(noProp, sel);
eq("class scan catches it when everything else breaks", [r.ok, r.value], [true, 2200]);
console.log("        matched by:", r.matchedBy);

// (f) ambiguity must not produce a confident wrong answer
// Two candidates of similar magnitude: there is no honest way to choose.
const ambiguous = docFrom(`<!doctype html><body><div id="wrapper">
  <span class="thing">2,200\u09f3</span><span class="thing">3,100\u09f3</span></div></body>`);
r = PW.resolve(ambiguous, sel);
eq("refuses to guess between two equally plausible numbers", r.ok, false);

// A single plausible number is used, but flagged as a loose match.
const loose = docFrom(`<!doctype html><body><div id="wrapper">
  <span class="thing">2,200\u09f3</span><span class="thing">Free shipping</span></div></body>`);
r = PW.resolve(loose, sel);
eq("loose match is used but marked", [r.ok, r.value, r.loose], [true, 2200, true]);
eq("structural matches are not marked loose", PW.resolve(changed, sel).loose, false);

console.log("\n5. stock status");
const stOut = docFrom(st.documentElement.outerHTML.replace(">In Stock<", ">Out Of Stock<"));
eq("star tech in stock (text near price)", PW.detectStock(st, st.querySelector("td.product-price ins")).stock, "in");
eq("star tech out of stock", PW.detectStock(stOut, stOut.querySelector("td.product-price ins")).stock, "out");
const ld = docFrom(`<!doctype html><head><script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"X",
   "offers":{"@type":"Offer","price":"10","availability":"https://schema.org/OutOfStock"}}
  </script></head><body><h1>X</h1><span class="p">10৳</span> In stock</body>`);
eq("json-ld beats page text", [PW.detectStock(ld, null).stock, PW.detectStock(ld, null).stockBy], ["out", "json-ld"]);
const brokenLd = docFrom(`<!doctype html><head><script type="application/ld+json">{oops</script></head>
  <body><div><h1>X</h1><button>Add to cart</button></div></body>`);
eq("broken json-ld ignored, button text used", PW.detectStock(brokenLd, null).stock, "in");
const itemprop = docFrom(`<!doctype html><body><div><link itemprop="availability" href="http://schema.org/InStock"><span>5$</span></div></body>`);
eq("itemprop availability", PW.detectStock(itemprop, null).stock, "in");
const bangla = docFrom(`<!doctype html><body><div class="box"><h1>পণ্য</h1><span>৳১,২০০</span><p>স্টকে নেই</p></div></body>`);
eq("bangla out of stock", PW.detectStock(bangla, bangla.querySelector("span")).stock, "out");
const nothing = docFrom(`<!doctype html><body><div><span>5$</span></div></body>`);
eq("unknown when nothing says", PW.detectStock(nothing, nothing.querySelector("span")).stock, "");
const notAvail = docFrom(`<!doctype html><body><div><span>5$</span> Not available</div></body>`);
eq("'not available' is out, never in", PW.detectStock(notAvail, notAvail.querySelector("span")).stock, "out");

// Shop hides the price entirely when the product is out of stock.
const hidden = docFrom(`<!doctype html><body><div class="product-short-info">
  <h1 class="product-name">Lenovo IdeaPad 1 15AMN7</h1>
  <table class="product-info-table"><tbody><tr><td>Status</td><td>Out Of Stock</td></tr></tbody></table></div></body>`);
r = PW.read(hidden, stSel);
eq("price hidden + out of stock is a valid reading", [r.ok, r.value, r.stock], [true, null, "out"]);
r = PW.read(stLater, stSel);
eq("read() returns price and stock together", [r.ok, r.value, r.stock], [true, 74500, "in"]);
eq("read() result has no DOM node in it", "el" in r, false);

console.log("\n6. price database CSV");
const csv = PW.logToCsv([
  { name: 'Laptop 15", "Pro"', url: "https://x.com/a?b=1,2", t: new Date(2026, 9, 11, 9, 5).getTime(), price: 74500, stock: "in" },
  { name: "মাউস", url: "https://x.com/m", t: new Date(2026, 9, 12, 18, 30).getTime(), price: null, stock: "out" },
]);
const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
eq("starts with BOM for Excel", csv.charCodeAt(0), 0xfeff);
eq("header", lines[0], "Product name,Product Link,Date,Price,Stock");
eq("quotes and commas escaped", lines[1], '"Laptop 15"", ""Pro""","https://x.com/a?b=1,2",2026-10-11 09:05,74500,In stock');
eq("empty price when hidden, Bangla kept", lines[2], "মাউস,https://x.com/m,2026-10-12 18:30,,Out of stock");

console.log("\n7. helpers");
eq("origin", PW.originOf("https://www.startech.com.bd/x/y?z=1"), "https://www.startech.com.bd");
eq("host strips www", PW.hostOf("https://www.startech.com.bd/x"), "startech.com.bd");

console.log("\n" + "=".repeat(56));
if (fails) {
  console.log(fails + " FAILURE(S)");
  process.exit(1);
}
console.log("All unit tests passed.");
