// Tiny fake shop used for a manual end-to-end check:
//   node test/fake-shop.js &
//   SOURCES_FILE=test/fake-sources.json node server.js
import http from 'node:http';

const page = (items) => `<html><body><ul>${items
  .map(
    ([title, price, path]) => `<li class="product"><a href="${path}"><img src="/img.jpg" alt="${title}"></a>
      <h3><a href="${path}">${title}</a></h3><span class="price-old">${price + 40},00 €</span><span class="price">${price},00 €</span></li>`,
  )
  .join('')}</ul></body></html>`;

http
  .createServer((req, res) => {
    // Simulates a WAF that rejects the first pattern tried but serves the real one.
    if (req.url.startsWith('/search?q=')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!req.url.startsWith('/catalogsearch/result/')) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      page([
        ['Titleist Vokey SM10 Tour Chrome Wedge 48.08 F', 169, '/p/1'],
        ['Titleist Vokey SM10 Tour Chrome Wedge 52.08 F', 169, '/p/2'],
        ['Cleveland RTX 6 ZipCore Wedge 48', 139, '/p/3'],
      ]),
    );
  })
  .listen(4001, '127.0.0.1', () => console.log('Fake shop on http://127.0.0.1:4001'));
