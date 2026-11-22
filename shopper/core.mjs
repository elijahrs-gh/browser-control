// Pure shopping logic: no browser, no filesystem. Unit-tested in tests/core.test.mjs.

/** Built-in stores with known search URLs and product IDs. Any other store works by domain or URL (see resolveSite). */
export const DEFAULT_RETAILERS = [
  { id: "amazon", merchant: "Amazon", origin: "https://www.amazon.com" },
  { id: "etsy", merchant: "Etsy", origin: "https://www.etsy.com" },
  { id: "walmart", merchant: "Walmart", origin: "https://www.walmart.com" },
  { id: "target", merchant: "Target", origin: "https://www.target.com" },
  { id: "bestbuy", merchant: "Best Buy", origin: "https://www.bestbuy.com" },
];

const SEARCH = {
  "amazon.com": ["/s", "k"],
  "walmart.com": ["/search", "q"],
  "target.com": ["/s", "searchTerm"],
  "etsy.com": ["/search", "q"],
  "bestbuy.com": ["/site/searchpage.jsp", "st"],
  "ebay.com": ["/sch/i.html", "_nkw"],
};

// Two-label public suffixes such as co.uk or com.au; enough to keep amazon.co.uk apart from other.co.uk.
const MULTI_PART_SUFFIX = /^(?:co|com|org|net|ac|gov|edu|ne|or|gob)\.[a-z]{2}$/;
export function siteKey(hostname) {
  const parts = hostname.toLowerCase().replace(/\.$/, "").split(".");
  const two = parts.slice(-2).join(".");
  return parts.length > 2 && MULTI_PART_SUFFIX.test(two) ? parts.slice(-3).join(".") : two;
}
const brandOf = (site) => site.split(".")[0];

/** Public HTTP(S) only; no credentials, no local hosts. OpenClaw's SSRF policy still applies. */
export function publicHttpUrl(raw) {
  const url = URL.parse(String(raw ?? "").trim());
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Not a public HTTP(S) URL: ${String(raw).slice(0, 120)}`);
  }
  const host = url.hostname;
  if (host === "localhost" || /\.(?:localhost|local|internal)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(":")) {
    throw new Error("Shopping tools only open public retailer hostnames.");
  }
  url.hash = "";
  return url.toString();
}

export function searchUrl(origin, query) {
  const url = new URL(publicHttpUrl(origin));
  const site = siteKey(url.hostname);
  const [pathname, param] = SEARCH[site] ?? SEARCH[`${brandOf(site)}.com`] ?? ["/search", "q"];
  url.pathname = pathname;
  url.search = "";
  url.searchParams.set(param, query);
  return url.toString();
}

/** "Crate & Barrel" -> "crateandbarrel": how most stores spell their name as a domain. */
const nameSlug = (name) => name.toLowerCase().normalize("NFKD").replace(/&/g, "and").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "");

/**
 * A store from its name ("Uncommon Goods"), a domain ("uncommongoods.com") or
 * a URL. A bare name becomes <name>.com; the store's home page is then
 * followed wherever it redirects. A URL with a path or query is used as the
 * start page, with `{query}` replaced by the search phrase.
 */
export function resolveSite(input = "etsy") {
  const raw = String(input).trim();
  const known = DEFAULT_RETAILERS.find((r) => r.id === nameSlug(raw) || nameSlug(r.merchant) === nameSlug(raw));
  if (known) return { ...known, known: true, startUrl: null };
  const looksLikeAddress = /^https?:\/\//i.test(raw) || /^[^\s/]+\.[a-z]{2,}(?:[/:?]|$)/i.test(raw);
  if (!looksLikeAddress && !nameSlug(raw)) throw new Error("--site needs a store name, domain or URL.");
  let url;
  try {
    url = new URL(publicHttpUrl(/^https?:\/\//i.test(raw) ? raw : `https://${looksLikeAddress ? raw : `${nameSlug(raw)}.com`}`));
  } catch {
    throw new Error(`--site "${raw}" is not a public store address.`);
  }
  const site = siteKey(url.hostname);
  // Regional domains (amazon.co.uk) reuse the built-in store's search URL and product IDs.
  const builtIn = DEFAULT_RETAILERS.find((r) => brandOf(siteKey(new URL(r.origin).hostname)) === brandOf(site));
  const startUrl = url.pathname !== "/" || url.search ? url.toString().replace(/%7Bquery%7D/gi, "{query}") : null;
  return {
    id: builtIn?.id ?? site.replace(/[^a-z0-9]+/g, "-"),
    merchant: builtIn?.merchant ?? url.hostname.replace(/^www\./, ""),
    origin: url.origin,
    known: Boolean(builtIn),
    startUrl,
  };
}

/** Last-resort search URLs for stores whose search could not be discovered: Shopify/most stores, then WooCommerce. */
export function fallbackSearchTemplates(origin) {
  return [`${origin}/search?q={query}`, `${origin}/?s={query}&post_type=product`];
}

/** Fill a search template (`{query}`) and keep it on the store's own site. */
export function fillSearchTemplate(template, query, origin) {
  const url = publicHttpUrl(String(template).replaceAll("{query}", encodeURIComponent(query).replace(/%20/g, "+")));
  if (origin && siteKey(new URL(url).hostname) !== siteKey(new URL(origin).hostname)) {
    throw new Error(`Search URL ${url} leaves the store's site.`);
  }
  return url;
}

/** Stable retailer product identity extracted from a URL, or null when unknown. */
export function productIdentity(raw) {
  const url = URL.parse(raw);
  if (!url) return null;
  const site = siteKey(url.hostname);
  const brand = brandOf(site);
  const path = url.pathname;
  const match = (pattern) => pattern.exec(path)?.[1] ?? null;
  const id =
    brand === "amazon" ? match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)
    : brand === "walmart" ? match(/\/ip\/(?:[^/]+\/)?(\d{5,})/)
    : brand === "target" ? match(/\/-\/A-(\d{5,})/)
    : brand === "etsy" ? match(/\/listing\/(\d{5,})/)
    : brand === "bestbuy" ? (match(/\/(\d{6,})\.p/) ?? url.searchParams.get("skuId") ?? match(/\/product\/[^/]+\/([A-Z0-9]{6,})/i))
    : brand === "ebay" ? match(/\/itm\/(?:[^/]+\/)?(\d{9,})/)
    : null;
  return id ? `${site}:${id}` : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * A sample succeeds only when the live page was not an interstitial and
 * yielded at least one product candidate. Failures are never "fast".
 */
export function classifySample(read) {
  if (!read) return { ok: false, reason: "no-read" };
  if (read.blocked) return { ok: false, reason: `interstitial:${read.blocked.kind}` };
  if (!read.products?.length) return { ok: false, reason: "no-products-extracted" };
  return { ok: true };
}

/** Rank by browser-measured DOMContentLoaded median over successful samples. */
export function rankRetailers(samples) {
  const byRetailer = new Map();
  for (const sample of samples) {
    const list = byRetailer.get(sample.retailer) ?? [];
    list.push(sample);
    byRetailer.set(sample.retailer, list);
  }
  const rows = [...byRetailer.entries()].map(([retailer, own]) => {
    const ok = own.filter((sample) => sample.ok);
    const dcl = ok.map((sample) => sample.domContentLoadedMs).filter((value) => typeof value === "number");
    const wall = ok.map((sample) => sample.wallMs);
    return {
      retailer,
      merchant: own[0]?.merchant ?? retailer,
      tab: own.at(-1)?.tab ?? null,
      attempts: own.length,
      successes: ok.length,
      medianDomContentLoadedMs: median(dcl),
      minDomContentLoadedMs: dcl.length ? Math.min(...dcl) : null,
      medianWallMs: median(wall),
      medianExtractMs: median(ok.map((sample) => sample.extractMs)),
      candidatesLastRead: own.at(-1)?.candidates ?? 0,
      failures: own.filter((sample) => !sample.ok).map((sample) => sample.reason),
    };
  });
  const key = (row) => row.medianDomContentLoadedMs ?? row.medianWallMs ?? Infinity;
  return rows.sort((a, b) => (b.successes > 0) - (a.successes > 0) || key(a) - key(b));
}

const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "pack", "set", "new", "gift", "gifts", "christmas"]);
export function titleTokens(text) {
  return new Set(
    String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
      .filter((word) => word.length >= 3 && !STOP.has(word)),
  );
}

/** Share of the shorter title's tokens present in the other. */
export function titleOverlap(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let hits = 0;
  for (const word of small) if (large.has(word)) hits++;
  return hits / small.size;
}

/**
 * Verify that a reopened live product page is the candidate that was observed.
 * Navigation succeeding is not enough: identity, title and page facts must agree.
 */
export function verifyProduct(candidate, read) {
  const reasons = [];
  const facts = {};
  if (!read) return { status: "unverified", reasons: ["no-read"], facts };
  if (read.blocked) reasons.push(`interstitial:${read.blocked.kind}`);
  const candidateUrl = URL.parse(candidate.url);
  const finalUrl = URL.parse(read.url);
  if (!candidateUrl || !finalUrl || siteKey(candidateUrl.hostname) !== siteKey(finalUrl.hostname)) {
    reasons.push("redirected-off-retailer");
  }
  const expectedId = productIdentity(candidate.url);
  const observedIds = [productIdentity(read.url), productIdentity(read.canonicalUrl)].filter(Boolean);
  facts.productId = observedIds[0] ?? null;
  if (expectedId && observedIds.length && !observedIds.includes(expectedId)) reasons.push("product-id-mismatch");
  if (expectedId && !observedIds.length) reasons.push("not-a-product-page");
  const page = read.page;
  if (!page?.name) reasons.push("no-product-name-on-page");
  const names = [page?.name, page?.h1, page?.ogTitle, read.title].filter(Boolean);
  const overlap = Math.max(0, ...names.map((name) => titleOverlap(candidate.title, name)));
  facts.titleOverlap = Math.round(overlap * 100) / 100;
  if (overlap < 0.5) reasons.push("title-mismatch");
  facts.name = page?.name ?? null;
  const structured = page?.structured;
  const symbol = { USD: "$", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$" }[structured?.currency];
  facts.price = structured?.price != null
    ? (symbol ? `${symbol}${structured.price}` : `${structured.price} ${structured.currency ?? ""}`.trim())
    : page?.visiblePrices?.[0] ?? null;
  facts.availability = structured?.availability || page?.availabilityText || (page?.addToCartVisible ? "add-to-cart visible" : null);
  facts.canonicalUrl = read.canonicalUrl;
  facts.observedAt = read.extractedAt;
  if (!facts.price) reasons.push("no-price-observed");
  const unavailable = /outofstock|soldout|discontinued|out of stock|sold out|unavailable/i.test(String(facts.availability ?? ""));
  if (reasons.length) return { status: "unverified", reasons, facts };
  return { status: unavailable ? "unavailable" : "verified", reasons: unavailable ? ["listed-unavailable"] : [], facts };
}

export const KIMI_REFERENCE = Object.freeze({
  label: "Reference: Kimi official high-speed API — 71 TPS (user-supplied; not measured in this environment).",
  tps: 71,
  measuredLocally: false,
});

/** Speed Bounty formula: (output tokens − 1) / (last token time − first token time), ms → s. */
export function computeTps({ outputTokens, firstTokenMs, lastTokenMs }) {
  if (!Number.isInteger(outputTokens) || outputTokens < 2) throw new Error("outputTokens must be an integer >= 2.");
  if (!Number.isFinite(firstTokenMs) || !Number.isFinite(lastTokenMs)) throw new Error("first/last token timestamps (ms) are required.");
  const seconds = (lastTokenMs - firstTokenMs) / 1000;
  if (!(seconds > 0)) throw new Error("lastTokenMs must be after firstTokenMs.");
  return (outputTokens - 1) / seconds;
}
