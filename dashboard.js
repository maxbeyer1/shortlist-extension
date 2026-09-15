const SETTLE_MS = 500;   // after load, before first extract
const RETRY_MS = 1500;   // extra wait if no product JSON-LD yet (late-rendered markup)
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

function addUrls(text) {
  const now = Date.now();
  for (const raw of text.split(/\s+/)) {
    const url = canonical(raw);
    if (!url) continue;
    let item = items.find(i => i.url === url);
    if (item?.hydratedAt && !item.error) continue;
    if (item) {
      delete item.error;
      delete item.hydratedAt;
    } else {
      item = { url, domain: new URL(url).hostname.replace(/^www\./, ''), addedAt: now, sessionId: null };
      items.push(item);
    }
    paint(item);
    enqueue(item);
  }
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
  let tabId;
  try {
    ({ id: tabId } = await chrome.tabs.create({ url: item.url, active: false }));
    liveTab = tabId;
    const { url, ...data } = await Promise.race([extractIn(tabId), timeout()]);
    Object.assign(item, data);
  } catch (e) {
    item.error = e.message ?? String(e);
  }
  item.hydratedAt = Date.now();
  liveTab = undefined;
  if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
}

async function extractIn(tabId) {
  await loaded(tabId);
  await sleep(SETTLE_MS);
  let data = await run(tabId);
  if (!Object.values(data._src).includes('ld')) {
    await sleep(RETRY_MS);
    data = await run(tabId);
  }
  return data;
}

async function run(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] });
  return result;
}

// Resolves when the tab finishes loading, or when it's closed (timeout path).
function loaded(tabId) {
  return new Promise(resolve => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const onRemoved = id => { if (id === tabId) done(); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') done(); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = () => sleep(TIMEOUT_MS).then(() => { throw new Error('timed out'); });

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
  addUrls(input.value);
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
  ({ items = [] } = await chrome.storage.local.get('items'));
  items.sort((a, b) => a.addedAt - b.addedAt);
  countEl.textContent = items.length;
  for (const item of items) {
    paint(item);
    if (!item.hydratedAt) enqueue(item); // interrupted last time
  }
})();
