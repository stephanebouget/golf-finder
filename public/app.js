// Front-end: opens a Server-Sent Events stream and renders results live.

const $ = (id) => document.getElementById(id);
const form = $('form');
const state = { products: [], sites: [], total: 0, source: null };

const STATUS_LABEL = {
  pending: 'en cours d’analyse...',
  ok: 'results found',
  'no-match': 'no matching product',
  'no-search': 'search page not recognised',
  unparsed: 'page loaded but no products recognised (JavaScript-rendered?)',
  blocked: 'blocked (anti-bot)',
  error: 'network error',
  aborted: 'analysis stopped',
  directory: 'directory, not a shop',
};

// "FR" -> 🇫🇷
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));

const money = (amount, currency) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);

// ---- country chips --------------------------------------------------------

async function loadCountries() {
  const { countries } = await (await fetch('/api/sources')).json();
  $('countries').innerHTML = Object.entries(countries)
    .sort((a, b) => b[1] - a[1])
    .map(([cc, n]) => `<label><input type="checkbox" value="${cc}" checked>${flag(cc)} ${cc} (${n})</label>`)
    .join('');
}

const selectedCountries = () => [...document.querySelectorAll('#countries input:checked')].map((i) => i.value);

// ---- rendering ------------------------------------------------------------

function sortedProducts() {
  const mode = $('sort').value;
  let list = state.products.filter((p) => !$('stock').checked || p.inStock !== false);
  const price = (p) => p.priceEur ?? Infinity;
  if (mode === 'price') list.sort((a, b) => price(a) - price(b));
  else if (mode === 'country') list.sort((a, b) => a.country.localeCompare(b.country) || price(a) - price(b));
  // "relevance" keeps arrival order (best match of each site first).
  return list;
}

function card(p) {
  const li = document.createElement('li');
  const img = p.image
    ? `<img class="thumb" src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
    : '<div class="thumb"></div>';
  const approx = p.price.currency !== 'EUR' && p.priceEur ? `<small>≈ ${money(p.priceEur, 'EUR')}</small>` : '';
  const stock = p.inStock === false ? ' · <span class="stock-no">out of stock</span>' : '';
  li.innerHTML = `
    ${img}
    <div>
      <a class="title" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>
      <div class="meta">${flag(p.country)} ${esc(p.host)} · ${p.country}${p.variant ? ` · ${esc(p.variant)}` : ''}${p.sku ? ` · ref <span class="sku">${esc(p.sku)}</span>` : ''}${stock}</div>
    </div>
    <div class="price">
      <strong>${money(p.price.amount, p.price.currency)}</strong>${approx}
      <a class="visit" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">View</a>
    </div>`;
  return li;
}

// Escape text before putting it into innerHTML (titles come from third-party sites).
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// One block per request: HTTP status / error, server, path and a page excerpt.
function attemptsHtml(site) {
  return (site.attempts ?? [])
    .map((a) => {
      const path = a.url.replace(/^https?:\/\/[^/]+/, '');
      const bits = [
        `<b>${esc(a.http ?? a.error ?? '?')}</b>`,
        a.server && `server: ${esc(a.server)}`,
        a.mitigated && `challenge: ${esc(a.mitigated)}`,
        a.products != null && `${a.products} products${a.matches != null ? `, ${a.matches} match` : ''}`,
        a.finalUrl && `redirected to ${esc(a.finalUrl)}`,
      ].filter(Boolean);
      return `<div class="attempt"><code>${esc(path)}</code><div>${bits.join(' · ')}</div>${a.note ? `<div class="note">“${esc(a.note)}”</div>` : ''}</div>`;
    })
    .join('');
}

function render(finished = false) {
  const list = sortedProducts();
  $('results').replaceChildren(...list.map(card));
  $('count').textContent = `${list.length} offer${list.length === 1 ? '' : 's'}`;
  $('toolbar').hidden = false;
  $('empty').hidden = !(finished && list.length === 0);

  // Compte uniquement les shops qui ont fini (statut différent de pending)
  const done = state.sites.filter((s) => s.status !== 'pending').length;
  $('bar-fill').style.width = `${state.total ? (done / state.total) * 100 : 0}%`;
  $('progress-text').textContent = finished ? `Done · ${done} shops checked` : `${done} / ${state.total} shops checked`;

  $('site-list').innerHTML = [...state.sites]
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((s) => {
      // Ajout d'une classe CSS d'animation si le statut est pending
      const isPending = s.status === 'pending';
      const statusClass = isPending ? 'text-amber-500 animate-pulse font-semibold' : `st-${s.status}`;
      
      return `<li>
        <div class="line">
          <span class="host">${flag(s.country)} ${esc(s.host)}</span>
          <span class="${statusClass}">
            ${STATUS_LABEL[s.status] ?? s.status}${s.products && s.products.length ? ` (${s.products.length})` : ''}
          </span>
        </div>
        ${attemptsHtml(s)}
      </li>`;
    })
    .join('');
  $('sites').hidden = state.sites.length === 0;
}

// ---- search ---------------------------------------------------------------

function stop() {
  state.source?.close();
  state.source = null;
  $('go').disabled = false;
  $('stop').hidden = true;
}

function finishPending(status) {
  for (const site of state.sites) {
    if (site.status === 'pending') site.status = status;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  stop();
  Object.assign(state, { products: [], sites: [], total: 0 });
  $('progress').hidden = false;
  $('stop').hidden = false;
  $('go').disabled = true;
  $('results').replaceChildren();

  const params = new URLSearchParams({ q: $('q').value, countries: selectedCountries().join(',') });
  const source = new EventSource(`/api/search?${params}`);
  state.source = source;

  source.addEventListener('start', (e) => {
    state.total = JSON.parse(e.data).total;
    render();
  });

  // Écouteur pour afficher les boutiques dès qu'elles passent en "pending"
  source.addEventListener('pending', (e) => {
    const site = JSON.parse(e.data);
    state.sites.push(site);
    render();
  });

  source.addEventListener('site', (e) => {
    const site = JSON.parse(e.data);
    // Remplace l'entrée "pending" existante par le résultat définitif du shop
    const index = state.sites.findIndex((s) => s.host === site.host);
    if (index !== -1) {
      state.sites[index] = site;
    } else {
      state.sites.push(site);
    }
    state.products.push(...site.products.filter((p) => p.price));
    render();
  });

  source.addEventListener('done', () => {
    finishPending('error');
    stop();
    render(true);
  });
  source.onerror = () => {
    finishPending('error');
    stop();
    render(true);
  };
});

$('stop').addEventListener('click', () => {
  finishPending('aborted');
  stop();
  render(true);
});
$('sort').addEventListener('change', () => render());
$('stock').addEventListener('change', () => render());

loadCountries();
