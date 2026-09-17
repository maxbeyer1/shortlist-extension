const POLL_MS = 400;     // between extraction attempts while a page loads
const TIMEOUT_MS = 8000; // hard cap per URL
const SAVE_MS = 500;

const grid = document.getElementById('grid');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const input = document.getElementById('urls');

let items = [];
const cards = new Map(); // url -> card element

// ---- storage ----

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ items }), SAVE_MS);
  countEl.textContent = items.length;
}

// Dedupe key: http(s) only, tracking params and fragment stripped, no trailing slash.
function canonical(raw) {
  let u;
  try { u = new URL(raw); } catch { return undefined; }
  if (!/^https?:$/.test(u.protocol)) return undefined;
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_[ce]id$|_ga$|ref$)/i.test(k)) u.searchParams.delete(k);
  }
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.href;
}

// Find or create the item for a raw URL; undefined for anything but http(s).
function upsert(raw) {
  const url = canonical(raw);
  if (!url) return undefined;
  let item = items.find(i => i.url === url);
  if (!item) {
    item = { url, domain: new URL(url).hostname.replace(/^www\./, ''), addedAt: Date.now(), sessionId: null };
    items.push(item);
  }
  return item;
}

function addUrls(raws) {
  for (const raw of raws) {
    const item = upsert(raw);
    if (!item || (item.hydratedAt && !item.error)) continue;
    delete item.error;
    delete item.hydratedAt;
    paint(item);
    enqueue(item);
  }
  save();
}

// Entry from the service worker (right-click add): a bare { url } to hydrate, or a page it
// already extracted in place, which replaces whatever we had — live session data beats a
// background tab.
function receive(entry) {
  if (!entry.hydratedAt) return addUrls([entry.url]);
  const item = upsert(entry.url);
  if (!item) return;
  const { url, ...data } = entry;
  delete item.error;
  Object.assign(item, data);
  paint(item);
  save();
}

function remove(item) {
  items.splice(items.indexOf(item), 1);
  if (queue.includes(item)) queue.splice(queue.indexOf(item), 1);
  cards.get(item.url).remove();
  cards.delete(item.url);
  save();
}

// ---- hydration queue: one background tab at a time ----

const queue = [];
let busy = false;
let liveTab; // tab id currently being hydrated, closed on unload

function enqueue(item) {
  if (!queue.includes(item)) queue.push(item);
  pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const item = queue.shift();
    statusEl.textContent = `Fetching ${item.domain}… (${queue.length} left)`;
    await hydrate(item);
    if (!items.includes(item)) continue; // removed while hydrating
    paint(item);
    save();
  }
  busy = false;
  statusEl.textContent = '';
}

async function hydrate(item) {
  const started = Date.now();
  let tabId;
  try {
    ({ id: tabId } = await chrome.tabs.create({ url: item.url, active: false }));
    liveTab = tabId;
    const { url, ...data } = await extractIn(tabId);
    Object.assign(item, data);
  } catch (e) {
    item.error = e.message ?? String(e);
  }
  item.hydratedAt = Date.now();
  liveTab = undefined;
  if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  console.log(`${item.domain} ${Date.now() - started}ms`, item.error ?? item._src, item._ld);
}

// Poll the extractor without waiting for the page to finish loading — JSON-LD and OG tags are in
// the <head> and appear long before window.load (trackers, ads, lazy images). Return as soon as
// product JSON-LD is found; at the deadline settle for the best partial result.
async function extractIn(tabId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let best, lastError;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'], injectImmediately: true });
      if (Object.values(result._src).includes('ld')) return result;
      if (result.title) best = result;
    } catch (e) {
      lastError = e; // document not committed yet, or a page we can't inject into
    }
    await sleep(POLL_MS);
  }
  if (best) return best;
  throw lastError ?? new Error('timed out');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- rendering ----

// Badge text for anything other than plain in-stock; unknown values show as-is.
const AVAILABILITY = {
  instock: '', onlineonly: '',
  outofstock: 'Sold out', soldout: 'Sold out', oos: 'Sold out', discontinued: 'Discontinued',
  backorder: 'Backorder', preorder: 'Pre-order', presale: 'Pre-sale', limitedavailability: 'Low stock',
  instoreonly: 'In store only',
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(n, currency) {
  if (!currency) return String(n);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
  } catch { return `${n} ${currency}`; } // non-ISO currency string from the wild
}

function card(item) {
  const el = document.createElement('article');
  el.className = 'card' + (item.hydratedAt ? '' : ' pending');
  const availability = item.availability && (AVAILABILITY[item.availability] ?? item.availability);
  el.innerHTML = `
    <a href="${esc(item.url)}" target="_blank" rel="noreferrer">
      <div class="img">${item.image ? `<img src="${esc(item.image)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</div>
      <div class="body">
        ${item.brand ? `<div class="brand">${esc(item.brand)}</div>` : ''}
        <div class="title">${esc(item.title ?? item.url)}</div>
        ${item.price != null || availability ? `<div class="price">
          ${item.price != null ? esc(money(item.price, item.currency)) : ''}
          ${item.strikePrice != null ? `<s>${esc(money(item.strikePrice, item.currency))}</s>` : ''}
          ${availability ? `<span class="badge">${esc(availability)}</span>` : ''}
        </div>` : ''}
        ${item.sizes ? `<div class="sizes">${item.sizes.map(s => `<span class="${s.inStock ? '' : 'out'}">${esc(s.name)}</span>`).join('')}</div>` : ''}
        <div class="meta">${esc(item.domain)}${item.error ? ` · <span class="err" title="${esc(item.error)}">failed</span>` : ''}</div>
      </div>
    </a>
    <button class="x" title="Remove">×</button>`;
  el.querySelector('.x').onclick = () => remove(item);
  return el;
}

function paint(item) {
  const el = card(item);
  const old = cards.get(item.url);
  if (old) old.replaceWith(el);
  else grid.append(el);
  cards.set(item.url, el);
}

// ---- wiring ----

function submit() {
  addUrls(input.value.split(/\s+/));
  input.value = '';
}
document.getElementById('add').onclick = submit;
input.addEventListener('keydown', e => { if (e.key === 'Enter' && e.metaKey) submit(); });
document.getElementById('clear').onclick = e => {
  e.preventDefault();
  if (!confirm(`Remove all ${items.length} items?`)) return;
  for (const item of [...items]) remove(item);
};
window.addEventListener('beforeunload', () => { if (liveTab != null) chrome.tabs.remove(liveTab); });

(async () => {
  let pending;
  ({ items = [], pending = [] } = await chrome.storage.local.get(['items', 'pending']));
  items.sort((a, b) => a.addedAt - b.addedAt);
  countEl.textContent = items.length;
  for (const item of items) {
    paint(item);
    if (!item.hydratedAt) enqueue(item); // interrupted last time
  }
  // Right-click adds: parked in storage while no dashboard was open, messaged live otherwise.
  // Listen only once items are loaded so an early message can't land in the throwaway array.
  for (const entry of pending) receive(entry);
  chrome.storage.local.remove('pending');
  chrome.runtime.onMessage.addListener(entry => { receive(entry); });
})();
