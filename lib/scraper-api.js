import { existsSync, readFileSync } from 'node:fs';
import { extractProducts } from './extract.js';
import { scoreTitle } from './match.js';

const OVERRIDES = existsSync(new URL('../search-overrides.json', import.meta.url))
  ? JSON.parse(readFileSync(new URL('../search-overrides.json', import.meta.url), 'utf8'))
  : {};

const GENERIC_TEMPLATES = [
  '/SearchResults.aspx?Search={q}',
  '/search?q={q}',
  '/catalogsearch/result/?q={q}',
];

export async function searchSiteScraperApi(source, parsed, signal) {
  const apiKey = process.env.SCRAPERAPI_KEY;
  if (!apiKey) {
    return { status: 'blocked', products: [], attempts: [{ error: 'Missing SCRAPERAPI_KEY' }] };
  }

  const host = new URL(source.url).hostname.replace(/^www\./, '');
  const origin = new URL(source.url).origin;
  const queries = [...new Set([parsed.searchText, parsed.broadText].filter(Boolean))];
  const attempts = [];

  const custom = OVERRIDES[host] ?? [];
  const templates = [...new Set([...custom, ...GENERIC_TEMPLATES])];

  const targetTemplate = templates[0];
  const mainQuery = queries[0];

  const targetUrl = origin + targetTemplate.replace('{q}', encodeURIComponent(mainQuery));
  const countryCode = (source.country || 'ie').toLowerCase();
  
  // Ajout de &premium=true pour contourner la protection du domaine
  const scraperApiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&premium=true&country_code=${countryCode}`;
  
  const attempt = { url: targetUrl };
  attempts.push(attempt);

  const startTime = Date.now();

  try {
    const response = await fetch(scraperApiUrl, { signal });
    const status = response.status;
    
    attempt.http = status;
    attempt.ms = Date.now() - startTime;

    if (!response.ok) {
      attempt.note = `ScraperAPI erreur HTTP ${status} (Premium requis)`;
      return { status: 'blocked', products: [], attempts };
    }

    const html = await response.text();

    if (/Azure WAF|Please enable JavaScript|captcha|access denied/i.test(html.slice(0, 5000))) {
      attempt.note = 'WAF détecté malgré ScraperAPI Premium';
      return { status: 'blocked', products: [], attempts };
    }

    const all = extractProducts(html, targetUrl, source.country);
    attempt.products = all.length;
    attempt.note = `Page chargée (${html.length} chars) - Produits extraits : ${all.length}`;

    if (all.length === 0) {
      return { status: 'no-match', products: [], attempts };
    }

    const matches = all
      .map((p) => ({ ...p, score: scoreTitle(p.title, parsed) }))
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score);

    attempt.matches = matches.length;

    if (matches.length > 0) {
      return { status: 'ok', products: matches, attempts };
    } else {
      return { status: 'no-match', products: [], attempts };
    }
  } catch (err) {
    attempt.error = err.message;
    return { status: 'error', products: [], attempts };
  }
}