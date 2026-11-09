import { normalize, compact } from './text.js';

// Matches "48°", "48deg", "48 degre", "48 degrees"...
const LOFT_RE = /(\d{2}(?:[.,]\d+)?)\s*(?:°|º|deg\w*)/g;

/**
 * Split a user query into word tokens (must appear in the product title)
 * and number tokens (loft, size...; must match a number in the title or variant).
 * Example: "vokey sm10 48degre" -> words ["vokey","sm10"], numbers [48]
 */
export function parseQuery(query) {
  let text = normalize(query);
  const numbers = [];

  // Numbers explicitly followed by a degree marker are always numeric tokens.
  text = text.replace(LOFT_RE, (_, n) => {
    numbers.push(parseInt(n, 10));
    return ' ';
  });

  const words = [];
  for (const token of text.split(/[\s,;/]+/).filter(Boolean)) {
    if (/^\d+([.,]\d+)?$/.test(token)) numbers.push(parseInt(token, 10));
    else words.push(token.replace(/[^a-z0-9]/g, '')); // "sm-10" -> "sm10"
  }

  return {
    words: words.filter(Boolean),
    numbers: [...new Set(numbers)],
    // Text sent to the shops' own search engines.
    searchText: [...words, ...numbers].join(' '),
    // Broader text used as a fallback when the full query finds nothing.
    broadText: words.join(' '),
  };
}

// Integer parts of every number found in a title: "Wedge 48.08 F" -> [48]
function titleNumbers(title) {
  return (normalize(title).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => parseInt(n, 10));
}

/**
 * Check a product title against a parsed query.
 * Returns a score (higher = closer match) or 0 when it does not match.
 */
export function scoreTitle(title, parsed) {
  if (!title) return 0;
  const norm = normalize(title);
  const squashed = compact(title);

  for (const word of parsed.words) {
    if (!norm.includes(word) && !squashed.includes(word)) return 0;
  }
  const nums = titleNumbers(title);
  for (const n of parsed.numbers) {
    if (!nums.includes(n)) return 0;
  }

  // Shorter titles are usually the more exact reference.
  return 1000 - Math.min(norm.length, 900);
}

export function matchProduct(product, parsed) {
  const score = scoreTitle(product.title, parsed);
  if (score > 0) return { score, variant: null };

  for (const variant of product.variants ?? []) {
    const variantScore = scoreTitle(`${product.title} ${variant}`, parsed);
    if (variantScore > 0) return { score: variantScore, variant };
  }
  return null;
}
