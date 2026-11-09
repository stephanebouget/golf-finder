import { existsSync, readFileSync } from "node:fs";
import { extractProducts } from "./extract.js";
import { parseQuery, scoreTitle } from "./match.js";
import { toEur } from "./price.js";
import { searchSiteScraperApi } from "./scraper-api.js";

// SOURCES_FILE lets you point to another list (handy for tests).
const SOURCES = JSON.parse(
  readFileSync(
    process.env.SOURCES_FILE ?? new URL("../sources.json", import.meta.url),
    "utf8",
  ),
);

// Entries of sources.json that are directories / retailer lists, not shops.
const DIRECTORY_HOSTS = new Set([
  "golf-list.com",
  "euroselectgolf.co.uk",
  "eu.callawaygolf.com",
]);

// Search URL patterns tried in order (covers Shopify, Magento, PrestaShop,
// WooCommerce, BigCommerce, OpenCart, Shopware...). {q} is the URL-encoded query.
const GENERIC_TEMPLATES = [
  "/search?q={q}",
  "/catalogsearch/result/?q={q}",
  "/recherche?controller=search&s={q}",
  "/?s={q}&post_type=product",
  "/search.php?search_query={q}",
  "/index.php?route=product/search&search={q}",
  "/search?type=product&q={q}",
  "/suche?sSearch={q}",
  "/search/?q={q}",
  "/zoeken?q={q}",
];

// Your own search URL patterns per host, e.g. { "halpennygolf.com": ["/fr/search.aspx?q={q}"] }.
// Copy the URL of a results page from your browser and replace the query with {q}.
const OVERRIDES = existsSync(
  new URL("../search-overrides.json", import.meta.url),
)
  ? JSON.parse(
      readFileSync(
        new URL("../search-overrides.json", import.meta.url),
        "utf8",
      ),
    )
  : {};

// Hosts with a well-known search URL.
const HOST_TEMPLATES = {
  amazon: ["/s?k={q}"],
  ebay: ["/sch/i.html?_nkw={q}"],
  "decathlon.fr": ["/search?Ntt={q}"],
  "sportsdirect.com": ["/searchresults?descriptionfilter={q}"],
};

const LANGUAGE = {
  FR: "fr-FR,fr",
  GB: "en-GB,en",
  IE: "en-IE,en",
  DE: "de-DE,de",
  NL: "nl-NL,nl",
  BE: "nl-BE,nl",
  ES: "es-ES,es",
  IT: "it-IT,it",
  SE: "sv-SE,sv",
  NO: "nb-NO,nb",
  FI: "fi-FI,fi",
  CH: "de-CH,de",
  CZ: "cs-CZ,cs",
  LU: "fr-LU,fr",
};

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_BODY_CHARS = 3_000_000;
const MAX_TEMPLATES_PER_SITE = 5;
const CONCURRENCY = 10;

// Remember which template worked for a host so later searches are faster.
const workingTemplate = new Map();

const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");

export function listSources() {
  return SOURCES.map((s) => ({
    ...s,
    host: hostOf(s.url),
    directory: DIRECTORY_HOSTS.has(hostOf(s.url)),
  }));
}

function templatesFor(host) {
  const specific =
    Object.entries(HOST_TEMPLATES).find(([key]) => host.includes(key))?.[1] ??
    [];
  const learned = workingTemplate.get(host);
  const custom = OVERRIDES[host] ?? [];
  // Custom patterns always come first and are never cut by the per-site limit.
  return [
    ...new Set(
      [...custom, learned, ...specific, ...GENERIC_TEMPLATES].filter(Boolean),
    ),
  ].slice(0, custom.length + MAX_TEMPLATES_PER_SITE);
}

async function fetchHtml(url, country, signal) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": `${LANGUAGE[country] ?? "en"};q=0.9,en;q=0.5`,
    },
  });
  // Clues about who answered, to tell a real anti-bot wall from a wrong URL.
  const clues = {
    server: response.headers.get("server") ?? undefined,
    mitigated: response.headers.get("cf-mitigated") ?? undefined, // Cloudflare challenge
    finalUrl: response.url !== url ? response.url : undefined, // redirected somewhere else
  };
  const excerpt = (text) =>
    text
      .replace(
        /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      ...clues,
      excerpt: excerpt(
        (await response.text().catch(() => "")).slice(0, 20_000),
      ),
    };
  }
  const html = (await response.text()).slice(0, MAX_BODY_CHARS);
  // Typical anti-bot walls served with a 200 status.
  if (
    /captcha|robot check|are you a human|access denied/i.test(
      html.slice(0, 5000),
    ) &&
    html.length < 20_000
  ) {
    return { ok: false, status: "blocked", ...clues, excerpt: excerpt(html) };
  }
  return { ok: true, html, finalUrl: response.url, ...clues };
}

/**
 * Search one shop. Returns { status, products, attempts } where status is one of:
 * ok | no-match | no-search | unparsed | blocked | error | directory
 * `attempts` lists every request made (diagnostics, shown in the UI and logged).
 */
async function searchSite(source, parsed, signal) {
  const host = hostOf(source.url);
  if (DIRECTORY_HOSTS.has(host))
    return { status: "directory", products: [], attempts: [] };

  const origin = new URL(source.url).origin;
  const queries = [
    ...new Set([parsed.searchText, parsed.broadText].filter(Boolean)),
  ];
  const attempts = [];
  let blocked = 0; // requests refused with 401/403/503
  let stopNow = false; // rate limit / captcha / network failure: do not insist
  let networkError = false;
  let unparsed = 0; // pages loaded (HTTP 200) where no product could be extracted

  templates: for (const template of templatesFor(host)) {
    let pageHadProducts = false;

    for (const q of queries) {
      const url = origin + template.replace("{q}", encodeURIComponent(q));
      const attempt = { url };
      attempts.push(attempt);

      let page;
      try {
        page = await fetchHtml(url, source.country, signal);
      } catch (error) {
        if (signal.aborted)
          return { status: "aborted", products: [], attempts };
        attempt.error = error.cause?.code ?? error.name; // e.g. ENOTFOUND, TimeoutError
        networkError = true;
        break templates; // Host unreachable: do not hammer it.
      }

      attempt.http = page.ok ? 200 : page.status;
      Object.assign(attempt, {
        server: page.server,
        mitigated: page.mitigated,
        redirectedTo:
          page.finalUrl !== url && page.ok ? page.finalUrl : page.finalUrl,
        note: page.excerpt,
      });
      if (!page.ok) {
        // A single 403 is often just the WAF rejecting an unknown URL, so try the
        // next search pattern. Only a captcha or a 429 (rate limit) stops us at once.
        if (page.status === "blocked" || page.status === 429) {
          blocked += 2;
          stopNow = true;
        } else if ([401, 403, 503].includes(page.status)) {
          blocked += 1;
        }
        if (stopNow || blocked >= 3) break templates;
        break; // Next template.
      }

      const all = extractProducts(
        page.html,
        page.finalUrl ?? url,
        source.country,
      );
      attempt.products = all.length;
      if (all.length === 0) {
        unparsed += 1;
        continue;
      }
      pageHadProducts = true;

      const matches = all
        .map((p) => ({ ...p, score: scoreTitle(p.title, parsed) }))
        .filter((p) => p.score > 0)
        .sort((a, b) => b.score - a.score);
      attempt.matches = matches.length;
      if (matches.length > 0) {
        workingTemplate.set(host, template);
        return { status: "ok", products: matches, attempts };
      }
    }

    // The search page works but nothing matches: no point trying other templates.
    if (pageHadProducts) {
      workingTemplate.set(host, template);
      return { status: "no-match", products: [], attempts };
    }
  }

  let status = "no-search";
  if (blocked >= 2) status = "blocked";
  else if (networkError) status = "error";
  else if (unparsed > 0) status = "no-match"; // Transforme "unparsed" en "no-match" pour que l'IHM décompte le shop comme terminé

  // --- SECOURS HEADLESS SI BLOQUÉ ---
  if (status === "blocked") {
    try {
      const headlessResult = await searchSiteScraperApi(source, parsed, signal);
      if (headlessResult.status === "ok") {
        return headlessResult; // Retourne les produits trouvés via le navigateur headless
      }
      // Fusionne les tentatives pour le diagnostic
      attempts.push(...headlessResult.attempts);
      if (headlessResult.status === "error") status = "error";
    } catch (e) {
      // En cas d'échec de Playwright, on conserve le statut bloqué initial
    }
  }

  return { status, products: [], attempts };
}

/**
 * Search every source with limited concurrency.
 * `onSite` is called as soon as each site is done (used for live streaming).
 */
export async function searchAll({ query, countries, signal, onSite }) {
  const parsed = parseQuery(query);
  const sources = listSources().filter(
    (s) => !countries?.length || countries.includes(s.country),
  );
  let next = 0;

  async function worker() {
    while (next < sources.length && !signal.aborted) {
      const source = sources[next++];
      const started = Date.now();

      // 1. Notifier l'IHM que le shop est en cours d'analyse
      onSite({
        host: source.host,
        country: source.country,
        status: "pending",
        ms: 0,
        attempts: [],
        products: [],
      });

      let result;
      try {
        result = await searchSite(source, parsed, signal);
      } catch {
        result = { status: "error", products: [], attempts: [] };
      }
      if (signal.aborted) return;

      // 2. Notifier l'IHM du résultat final
      onSite({
        host: source.host,
        country: source.country,
        status: result.status,
        ms: Date.now() - started,
        attempts: result.attempts,
        products: result.products.slice(0, 5).map((p) => ({
          title: p.title,
          url: p.url,
          image: p.image,
          sku: p.sku,
          price: p.price,
          priceEur: p.price ? toEur(p.price.amount, p.price.currency) : null,
          inStock: p.inStock,
          host: source.host,
          country: source.country,
        })),
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker),
  );
  return { total: sources.length, parsed };
}

export { parseQuery };
