# Golf Finder

One search box that queries every golf shop listed in `sources.json` and returns,
for each seller: the exact product title / reference, the price, the URL, the
country and a photo.

```bash
npm install
npm run setup:scrapling
npm start            # http://127.0.0.1:3000
npm test
```

`npm run setup:scrapling` installs the Python dependency and Scrapling's browser
runtime. Python 3.10 or newer and its `py` launcher must be available; set
`SCRAPLING_PYTHON` if your Python executable has a different name or path.

Type e.g. `vokey sm10 48degre` (also `48°`, `48 deg`, or just `48`).

## How it works

- `server.js` streams results to the browser with Server-Sent Events, so offers appear as each shop answers.
- `lib/search.js` tries the usual search URLs (Shopify, Magento, PrestaShop, WooCommerce...) on each
  shop, remembers the one that works, and runs 10 shops in parallel.
- `scrapling_worker.py` uses Scrapling's HTTP fetcher for normal requests and retries blocked or
  JavaScript-rendered result pages with its stealth browser. HTTP requests time out after 12 seconds;
  browser attempts time out after 75 seconds and are recorded in diagnostics.
- `lib/extract.js` reads schema.org JSON-LD first, then falls back to product cards in the HTML.
- If a model title omits the requested loft, the scraper checks up to three matching product pages
  for available options such as loft and grind before ruling the shop out.
- `lib/match.js` keeps only products whose title or variant contains every word and requested
  number (`48.08` matches `48`, `SM-10` matches `sm10`).
- Prices in other currencies are sorted with approximate fixed rates (`lib/price.js`).

## Known limits

- Amazon, eBay, Decathlon and Sports Direct use anti-bot protection and will often show as "blocked".
- Scrapling's browser retry needs its browser runtime, installed by `npm run setup:scrapling`.
- `golf-list.com`, `euroselectgolf.co.uk` and the Callaway page are directories, not shops, and are skipped.
- To support a shop with an unusual search URL, add it to `HOST_TEMPLATES` in `lib/search.js`.
- The server listens on 127.0.0.1 only. Set `HOST` / `PORT` to change that.
