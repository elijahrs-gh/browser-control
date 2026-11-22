// Runs the page-side reader against TEST-ONLY fixtures in a throwaway,
// headless Helium profile. Network is fully intercepted; nothing is fetched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { readerFunctionSource } from "../shopper/reader.js";

const executablePath = process.env.READER_TEST_BROWSER || "/Applications/Helium.app/Contents/MacOS/Helium";
const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");

test("reader on fixtures", { skip: !fs.existsSync(executablePath) && "no Chromium binary" }, async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shopper-reader-test-"));
  const context = await chromium.launchPersistentContext(userDataDir, { executablePath, headless: true, args: ["--no-first-run", "--disable-extensions"] });
  t.after(async () => { await context.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const body = url.hostname.endsWith("etsy.com") ? fixture(url.pathname === "/search" ? "etsy-search.html" : "etsy-listing.html")
      : url.pathname === "/s" ? fixture("search.html") : url.hostname === "captcha.fixture.test" ? fixture("captcha.html") : url.pathname.includes("/dp/") ? fixture("product.html") : null;
    return body ? route.fulfill({ status: 200, contentType: "text/html", body }) : route.abort();
  });
  const page = await context.newPage();
  // Mirror OpenClaw's evaluate path: eval the fn source, then call it.
  // Helium sometimes aborts one load a few seconds after startup (ERR_ABORTED); retry it once.
  const open = (url) => page.goto(url).catch((error) => {
    if (!/ERR_ABORTED/.test(error.message)) throw error;
    return page.goto(url);
  });
  const run = (options) => page.evaluate((source) => (0, eval)(`(${source})`)(), readerFunctionSource(options));

  await open("https://captcha.fixture.test/");
  const blocked = await run({});
  assert.equal(blocked.blocked?.kind, "captcha");

  await open("https://www.amazon.com/s?k=cozy+gifts");
  const search = await run({ maxProducts: 10, maxChars: 2000 });
  assert.equal(search.blocked, null);
  assert.deepEqual(search.products.map((p) => p.url), ["https://www.amazon.com/dp/B0FIXTURE1", "https://www.amazon.com/dp/B0FIXTURE2"]);
  assert.equal(search.products[0].title, "Fixture Sherpa Throw Blanket, Grey");
  assert.deepEqual(search.products[0].prices, ["$24.99"]);
  assert.equal(search.products[0].sponsored, true);
  assert.equal(search.products[0].rating, 4.6);
  assert.equal(search.products[1].sponsored, false);
  assert.deepEqual(search.products[1].prices, ["$18.50"]);
  assert.ok(!search.markdown.includes("Nav product") && !search.markdown.includes("Footer product") && !search.markdown.includes("Hidden product"));
  assert.ok(search.markdown.includes("[Fixture Ceramic Mug Set of 2](https://www.amazon.com/dp/B0FIXTURE2)"));
  assert.ok(!search.markdown.includes("Customer service]("), "non-product links render as text only");
  assert.ok(!JSON.stringify(search).includes("password"));
  assert.ok(search.timing && typeof search.extractMs === "number");

  await open("https://www.amazon.com/Fixture-Mug/dp/B0FIXTURE2?tag=aff-20");
  const product = await run({ maxProducts: 0 });
  assert.equal(product.url, "https://www.amazon.com/dp/B0FIXTURE2");
  assert.equal(product.page.name, "Fixture Ceramic Mug Set of 2, 14 oz");
  assert.equal(product.page.structured.price, "18.50");
  assert.equal(product.page.structured.availability, "InStock");
  assert.equal(product.page.addToCartVisible, true);

  await open("https://www.etsy.com/search?q=christmas+gifts");
  const etsy = await run({ maxProducts: 10, minProducts: 2, waitMs: 1000 });
  assert.deepEqual(etsy.products.map((p) => p.url), [
    "https://www.etsy.com/listing/2222222222/fixture-personalized-ornament",
    "https://www.etsy.com/listing/3333333333/fixture-knit-scarf",
  ]);
  assert.equal(etsy.products[0].title, "Fixture Personalized Wooden Ornament");
  assert.equal(etsy.products[0].sponsored, true);
  assert.equal(etsy.products[1].sponsored, false);
  assert.deepEqual(etsy.products[1].prices, ["$38.00"]);

  await open("https://www.etsy.com/listing/3333333333/fixture-knit-scarf?ref=sr_gallery-1-2");
  const listing = await run({ maxProducts: 0, needPage: true, waitMs: 1000 });
  assert.equal(listing.url, "https://www.etsy.com/listing/3333333333/fixture-knit-scarf");
  assert.equal(listing.page.name, "Fixture Hand Knit Wool Scarf");
  assert.equal(listing.page.structured.price, "38.00");

});
