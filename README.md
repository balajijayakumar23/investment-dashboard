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
  The allocation chart and world map keep their shape/coloring but hide
  numeric values in tooltips. State is remembered in `localStorage`.
- **Country exposure**: each company is mapped to a headquarters country via
  `COMPANY_COUNTRY` in `app.js`, so the same look-through amounts that build
  the company table are re-aggregated by country too — covering both ETFs
  and direct stocks together, the same way the company table does. A company
  with no country mapping (including residual "other/unlisted holdings"
  buckets) is grouped under "Unclassified / other holdings" rather than
  guessed, so the total still reconciles with what you invested.
- **Country map**: a choropleth world map below the allocation chart, colored
  by relative exposure (darker = more). Hover a row in either the company
  look-through table or the country table to highlight that country on the
  map; hover a country on the map directly for a tooltip with its exposure,
  % of portfolio, and contributing tickers. Built with
  [jsVectorMap](https://github.com/themustafaomar/jsvectormap) (CDN, no
  build step).

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

Six ETFs ship with seeded top-holdings snapshots (each file's `source`
field says where the numbers came from and when — **these are point-in-time
snapshots, not live data**; refresh from the issuer factsheet before
relying on them for real decisions):

| Ticker | Fund | ISIN |
|---|---|---|
| `CSPX` | iShares Core S&P 500 UCITS ETF | IE00B5BMR087 |
| `VUAA` | Vanguard S&P 500 UCITS ETF (USD) Accumulating | IE00BFMXXD54 |
| `LSMC` | Amundi MSCI Semiconductors UCITS ETF Acc | LU1900066033 |
| `NIFTYBEES` | Nippon India ETF Nifty 50 BeES | — (NSE ticker) |
| `84X0` | iShares MSCI EM ex-China UCITS ETF USD (Acc) | IE00BMG6Z448 |
| `EXUS` | Xtrackers MSCI World ex USA UCITS ETF 1C | IE0006WW1TQ4 |

Company names are normalized across all four files (e.g. always `Nvidia`,
never `NVIDIA Corp.`), and multiple share classes of the same company (e.g.
Alphabet A/C) are combined into one row, so exposure to the same company
correctly merges across funds and direct stock holdings.

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

### Adding/fixing a company's country

Add or edit an entry in `COMPANY_COUNTRY` in `app.js`, keyed by the exact
company name used elsewhere (ETF holdings files and `STOCK_NAME_MAP`), e.g.:

```js
Siemens: 'DE',
```

Values are ISO 3166-1 alpha-2 codes and must exist in the world map's region
set — if you add a country not already in `COUNTRY_NAMES`, add a display
name there too. A company with no entry here shows up under "Unclassified /
other holdings" in the country table instead of on the map.

## Architecture notes

The aggregation engine (`aggregateExposure` / `aggregateByCountry` in
`app.js`) only ever consumes a list of
`{ ticker, amountEUR, components: [{ company, weight, country }] }`
objects — it has no idea whether those components came from a seeded JSON
file, a future live API, or a future "paste your holdings" UI. Ingestion
(`resolveComponents`, which reads the JSON files and the `COMPANY_COUNTRY`
lookup today) is the only part that would need to change to support a new
data source; rendering and aggregation stay untouched.

## Out of scope (v1)

Live prices, P&L, news, sector breakdown, encryption, multi-currency,
auto-fetch, PWA/offline install, cross-device sync. The ingestion/engine
split above is meant to make most of these addable later without rewriting
the core.
