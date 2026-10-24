import * as cheerio from 'cheerio';
import { parsePrice, defaultCurrency } from './price.js';

// A price-looking string: "89,90 €", "£1,299.00", "CHF 120", "1 299 Kč"...
const PRICE_RE = /(?:€|£|\$|CHF|EUR|GBP|USD|SEK|NOK|CZK)\s?\d[\d.,\s]*\d|\d[\d.,\s]*\d?\s?(?:€|£|\$|EUR|GBP|CHF|SEK|NOK|CZK|kr|Kč)/i;
const OLD_PRICE_SELECTOR = 'del, s, strike, [class*="old"], [class*="was"], [class*="regular"], [class*="strike"], [class*="before"]';

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function firstImage(value, base) {
  for (const item of toArray(value)) {
    const url = typeof item === 'string' ? item : item?.url ?? item?.contentUrl;
    if (url) return absolute(url, base);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1) Structured data (schema.org JSON-LD) - the most reliable source.
// ---------------------------------------------------------------------------

function collectProductNodes(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    node.forEach((n) => collectProductNodes(n, found));
    return found;
  }
  const types = toArray(node['@type']);
  if (types.includes('Product') || types.includes('ProductGroup')) found.push(node);
  // Walk into graphs, item lists and nested "item" wrappers.
  for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasVariant']) {
    if (node[key]) collectProductNodes(node[key], found);
  }
  return found;
}

function offerPrice(offers, country) {
  for (const offer of toArray(offers)) {
    const raw = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price;
    if (raw == null || raw === '') continue;
    const amount = parseFloat(String(raw).replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    return {
      amount,
      currency: offer.priceCurrency ?? offer.priceSpecification?.priceCurrency ?? defaultCurrency(country),
      inStock: offer.availability ? /InStock|LimitedAvailability|PreOrder/i.test(offer.availability) : null,
    };
  }
  return null;
}

function fromJsonLd($, baseUrl, country) {
  const products = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return; // Malformed JSON-LD is common; just skip it.
    }
    for (const node of collectProductNodes(data)) {
      const url = absolute(node.url ?? node['@id'] ?? '', baseUrl);
      const title = String(node.name ?? '').trim();
      if (!title || !url) continue;
      const price = offerPrice(node.offers, country);
      products.push({
        title,
        url,
        image: firstImage(node.image, baseUrl),
        sku: node.sku ?? node.mpn ?? node.gtin13 ?? null,
        brand: typeof node.brand === 'string' ? node.brand : node.brand?.name ?? null,
        price: price ? { amount: price.amount, currency: price.currency } : null,
        inStock: price?.inStock ?? null,
      });
    }
  });
  return products;
}

// ---------------------------------------------------------------------------
// 2) Fallback: product cards found in the listing HTML.
// ---------------------------------------------------------------------------

function imageOf($, scope, base) {
  const img = scope.find('img').first();
  if (!img.length) return null;
  const srcset = img.attr('data-srcset') ?? img.attr('srcset');
  const src =
    img.attr('data-src') ?? img.attr('data-lazy-src') ?? img.attr('data-original') ?? img.attr('src') ?? srcset?.split(',')[0]?.trim().split(' ')[0];
  if (!src || src.startsWith('data:')) return null;
  return absolute(src, base);
}

function priceOf($, card, country) {
  // Prefer elements explicitly labelled as price, skipping crossed-out old prices.
  let found = null;
  card.find('[class*="price"], [class*="Price"], [itemprop="price"]').each((_, el) => {
    const node = $(el);
    if (found || node.is(OLD_PRICE_SELECTOR) || node.closest(OLD_PRICE_SELECTOR).length) return;
    const text = node.attr('content') ?? node.text();
    if (PRICE_RE.test(text) || node.attr('content')) found = parsePrice(text, country);
  });
  if (found) return found;
  const match = card.text().replace(/\s+/g, ' ').match(PRICE_RE);
  return match ? parsePrice(match[0], country) : null;
}

// Climb from a link to the smallest ancestor that looks like one product card.
function findCard($, link) {
  let node = $(link);
  for (let depth = 0; depth < 6; depth += 1) {
    node = node.parent();
    if (!node.length || node.is('body, html, main')) return null;
    const hasPrice = PRICE_RE.test(node.text());
    const hrefs = new Set(node.find('a[href]').map((_, a) => $(a).attr('href')).get());
    if (hasPrice) return hrefs.size <= 4 ? node : null; // Too many links = a whole list, not a card.
  }
  return null;
}

function titleOf($, link, card) {
  const heading = card.find('h1, h2, h3, h4, [class*="title"], [class*="name"]').first().text().trim();
  const candidates = [
    $(link).attr('title'),
    heading,
    $(link).find('img').first().attr('alt'),
    $(link).text().replace(/\s+/g, ' ').trim(),
  ];
  return candidates.map((c) => (c ?? '').replace(/\s+/g, ' ').trim()).find((c) => c.length >= 6 && c.length <= 220) ?? '';
}

function fromCards($, baseUrl, country) {
  const products = [];
  const seen = new Set();
  $('a[href]').each((_, link) => {
    const href = $(link).attr('href');
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return;
    const url = absolute(href, baseUrl);
    if (!url || seen.has(url)) return;
    const card = findCard($, link);
    if (!card) return;
    const title = titleOf($, link, card);
    const price = priceOf($, card, country);
    if (!title || !price) return;
    seen.add(url);
    products.push({ title, url, image: imageOf($, card, baseUrl), sku: null, brand: null, price, inStock: null });
  });
  return products;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract products from a search-results (or product) page.
 * JSON-LD wins; HTML cards complete missing prices and images.
 */
export function extractProducts(html, baseUrl, country) {
  const $ = cheerio.load(html);
  const structured = fromJsonLd($, baseUrl, country);
  const cards = fromCards($, baseUrl, country);

  const byUrl = new Map(structured.map((p) => [p.url, p]));
  for (const card of cards) {
    const existing = byUrl.get(card.url);
    if (!existing) {
      byUrl.set(card.url, card);
    } else {
      existing.price ??= card.price;
      existing.image ??= card.image;
    }
  }
  return [...byUrl.values()];
}
