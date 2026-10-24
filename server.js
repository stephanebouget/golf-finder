import express from 'express';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { listSources, searchAll, parseQuery } from './lib/search.js';

const PORT = Number(process.env.PORT ?? 3000);
// Bound to localhost by default: this server fetches third-party sites on demand.
const HOST = process.env.HOST ?? '127.0.0.1';

const app = express();
// fileURLToPath (not URL.pathname) so the path is valid on Windows too.
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

// Countries available in sources.json, with the number of sources for each.
app.get('/api/sources', (_req, res) => {
  const counts = {};
  for (const s of listSources()) if (!s.directory) counts[s.country] = (counts[s.country] ?? 0) + 1;
  res.json({ countries: counts });
});

// Live search: results are pushed to the browser as Server-Sent Events.
app.get('/api/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim().slice(0, 120);
  const countries = String(req.query.countries ?? '').split(',').filter((c) => /^[A-Z]{2}$/.test(c));
  if (query.length < 2) return res.status(400).json({ error: 'Query too short' });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Stop fetching as soon as the browser closes the stream.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const parsed = parseQuery(query);
  const total = listSources().filter((s) => !countries.length || countries.includes(s.country)).length;
  send('start', { total, parsed });

  const sites = [];
  await searchAll({
    query,
    countries,
    signal: controller.signal,
    onSite: (site) => {
      sites.push({ host: site.host, country: site.country, status: site.status, ms: site.ms, attempts: site.attempts });
      send('site', site);
    },
  });
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(LOG_FILE, JSON.stringify({ query, date: new Date().toISOString(), sites }, null, 2));
  send('done', {});
  res.end();
});

// Diagnostics of the last search (one entry per shop with every request made).
const LOG_DIR = fileURLToPath(new URL('./logs', import.meta.url));
const LOG_FILE = `${LOG_DIR}/last-search.json`;
app.get('/api/diagnostics', (_req, res) => {
  if (!existsSync(LOG_FILE)) return res.status(404).json({ error: 'Run a search first' });
  res.download(LOG_FILE, 'golf-finder-diagnostics.json');
});

app.listen(PORT, HOST, () => console.log(`Golf finder running on http://${HOST}:${PORT}`));
