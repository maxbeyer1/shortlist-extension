# Shortlist Extension — build reference

Personal Chrome extension. Not production software. Utility over polish, simplest path that works.

---

## What we're building

When shopping online I have a goal in mind (right now: activewear) and I cmd+click a bunch of
product links into tabs. Then I have to cycle back through them, and there's no way to see all my
options at once.

This extension captures those links into a grid/gallery dashboard so I can compare everything at a
glance — product photos first, plus price, availability, sizes where we can get them.

**The whole thing lives or dies on capture friction.** Adding a link must be no harder than the
cmd+click I already do. If it's slower, the tool gets abandoned.

### Rough shape

- Add links three ways: bulk paste, right-click, and Option+click
- Everything lands in an "Unsorted" bin
- Sort Unsorted by time, shift-click a range, group it into a named session (`activewear 9/14/26`)
- Dashboard is a grid of cards, click a card to open the real page

### Environment

- **Arc browser** (Chromium 149 as of mid-2026, full MV3 extension support, `load unpacked` works).
  Arc has been in maintenance mode since May 2025 — security patches only — but nothing here
  depends on Arc-specific behaviour.
- Two Arc-specific things to avoid:
  - **`chrome.commands` keyboard shortcuts** — Arc grabs a lot of key combos for its command bar
    and spaces. We do modifier+click in a content script instead, which sidesteps the API entirely.
  - **`chrome.sidePanel`** — not confident Arc implements it. Use a normal tab, non-issue.

### Constraints

- **Lightweight.** Chromium already eats memory. No tab pools, no live iframes, no heavy libs.
- **No build step.** Plain MV3, vanilla JS, edit a file and hit reload.
- ~400–500 lines total across all files.

---

## Decisions already made (don't relitigate)

**Iframes: no.** Technically possible — strip `X-Frame-Options` and `Content-Security-Policy:
frame-ancestors` with `declarativeNetRequest` response-header rules, people do this. But 12 live
product pages in a grid is the *same* memory and CPU problem as 12 tabs, plus cookie banners, plus
lazy-loaded images that never fire in a 300px frame, plus sites that frame-bust via JS anyway, plus
`SameSite=Strict` cookies making you look logged out. It rebuilds the original problem inside one tab.

**Firecrawl: no.** It re-fetches a page the browser already rendered, without your cookies, locale,
or session, and through Akamai/Cloudflare on exactly the sites that matter (Nike, Lululemon, SSENSE).
Right tool when you don't have a browser on the page. We do.

**LLM/VLM pass: no, not yet.** See "Do we need an LLM?" below.

**The approach: extract at add-time, in the page.** When you click, your browser has already
rendered that page — logged in, correct currency, fully hydrated. A content script reading JSON-LD +
Open Graph at that moment is free, instant, and more accurate than any scraper. Then render our own
grid from that data with plain `<img>` tags pointing at their CDN. Loads instantly, no memory cost.

---

## JSON-LD research (already done — don't redo this)

Source: Google Search Central docs for
[Product variants](https://developers.google.com/search/docs/appearance/structured-data/product-variants)
and [Merchant listing](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing).

### The format space is closed

This is the key finding. We're writing code against a **published spec with a finite set of shapes**,
not against individual sites. A new site doesn't invent a fifth layout — it picks one of the four
below. That's what prevents the "constantly patching for new formats until I abandon it" failure mode.

### ProductGroup is the official variant standard

Google added it Feb 2024: `ProductGroup` with `variesBy`, `hasVariant`, `productGroupID`,
specifically for apparel/shoes/anything with sizes and colors. Lululemon emitting `ProductGroup` is
spec-compliant, not weird.

**Four layouts, that's all:**

| # | Layout | How to find variants |
|---|---|---|
| 1 | Single-page, nested | `ProductGroup.hasVariant: [Product, Product, …]` |
| 2 | Single-page, unnested | Separate `Product` nodes with `isVariantOf: {"@id": "#parent"}` |
| 3 | Multi-page, nested | Same as 1, some variants are stubs — just `{url: "..."}` |
| 4 | Multi-page, unnested | Same as 2, with stubs |

Google says layout 1 is recommended and most compact, so it's the common case. Handling `hasVariant`
+ resolving `isVariantOf` by `@id` covers all four.

**Why this matters:** each variant `Product` under `hasVariant` carries its own `size`, `color`, and
`offers.availability`. That's a real size matrix on non-Shopify sites.

`variesBy` tells you the axes up front. Supported set is only six: `color`, `size`, `suggestedAge`,
`suggestedGender`, `material`, `pattern`. So you know whether to render size chips or color swatches
before parsing variants.

### Normalization gotchas

All from the spec. These are what silently break a naive parser.

- **`@type` can be an array.** Google documents `["Product", "Book"]` and `["Product", "Car"]` as
  valid. `node['@type'] === 'Product'` is a bug — normalize to array, check membership.
- **`@context` can be `http://` or `https://`**, with or without trailing slash. (Abercrombie uses
  `http://schema.org`.) Never match on context.
- **Multiple `ld+json` blocks per page.** Abercrombie has a `WebPage` block *and* a `Product` block.
  Scan all of them, don't grab the first.
- **`@graph` wrapping.** Some CMSes nest everything under `"@graph": [...]`. Flatten first.
- **Availability is a closed 10-value enum:** `InStock`, `OutOfStock`, `BackOrder`, `Discontinued`,
  `InStoreOnly`, `LimitedAvailability`, `OnlineOnly`, `PreOrder`, `PreSale`, `SoldOut`. Google
  explicitly supports the short names without the URL prefix, so you'll see all of
  `https://schema.org/InStock`, `http://schema.org/InStock`, and bare `InStock`.
  **Rule: take everything after the last `/`, lowercase, compare.** Done forever.
- **Price has three kinds:**
  - Active — has *neither* `priceType` nor `validForMemberTier`
  - Strikethrough — `priceType: StrikethroughPrice` (and `ListPrice` is still allowed during a
    transition period — Abercrombie emits `ListPrice`, so handle both)
  - Member — has `validForMemberTier`
- **Price tiebreak rule, straight from Google:** if both `offers.price` and
  `offers.priceSpecification` are present, use `offers.price` and ignore the spec. Just copy this.
  - So: active price = `offers.price` if present, else the `priceSpecification` entry
    (object *or* array) with neither `priceType` nor `validForMemberTier`.
- **`image` can be a string, an array, or an ImageObject.** Google's own example is an array of three
  aspect ratios. Normalize to array, take first.
- **`offers` can be `Offer` or `AggregateOffer`.** Merchant listings require `Offer`, but product
  snippets accept either, so AggregateOffer is out there — `lowPrice`/`highPrice` instead of `price`.
- **`size` can be Text ("XL") or a `SizeSpecification` object** with `name`, `sizeGroup`,
  `sizeSystem`. Take `.name` if object.
- **`brand` is usually `{@type: Brand, name}`, sometimes a bare string.**
- **Key casing isn't guaranteed.** Abercrombie emits `"SKU"` uppercase. Be lenient, never throw on
  one weird field.

### What we're NOT handling

- **Microdata and RDFa.** Google supports all three formats; we only do JSON-LD. JSON-LD dominates
  and Google recommends it. If a site turns up bare, this is the likely reason — acceptable for a
  personal tool.
- **JS-generated Product markup** that appears after render. Google warns this is less reliable.
  Our right-click path reads the live DOM so it's actually fine there; the hydration path might miss
  it if we read too early.

### Shopify shortcut

Most DTC activewear is Shopify (Vuori, Alo, Outdoor Voices, Gymshark, Ten Thousand, Bandit,
Tracksmith). Shopify exposes a public per-product endpoint:

```
https://store.com/products/{handle}.js
```

Returns product JSON by handle, in the customer's presentment currency, with every variant's title,
SKU, price, compare-at price, and availability. Full size × color matrix with in-stock booleans from
one `fetch`, no parsing. Detect via `window.Shopify` or a `/products/{handle}` URL shape.

Caveat: `available` is a boolean, not a quantity. No "only 2 left."

### Data tiers — design the UI around these

Sites differ a lot in how much they publish (Lululemon is much richer than Abercrombie). **Render
what we have, show nothing where we don't.** No placeholders, no guesses — a wrong "M in stock" is
worse than a blank.

| Tier | What | Where |
|---|---|---|
| 0 | Image, title, URL, domain, timestamp | Always |
| 1 | Price, strikethrough, brand, page-level availability | Most sites (JSON-LD / OG) |
| 2 | Size/color matrix + per-variant availability | Shopify `.js`, and any site using ProductGroup |
| 3 | Sizes elsewhere (Nike, Amazon, etc.) | **Don't try** — XHR'd post-render, different per site, behind bot detection. Show a "check sizes ↗" button that opens the tab. |

### Do we need an LLM?

Not now. The residual risk isn't weird formats — it's sites emitting **no Product JSON-LD at all**.
Those fall to Tier 1 or Tier 0 regardless of what tool you use.

Plan: build the normalizer, **instrument it**. Store a tiny `_src` field per item recording which
path each field came from (`ld` / `og` / `dom`). After one real session you'll have exact hit-rate
data. If it's 90%+, done permanently. If one site you actually shop is consistently Tier 0, *then*
add a per-card "enrich" button for that case — manual, on demand, no background API dependency.
Don't build it speculatively.

---

## Stack

**Files:** `manifest.json`, `background.js`, `extract.js`, `dashboard.html`, `dashboard.js`. That's it.

**Permissions:** `contextMenus`, `storage`, `scripting`, `tabs`, `host_permissions: ["<all_urls>"]`

**Storage:** `chrome.storage.local`, single `items` array.
- Store only the ~10 rendered fields + size chips + `_src`. **Never store the raw JSON-LD blob** —
  10–50KB per item you'll never read again.
- Debounce writes ~500ms, don't write per card update.
- Dedupe on canonical URL with UTM params stripped, or you'll add the same shoe twice from two listings.

**Dashboard:** opens as a full tab via `chrome.tabs.create` on toolbar click. Not a popup — popups
are cramped and close on blur, fatal when comparing.

**Card layout:** CSS grid, `aspect-ratio: 3/4` image with `object-fit: cover`, 2-line title clamp,
price with strikethrough if present, domain, size chips if Tier 2. Click opens in new tab.
- `loading="lazy"` on every `<img>`
- `referrerpolicy="no-referrer"` — a few CDNs hotlink-block, this usually gets around it
- No masonry lib, no virtualization. 30 items, not 3000.

---

## Build stages

Discrete and testable. Stop at each test before moving on.

### Stage 1 — Bulk paste + grid

This is the whole tool minus the nice input methods. **Build this first — I'm mid-session and need
to import what I've already got open.**

**The extractor** (`extract.js`, one function, runs in the page):

1. **Collect** — all `ld+json` tags, `JSON.parse` each in its own try/catch (one malformed block
   shouldn't kill the rest), flatten arrays and `@graph`.
2. **Classify** — normalize `@type` to array. Bucket into `ProductGroup` and `Product` nodes. Ignore
   `WebPage`, `BreadcrumbList`, `Organization`, etc.
3. **Pick the root** — prefer a `ProductGroup`; else the `Product` with the most fields.
4. **Collect variants** — `root.hasVariant` (array or single), plus any `Product` whose
   `isVariantOf.@id` matches the root's `@id`. Drop stubs that only have a `url`.
5. **Extract per node** using the normalizers above: name, image, brand, availability, active price,
   strikethrough price, size, color.
6. **Roll up** — card shows root name/image/price. If variants exist, build chips from `size` (or
   whatever `variesBy` says) with in-stock state from each variant's `availability`.
7. **Backfill** from `og:image`, `og:title`, `product:price:amount`, then `document.title` and
   largest image. Merge **field by field**, not "pick one source and stop" — Abercrombie's OG image
   has useful size params (`wid=350`) that the JSON-LD one lacks.
8. **Always return something.** Whole thing in one try/catch. Worst case `{url, title: document.title}`.
   A card with just a title and a link still beats a tab.

Every field is optional at every layer. Missing data renders as absent, never as a placeholder.

**The hydration queue** — run it **from the dashboard page, not the service worker**. MV3 service
workers get killed after ~30s idle and you'd have to persist and resume queue state. The dashboard
tab is alive as long as you're looking at it.

- Paste URLs into a textarea → dedupe → insert as stub cards (url + domain only) immediately
- Then one at a time: `chrome.tabs.create({url, active: false})` → wait for load →
  `chrome.scripting.executeScript` the extractor → update card → **`chrome.tabs.remove` immediately**
- **One tab at a time. Never a pool.** Two parallel tabs is 2× memory for 1.5× speed. 20 URLs at
  ~2s is 40 seconds — go make coffee.
- Hard timeout 8s per URL. If it hangs, close the tab, keep the stub, move on.
- Cards fill in live, so you can start browsing before the queue finishes.

**Test:**
- Paste the current session's URLs. Images and prices for most of them?
- Lululemon renders size chips with correct greyed-out states
- Abercrombie renders `$39.97` with `$80` struck through
- Nothing throws on either
- Can you scan the grid faster than cycling tabs?

**Then actually use it for the real session.** Everything below is polish on a working tool.

### Stage 2 — Debug view (DEFFERRED)

Small but do it early: a toggle on each card showing what the extractor found and which source won
each field (`_src`). When a card looks wrong you diagnose in 2 seconds instead of opening devtools.
This is the thing that keeps the tool maintainable.

**Test:** open a card that came out sparse, confirm you can immediately tell whether it was
no-JSON-LD, a parse failure, or a field the site just doesn't publish.

### Stage 3 — Right-click add

Two context menu entries:
- `contexts: ["page"]` → "Add this page" — you're on the product page, extractor runs on the live
  DOM, best possible data, no tab opened
- `contexts: ["link"]` → "Add this link" — grabs href, queues for hydration like a paste

Service worker only needs to live long enough for one `executeScript` + one storage write, so no
lifecycle problems here.

**Test:** right-click 5 product pages you're already viewing. Data should be *better* than what
hydration gave for the same URLs — real session, real currency, fully rendered.

### Stage 4 — Option+click (the actual product)

Content script on `<all_urls>`, capture-phase click listener:

```js
if (e.altKey && e.target.closest('a')) { e.preventDefault(); e.stopPropagation(); /* ... */ }
```

`preventDefault()` **first thing** — Option+click is Chromium's "download link target" gesture and
you need to kill it before anything else sees it.

Then run the extractor/hydration queue, whatever makes the most sense. Keep it simple and snappy, so that this is just as easy as using cmd+click to open a tab.

Memory: this runs on every page you visit. Keep it tiny — one listener, no polling, no
MutationObserver, nothing running until you actually alt-click.

**Test:** listing page, Option+click 8 products in a row. Under 10 seconds total, 8 cards with
images. **If it feels slower than cmd+click, fix it before anything else.**

### Stage 5 — Sessions

Everything lands with `sessionId: null` → "Unsorted."

Dashboard: sort Unsorted by `addedAt`, shift-click a range, "Group" button, prompt for a name,
default to `{most common domain} {today's date}`. Sessions become a simple left-nav list.

That's the whole feature. No nesting, no tags, no drag-and-drop.

**Test:** group a range into a named session, confirm it leaves Unsorted and shows under its own nav item.

### Stage 6 — Only if the data says it's worth it

**Shopify variants.** Detect `window.Shopify` or `/products/{handle}`, fetch the `.js` endpoint,
render size chips greyed-out when unavailable. One fetch, no parsing.

**Screenshots.** `chrome.tabs.captureVisibleTab` for sites with no OG image. Only works on the
*active* tab, so it pairs with the Stage 3 right-click path. Downscale to ~400px via `OffscreenCanvas`
and store in IndexedDB, not `chrome.storage.local` — full-size base64 will blow quota fast.
Honestly probably skip this; an `og:image` miss is rare.

---

## Deliberately not building

- Iframes, Firecrawl, VLM screenshot reading
- Tier 3 size data on Nike/Lululemon-style XHR'd availability
- Microdata/RDFa parsing
- Build step, framework, virtualization, sync, export, tags, drag-and-drop
