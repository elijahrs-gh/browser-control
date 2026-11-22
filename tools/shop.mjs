#!/usr/bin/env node
// Helium Shopper CLI. Every browser step goes through `openclaw browser`
// against the extension profile (default "chrome", i.e. Helium once the
// extension is loaded there). Output is compact JSON for the agent.
import { parseArgs } from "node:util";
import { DEFAULT_RETAILERS, KIMI_REFERENCE, classifySample, computeTps, fallbackSearchTemplates, fillSearchTemplate, productIdentity, publicHttpUrl, rankRetailers, resolveSite, searchUrl, verifyProduct } from "../shopper/core.mjs";
import { clickRef, discoverSearchTemplates, interactiveRefs, listTabs, openLabeledTab, readTab, tabHandle, typeRef } from "../shopper/browser.mjs";
import { stageDemoWindows } from "../shopper/stage.mjs";
import { appendJsonl, createRun, readJson, readJsonl, resolveRun, writeJson } from "../shopper/runs.mjs";

const USAGE = `Usage: shop.mjs <command> [options]
  search  [--site <store>] [--query <q>]                 New run: search one store, list candidates c1..cN
          <store> is a built-in id (etsy, amazon, walmart, target, bestbuy), any store's
          domain (uncommongoods.com), or a URL (a search URL may contain {query})
  pick    --run <id> --ids c1,c4,...                     Verify picks in parallel into open gift slots; prints final list
  start   --query <q> [--purpose demo|bounty|test]      Create a run directory
  tabs                                                   List tabs (official handles)
  bench   --run <id> [--rounds 1-3] [--retailers amazon,etsy,example.com,...] [--query <q>]
  read    --run <id> --tab <handle> [--max-products N] [--max-chars N] [--markdown]
  open    --run <id> --url <url> --label <shop-...>      Open a labeled tab, then read it
  stage   [--site <store>]                                Demo layout: OpenClaw chat left, retailer window right
  verify  --run <id> --url <product url> --title <observed title> [--slot 1-5]
  report  --run <id>                                     Final list of verified gifts
  tps     --run <id> --output-tokens N --first-ms A --last-ms B --source official_speed_patch|standard_openclaw`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: "string" }, query: { type: "string" }, purpose: { type: "string" },
    rounds: { type: "string" }, retailers: { type: "string" }, tab: { type: "string" },
    url: { type: "string" }, label: { type: "string" }, title: { type: "string" }, slot: { type: "string" },
    "max-products": { type: "string" }, "max-chars": { type: "string" }, markdown: { type: "boolean" },
    site: { type: "string" }, ids: { type: "string" },
    "output-tokens": { type: "string" }, "first-ms": { type: "string" }, "last-ms": { type: "string" }, source: { type: "string" },
  },
});
const int = (value, fallback, min, max) => {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer ${min}-${max}, got ${value}`);
  return parsed;
};
const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 1)}\n`);

/** What the model sees from a read: bounded, no page code, provenance attached. */
function projectRead(read, { markdown = false, maxProducts = 10 } = {}) {
  return {
    tab: read.tab,
    url: read.url,
    title: read.title,
    blocked: read.blocked,
    extractedAt: read.extractedAt,
    products: read.products.slice(0, maxProducts).map(({ evidence, ...rest }) => rest),
    ...(read.page ? { page: { name: read.page.name, price: read.page.structured?.price ?? read.page.visiblePrices?.[0] ?? null, availability: read.page.structured?.availability || read.page.availabilityText || null } } : {}),
    ...(markdown ? { markdown: read.markdown, truncated: read.truncated } : {}),
  };
}

async function recordCandidates(run, read, { withCids = false } = {}) {
  for (const [index, product] of read.products.entries()) {
    await appendJsonl(run, "candidates.jsonl", { ...(withCids ? { cid: `c${index + 1}` } : {}), ...product, id: productIdentity(product.url), sourceUrl: read.url, tab: read.tab, observedAt: read.extractedAt });
  }
}

/**
 * Reopen an observed candidate in its gift-slot tab and check it is the same
 * live product. `stage` pre-opens shop-gift-1..5 in the retailer window so
 * these navigations stay out of the chat window.
 */
const GIFT_LABEL = process.env.SHOP_GIFT_LABEL || "shop-gift";
async function verifyCandidate(run, observed, title, slot, label = `${GIFT_LABEL}-${slot}`) {
  const tab = await openLabeledTab(observed.url, label);
  const read = await readTab(tab.handle, { maxProducts: 0, maxChars: 400, needPage: true });
  const verdict = verifyProduct({ title, url: observed.url }, read);
  const record = {
    slot, status: verdict.status, reasons: verdict.reasons, title, observedTitle: observed.title,
    url: observed.url, merchant: observed.merchant, observedPrices: observed.prices, sourceUrl: observed.sourceUrl,
    sourceTab: observed.tab, observedAt: observed.observedAt, verifyTab: tab.handle, verifiedUrl: read.url, ...verdict.facts,
  };
  await appendJsonl(run, "gifts.jsonl", record);
  return record;
}

async function latestGifts(run) {
  const latest = new Map();
  for (const gift of await readJsonl(run, "gifts.jsonl")) latest.set(gift.slot, gift);
  return [...latest.values()].sort((a, b) => a.slot - b.slot);
}

const giftLine = (gift) => ({
  slot: gift.slot, status: gift.status, name: gift.name ?? gift.title, price: gift.price ?? gift.observedPrices?.[0] ?? null, url: gift.url,
  ...(gift.status === "verified" ? {} : { reasons: gift.reasons }),
});

const SEARCH_BOX = (r) => r.role === "searchbox" || (/^(?:textbox|combobox)$/.test(r.role) && /search|find|looking for/i.test(r.name ?? ""));
const CLOSE_POPUP = /^(?:close|dismiss|no,? thanks|not now|maybe later|×|x)\b|close (?:modal|dialog|pop-?up|banner)/i;
const OPEN_SEARCH = /^(?:open |show )?search\b|search (?:icon|button|toggle)/i;

/**
 * Search the way a person would, through official snapshot refs: find the
 * search box (dismissing a pop-up or opening a search toggle first if
 * needed), type the query and press Enter. Returns the URL it landed on.
 */
async function searchByTyping(handle, query) {
  const clicked = new Set();
  let refs = await interactiveRefs(handle);
  const box = () => Object.entries(refs).find(([, r]) => SEARCH_BOX(r))?.[0];
  for (let step = 0; step < 3 && !box(); step++) {
    const entries = Object.entries(refs).filter(([ref]) => !clicked.has(ref));
    const target = entries.find(([, r]) => r.role === "button" && CLOSE_POPUP.test(r.name ?? ""))
      ?? entries.find(([, r]) => /^(?:button|link)$/.test(r.role) && OPEN_SEARCH.test(r.name ?? ""));
    if (!target) break;
    clicked.add(target[0]);
    await clickRef(handle, target[0]).catch(() => {});
    refs = await interactiveRefs(handle);
  }
  const ref = box();
  if (!ref) return null;
  const typed = await typeRef(handle, ref, query, { submit: true });
  return typed?.url ?? null;
}

/** Turn a search results URL back into a `{query}` template, if the query appears in it. */
function templateFrom(url, query) {
  for (const encoded of [encodeURIComponent(query), encodeURIComponent(query).replace(/%20/g, "+")]) {
    if (url?.includes(encoded)) return url.replace(encoded, "{query}");
  }
  return null;
}

/**
 * Open the store's search results for `query` in the labeled tab and read them.
 * Built-in stores use their known search URL. Other stores, in order: search
 * URLs the home page declares (schema.org, OpenSearch, search forms), typing
 * into the site's search box, common defaults, and finally the home page's
 * own products. Stops at the first page that yields products or is blocked.
 */
async function openSearch(site, query, label, readOptions) {
  const tried = [];
  const attempt = async (url) => {
    const tab = await openLabeledTab(url, label);
    const read = await readTab(tab.handle, readOptions);
    tried.push({ url: read.url, products: read.products.length, ...(read.blocked ? { blocked: read.blocked.kind } : {}) });
    return read;
  };
  if (site.startUrl) return { read: await attempt(fillSearchTemplate(site.startUrl, query, site.origin)), template: site.startUrl, tried };
  if (site.known) return { read: await attempt(searchUrl(site.origin, query)), template: null, tried };
  const home = await openLabeledTab(`${site.origin}/`, label);
  const found = await discoverSearchTemplates(home.handle).catch(() => ({ templates: [] }));
  // Follow the store wherever its home page landed (brand.com -> www.brand.co.uk, etc.).
  const landed = URL.parse(found.url ?? "");
  if (!landed || !/^https?:$/.test(landed.protocol)) throw new Error(`Could not open ${site.origin}. Pass the store's exact domain or a URL as --site.`);
  site.origin = landed.origin;
  site.merchant = landed.hostname.replace(/^www\./, "");
  const done = (read, template) => read && (read.products.length || read.blocked) ? { read, template, tried, discovered: found.templates } : null;
  // A failed load just moves on to the next approach.
  const tryUrl = async (template) => {
    try { return await attempt(fillSearchTemplate(template, query, site.origin)); } catch (error) {
      tried.push({ template, error: String(error.message).slice(0, 160) });
      return null;
    }
  };
  for (const template of found.templates.map((t) => t.template).slice(0, 3)) {
    const result = done(await tryUrl(template), template);
    if (result) return result;
  }
  if (tried.length) await openLabeledTab(`${site.origin}/`, label);
  const landedOn = await searchByTyping(home.handle, query).catch(() => null);
  if (landedOn) {
    const read = await readTab(home.handle, readOptions);
    tried.push({ url: read.url, products: read.products.length, typed: true, ...(read.blocked ? { blocked: read.blocked.kind } : {}) });
    const result = done(read, templateFrom(read.url, query));
    if (result) return result;
  }
  for (const template of fallbackSearchTemplates(site.origin)) {
    const result = done(await tryUrl(template), template);
    if (result) return result;
  }
  // No search page yielded products: use what the home page itself shows.
  return { read: await attempt(`${site.origin}/`), template: null, tried, discovered: found.templates };
}

const commands = {
  async start() {
    if (!values.query) throw new Error("--query is required");
    const dir = await createRun({ query: values.query, purpose: values.purpose ?? "demo" });
    out({ run: dir.split("/").at(-1), dir });
  },

  async tabs() {
    out((await listTabs()).map((tab) => ({ handle: tabHandle(tab), label: tab.label ?? null, title: tab.title, url: tab.url })));
  },

  async bench() {
    const run = await resolveRun(values.run);
    const meta = await readJson(run, "run.json");
    const query = values.query ?? meta.query;
    const wanted = values.retailers?.split(",").map((value) => value.trim()).filter(Boolean);
    const retailers = wanted ? wanted.map((value) => resolveSite(value)) : DEFAULT_RETAILERS.map((retailer) => resolveSite(retailer.id));
    const rounds = int(values.rounds, 1, 1, 3);
    const samples = [];
    for (let round = 0; round < rounds; round++) {
      // Alternate order so no retailer always goes first.
      const order = round % 2 ? [...retailers].reverse() : retailers;
      for (const retailer of order) {
        const label = `shop-bench-${retailer.id}`;
        const started = performance.now();
        const sample = { round, retailer: retailer.id, merchant: retailer.merchant, tab: label };
        try {
          const { read, template } = await openSearch(retailer, query, label, { maxProducts: 12, maxChars: 600, minProducts: 4 });
          // Later rounds go straight to the search URL found in the first one.
          if (template && !retailer.startUrl && read.products.length) retailer.startUrl = template;
          sample.requestedUrl = read.url;
          sample.wallMs = Math.round(performance.now() - started);
          Object.assign(sample, {
            observedUrl: read.url, title: read.title, blocked: read.blocked, candidates: read.products.length,
            domContentLoadedMs: read.timing?.domContentLoadedMs ?? null, ttfbMs: read.timing?.ttfbMs ?? null,
            loadMs: read.timing?.loadMs ?? null, extractMs: read.extractMs, extractedAt: read.extractedAt,
          }, classifySample(read));
          if (sample.ok) await recordCandidates(run, read);
        } catch (error) {
          Object.assign(sample, { ok: false, reason: "error", error: String(error.message).slice(0, 300), wallMs: Math.round(performance.now() - started), candidates: 0 });
        }
        samples.push(sample);
        await appendJsonl(run, "bench-samples.jsonl", sample);
      }
    }
    const ranking = rankRetailers(samples);
    const result = {
      query, rounds, measuredAt: new Date().toISOString(),
      method: "Per sample: official open/navigate of a labeled tab, wait for DOMContentLoaded, then the fixed reader. Ranked by browser-measured Navigation Timing domContentLoadedEventEnd (median over successful samples). Interstitials and zero-candidate pages are failures. Browser latency is not inference TPS.",
      ranking, samples,
    };
    await writeJson(run, "benchmarks.json", result);
    out({ query, rounds, fastest: ranking.find((row) => row.successes > 0)?.retailer ?? null, ranking: ranking.map(({ failures, ...row }) => ({ ...row, failures: [...new Set(failures)] })) });
  },

  async read() {
    const run = await resolveRun(values.run);
    if (!values.tab) throw new Error("--tab is required (a handle from `tabs` or `bench`)");
    const maxProducts = int(values["max-products"], 10, 0, 30);
    const read = await readTab(values.tab, { maxProducts, maxChars: int(values["max-chars"], 3000, 400, 12000) });
    await recordCandidates(run, read);
    await appendJsonl(run, "reads.jsonl", { tab: read.tab, url: read.url, blocked: read.blocked, productCount: read.products.length, extractedAt: read.extractedAt });
    out(projectRead(read, { markdown: values.markdown, maxProducts }));
  },

  async open() {
    const run = await resolveRun(values.run);
    if (!values.url || !values.label?.startsWith("shop-")) throw new Error("--url and a --label starting with shop- are required");
    const tab = await openLabeledTab(publicHttpUrl(values.url), values.label);
    const read = await readTab(tab.handle, { maxProducts: int(values["max-products"], 10, 0, 30), minProducts: 1 });
    await recordCandidates(run, read);
    out(projectRead(read, { markdown: values.markdown }));
  },

  async verify() {
    const run = await resolveRun(values.run);
    if (!values.url || !values.title) throw new Error("--url and --title (as observed) are required");
    const url = publicHttpUrl(values.url);
    const observed = (await readJsonl(run, "candidates.jsonl")).find((candidate) => candidate.url === url || (candidate.id && candidate.id === productIdentity(url)));
    if (!observed) throw new Error("URL was never observed on a live page in this run. Only observed candidates can be saved.");
    out(await verifyCandidate(run, observed, values.title, int(values.slot, 1, 1, 5)));
  },

  async stage() {
    const site = resolveSite(values.site ?? "etsy");
    out(await stageDemoWindows({ retailerUrl: `${site.origin}/`, label: `shop-search-${site.id}`, giftLabels: [1, 2, 3, 4, 5].map((slot) => `${GIFT_LABEL}-${slot}`) }));
  },

  async search() {
    const site = resolveSite(values.site ?? "etsy");
    const query = values.query ?? "christmas gifts";
    const run = await createRun({ query, purpose: values.purpose ?? "demo" });
    const { read, tried } = await openSearch(site, query, `shop-search-${site.id}`, { maxProducts: 16, maxChars: 400, minProducts: 8 });
    await recordCandidates(run, read, { withCids: true });
    await appendJsonl(run, "reads.jsonl", { tab: read.tab, url: read.url, blocked: read.blocked, productCount: read.products.length, extractedAt: read.extractedAt, tried });
    out({
      run: run.split("/").at(-1), site: site.merchant, url: read.url, blocked: read.blocked,
      ...(!read.products.length && !read.blocked ? { note: "No products found. Try a more specific --query, or pass the store's search results URL as --site." } : {}),
      candidates: read.products.map((product, index) => ({
        id: `c${index + 1}`, title: product.title, price: product.prices[0] ?? null,
        ...(product.rating ? { rating: product.rating } : {}), ...(product.sponsored ? { ad: true } : {}),
      })),
    });
  },

  async pick() {
    const run = await resolveRun(values.run);
    const ids = [...new Set((values.ids ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) throw new Error("--ids is required, e.g. --ids c1,c3,c4,c7,c9");
    const candidates = await readJsonl(run, "candidates.jsonl");
    const verified = new Set((await latestGifts(run)).filter((gift) => gift.status === "verified").map((gift) => gift.slot));
    const openSlots = [1, 2, 3, 4, 5].filter((slot) => !verified.has(slot));
    if (ids.length > openSlots.length) throw new Error(`Only ${openSlots.length} gift slot(s) open; pass at most that many ids.`);
    const picks = ids.map((id) => {
      const observed = candidates.findLast((candidate) => candidate.cid === id);
      if (!observed) throw new Error(`${id} was not observed in this run's search results.`);
      return observed;
    });
    await Promise.all(picks.map((observed, index) => verifyCandidate(run, observed, observed.title, openSlots[index])));
    const gifts = await latestGifts(run);
    const done = gifts.filter((gift) => gift.status === "verified");
    await writeJson(run, "report.json", { ...(await readJson(run, "run.json")), verifiedCount: done.length, gifts: gifts.map(giftLine), reference: KIMI_REFERENCE.label });
    out({
      run: run.split("/").at(-1), verified: done.length,
      gifts: gifts.map(giftLine),
      ...(done.length < 5 ? { next: `Pick ${5 - done.length} more ids from the search candidates to fill the remaining slots.` } : {}),
    });
  },

  async report() {
    const run = await resolveRun(values.run);
    const gifts = await latestGifts(run);
    const bench = await readJson(run, "benchmarks.json").catch(() => null);
    const performance = await readJson(run, "performance.json").catch(() => null);
    const report = {
      run: run.split("/").at(-1), ...(await readJson(run, "run.json")),
      fastestRetailer: bench?.ranking?.find((row) => row.successes > 0) ?? null,
      verifiedCount: gifts.filter((gift) => gift.status === "verified").length,
      gifts: gifts.map((gift) => ({ slot: gift.slot, status: gift.status, name: gift.name ?? gift.title, merchant: gift.merchant, price: gift.price, availability: gift.availability, url: gift.url, reasons: gift.reasons })),
      performance,
      reference: KIMI_REFERENCE.label,
    };
    await writeJson(run, "report.json", report);
    out(report);
  },

  async tps() {
    const run = await resolveRun(values.run);
    if (!["official_speed_patch", "standard_openclaw"].includes(values.source)) throw new Error("--source must be official_speed_patch or standard_openclaw");
    const input = {
      outputTokens: int(values["output-tokens"], undefined, 2, 10_000_000),
      firstTokenMs: Number(values["first-ms"]),
      lastTokenMs: Number(values["last-ms"]),
    };
    const tps = computeTps(input);
    const record = {
      source: values.source, ...input, tps: Math.round(tps * 10) / 10,
      formula: "(outputTokens - 1) / ((lastTokenMs - firstTokenMs) / 1000)",
      note: "Inference telemetry only; independent of browser benchmark timing.",
      reference: KIMI_REFERENCE,
      recordedAt: new Date().toISOString(),
    };
    await writeJson(run, "performance.json", record);
    out(record);
  },
};

const command = commands[positionals[0]];
if (!command) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(positionals[0] ? 2 : 0);
}
try {
  await command();
} catch (error) {
  out({ ok: false, error: String(error?.message ?? error) });
  process.exit(1);
}
