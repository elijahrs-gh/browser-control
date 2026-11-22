/**
 * Page-side shopping reader. It runs inside the inspected tab through
 * OpenClaw's official `browser evaluate` route (exact target, normal
 * navigation policy, extension debugger already authorized by the user).
 *
 * It reads only; it never clicks, types, stores refs, or mutates the page.
 * Actions go through official snapshot refs (`openclaw browser click <ref>`).
 * Page text is untrusted evidence, never instructions.
 *
 * Keep this function self-contained: it is serialized with toString().
 */
export function compactShoppingPage(options) {
  "use strict";
  const started = performance.now();
  const maxChars = Math.min(12000, Math.max(400, options.maxChars ?? 3000));
  const maxProducts = Math.min(30, Math.max(0, options.maxProducts ?? 10));
  const clean = (value) =>
    String(value ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  const cut = (value, max) => clean(value).slice(0, max);
  const host = location.hostname.replace(/^www\./, "");
  const siteOf = (hostname) => {
    const parts = hostname.toLowerCase().split(".");
    const two = parts.slice(-2).join(".");
    return parts.length > 2 && /^(?:co|com|org|net|ac|gov|edu|ne|or|gob)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
  };
  const site = siteOf(location.hostname);
  // Stores without built-in URL patterns also accept priced cards and structured lists on the same site.
  // "auto" (the default) turns this on for every store except the built-in ones.
  const anyStore = options.anyStore === "auto" ? !/^(?:amazon|walmart|target|etsy|bestbuy|ebay)$/.test(site.split(".")[0]) : options.anyStore === true;
  // Titles sometimes carry escaped entities or an accessibility prefix ("Link to product page, …").
  const decoder = document.createElement("textarea");
  const titleText = (value) => {
    decoder.innerHTML = String(value ?? "").slice(0, 600);
    return clean(decoder.value).replace(/^(?:link to|go to|view|shop|open)(?: the)?(?: product)?(?: page| details)?\s*[,:–-]\s*/i, "");
  };

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.closest("[hidden],[aria-hidden='true'],[inert]")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return el.getClientRects().length > 0;
  };

  // Tracking and credential-like parameters are removed; identity params stay.
  const TRACKING = /^(utm_|gclid$|gbraid$|wbraid$|fbclid$|msclkid$|mc_[ce]id$|cmpid$|campaignid$|adgrpid$|hvadid$|hvpos$|hvnetw$|hvrand$|hvpone$|hvptwo$|hvqmt$|hvdev$|hvdvcmdl$|hvlocint$|hvlocphy$|hvtargid$|tag$|ref$|ref_$|pd_rd_.*|pf_rd_.*|qid$|sr$|crid$|sprefix$|dib$|dib_tag$|content-id$|psc$|_trkparms$|_trksid$|hash$|xpid$|athcpid$|athpgid$|athznid$|athieid$|athstid$|athguid$|athwpid$|athtvid$|athancid$|athena$|adsRedirect$|click_key$|click_sum$|organic_search_click$|sts$|lnk$|preffdbk$|frs$|from$|sid$|clickid$|irclickid$|irgwc$|cjevent$|_pos$|_sid$|_ss$|_psq$|_fid$|_v$|srsltid$)/i;
  const SECRET = /token|signature|session|auth|password|secret|email/i;
  const safeUrl = (raw, base = location.href) => {
    let url;
    try { url = new URL(String(raw ?? ""), base); } catch { return ""; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    // Amazon sponsored links wrap the real product path in ?url=.
    if (/\/sspa\/click$/.test(url.pathname) && url.searchParams.get("url")) {
      return safeUrl(url.searchParams.get("url"), url.origin);
    }
    url.hash = "";
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.test(key) || SECRET.test(key)) url.searchParams.delete(key);
    }
    // Amazon product identity is the ASIN path; the slug and /ref= tail are noise.
    const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/.exec(url.pathname);
    const listing = /^\/listing\/(\d{5,})(\/[^/?]*)?/.exec(url.pathname);
    if (/(^|\.)amazon\./.test(url.hostname) && asin) {
      url.pathname = `/dp/${asin[1]}`;
      url.search = "";
    } else if (/(^|\.)etsy\.com$/.test(url.hostname) && listing) {
      // Etsy listing identity is the numeric id; query params are search/ad tracking.
      url.pathname = `/listing/${listing[1]}${listing[2] ?? ""}`;
      url.search = "";
    } else {
      url.pathname = url.pathname.replace(/\/ref=[^/]*$/, "");
    }
    return url.toString().slice(0, 1000);
  };

  const PRODUCT_PATH = [
    /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/, // Amazon
    /\/ip\/(?:[^/]+\/)?\d{5,}/, // Walmart
    /\/p\/[^/]*\/-\/A-\d{5,}/, // Target
    /\/listing\/\d{5,}/, // Etsy
    /\/site\/[^?]*\/\d{6,}\.p|\/product\/[^/]+\/[A-Z0-9]{6,}/i, // Best Buy
    /\/itm\/(?:[^/]+\/)?\d{9,}/, // eBay
    /\/products?\/[^/?]{3,}/, // common storefronts
  ];
  // Common product paths on other stores; only used in anyStore mode.
  const GENERIC_PRODUCT_PATH = [
    /\/(?:p|pd|item|items|prod|shop\/p)\/[^/?]{3,}/i,
    /[-_/]p[-_]?\d{4,}(?:[./?]|$)/i,
    /\/[^/?]*\d{5,}[^/?]*\.html?$/i,
    /\/[a-z0-9]+(?:-[a-z0-9]+){2,}\/?$/i, // long slug, e.g. /hand-knit-wool-scarf
  ];
  const NOT_PRODUCT_PATH = /\/(?:search|cart|basket|bag|checkout|account|login|log-in|signin|sign-in|register|help|support|customer-service|wishlist|compare|blog|news|stores?|store-locator|gift-?cards?|about|contact|faq|policies|policy|pages|terms|privacy|returns|shipping|careers|sitemap)(?:[/?.]|$)/i;
  const isProductUrl = (href) => {
    try { return PRODUCT_PATH.some((pattern) => pattern.test(new URL(href).pathname)); } catch { return false; }
  };
  const sameSite = (href) => {
    try { return siteOf(new URL(href).hostname) === site; } catch { return false; }
  };

  const PRICE = /(?:US\s?)?[$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?!\d)|\b\d{1,3}(?:,\d{3})*\.\d{2}\s?(?:USD|EUR|GBP|CAD)\b/gi;
  const pricesIn = (text) => [...new Set(clean(text).match(PRICE) ?? [])].slice(0, 3);

  const blockedSignals = [
    [/captcha|are you a (?:human|robot)|verify (?:you are|that you're) (?:a )?human|press (?:&|and) hold|robot check|unusual traffic/i, "captcha"],
    [/access denied|request blocked|you have been blocked|pardon our interruption|forbidden/i, "blocked"],
    [/sign in to continue|please sign in|log in to continue/i, "login"],
  ];
  const bodyText = cut(document.body?.innerText ?? "", 4000);
  let blocked = null;
  for (const [pattern, kind] of blockedSignals) {
    const match = pattern.exec(`${document.title} ${bodyText.slice(0, 1500)}`);
    if (match && bodyText.length < 3000) { blocked = { kind, evidence: cut(match[0], 80) }; break; }
  }

  // Structured data: Product entries from JSON-LD, bounded.
  const structured = [];
  const listedUrls = new Set(); // product URLs from JSON-LD ItemList / Product entries
  for (const script of [...document.querySelectorAll("script[type='application/ld+json']")].slice(0, 20)) {
    let value;
    try { value = JSON.parse(script.textContent ?? ""); } catch { continue; }
    const stack = [value];
    let visited = 0;
    while (stack.length && visited++ < 400 && structured.length < 40) {
      const item = stack.pop();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item)) { stack.push(...item.slice(0, 60)); continue; }
      for (const key of ["@graph", "itemListElement", "mainEntity", "item", "hasVariant"]) if (item[key]) stack.push(item[key]);
      const type = [].concat(item["@type"] ?? []).join(" ");
      if (/\bListItem\b/.test(type) && typeof item.url === "string") listedUrls.add(safeUrl(item.url));
      if (!/\bProduct\b|ProductGroup/.test(type) || !item.name) continue;
      if (typeof item.url === "string") listedUrls.add(safeUrl(item.url));
      const offer = [].concat(item.offers ?? [])[0] ?? {};
      const innerOffer = [].concat(offer.offers ?? [])[0];
      const priced = innerOffer && innerOffer.price !== undefined ? innerOffer : offer;
      structured.push({
        name: cut(item.name, 240),
        url: item.url ? safeUrl(item.url) : "",
        sku: cut(item.sku ?? item.productID ?? item.mpn ?? "", 60),
        gtin: cut(item.gtin13 ?? item.gtin12 ?? item.gtin ?? "", 20),
        brand: cut(typeof item.brand === "object" ? item.brand?.name : item.brand, 80),
        price: priced.price ?? priced.lowPrice ?? null,
        currency: cut(priced.priceCurrency ?? "", 8),
        availability: cut(String(priced.availability ?? "").replace(/^https?:\/\/schema\.org\//, ""), 40),
      });
    }
  }

  const meta = (selector) => cut(document.querySelector(selector)?.getAttribute("content") ?? "", 300);
  const canonicalUrl = safeUrl(document.querySelector("link[rel='canonical']")?.getAttribute("href") ?? location.href);
  const h1 = cut(document.querySelector("h1")?.innerText ?? "", 240);

  // Product detail page facts (used by verification).
  let page = null;
  const addToCartVisible = [...document.querySelectorAll("button, input[type='submit'], [role='button']")].some((el) => /add to (?:cart|bag|basket|trolley|order)|buy (?:it )?now/i.test(el.innerText || el.value || el.getAttribute("aria-label") || "") && isVisible(el));
  const metaPrice = meta("meta[property='product:price:amount'], meta[property='og:price:amount'], meta[itemprop='price']");
  const metaCurrency = meta("meta[property='product:price:currency'], meta[property='og:price:currency'], meta[itemprop='priceCurrency']");
  const pageStructured = structured.find((item) => !item.url || item.url === canonicalUrl || item.url === safeUrl(location.href)) ?? (structured.length === 1 ? structured[0] : null);
  if (isProductUrl(safeUrl(location.href)) || isProductUrl(canonicalUrl) || pageStructured || /product/i.test(meta("meta[property='og:type']")) || (anyStore && addToCartVisible && h1)) {
    const priceNode = document.querySelector("[itemprop='price'], #corePrice_feature_div .a-offscreen, .a-price .a-offscreen, [data-testid='product-price'], [data-test='product-price'], [itemprop='offers'] [itemprop='price'], .priceView-customer-price span, [data-buy-box-region='price']");
    const availabilityNode = document.querySelector("#availability, [data-testid*='availability' i], [data-test*='fulfillment' i], .fulfillment-add-to-cart-button");
    page = {
      name: pageStructured?.name || h1 || meta("meta[property='og:title']"),
      h1,
      ogTitle: meta("meta[property='og:title']"),
      structured: pageStructured,
      visiblePrices: pricesIn(`${priceNode?.textContent ?? ""} ${priceNode?.getAttribute?.("content") ?? ""}`)
        .concat(/^\d+(?:\.\d+)?$/.test(metaPrice) ? [`${metaPrice} ${metaCurrency || ""}`.trim()] : [])
        .concat(priceNode ? [] : pricesIn((document.querySelector("main") ?? document.body)?.innerText?.slice(0, 1500) ?? "")).slice(0, 3),
      availabilityText: cut(availabilityNode?.innerText ?? "", 120),
      addToCartVisible,
    };
  }

  // Search-result style product cards.
  const products = [];
  const seen = new Set();
  const CARD = "[data-component-type='s-search-result'], [data-item-id], [data-testid='list-view'] > div, [data-test='@web/site-top-of-funnel/ProductCardWrapper'], [data-test*='product-card' i], [data-testid*='product-card' i], .sku-item, li.s-item, .v2-listing-card, [data-listing-id], [data-product-id], [class*='product-card' i], [class*='product-item' i], [class*='productCard'], [class*='product-tile' i], .product, article, li";
  const TITLE = "h2, h3, [data-automation-id='product-title'], [data-test='product-title'], .sku-title, .s-item__title, .v2-listing-card__title, [data-testid*='title' i], [class*='product-title' i], [class*='product-name' i], [class*='productName'], [class*='card__heading' i], [itemprop='name']";
  const root = document.querySelector("main, [role='main'], #search, #main") ?? document.body;
  if (maxProducts > 0 && root) {
    for (const link of root.querySelectorAll("a[href]")) {
      if (products.length >= maxProducts) break;
      const href = safeUrl(link.getAttribute("href"));
      if (!href || seen.has(href) || !isVisible(link)) continue;
      const knownPath = isProductUrl(href);
      if (!knownPath && !anyStore) continue;
      if (link.closest("nav, header, footer, aside, [role='navigation'], [role='dialog']")) continue;
      // Without a recognizable card container, widen from the link until there is some text.
      let card = link.closest(CARD);
      if (!card) {
        card = link;
        for (let n = 0; n < 4 && card.parentElement && clean(card.innerText).length < 30; n++) card = card.parentElement;
      }
      const cardText = cut(card.innerText, 600);
      if (!knownPath) {
        // Other stores: a same-site link that the page lists as a product, that has a
        // product-like path, or whose card shows both a price and an image.
        const path = new URL(href).pathname;
        if (!sameSite(href) || path === "/" || NOT_PRODUCT_PATH.test(path) || href === safeUrl(location.href)) continue;
        const priced = pricesIn(cardText).length > 0;
        const pictured = Boolean(card.querySelector("img, picture"));
        if (!listedUrls.has(href) && !(priced && (pictured || GENERIC_PRODUCT_PATH.some((pattern) => pattern.test(path))))) continue;
      }
      const titleNode = card.querySelector(TITLE);
      const title = cut(titleText(
        (titleNode && clean(titleNode.innerText).length >= 4 ? titleNode.innerText : "") ||
          link.getAttribute("aria-label") || link.innerText || link.querySelector("img")?.getAttribute("alt") || "",
      ), 240);
      if (title.length < 4 || /^(shop|see|view|learn more|shop now|view details|quick view|options|sponsored)$/i.test(title)) continue;
      const amazonPrice = card.querySelector(".a-price .a-offscreen")?.textContent;
      seen.add(href);
      const rating = /(\d(?:\.\d)?) (?:out of 5 stars|stars? out of 5)/i.exec(cardText)?.[1];
      const availability = /\b(?:in stock|out of stock|only \d+ left(?: in stock)?|sold out|pickup [^.|]{1,40}|(?:free )?(?:delivery|shipping) [^.|]{1,50})/i.exec(cardText)?.[0];
      products.push({
        title,
        url: href,
        merchant: host,
        prices: amazonPrice ? pricesIn(amazonPrice) : pricesIn(cardText),
        sponsored: /\bsponsored\b|^ad\b|\bad by\b/i.test(cardText.slice(0, 160)),
        ...(rating ? { rating: Number(rating) } : {}),
        ...(availability ? { availability: cut(availability, 80) } : {}),
        evidence: cardText.slice(0, 280),
      });
    }
  }

  // Compact Markdown of visible main content. Links appear only for product URLs.
  const lines = [];
  let chars = 0;
  let truncated = false;
  const SKIP = "script,style,noscript,template,svg,canvas,iframe,nav,header,footer,aside,form,button,input,select,textarea,[role='navigation'],[role='dialog'],[role='banner'],[role='contentinfo']";
  let line = "";
  const flush = () => {
    const text = clean(line);
    line = "";
    if (!text || text === lines[lines.length - 1]) return;
    if (chars + text.length > maxChars) { truncated = true; return; }
    lines.push(text);
    chars += text.length + 1;
  };
  const walk = (node, depth) => {
    if (truncated || depth > 60) return;
    if (node.nodeType === Node.TEXT_NODE) { line += ` ${node.textContent}`; return; }
    if (!(node instanceof HTMLElement) || node.matches(SKIP) || !isVisible(node)) return;
    const tag = node.tagName.toLowerCase();
    const block = /^(p|div|section|article|li|ul|ol|h[1-6]|tr|table|dl|dt|dd|main)$/.test(tag);
    if (block) flush();
    if (/^h[1-4]$/.test(tag)) line += `${"#".repeat(Number(tag[1]))} `;
    if (tag === "li") line += "- ";
    if (tag === "a") {
      const href = safeUrl(node.getAttribute("href"));
      const label = cut(node.innerText || node.getAttribute("aria-label"), 160);
      if (label && href && (isProductUrl(href) || seen.has(href))) { line += ` [${label}](${href}) `; return; }
    }
    for (const child of node.childNodes) walk(child, depth + 1);
    if (block) flush();
  };
  if (root) walk(root, 0);
  flush();

  const nav = performance.getEntriesByType("navigation")[0];
  const ms = (value) => (typeof value === "number" && value > 0 ? Math.round(value) : null);
  return {
    v: 1,
    title: cut(document.title, 240),
    url: safeUrl(location.href),
    canonicalUrl,
    merchant: host,
    readyState: document.readyState,
    blocked,
    page,
    products,
    markdown: lines.join("\n"),
    truncated,
    timing: nav
      ? { ttfbMs: ms(nav.responseStart), domContentLoadedMs: ms(nav.domContentLoadedEventEnd), loadMs: ms(nav.loadEventEnd), navigationType: nav.type }
      : null,
    extractMs: Math.round(performance.now() - started),
    extractedAt: new Date().toISOString(),
    stats: { markdownChars: chars, productCount: products.length, structuredProducts: structured.length },
  };
}

/**
 * Build the fixed `--fn` source for `openclaw browser evaluate`. The function
 * polls inside the page (no extra CLI round-trip) until the document has
 * parsed and enough content rendered, or `waitMs` passes, then reads once more.
 */
export function readerFunctionSource(options = {}) {
  const int = (value) => (Number.isFinite(value) ? Math.trunc(value) : undefined);
  const safe = { maxChars: int(options.maxChars), maxProducts: int(options.maxProducts), anyStore: typeof options.anyStore === "boolean" ? options.anyStore : "auto" };
  const wait = {
    waitMs: Math.min(12000, Math.max(0, int(options.waitMs) ?? 8000)),
    minProducts: Math.max(0, int(options.minProducts) ?? 0),
    needPage: options.needPage === true,
  };
  return `async () => {
  const read = ${compactShoppingPage.toString()};
  const options = ${JSON.stringify(safe)};
  const wait = ${JSON.stringify(wait)};
  const deadline = Date.now() + wait.waitMs;
  for (;;) {
    if (document.readyState !== "loading") {
      const result = read(options);
      const ready = result.products.length >= wait.minProducts && (!wait.needPage || Boolean(result.page && result.page.name));
      if (ready || result.blocked || Date.now() >= deadline) return result;
    } else if (Date.now() >= deadline) {
      return read(options);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}`;
}

/**
 * Finds how to search the current store, read-only. Returns URL templates with
 * `{query}`, best first: schema.org SearchAction, OpenSearch, then GET search
 * forms (hidden fields kept, e.g. WooCommerce's post_type=product). Only
 * templates on the page's own site are returned. Self-contained (serialized).
 */
export async function discoverSearch() {
  "use strict";
  const siteOf = (hostname) => {
    const parts = hostname.toLowerCase().split(".");
    const two = parts.slice(-2).join(".");
    return parts.length > 2 && /^(?:co|com|org|net|ac|gov|edu|ne|or|gob)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
  };
  const site = siteOf(location.hostname);
  const templates = [];
  const add = (raw, source) => {
    let url;
    try { url = new URL(String(raw).replace(/\{(?:search_term_string|searchTerms|query)\??\}/g, "__QUERY__"), location.href); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || siteOf(url.hostname) !== site) return;
    url.hash = "";
    const template = url.toString().replace("__QUERY__", "{query}");
    if (template.includes("{query}") && !templates.some((t) => t.template === template)) templates.push({ template, source });
  };

  for (const script of [...document.querySelectorAll("script[type='application/ld+json']")].slice(0, 20)) {
    let value;
    try { value = JSON.parse(script.textContent ?? ""); } catch { continue; }
    const stack = [value];
    for (let visited = 0; stack.length && visited < 300; visited++) {
      const item = stack.pop();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item)) { stack.push(...item.slice(0, 50)); continue; }
      if (item["@graph"]) stack.push(item["@graph"]);
      for (const action of [].concat(item.potentialAction ?? [])) {
        if (!/SearchAction/.test([].concat(action?.["@type"] ?? []).join(" "))) continue;
        for (const target of [].concat(action.target ?? [])) add(typeof target === "string" ? target : target?.urlTemplate ?? "", "schema.org");
      }
    }
  }

  const openSearch = document.querySelector("link[rel='search'][type*='opensearch' i]")?.getAttribute("href");
  if (openSearch) {
    try {
      const href = new URL(openSearch, location.href);
      if (siteOf(href.hostname) === site) {
        const response = await fetch(href, { credentials: "omit", signal: AbortSignal.timeout(2500) });
        const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
        for (const node of xml.querySelectorAll("Url")) {
          if (/text\/html/i.test(node.getAttribute("type") ?? "")) add(node.getAttribute("template") ?? "", "opensearch");
        }
      }
    } catch { /* optional */ }
  }

  const QUERY_NAME = /^(?:q|query|s|search|searchterm|search_query|searchquery|keyword|keywords|k|kw|term|text|w|st|ntt|_nkw|search_term|searchtext)$/i;
  const forms = [...document.forms].filter((form) => (form.getAttribute("method") ?? "get").toLowerCase() === "get");
  const scored = [];
  for (const form of forms) {
    const field = [...form.querySelectorAll("input")].find((input) => input.type === "search" || (/^(?:text|search)$/.test(input.type) && QUERY_NAME.test(input.name)));
    if (!field?.name) continue;
    let action;
    try { action = new URL(form.getAttribute("action") || location.pathname, location.href); } catch { continue; }
    for (const hidden of form.querySelectorAll("input[type='hidden'][name]")) {
      if (!/token|csrf|nonce|session|auth/i.test(hidden.name)) action.searchParams.set(hidden.name, hidden.value);
    }
    action.searchParams.set(field.name, "__QUERY__");
    const hint = `${form.getAttribute("role") ?? ""} ${form.id} ${form.className} ${form.getAttribute("action") ?? ""} ${field.placeholder} ${field.getAttribute("aria-label") ?? ""}`;
    scored.push({ url: action.toString(), score: (/search/i.test(hint) ? 2 : 0) + (field.type === "search" ? 1 : 0) });
  }
  for (const { url } of scored.sort((a, b) => b.score - a.score)) add(url, "form");

  return { v: 1, url: location.href, title: document.title.slice(0, 200), templates: templates.slice(0, 6) };
}

/** Fixed `--fn` source for search discovery; waits for the page to finish parsing first. */
export function discoverFunctionSource() {
  return `async () => {
  const discover = ${discoverSearch.toString()};
  const deadline = Date.now() + 6000;
  for (;;) {
    if (document.readyState !== "loading") {
      const result = await discover();
      if (result.templates.length || Date.now() >= deadline) return result;
    } else if (Date.now() >= deadline) {
      return discover();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}`;
}
