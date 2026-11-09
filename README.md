# Golf Finder

One search box that queries every golf shop listed in `sources.json` and returns,
for each seller: the exact product title / reference, the price, the URL, the
country and a photo.

```bash
npm install
npm start            # http://127.0.0.1:3000
npm test
```

Type e.g. `vokey sm10 48degre` (also `48°`, `48 deg`, or just `48`).

## How it works

- `server.js` streams results to the browser with Server-Sent Events, so offers appear as each shop answers.
- `lib/search.js` tries the usual search URLs (Shopify, Magento, PrestaShop, WooCommerce...) on each
  shop, remembers the one that works, and runs 10 shops in parallel.
- When a shop blocks direct requests, the search can fall back to ScraperAPI; each fallback request
  has a 75-second timeout (ScraperAPI may retry for up to 70 seconds) and records the provider's
  HTTP error details in diagnostics.
- `lib/extract.js` reads schema.org JSON-LD first, then falls back to product cards in the HTML.
- `lib/match.js` keeps only titles containing every word of the query and the loft number
  (`48.08` matches `48`, `SM-10` matches `sm10`).
- Prices in other currencies are sorted with approximate fixed rates (`lib/price.js`).

## Known limits

- Amazon, eBay, Decathlon and Sports Direct use anti-bot protection and will often show as "blocked".
- Shops that render results only with JavaScript return nothing; the per-shop status panel shows which.
- `golf-list.com`, `euroselectgolf.co.uk` and the Callaway page are directories, not shops, and are skipped.
- To support a shop with an unusual search URL, add it to `HOST_TEMPLATES` in `lib/search.js`.
- The server listens on 127.0.0.1 only. Set `HOST` / `PORT` to change that.
