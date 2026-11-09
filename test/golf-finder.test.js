import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchProduct, parseQuery, scoreTitle } from '../lib/match.js';
import { parseAmount, parsePrice } from '../lib/price.js';
import { extractProductVariants, extractProducts } from '../lib/extract.js';
import { fetchWithScrapling } from '../lib/scrapling.js';

test('parseQuery splits words and loft number', () => {
  const q = parseQuery('vokey sm10 48degre');
  assert.deepEqual(q.words, ['vokey', 'sm10']);
  assert.deepEqual(q.numbers, [48]);
  assert.equal(q.searchText, 'vokey sm10 48');
  assert.equal(q.broadText, 'vokey sm10');
});

test('parseQuery accepts the degree sign and a bare number', () => {
  assert.deepEqual(parseQuery('Vokey SM10 48°').numbers, [48]);
  assert.deepEqual(parseQuery('vokey sm10 48').numbers, [48]);
});

test('scoreTitle matches the right wedge only', () => {
  const q = parseQuery('vokey sm10 48degre');
  assert.ok(scoreTitle('Titleist Vokey SM10 Tour Chrome Wedge 48.08 F', q) > 0);
  assert.ok(scoreTitle('Titleist Vokey SM-10 Wedge 48°', q) > 0);
  assert.equal(scoreTitle('Titleist Vokey SM10 Tour Chrome Wedge 52.08 F', q), 0);
  assert.equal(scoreTitle('Titleist Vokey SM9 Wedge 48.08', q), 0);
  assert.equal(scoreTitle('Cleveland RTX 6 ZipCore 48', q), 0);
});

test('matchProduct matches the requested loft in product options', () => {
  const query = parseQuery('vokey sm10 48');
  const product = {
    title: 'Titleist Vokey SM10 Tour Chrome Wedge Right Hand',
    variants: [
      '48 Degree 10 Bounce F Grind Wedge - In stock',
      '50 Degree 12 Bounce F Grind Wedge - In stock',
    ],
  };

  assert.equal(
    matchProduct(product, query).variant,
    '48 Degree 10 Bounce F Grind Wedge - In stock',
  );
  assert.equal(
    matchProduct(
      { ...product, variants: ['50 Degree 12 Bounce F Grind Wedge'] },
      query,
    ),
    null,
  );
});

test('parseAmount handles European and UK formats', () => {
  assert.equal(parseAmount('1.299,00 €'), 1299);
  assert.equal(parseAmount('£1,299.50'), 1299.5);
  assert.equal(parseAmount('1 299,90 €'), 1299.9);
  assert.equal(parseAmount('149,95'), 149.95);
  assert.equal(parseAmount('1.299'), 1299);
  assert.equal(parseAmount('no price'), null);
});

test('parsePrice detects the currency', () => {
  assert.deepEqual(parsePrice('£139.00', 'GB'), { amount: 139, currency: 'GBP' });
  assert.deepEqual(parsePrice('159,00 €', 'FR'), { amount: 159, currency: 'EUR' });
  assert.deepEqual(parsePrice('1 490 Kč', 'CZ'), { amount: 1490, currency: 'CZK' });
});

test('extractProducts reads JSON-LD products', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"ItemList","itemListElement":[
      {"@type":"ListItem","item":{"@type":"Product","name":"Vokey SM10 Wedge 48.08 F","sku":"VK-SM10-48",
        "url":"/p/vokey-sm10-48","image":"/img/v.jpg",
        "offers":{"@type":"Offer","price":"169.00","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}}]}
  </script></head><body></body></html>`;
  const [p] = extractProducts(html, 'https://shop.example/search?q=x', 'FR');
  assert.equal(p.title, 'Vokey SM10 Wedge 48.08 F');
  assert.equal(p.url, 'https://shop.example/p/vokey-sm10-48');
  assert.equal(p.sku, 'VK-SM10-48');
  assert.deepEqual(p.price, { amount: 169, currency: 'EUR' });
  assert.equal(p.inStock, true);
});

test('extractProducts reads product variants from option selectors', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"Titleist Vokey SM10 Wedge",
      "url":"/p/vokey-sm10","offers":{"@type":"Offer","price":"159.00","priceCurrency":"EUR"}}
  </script></head><body>
    <select name="ProductOptions_StockOptions">
      <option value="0">Select an option</option>
      <option value="114785">48 Degree 10 Bounce F Grind Wedge - In stock</option>
      <option value="114722">50 Degree 12 Bounce F Grind Wedge - In stock</option>
    </select>
    <select name="ReviewsFilter"><option value="1">Five stars</option></select>
  </body></html>`;
  const [product] = extractProducts(html, 'https://shop.example/p/vokey-sm10', 'IE');

  assert.deepEqual(product.variants, [
    '48 Degree 10 Bounce F Grind Wedge - In stock',
    '50 Degree 12 Bounce F Grind Wedge - In stock',
  ]);
  assert.deepEqual(extractProductVariants(html), product.variants);
});

test('extractProducts falls back to HTML cards and ignores old prices', () => {
  const html = `<body><ul>
    <li class="product"><a href="/vokey-sm10-48"><img data-src="/i/a.jpg" alt="Vokey SM10 Wedge 48"></a>
      <h3><a href="/vokey-sm10-48">Titleist Vokey SM10 Wedge 48</a></h3>
      <span class="price-old">199,00 €</span><span class="price">159,00 €</span></li>
    <li class="product"><a href="/other"><img src="/i/b.jpg" alt="Other club"></a>
      <h3><a href="/other">Some Other Club Driver</a></h3><span class="price">299,00 €</span></li>
  </ul></body>`;
  const products = extractProducts(html, 'https://shop.example/', 'FR');
  const wedge = products.find((p) => p.url.endsWith('/vokey-sm10-48'));
  assert.equal(wedge.title, 'Titleist Vokey SM10 Wedge 48');
  assert.equal(wedge.price.amount, 159);
  assert.equal(wedge.image, 'https://shop.example/i/a.jpg');
  assert.equal(products.length, 2);
});

test('Scrapling requests honor an already-aborted search signal', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fetchWithScrapling('https://shop.example/search', {
      headers: {},
      signal: controller.signal,
      timeoutMs: 1000,
    }),
    { name: 'AbortError' },
  );
});
