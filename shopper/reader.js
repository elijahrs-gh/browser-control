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

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.closest("[hidden],[aria-hidden='true'],[inert]")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return el.getClientRects().length > 0;
  };

  // Tracking and credential-like parameters are removed; identity params stay.
  const TRACKING = /^(utm_|gclid$|gbraid$|wbraid$|fbclid$|msclkid$|mc_[ce]id$|cmpid$|campaignid$|adgrpid$|hvadid$|hvpos$|hvnetw$|hvrand$|hvpone$|hvptwo$|hvqmt$|hvdev$|hvdvcmdl$|hvlocint$|hvlocphy$|hvtargid$|tag$|ref$|ref_$|pd_rd_.*|pf_rd_.*|qid$|sr$|crid$|sprefix$|dib$|dib_tag$|content-id$|psc$|_trkparms$|_trksid$|hash$|xpid$|athcpid$|athpgid$|athznid$|athieid$|athstid$|athguid$|athwpid$|athtvid$|athancid$|athena$|adsRedirect$|click_key$|click_sum$|organic_search_click$|sts$|lnk$|preffdbk$|frs$|from$|sid$|clickid$|irclickid$|irgwc$|cjevent$)/i;
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
  const isProductUrl = (href) => {
    try { return PRODUCT_PATH.some((pattern) => pattern.test(new URL(href).pathname)); } catch { return false; }
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
      if (!/\bProduct\b|ProductGroup/.test(type) || !item.name) continue;
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
  const pageStructured = structured.find((item) => !item.url || item.url === canonicalUrl || item.url === safeUrl(location.href)) ?? (structured.length === 1 ? structured[0] : null);
  if (isProductUrl(safeUrl(location.href)) || isProductUrl(canonicalUrl) || pageStructured || /product/i.test(meta("meta[property='og:type']"))) {
    const priceNode = document.querySelector("[itemprop='price'], #corePrice_feature_div .a-offscreen, .a-price .a-offscreen, [data-testid='product-price'], [data-test='product-price'], [itemprop='offers'] [itemprop='price'], .priceView-customer-price span, [data-buy-box-region='price']");
    const availabilityNode = document.querySelector("#availability, [data-testid*='availability' i], [data-test*='fulfillment' i], .fulfillment-add-to-cart-button");
    page = {
      name: pageStructured?.name || h1 || meta("meta[property='og:title']"),
      h1,
      ogTitle: meta("meta[property='og:title']"),
      structured: pageStructured,
      visiblePrices: pricesIn(`${priceNode?.textContent ?? ""} ${priceNode?.getAttribute?.("content") ?? ""}`).concat(priceNode ? [] : pricesIn(document.querySelector("main")?.innerText?.slice(0, 1500) ?? "")).slice(0, 3),
      availabilityText: cut(availabilityNode?.innerText ?? "", 120),
      addToCartVisible: [...document.querySelectorAll("button, input[type='submit']")].some((el) => /add to (?:cart|bag|basket)/i.test(el.innerText || el.value || "") && isVisible(el)),
    };
  }

  // Search-result style product cards.
  const products = [];
  const seen = new Set();
  const CARD = "[data-component-type='s-search-result'], [data-item-id], [data-testid='list-view'] > div, [data-test='@web/site-top-of-funnel/ProductCardWrapper'], [data-test*='product-card' i], [data-testid*='product-card' i], .sku-item, li.s-item, .v2-listing-card, [data-listing-id], article, li";
  const TITLE = "h2, h3, [data-automation-id='product-title'], [data-test='product-title'], .sku-title, .s-item__title, .v2-listing-card__title, [data-testid*='title' i]";
  const root = document.querySelector("main, [role='main'], #search, #main") ?? document.body;
  if (maxProducts > 0 && root) {
    for (const link of root.querySelectorAll("a[href]")) {
      if (products.length >= maxProducts) break;
      const href = safeUrl(link.getAttribute("href"));
      if (!href || seen.has(href) || !isProductUrl(href) || !isVisible(link)) continue;
      if (link.closest("nav, header, footer, aside, [role='navigation'], [role='dialog']")) continue;
      let card = link.closest(CARD) ?? link;
      for (let n = 0; n < 4 && card.parentElement && clean(card.innerText).length < 30; n++) card = card.parentElement;
      const cardText = cut(card.innerText, 600);
      const titleNode = card.querySelector(TITLE);
      const title = cut(
        (titleNode && clean(titleNode.innerText).length >= 4 ? titleNode.innerText : "") ||
          link.getAttribute("aria-label") || link.innerText || link.querySelector("img")?.getAttribute("alt") || "",
        240,
      );
      if (title.length < 4 || /^(shop|see|view|learn more|shop now|view details|quick view|options|sponsored)$/i.test(title)) continue;
      const amazonPrice = card.querySelector(".a-price .a-offscreen")?.textContent;
      seen.add(href);
      const rating = /(\d(?:\.\d)?) out of 5 stars/i.exec(cardText)?.[1];
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
      if (label && href && isProductUrl(href)) { line += ` [${label}](${href}) `; return; }
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
  const safe = { maxChars: int(options.maxChars), maxProducts: int(options.maxProducts) };
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
