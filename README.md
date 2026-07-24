# ETF Look-Through Dashboard

A static, client-side dashboard that "looks through" the ETFs you hold to
their underlying companies, merges that with any direct stocks you hold, and
shows your true company-level exposure across your whole portfolio.

No backend, no build step, no framework. Plain HTML/CSS/JS. All your amounts
live in your browser's `localStorage` only — nothing you enter is written to
this repo or sent anywhere.

## Run it

**Option A — open directly**

Just open `index.html` in a browser.

Note: some browsers (Chrome, Safari) block `fetch()` of local files under
`file://`, which means the ETF holdings JSON files (`data/etf-holdings/*.json`)
may fail to load — affected ETFs will show up as "no holdings data available"
in the look-through table instead of being broken down. Direct stocks are
unaffected since they don't need a fetch. If you see that message, use
Option B instead.

**Option B — local server (recommended)**

```
python3 -m http.server
```

Then open http://localhost:8000

## Deploy

This is a static site — deploy the repo as-is.

**GitHub Pages**: repo Settings → Pages → Deploy from branch → pick `main`
and `/ (root)`.

**Cloudflare Pages**: create a project pointing at this repo with no build
command and `/` as the output directory.

Either way, your holdings never leave your browser — deploying just serves
the static files; your `localStorage` data is per-browser, per-device, and
isn't part of the deployment.

## How it works

- **Add holding**: type a ticker (autocompletes known ETFs and common
  stocks, but accepts any ticker) and an amount in EUR, then Add. Known ETF
  tickers are stored as type `ETF`; anything else is stored as type `Stock`.
- **Look-through**: for each ETF holding, the app loads
  `data/etf-holdings/<TICKER>.json` and multiplies each underlying
  company's weight by the amount you invested in that ETF. A direct stock
  is treated as 100% weight to itself. Everything is merged by company name
  and sorted by total exposure.
- **Sources**: the look-through table's Sources column shows which of your
  tickers contributed to that company's exposure (e.g. a company appearing
  in both an ETF and as a direct stock shows both).
- **Blur toggle** (👁️ icon, top right): masks all EUR amounts as `••••`.
  The allocation chart keeps its shape/labels but hides numeric values in
  tooltips. State is remembered in `localStorage`.

## Data model

Each ETF has one file at `data/etf-holdings/<TICKER>.json`:

```json
{
  "ticker": "CSPX",
  "name": "iShares Core S&P 500",
  "type": "ETF",
  "asOf": "2025-01-01",
  "holdings": [
    { "company": "Apple", "weight": 7.0 },
    { "company": "Microsoft", "weight": 6.5 }
  ]
}
```

- `weight` is a percentage of the fund (0–100).
- Weights don't need to sum to exactly 100 — if they add up to less (e.g.
  you only listed the top 15 holdings), the app fills the remainder with a
  clearly-labelled `<TICKER> — other/unlisted holdings` bucket so your total
  exposure always matches what you invested.
- A ticker with no JSON file (any stock, or an ETF you haven't seeded yet)
  is treated as 100% weight to itself for stocks, or shows as
  `<TICKER> — no holdings data available` for an unseeded ETF.

### Seeded data

`data/etf-holdings/CSPX.json` ships with ~15 representative top holdings of
the S&P 500. **It's an illustrative snapshot, not live data** — update the
weights from the issuer factsheet (ishares.com) before relying on it for
real decisions.

### Adding a new ETF

1. Create `data/etf-holdings/<TICKER>.json` following the format above,
   using top holdings + weights from the issuer's factsheet.
2. Add an entry to `ETF_REGISTRY` near the top of `app.js`:
   ```js
   { ticker: 'VWCE', name: 'Vanguard FTSE All-World UCITS ETF' },
   ```
   This makes it appear in the ticker autocomplete and marks it as type
   `ETF` when added. (An ETF ticker not in the registry still works if you
   add its JSON file — the registry is only needed for autocomplete/type
   inference, not for look-through itself.)

### Adding/renaming a known stock

Add or edit an entry in `STOCK_NAME_MAP` in `app.js`, e.g.:

```js
AAPL: 'Apple',
```

The company name here should match the spelling used in ETF holdings files
exactly, so a direct stock holding merges with the same company appearing
inside your ETFs instead of showing as a separate row.

## Architecture notes

The aggregation engine (`aggregateExposure` in `app.js`) only ever consumes
a list of `{ ticker, amountEUR, components: [{ company, weight }] }`
objects — it has no idea whether those components came from a seeded JSON
file, a future live API, or a future "paste your holdings" UI. Ingestion
(`resolveComponents`, which reads the JSON files today) is the only part
that would need to change to support a new data source; rendering and
aggregation stay untouched.

## Out of scope (v1)

Live prices, P&L, news, sector/country breakdown, encryption, multi-currency,
auto-fetch, PWA/offline install. The ingestion/engine split above is meant
to make most of these addable later without rewriting the core.
