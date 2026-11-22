import assert from "node:assert/strict";
import test from "node:test";
import { classifySample, computeTps, fillSearchTemplate, productIdentity, publicHttpUrl, rankRetailers, resolveSite, searchUrl, siteKey, titleOverlap, verifyProduct } from "../shopper/core.mjs";

test("search URLs per retailer", () => {
  assert.equal(searchUrl("https://www.amazon.com", "cozy gifts"), "https://www.amazon.com/s?k=cozy+gifts");
  assert.equal(searchUrl("https://www.target.com/x?y=1", "mug"), "https://www.target.com/s?searchTerm=mug");
  assert.equal(searchUrl("https://www.bestbuy.com", "lego"), "https://www.bestbuy.com/site/searchpage.jsp?st=lego");
});

test("public URL guard", () => {
  for (const bad of ["file:///etc/passwd", "http://localhost:18789/", "http://127.0.0.1/", "https://user:pw@amazon.com/", "http://printer.local/"]) {
    assert.throws(() => publicHttpUrl(bad));
  }
  assert.equal(publicHttpUrl("https://www.etsy.com/listing/123456#reviews"), "https://www.etsy.com/listing/123456");
});

test("product identities", () => {
  assert.equal(productIdentity("https://www.amazon.com/Foo/dp/B0ABCDEFGH/ref=x"), "amazon.com:B0ABCDEFGH");
  assert.equal(productIdentity("https://www.walmart.com/ip/Thing/123456789"), "walmart.com:123456789");
  assert.equal(productIdentity("https://www.target.com/p/thing/-/A-87654321"), "target.com:87654321");
  assert.equal(productIdentity("https://www.etsy.com/listing/1234567/thing"), "etsy.com:1234567");
  assert.equal(productIdentity("https://www.bestbuy.com/site/thing/6501234.p?skuId=6501234"), "bestbuy.com:6501234");
  assert.equal(productIdentity("https://example.com/whatever"), null);
});

test("interstitials and empty pages are failures, not fast successes", () => {
  assert.deepEqual(classifySample({ blocked: { kind: "captcha" }, products: [{}] }), { ok: false, reason: "interstitial:captcha" });
  assert.equal(classifySample({ blocked: null, products: [] }).ok, false);
  const ranking = rankRetailers([
    { retailer: "a", ok: false, reason: "interstitial:captcha", wallMs: 100, domContentLoadedMs: 50 },
    { retailer: "b", ok: true, wallMs: 4000, domContentLoadedMs: 900, extractMs: 20 },
    { retailer: "b", ok: true, wallMs: 4200, domContentLoadedMs: 700, extractMs: 30 },
    { retailer: "c", ok: true, wallMs: 3000, domContentLoadedMs: 1500, extractMs: 10 },
  ]);
  assert.deepEqual(ranking.map((row) => row.retailer), ["b", "c", "a"]);
  assert.equal(ranking[0].medianDomContentLoadedMs, 800);
  assert.equal(ranking[0].minDomContentLoadedMs, 700);
  assert.equal(ranking[2].successes, 0);
});

test("verification requires identity, title, and price; navigation alone is not enough", () => {
  const candidate = { title: "Fixture Ceramic Mug Set of 2", url: "https://www.amazon.com/dp/B0FIXTURE2" };
  const good = {
    url: "https://www.amazon.com/dp/B0FIXTURE2", canonicalUrl: "https://www.amazon.com/dp/B0FIXTURE2", title: "x", blocked: null, extractedAt: "t",
    page: { name: "Fixture Ceramic Mug Set of 2, 14 oz", structured: { price: "18.50", currency: "USD", availability: "InStock" }, visiblePrices: [] },
  };
  assert.equal(verifyProduct(candidate, good).status, "verified");
  assert.deepEqual(verifyProduct(candidate, { ...good, url: "https://www.amazon.com/dp/B0OTHERONE", canonicalUrl: "https://www.amazon.com/dp/B0OTHERONE" }).reasons, ["product-id-mismatch"]);
  assert.ok(verifyProduct(candidate, { ...good, page: { ...good.page, name: "Bluetooth Speaker" } }).reasons.includes("title-mismatch"));
  assert.ok(verifyProduct(candidate, { ...good, page: { name: good.page.name, visiblePrices: [] } }).reasons.includes("no-price-observed"));
  assert.ok(verifyProduct(candidate, { ...good, blocked: { kind: "captcha" } }).reasons.includes("interstitial:captcha"));
  assert.equal(verifyProduct(candidate, { ...good, page: { ...good.page, structured: { ...good.page.structured, availability: "OutOfStock" } } }).status, "unavailable");
  assert.ok(titleOverlap("Sherpa Throw Blanket Grey", "Grey Sherpa Throw Blanket 50x60") >= 0.99);
});

test("TPS formula", () => {
  assert.equal(computeTps({ outputTokens: 1001, firstTokenMs: 1000, lastTokenMs: 2000 }), 1000);
  assert.throws(() => computeTps({ outputTokens: 1, firstTokenMs: 0, lastTokenMs: 1 }));
  assert.throws(() => computeTps({ outputTokens: 10, firstTokenMs: 5, lastTokenMs: 5 }));
});

test("any store by id, domain or URL", () => {
  assert.equal(resolveSite("etsy").known, true);
  assert.deepEqual(resolveSite("uncommongoods.com"), { id: "uncommongoods-com", merchant: "uncommongoods.com", origin: "https://uncommongoods.com", known: false, startUrl: null });
  assert.equal(resolveSite("https://www.amazon.co.uk").id, "amazon", "regional domains of built-in stores keep their search URL");
  assert.equal(resolveSite("https://shop.example/search?q={query}").startUrl, "https://shop.example/search?q={query}");
  assert.equal(resolveSite("Uncommon Goods").origin, "https://uncommongoods.com", "store names become <name>.com");
  assert.equal(resolveSite("Crate & Barrel").origin, "https://crateandbarrel.com");
  assert.equal(resolveSite("Best Buy").id, "bestbuy");
  assert.throws(() => resolveSite("http://localhost:3000"));
  assert.equal(siteKey("www.amazon.co.uk"), "amazon.co.uk");
  assert.equal(siteKey("shop.example.com"), "example.com");
  assert.equal(searchUrl("https://www.amazon.co.uk", "mug"), "https://www.amazon.co.uk/s?k=mug");
  assert.equal(productIdentity("https://www.amazon.co.uk/dp/B0ABCDEFGH"), "amazon.co.uk:B0ABCDEFGH");
});

test("search templates stay on the store's site", () => {
  assert.equal(fillSearchTemplate("https://shop.example/find?term={query}", "wool scarf", "https://shop.example"), "https://shop.example/find?term=wool+scarf");
  assert.throws(() => fillSearchTemplate("https://evil.example/?q={query}", "x", "https://shop.example"), /leaves the store/);
});

test("other stores verify on title, page name and price", () => {
  const candidate = { title: "Fixture Hand Knit Wool Scarf", url: "https://shop.example/gifts/hand-knit-wool-scarf" };
  const read = { url: candidate.url, canonicalUrl: candidate.url, title: "Scarf", blocked: null, page: { name: "Fixture Hand Knit Wool Scarf", visiblePrices: ["38.00 USD"], addToCartVisible: true } };
  assert.equal(verifyProduct(candidate, read).status, "verified");
  assert.equal(verifyProduct(candidate, { ...read, url: "https://other.example/gifts/hand-knit-wool-scarf" }).status, "unverified");
  assert.equal(verifyProduct(candidate, { ...read, title: "Ceramic Mug", page: { ...read.page, name: "Ceramic Mug" } }).status, "unverified");
});
