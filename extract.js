// Runs inside a product page via chrome.scripting.executeScript; the IIFE's return
// value is the injection result. Reads JSON-LD, then Open Graph, then the DOM,
// filling each field from the first source that has it. Never throws — worst case
// returns { url, title }.
(() => {
  const src = {}; // field -> 'ld' | 'og' | 'dom'
  const out = { url: location.href, _src: src };
  const set = (key, value, from) => {
    if (value == null || value === '' || out[key] != null) return;
    out[key] = value;
    src[key] = from;
  };

  const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const first = v => (Array.isArray(v) ? v[0] : v);
  // Case-insensitive property read (Abercrombie emits "SKU"); undefined for non-objects.
  const prop = (o, key) => {
    if (!o || typeof o !== 'object') return undefined;
    if (key in o) return o[key];
    const lower = key.toLowerCase();
    return o[Object.keys(o).find(k => k.toLowerCase() === lower)];
  };
  // Text from a string, number, or a named object (Brand, SizeSpecification, ImageObject…).
  const str = v => {
    v = first(v);
    if (typeof v === 'string') return v.trim() || undefined;
    if (typeof v === 'number') return String(v);
    if (v && typeof v === 'object') return str(prop(v, 'name'));
    return undefined;
  };
  // schema.org enum → short lowercase name: "https://schema.org/InStock" → "instock".
  const tail = v => (typeof v === 'string' ? v.split('/').pop().toLowerCase() : undefined);
  const num = v => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  };
  const abs = u => {
    if (typeof u !== 'string' || !u) return undefined;
    try { return new URL(u, location.href).href; } catch { return undefined; }
  };
  const img = v => {
    v = first(v);
    if (typeof v === 'string') return abs(v);
    return abs(str(prop(v, 'url') ?? prop(v, 'contentUrl')));
  };

  // One Offer/AggregateOffer → { price, strikePrice, currency, availability }.
  const parseOffer = o => {
    const r = { currency: str(prop(o, 'priceCurrency')), availability: tail(str(prop(o, 'availability'))) };
    // Google's tiebreak: offers.price wins over priceSpecification when both exist.
    let price = num(prop(o, 'price') ?? prop(o, 'lowPrice'));
    let strike;
    for (const s of list(prop(o, 'priceSpecification'))) {
      const kind = tail(str(prop(s, 'priceType')));
      if (kind === 'strikethroughprice' || kind === 'listprice') strike ??= num(prop(s, 'price'));
      else if (!kind && !prop(s, 'validForMemberTier')) price ??= num(prop(s, 'price'));
      r.currency ??= str(prop(s, 'priceCurrency'));
    }
    r.price = price;
    r.strikePrice = strike > price ? strike : undefined;
    return r;
  };
  const inStock = a => a === 'instock' || a === 'onlineonly' || a === 'limitedavailability';
  // Merge parsed offers: cheapest price wins (with its strikethrough), in stock if any is.
  const merge = offers => offers.reduce((a, b) => ({
    currency: a.currency ?? b.currency,
    availability: inStock(a.availability) ? a.availability : inStock(b.availability) ? b.availability : a.availability ?? b.availability,
    ...(b.price != null && !(a.price <= b.price) ? { price: b.price, strikePrice: b.strikePrice } : { price: a.price, strikePrice: a.strikePrice }),
  }), {});
  const offer = node => merge(list(prop(node, 'offers')).map(parseOffer));

  try {
    // 1. Collect every node from every ld+json block; a malformed block only loses itself.
    const nodes = [];
    const flatten = v => {
      for (const n of list(v)) {
        if (!n || typeof n !== 'object') continue;
        nodes.push(n);
        flatten(prop(n, '@graph'));
        flatten(prop(n, 'mainEntity'));
      }
    };
    const blocks = document.querySelectorAll('script[type="application/ld+json"]');
    let parsed = 0;
    for (const b of blocks) {
      try { flatten(JSON.parse(b.textContent)); parsed++; } catch {}
    }

    // 2–3. Classify by @type (may be an array or a full URL) and pick the root.
    const types = n => list(prop(n, '@type')).map(t => tail(String(t)));
    const groups = nodes.filter(n => types(n).includes('productgroup'));
    const products = nodes.filter(n => types(n).includes('product'));
    const richest = arr => arr.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0];
    const root = richest(groups) ?? richest(products);
    out._ld = { blocks: blocks.length, parsed, groups: groups.length, products: products.length, variants: 0 };

    if (root) {
      // 4. Variants: nested under hasVariant, or top-level Products pointing back via isVariantOf.
      const rootId = prop(root, '@id');
      const parentId = p => { const v = prop(p, 'isVariantOf'); return typeof v === 'string' ? v : prop(v, '@id'); };
      const variants = [...list(prop(root, 'hasVariant')), ...products.filter(p => p !== root && rootId && parentId(p) === rootId)]
        .filter(v => v && typeof v === 'object' && (prop(v, 'size') || prop(v, 'color') || prop(v, 'offers'))) // drop url-only stubs
        .map(v => ({ node: v, offer: offer(v) }));
      out._ld.variants = variants.length;

      // 5–6. Root fields, rolling price/availability up from variants when the root has none.
      set('title', str(prop(root, 'name')), 'ld');
      set('image', img(prop(root, 'image')) ?? variants.map(v => img(prop(v.node, 'image'))).find(Boolean), 'ld');
      set('brand', str(prop(root, 'brand')), 'ld');
      const rootOffer = offer(root);
      const o = rootOffer.price != null || rootOffer.availability ? rootOffer : merge(variants.map(v => v.offer));
      set('price', o.price, 'ld');
      set('strikePrice', o.strikePrice, 'ld');
      set('currency', o.currency, 'ld');
      set('availability', o.availability, 'ld');

      const sizes = [];
      for (const { node, offer: vo } of variants) {
        const name = str(prop(node, 'size'));
        if (!name) continue;
        const existing = sizes.find(s => s.name === name);
        if (existing) existing.inStock ||= inStock(vo.availability);
        else sizes.push({ name, inStock: inStock(vo.availability) });
      }
      if (sizes.length) set('sizes', sizes, 'ld');
    }

    // 7. Backfill from Open Graph, then the DOM.
    const meta = p => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content.trim();
    set('title', meta('og:title'), 'og');
    set('image', abs(meta('og:image:secure_url') ?? meta('og:image')), 'og');
    set('brand', meta('product:brand'), 'og');
    set('price', num(meta('product:price:amount')), 'og');
    set('currency', meta('product:price:currency'), 'og');
    set('availability', tail(meta('product:availability'))?.replace(/[\s_]/g, ''), 'og');

    let best = { area: 200 * 200 };
    for (const i of document.images) {
      const area = i.naturalWidth * i.naturalHeight;
      if (area > best.area && /^https?:/.test(i.currentSrc)) best = { area, src: i.currentSrc };
    }
    set('image', best.src, 'dom');
  } catch (e) {
    out.error = String(e);
  }
  set('title', document.title.trim(), 'dom');
  return out;
})();
