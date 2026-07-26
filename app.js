'use strict';

/* =========================================================================
 * ETF Look-Through Dashboard
 *
 * Sections in this file:
 *
 *   1. REGISTRY    - known ETFs / stock aliases / country+sector tags.
 *   2. STORAGE      - localStorage for holdings, UI prefs, snapshots.
 *   3. INGESTION    - resolves a holding into company-level components
 *                     AND into complete country/sector allocation
 *                     components. Later this could hit a live API or a
 *                     paste-parser instead - nothing outside this section
 *                     would need to change.
 *   4. ENGINE       - pure aggregation over ingestion's output only.
 *   4b. ANALYSIS    - concentration/overlap/divergence math, still pure,
 *                     still only consuming the engine's own output.
 *   5. RENDER       - DOM + chart + map output.
 *   6. MAIN         - wiring: forms, edit/delete, toggle, snapshots, boot.
 *
 * Data model note (why "Unclassified" never appears, and why country x
 * industry is correct rather than estimated-everywhere): each ETF's own
 * holdings data is now a JOINT per-company dataset - every itemized holding
 * carries its OWN real {company, weight, country, sector}, and the
 * un-itemized remainder ("tail") is a separate, clearly-labelled joint
 * {country, sector, weight} estimate constrained to countries the fund
 * actually discloses holding (see each data/etf-holdings/<ticker>.json's
 * "tail"/"verify" fields). Country and industry EXPOSURE (breakdown tiles,
 * trees, map, divergence, snapshots) is derived by SUMMING this real joint
 * data, never by cross-multiplying independent country% and sector%
 * marginals - so a sector can never appear under a country the fund doesn't
 * hold. Each stock's own country/sector tag is likewise exact. Every euro
 * always resolves to a real, or explicitly-labelled-estimate, bucket.
 * ===================================================================== */


/* -------------------------------------------------------------------- */
/* 1. REGISTRY                                                          */
/* -------------------------------------------------------------------- */

// Known ETFs with a seeded holdings file in data/etf-holdings/<ticker>.json.
// Add a row here (and the matching JSON file) to extend look-through coverage.
const ETF_REGISTRY = [
  { ticker: 'CSPX', name: 'iShares Core S&P 500 UCITS ETF' },
  { ticker: 'VUAA', name: 'Vanguard S&P 500 UCITS ETF (USD) Accumulating' },
  { ticker: 'LSMC', name: 'Amundi MSCI Semiconductors UCITS ETF Acc' },
  { ticker: 'NIFTYBEES', name: 'Nippon India ETF Nifty 50 BeES' },
  { ticker: '84X0', name: 'iShares MSCI EM ex-China UCITS ETF USD (Acc)' },
  { ticker: 'EXUS', name: 'Xtrackers MSCI World ex USA UCITS ETF 1C' },
];

// Ticker -> display company name, used so a direct stock holding (e.g. AAPL)
// merges with the same company appearing inside an ETF's look-through data.
// Unlisted tickers just fall back to the ticker itself as the company name.
const STOCK_NAME_MAP = {
  AAPL: 'Apple',
  MSFT: 'Microsoft',
  NVDA: 'Nvidia',
  AMZN: 'Amazon',
  GOOGL: 'Alphabet',
  GOOG: 'Alphabet',
  META: 'Meta Platforms',
  AVGO: 'Broadcom',
  'BRK.B': 'Berkshire Hathaway',
  TSLA: 'Tesla',
  JPM: 'JPMorgan Chase',
  LLY: 'Eli Lilly',
  V: 'Visa',
  UNH: 'UnitedHealth Group',
  XOM: 'ExxonMobil',
  NFLX: 'Netflix',
  TSM: 'Taiwan Semiconductor Manufacturing (TSMC)',
  ASML: 'ASML Holding',
  HAUTO: 'Höegh Autoliners',
  'NOVO-B': 'Novo Nordisk',
  NOV: 'Novo Nordisk',
  NVO: 'Novo Nordisk',
  SIE: 'Siemens',
  ITC: 'ITC Limited',
};

// Direct-stock ticker -> real country of domicile. Every ticker in
// STOCK_NAME_MAP has an entry here, so a direct holding always resolves to
// a real country (never a guess, never "Unclassified"). A ticker typed by
// the user that ISN'T in this map (arbitrary/unregistered) falls back to a
// ticker-specific label ("<TICKER> (country not set)") in resolveAllocation
// Components below - specific and actionable, not a generic catch-all.
const STOCK_COUNTRY = {
  AAPL: 'US', MSFT: 'US', NVDA: 'US', AMZN: 'US', GOOGL: 'US', GOOG: 'US',
  META: 'US', AVGO: 'US', 'BRK.B': 'US', TSLA: 'US', JPM: 'US', LLY: 'US',
  V: 'US', UNH: 'US', XOM: 'US', NFLX: 'US',
  TSM: 'TW', ASML: 'NL', HAUTO: 'NO',
  'NOVO-B': 'DK', NOV: 'DK', NVO: 'DK',
  SIE: 'DE', ITC: 'IN',
};

// Direct-stock ticker -> GICS-style sector, same completeness guarantee and
// fallback behaviour as STOCK_COUNTRY above.
const STOCK_SECTOR = {
  AAPL: 'Information Technology',
  MSFT: 'Information Technology',
  NVDA: 'Information Technology',
  AMZN: 'Consumer Discretionary',
  GOOGL: 'Communication Services',
  GOOG: 'Communication Services',
  META: 'Communication Services',
  AVGO: 'Information Technology',
  'BRK.B': 'Financials',
  TSLA: 'Consumer Discretionary',
  JPM: 'Financials',
  LLY: 'Health Care',
  V: 'Financials',
  UNH: 'Health Care',
  XOM: 'Energy',
  NFLX: 'Communication Services',
  TSM: 'Information Technology',
  ASML: 'Information Technology',
  HAUTO: 'Industrials',
  'NOVO-B': 'Health Care',
  NOV: 'Health Care',
  NVO: 'Health Care',
  SIE: 'Industrials',
  ITC: 'Consumer Staples',
};

// Country code -> display name, shown in tables, trees and map tooltips.
// 'XX' is a deliberate, labelled pseudo-code some ETFs use in their own
// countryAllocation for "other / diversified, not itemized individually" -
// it's real fund data, just with no single country to paint on the map.
const COUNTRY_NAMES = {
  US: 'United States',
  TW: 'Taiwan',
  KR: 'South Korea',
  NL: 'Netherlands',
  IN: 'India',
  GB: 'United Kingdom',
  CA: 'Canada',
  CH: 'Switzerland',
  DE: 'Germany',
  AU: 'Australia',
  NO: 'Norway',
  DK: 'Denmark',
  JP: 'Japan',
  FR: 'France',
  BR: 'Brazil',
  ZA: 'South Africa',
  SA: 'Saudi Arabia',
  MX: 'Mexico',
  XX: 'Other / diversified',
};

function isKnownEtf(tickerUpper) {
  return ETF_REGISTRY.some((e) => e.ticker === tickerUpper);
}

function inferType(tickerUpper) {
  return isKnownEtf(tickerUpper) ? 'ETF' : 'Stock';
}

function buildAutocompleteOptions() {
  const datalist = document.getElementById('tickerOptions');
  datalist.innerHTML = '';
  const frag = document.createDocumentFragment();

  ETF_REGISTRY.forEach((e) => {
    const opt = document.createElement('option');
    opt.value = e.ticker;
    opt.textContent = `${e.ticker} — ${e.name} (ETF)`;
    frag.appendChild(opt);
  });

  Object.entries(STOCK_NAME_MAP).forEach(([ticker, name]) => {
    const opt = document.createElement('option');
    opt.value = ticker;
    opt.textContent = `${ticker} — ${name}`;
    frag.appendChild(opt);
  });

  datalist.appendChild(frag);
}


/* -------------------------------------------------------------------- */
/* 2. STORAGE                                                           */
/* -------------------------------------------------------------------- */

const STORAGE_KEY = 'ltd.holdings.v1';
const BLUR_KEY = 'ltd.blurred.v1';
const SOURCE_FILTER_KEY = 'ltd.sourceFilter.v1';
const SNAPSHOTS_KEY = 'ltd.snapshots.v1';

function loadHoldings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn('Could not read holdings from localStorage:', err);
    return [];
  }
}

function saveHoldings(holdings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
}

function loadBlurState() {
  return localStorage.getItem(BLUR_KEY) === 'true';
}

function saveBlurState(isBlurred) {
  localStorage.setItem(BLUR_KEY, isBlurred ? 'true' : 'false');
}

function loadSourceFilter() {
  const v = localStorage.getItem(SOURCE_FILTER_KEY);
  return v === 'ETF' || v === 'Direct' ? v : 'Combined';
}

function saveSourceFilter(filter) {
  localStorage.setItem(SOURCE_FILTER_KEY, filter);
}

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(SNAPSHOTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn('Could not read snapshots from localStorage:', err);
    return [];
  }
}

function saveSnapshots(snapshots) {
  localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snapshots));
}

// Local (not UTC) YYYY-MM-DD, so "today" matches the user's own calendar day.
function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


/* -------------------------------------------------------------------- */
/* 3. INGESTION                                                         */
/* -------------------------------------------------------------------- */

const etfFileCache = new Map(); // ticker -> Promise<parsed JSON | null>

function fetchEtfFile(tickerUpper) {
  if (etfFileCache.has(tickerUpper)) return etfFileCache.get(tickerUpper);

  const promise = (async () => {
    try {
      const res = await fetch(`data/etf-holdings/${tickerUpper}.json`, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.warn(`Could not load ETF file for ${tickerUpper}:`, err);
      return null;
    }
  })();

  etfFileCache.set(tickerUpper, promise);
  return promise;
}

// Itemized per-company holdings, each with its OWN real country + sector
// (the joint data item 1 requires - no more independent marginal lookup).
function extractHoldings(json) {
  if (!json || !Array.isArray(json.holdings)) return null;
  return json.holdings
    .filter((h) => h && typeof h.company === 'string' && Number.isFinite(Number(h.weight))
      && typeof h.country === 'string' && typeof h.sector === 'string')
    .map((h) => ({ company: h.company.trim(), weight: Number(h.weight), country: h.country, sector: h.sector }));
}

// The un-itemized remainder's joint (country, sector, weight) estimate -
// see each JSON's tail.note/verify for how it was derived and what to
// confirm. Every row's country is one the fund's own itemized holdings or
// the tail itself actually discloses - never invented.
function extractTail(json) {
  if (!json || !json.tail || !Array.isArray(json.tail.split)) return [];
  return json.tail.split
    .filter((r) => r && typeof r.country === 'string' && typeof r.sector === 'string' && Number.isFinite(Number(r.weight)))
    .map((r) => ({ country: r.country, sector: r.sector, weight: Number(r.weight) }));
}

// Pads a partial/missing company holdings list up to 100% with a
// clearly-labelled residual bucket, so exposure totals always match the
// amount invested. (Company-level look-through table only - the joint
// country/sector data below carries the tail's own real split already, so
// it never needs this.)
function padToFull(components, tickerUpper, tolerance = 0.5) {
  const sum = components.reduce((s, c) => s + c.weight, 0);
  const remainder = 100 - sum;
  if (remainder > tolerance) {
    return [...components, { company: `${tickerUpper} — remaining holdings (not itemized)`, weight: remainder, country: null, sector: null }];
  }
  return components;
}

// Resolves one user holding into {company, weight, country}[] for the
// COMPANY look-through table. For an ETF, country now comes straight from
// the holding's own real per-company data (not a best-effort lookup).
async function resolveComponents(tickerUpper, type) {
  if (type === 'Stock') {
    const company = STOCK_NAME_MAP[tickerUpper] || tickerUpper;
    return [{ company, weight: 100, country: STOCK_COUNTRY[tickerUpper] || null }];
  }

  const json = await fetchEtfFile(tickerUpper);
  const raw = extractHoldings(json);
  if (!raw || raw.length === 0) {
    return [{ company: `${tickerUpper} — no holdings data available`, weight: 100, country: null }];
  }
  return padToFull(raw, tickerUpper).map((c) => ({ company: c.company, weight: c.weight, country: c.country }));
}

// Resolves one user holding into a real JOINT {country, sector, weight}[]
// (countryIndustryJoint) plus its two marginals (countryComponents /
// industryComponents, each summing to 100, for the existing per-field
// aggregation helpers). For an ETF the joint is the fund's own itemized
// holdings + its labelled tail split (see data/etf-holdings/<ticker>.json) -
// a sector can only ever appear paired with a country that row's own data
// says it's actually in, never an independent cross-multiply. For a stock
// it's that stock's own exact tag. An unregistered ticker gets a specific,
// actionable "<TICKER> (x not set)" label instead of a generic "Unclassified".
async function resolveAllocationComponents(tickerUpper, type) {
  if (type === 'Stock') {
    const country = STOCK_COUNTRY[tickerUpper] || `${tickerUpper} (country not set)`;
    const industry = STOCK_SECTOR[tickerUpper] || `${tickerUpper} (sector not set)`;
    return {
      countryComponents: [{ country, weight: 100 }],
      industryComponents: [{ industry, weight: 100 }],
      countryIndustryJoint: [{ country, industry, weight: 100 }],
    };
  }

  const json = await fetchEtfFile(tickerUpper);
  const holdings = extractHoldings(json);
  const tail = extractTail(json);

  if (!holdings || holdings.length === 0) {
    const country = `${tickerUpper} (country not set)`;
    const industry = `${tickerUpper} (sector not set)`;
    return {
      countryComponents: [{ country, weight: 100 }],
      industryComponents: [{ industry, weight: 100 }],
      countryIndustryJoint: [{ country, industry, weight: 100 }],
    };
  }

  const joint = [
    ...holdings.map((h) => ({ country: h.country, industry: h.sector, weight: h.weight })),
    ...tail.map((t) => ({ country: t.country, industry: t.sector, weight: t.weight })),
  ];

  const countryMap = new Map();
  const industryMap = new Map();
  joint.forEach((r) => {
    countryMap.set(r.country, (countryMap.get(r.country) || 0) + r.weight);
    industryMap.set(r.industry, (industryMap.get(r.industry) || 0) + r.weight);
  });

  return {
    countryComponents: Array.from(countryMap.entries()).map(([country, weight]) => ({ country, weight })),
    industryComponents: Array.from(industryMap.entries()).map(([industry, weight]) => ({ industry, weight })),
    countryIndustryJoint: joint,
  };
}

// Full itemized company list for one held ETF, sorted by weight desc, for
// the per-ETF "country-wise holdings" and "top companies (indirect)" tables
// (items 4/5) - kept separate from resolveComponents (which pads with a
// residual row for the look-through table) since these two tables show only
// the REAL itemized rows, never a synthetic remainder line.
async function resolveEtfHoldingsDetail(tickerUpper) {
  const json = await fetchEtfFile(tickerUpper);
  const holdings = extractHoldings(json);
  if (!holdings) return null;
  return {
    holdings: [...holdings].sort((a, b) => b.weight - a.weight),
    approxConstituents: Number.isFinite(Number(json.approxConstituents)) ? Number(json.approxConstituents) : null,
  };
}


/* -------------------------------------------------------------------- */
/* 4. ENGINE (pure)                                                     */
/* -------------------------------------------------------------------- */

// sources: [{ ticker, amountEUR, components: [{company, weight, country}] }]
// returns: [{ company, country, exposureEUR, sources: Set<ticker> }] sorted desc.
function aggregateExposure(sources) {
  const byCompany = new Map();

  for (const src of sources) {
    for (const comp of src.components) {
      const exposureEUR = src.amountEUR * (comp.weight / 100);
      if (!byCompany.has(comp.company)) {
        byCompany.set(comp.company, { company: comp.company, country: comp.country, exposureEUR: 0, sources: new Set() });
      }
      const entry = byCompany.get(comp.company);
      entry.exposureEUR += exposureEUR;
      entry.sources.add(src.ticker);
    }
  }

  return Array.from(byCompany.values()).sort((a, b) => b.exposureEUR - a.exposureEUR);
}

// Generic aggregation over a named per-source components array (e.g.
// 'countryComponents' or 'industryComponents'), grouped by `field` (e.g.
// 'country' or 'industry'). Those arrays are always complete (sum to 100),
// so - unlike the old version of this function - there is no "unclassified"
// fallback value needed here. Tracks `contributions` (ticker -> €) per
// group, which is what powers the industry -> holdings drill-down.
// returns: [{ [field]: key, exposureEUR, sources: Set<ticker>,
//              contributions: Map<ticker, exposureEUR> }] sorted desc.
function aggregateByField(sources, componentsKey, field) {
  const byKey = new Map();

  for (const src of sources) {
    const comps = src[componentsKey] || [];
    for (const comp of comps) {
      const exposureEUR = src.amountEUR * (comp.weight / 100);
      const key = comp[field];
      if (!byKey.has(key)) {
        byKey.set(key, { [field]: key, exposureEUR: 0, sources: new Set(), contributions: new Map() });
      }
      const entry = byKey.get(key);
      entry.exposureEUR += exposureEUR;
      entry.sources.add(src.ticker);
      entry.contributions.set(src.ticker, (entry.contributions.get(src.ticker) || 0) + exposureEUR);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.exposureEUR - a.exposureEUR);
}

function aggregateByCountry(sources) {
  return aggregateByField(sources, 'countryComponents', 'country');
}

function aggregateByIndustry(sources) {
  return aggregateByField(sources, 'industryComponents', 'industry');
}

// Nested Country -> Industry breakdown for the accordion trees, built
// directly from each source's real countryIndustryJoint rows (see
// resolveAllocationComponents) - a stock's single {country, sector} tag, or
// an ETF's own itemized per-company country+sector plus its labelled tail
// split. An industry can only ever land under a country that same row's
// data actually paired it with, never an independent country% x sector%
// cross-multiply.
function buildCountryIndustryTree(sources) {
  const tree = new Map(); // country -> Map(industry -> exposureEUR)

  for (const src of sources) {
    const joint = src.countryIndustryJoint || [];
    for (const row of joint) {
      if (!tree.has(row.country)) tree.set(row.country, new Map());
      const industryMap = tree.get(row.country);
      const exposureEUR = src.amountEUR * (row.weight / 100);
      industryMap.set(row.industry, (industryMap.get(row.industry) || 0) + exposureEUR);
    }
  }

  return Array.from(tree.entries())
    .map(([country, industryMap]) => ({
      country,
      exposureEUR: Array.from(industryMap.values()).reduce((s, v) => s + v, 0),
      industries: Array.from(industryMap.entries())
        .map(([industry, exposureEUR]) => ({ industry, exposureEUR }))
        .sort((a, b) => b.exposureEUR - a.exposureEUR),
    }))
    .sort((a, b) => b.exposureEUR - a.exposureEUR);
}


/* -------------------------------------------------------------------- */
/* 4b. ANALYSIS (pure - consumes the engine's own output above; no new   */
/*     ingestion or aggregation, just math over {exposureEUR, sources})  */
/* -------------------------------------------------------------------- */

function computeConcentration(aggregated, totalInvested) {
  if (aggregated.length === 0 || totalInvested <= 0) return null;

  const fractions = aggregated.map((r) => r.exposureEUR / totalInvested);
  const top5Pct = fractions.slice(0, 5).reduce((s, f) => s + f, 0) * 100;
  const top10Pct = fractions.slice(0, 10).reduce((s, f) => s + f, 0) * 100;
  const hhi = fractions.reduce((s, f) => s + f * f, 0);
  const effectiveN = hhi > 0 ? 1 / hhi : aggregated.length;

  let hhiLabel;
  if (hhi < 0.15) hhiLabel = 'Low concentration';
  else if (hhi <= 0.25) hhiLabel = 'Moderate concentration';
  else hhiLabel = 'High concentration';

  return { largest: aggregated[0], top5Pct, top10Pct, hhi, hhiLabel, effectiveN, nominalN: aggregated.length };
}

function computeOverlapCompanies(aggregated) {
  return aggregated.filter((r) => r.sources.size > 1);
}

function buildWeightMap(source) {
  const m = new Map();
  source.components.forEach((c) => {
    m.set(c.company, (m.get(c.company) || 0) + c.weight);
  });
  return m;
}

function computeEtfPairOverlap(etfSources) {
  const funds = etfSources.map((s) => ({ ticker: s.ticker, weights: buildWeightMap(s) }));
  const pairs = [];

  for (let i = 0; i < funds.length; i++) {
    for (let j = i + 1; j < funds.length; j++) {
      const a = funds[i];
      const b = funds[j];
      let overlapPct = 0;
      a.weights.forEach((weightA, company) => {
        if (b.weights.has(company)) overlapPct += Math.min(weightA, b.weights.get(company));
      });
      pairs.push({ tickerA: a.ticker, tickerB: b.ticker, overlapPct });
    }
  }

  return pairs.sort((x, y) => y.overlapPct - x.overlapPct);
}

// % of `total` for every row of an aggregate, keyed by `field`.
function pctMapFromAgg(agg, field, total) {
  const m = new Map();
  agg.forEach((r) => { m.set(r[field], total > 0 ? (r.exposureEUR / total) * 100 : 0); });
  return m;
}

// Direct vs ETF % allocation gap for one dimension (company/industry/country).
// Sorted by absolute gap desc. Percentages are each of THEIR OWN source
// type's total, so e.g. "100% Energy via direct" isn't diluted just because
// direct holdings are a small slice of the whole portfolio.
function buildDivergenceList(directAgg, etfAgg, field, directTotal, etfTotal) {
  const directPct = pctMapFromAgg(directAgg, field, directTotal);
  const etfPct = pctMapFromAgg(etfAgg, field, etfTotal);
  const allKeys = new Set([...directPct.keys(), ...etfPct.keys()]);

  return Array.from(allKeys)
    .map((key) => {
      const d = directPct.get(key) || 0;
      const e = etfPct.get(key) || 0;
      return { label: key, directPct: d, etfPct: e, gap: Math.abs(d - e) };
    })
    .sort((a, b) => b.gap - a.gap);
}


/* -------------------------------------------------------------------- */
/* 5. RENDER                                                            */
/* -------------------------------------------------------------------- */

let isBlurred = loadBlurState();
let sourceFilter = loadSourceFilter();
let chartInstance = null;

const eurFormatter = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFormatter = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function isDarkMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function formatEUR(n) {
  return eurFormatter.format(n);
}

function setMaskable(el, rawText) {
  el.dataset.raw = rawText;
  el.textContent = isBlurred ? '••••' : rawText;
}

function renderStatus() {
  const el = document.getElementById('dataStatus');
  if (window.location.protocol === 'file:') {
    el.hidden = false;
    el.textContent =
      "You're opening this file directly (file://). Some browsers block loading the ETF holdings JSON files under file://, which will show ETFs as \"no holdings data\". Run `python3 -m http.server` in this folder and open http://localhost:8000, or deploy to GitHub Pages / Cloudflare Pages, for full look-through.";
  } else {
    el.hidden = true;
  }
}

function renderTotal(totalInvested) {
  const el = document.getElementById('totalInvested');
  setMaskable(el, `Total invested: ${formatEUR(totalInvested)}`);
}

const HOLDINGS_SCROLL_CAP = 30; // beyond this many rows, re-cap height + scroll as a safety net

function renderHoldingsTable(holdings, emptyMessage) {
  const empty = document.getElementById('holdingsEmpty');
  const table = document.getElementById('holdingsTable');
  const body = document.getElementById('holdingsBody');
  const scrollWrap = table.closest('.table-scroll');
  body.innerHTML = '';

  if (scrollWrap) scrollWrap.classList.toggle('scroll-capped', holdings.length > HOLDINGS_SCROLL_CAP);

  if (holdings.length === 0) {
    empty.hidden = false;
    empty.textContent = emptyMessage || 'No holdings yet — add your first ETF or stock above.';
    table.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  holdings.forEach((h) => {
    const tr = document.createElement('tr');
    tr.dataset.ticker = h.ticker;

    // Ticker + type badge share one cell (rather than two columns), and the
    // last-updated date moves into a hover tooltip - this tile is only 1
    // grid column wide, so a 5-column table doesn't fit without scrolling.
    const holdingTd = document.createElement('td');
    holdingTd.className = 'holding-cell';
    holdingTd.title = `Updated ${h.lastUpdated || '—'}`;
    holdingTd.innerHTML = `${h.ticker} <span class="badge badge-${h.type.toLowerCase()}">${h.type}</span>`;

    const amountTd = document.createElement('td');
    amountTd.className = 'eur-value amount-cell';
    setMaskable(amountTd, formatEUR(h.amountEUR));

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-cell';

    // Icon-only (not "Edit"/"Delete" text) so the 5-column table stays
    // narrow enough to fit its 1-grid-column tile without needing
    // horizontal scroll to reach the actions.
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'link-btn icon-btn edit-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit holding');

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'link-btn icon-btn delete-btn';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Delete';
    deleteBtn.setAttribute('aria-label', 'Delete holding');

    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(holdingTd);
    tr.appendChild(amountTd);
    tr.appendChild(actionsTd);
    body.appendChild(tr);
  });
}

function renderLookthrough(aggregated, totalInvested) {
  const empty = document.getElementById('lookthroughEmpty');
  const table = document.getElementById('lookthroughTable');
  const body = document.getElementById('lookthroughBody');
  body.innerHTML = '';

  if (aggregated.length === 0) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  aggregated.forEach((row) => {
    const tr = document.createElement('tr');
    if (row.country) tr.dataset.country = row.country;

    const companyTd = document.createElement('td');
    companyTd.textContent = row.company;

    const exposureTd = document.createElement('td');
    exposureTd.className = 'eur-value';
    setMaskable(exposureTd, formatEUR(row.exposureEUR));

    const pctTd = document.createElement('td');
    const pct = totalInvested > 0 ? (row.exposureEUR / totalInvested) * 100 : 0;
    pctTd.textContent = `${pctFormatter.format(pct)}%`;

    const sourcesTd = document.createElement('td');
    sourcesTd.className = 'sources-cell';
    sourcesTd.textContent = Array.from(row.sources).join(', ');

    tr.appendChild(companyTd);
    tr.appendChild(exposureTd);
    tr.appendChild(pctTd);
    tr.appendChild(sourcesTd);
    body.appendChild(tr);
  });
}

function palette(n) {
  const colors = [];
  const baseHue = 174;
  const light = isDarkMode() ? 62 : 50;
  for (let i = 0; i < n; i++) {
    const hue = Math.round((baseHue + (360 / Math.max(n, 1)) * i) % 360);
    colors.push(`hsl(${hue} 55% ${light}%)`);
  }
  return colors;
}

// Pie units are MY HOLDINGS (one slice per ETF/stock, by invested amount) -
// never underlying look-through companies. `units` is built from the same
// tab-filtered source list as everything else (see buildPieUnits), so
// percentages always reconcile with the tab's own total.
function renderChart(units) {
  const empty = document.getElementById('chartEmpty');
  const wrap = document.getElementById('chartWrap');
  const canvas = document.getElementById('allocationChart');

  if (units.length === 0) {
    empty.hidden = false;
    wrap.hidden = true;
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  const labels = units.map((u) => u.label);
  const data = units.map((u) => u.amountEUR);
  const total = data.reduce((s, v) => s + v, 0);
  const colors = palette(units.length);

  const textSecondary = cssVar('--text-secondary', '#4b5157');
  const cardBg = cssVar('--card-bg', '#ffffff');

  const config = {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: cardBg }],
    },
    options: {
      responsive: true,
      // Bottom (not 'right') so the legend wraps across the tile's full
      // width instead of stacking in a narrow side column that clips or
      // spills long labels past the tile's edge.
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, font: { size: 11 }, color: textSecondary, padding: 10, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: cardBg,
          titleColor: cssVar('--text', '#16181b'),
          bodyColor: textSecondary,
          borderColor: cssVar('--border', '#e5e7e6'),
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              if (isBlurred) return `${ctx.label}: ••••`;
              const value = ctx.parsed;
              const pct = total > 0 ? (value / total) * 100 : 0;
              return `${ctx.label}: ${formatEUR(value)} (${pctFormatter.format(pct)}%)`;
            },
          },
        },
      },
    },
  };

  if (chartInstance) {
    chartInstance.data = config.data;
    chartInstance.options = config.options;
    chartInstance.update();
  } else {
    chartInstance = new Chart(canvas.getContext('2d'), config);
  }
}

// --- New: per-ETF holdings detail (country-wise + top companies) ------

// Company | Weight %, grouped under country headers, sorted by each
// country's total weight desc, companies within a country sorted by
// weight desc. Uses the ETF's own itemized per-company country (item 4).
function buildCountryWiseTable(holdings) {
  const table = document.createElement('table');
  table.className = 'etf-mini-table';
  table.innerHTML = '<thead><tr><th>Company</th><th>Weight %</th></tr></thead>';
  const tbody = document.createElement('tbody');

  const byCountry = new Map();
  holdings.forEach((h) => {
    if (!byCountry.has(h.country)) byCountry.set(h.country, []);
    byCountry.get(h.country).push(h);
  });

  Array.from(byCountry.entries())
    .map(([country, rows]) => ({ country, rows, total: rows.reduce((s, r) => s + r.weight, 0) }))
    .sort((a, b) => b.total - a.total)
    .forEach(({ country, rows }) => {
      const headerTr = document.createElement('tr');
      headerTr.className = 'country-group-header';
      const headerTd = document.createElement('td');
      headerTd.colSpan = 2;
      headerTd.textContent = COUNTRY_NAMES[country] || country;
      headerTr.appendChild(headerTd);
      tbody.appendChild(headerTr);

      [...rows].sort((a, b) => b.weight - a.weight).forEach((h) => {
        const tr = document.createElement('tr');
        const companyTd = document.createElement('td');
        companyTd.textContent = h.company;
        const weightTd = document.createElement('td');
        weightTd.className = 'eur-value';
        weightTd.textContent = `${pctFormatter.format(h.weight)}%`;
        tr.appendChild(companyTd);
        tr.appendChild(weightTd);
        tbody.appendChild(tr);
      });
    });

  table.appendChild(tbody);
  return table;
}

// Company | Weight % | Indirect (€) - Indirect € = my invested amount in
// this ETF x that company's weight. Sorted by weight desc (item 5). Never
// feeds the pie chart - this is a separate, standalone table.
function buildTopCompaniesTable(holdings, amountEUR) {
  const table = document.createElement('table');
  table.className = 'etf-mini-table';
  table.innerHTML = '<thead><tr><th>Company</th><th>Weight %</th><th>Indirect (€)</th></tr></thead>';
  const tbody = document.createElement('tbody');

  holdings.forEach((h) => {
    const tr = document.createElement('tr');
    const companyTd = document.createElement('td');
    companyTd.textContent = h.company;
    const weightTd = document.createElement('td');
    weightTd.className = 'eur-value';
    weightTd.textContent = `${pctFormatter.format(h.weight)}%`;
    const indirectTd = document.createElement('td');
    indirectTd.className = 'eur-value';
    setMaskable(indirectTd, formatEUR(amountEUR * (h.weight / 100)));
    tr.appendChild(companyTd);
    tr.appendChild(weightTd);
    tr.appendChild(indirectTd);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

// ETF-tab-only tile: one block per held ETF, each with the two tables above.
function renderEtfDetail() {
  const tile = document.getElementById('etfDetailTile');

  if (sourceFilter !== 'ETF') {
    tile.hidden = true;
    return;
  }
  tile.hidden = false;

  const empty = document.getElementById('etfDetailEmpty');
  const body = document.getElementById('etfDetailBody');
  body.innerHTML = '';

  const heldEtfs = lastHoldings.filter((h) => h.type === 'ETF');
  if (heldEtfs.length === 0) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  heldEtfs.forEach((h) => {
    const detail = lastEtfHoldingsDetail.get(h.ticker);
    const block = document.createElement('div');
    block.className = 'etf-detail-block';

    const heading = document.createElement('h3');
    heading.append(`${h.ticker} — `);
    const eurSpan = document.createElement('span');
    setMaskable(eurSpan, formatEUR(h.amountEUR));
    heading.appendChild(eurSpan);
    heading.append(' invested');
    block.appendChild(heading);

    if (!detail || detail.holdings.length === 0) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'No holdings data available for this ETF.';
      block.appendChild(note);
      body.appendChild(block);
      return;
    }

    const { holdings, approxConstituents } = detail;
    const capNote = document.createElement('p');
    capNote.className = 'hint';
    capNote.textContent = approxConstituents && holdings.length < approxConstituents
      ? `Top ${holdings.length} of ~${approxConstituents} holdings.`
      : `All ${holdings.length} holdings shown.`;
    block.appendChild(capNote);

    const grid = document.createElement('div');
    grid.className = 'etf-detail-grid';

    const countryCol = document.createElement('div');
    const countrySubhead = document.createElement('p');
    countrySubhead.className = 'subheading';
    countrySubhead.textContent = 'Country-wise holdings';
    countryCol.appendChild(countrySubhead);
    countryCol.appendChild(buildCountryWiseTable(holdings));
    grid.appendChild(countryCol);

    const topCol = document.createElement('div');
    const topSubhead = document.createElement('p');
    topSubhead.className = 'subheading';
    topSubhead.textContent = 'Top companies (indirect)';
    topCol.appendChild(topSubhead);
    topCol.appendChild(buildTopCompaniesTable(holdings, h.amountEUR));
    grid.appendChild(topCol);

    block.appendChild(grid);
    body.appendChild(block);
  });
}

// Renders a breakdown table (country or industry) from an aggregateByField()
// result. idPrefix picks the DOM ids, e.g. 'countryExposure' ->
// #countryExposureEmpty/#countryExposureTable/#countryExposureBody. keyField
// is which property of each row holds the group key ('country' or 'industry').
// options.displayNames optionally maps key -> display text (country codes).
// options.hoverAttr opts a table into hover-highlights-the-map (country
// tables only; harmless no-op for a code with no matching map region).
// options.drilldown marks industry rows as click-to-expand (see
// toggleDrilldown) and stashes each row's per-ticker contributions on the
// <tr> itself for that handler to read.
const BREAKDOWN_SCROLL_CAP = 40; // beyond this many rows, re-cap height + scroll as a safety net

function renderBreakdownTable(idPrefix, agg, totalInvested, keyField, options = {}) {
  const { displayNames, hoverAttr, drilldown } = options;
  const empty = document.getElementById(`${idPrefix}Empty`);
  const table = document.getElementById(`${idPrefix}Table`);
  const body = document.getElementById(`${idPrefix}Body`);
  const scrollWrap = table.closest('.table-scroll');
  body.innerHTML = '';

  if (scrollWrap) scrollWrap.classList.toggle('scroll-capped', agg.length > BREAKDOWN_SCROLL_CAP);

  if (agg.length === 0) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  agg.forEach((row) => {
    const key = row[keyField];
    const tr = document.createElement('tr');
    if (hoverAttr) tr.dataset[hoverAttr] = key;
    if (drilldown) {
      tr.classList.add('drilldown-row');
      tr._contributions = row.contributions;
    }

    const labelTd = document.createElement('td');
    labelTd.textContent = displayNames ? (displayNames[key] || key) : key;

    const exposureTd = document.createElement('td');
    exposureTd.className = 'eur-value';
    setMaskable(exposureTd, formatEUR(row.exposureEUR));

    const pctTd = document.createElement('td');
    const pct = totalInvested > 0 ? (row.exposureEUR / totalInvested) * 100 : 0;
    pctTd.textContent = `${pctFormatter.format(pct)}%`;

    const sourcesTd = document.createElement('td');
    sourcesTd.className = 'sources-cell';
    sourcesTd.textContent = Array.from(row.sources).join(', ');

    tr.appendChild(labelTd);
    tr.appendChild(exposureTd);
    tr.appendChild(pctTd);
    tr.appendChild(sourcesTd);
    body.appendChild(tr);
  });
}

// Toggles a "which holdings contribute" detail row directly under a
// drilldown-row (industry breakdown tables + the trees' industry rows all
// share this). Only one detail row open per tbody, for simplicity.
function toggleDrilldown(tr, totalInvested) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('drilldown-detail')) {
    next.remove();
    return;
  }

  const tbody = tr.parentElement;
  const existing = tbody.querySelector('.drilldown-detail');
  if (existing) existing.remove();

  const contributions = tr._contributions;
  if (!contributions || contributions.size === 0) return;

  const detailTr = document.createElement('tr');
  detailTr.className = 'drilldown-detail';
  const detailTd = document.createElement('td');
  detailTd.colSpan = tr.children.length;

  const list = document.createElement('div');
  list.className = 'drilldown-list';

  Array.from(contributions.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([ticker, exposureEUR]) => {
      const item = document.createElement('div');
      item.className = 'drilldown-item';

      const tickerSpan = document.createElement('span');
      tickerSpan.textContent = ticker;

      const valueSpan = document.createElement('span');
      valueSpan.className = 'eur-value';
      const eurEl = document.createElement('span');
      setMaskable(eurEl, formatEUR(exposureEUR));
      const pct = totalInvested > 0 ? (exposureEUR / totalInvested) * 100 : 0;
      valueSpan.appendChild(eurEl);
      valueSpan.append(` (${pctFormatter.format(pct)}%)`);

      item.appendChild(tickerSpan);
      item.appendChild(valueSpan);
      list.appendChild(item);
    });

  detailTd.appendChild(list);
  detailTr.appendChild(detailTd);
  tr.after(detailTr);
}

// Shown wherever the effective-holdings figure appears (KPI card + the
// Concentration tile's own row) - Combined-tab only, see renderSummaryCards
// and renderConcentration.
const EFFECTIVE_HOLDINGS_EXPLANATION =
  "You own more companies on paper, but your money is concentrated in a few. This is how many you're really spread across — higher means more diversified.";

function buildInfoIcon(explanation) {
  const icon = document.createElement('span');
  icon.className = 'info-icon';
  icon.tabIndex = 0;
  icon.title = explanation;
  icon.textContent = 'ⓘ';
  return icon;
}

function renderSummaryCards(aggregated, countryAgg, industryAgg, totalInvested, concentration) {
  const empty = document.getElementById('summaryEmpty');
  const row = document.getElementById('summaryRow');

  if (aggregated.length === 0 || !concentration) {
    empty.hidden = false;
    row.hidden = true;
    return;
  }
  empty.hidden = true;
  row.hidden = false;

  const pctOf = (exposureEUR) => (totalInvested > 0 ? (exposureEUR / totalInvested) * 100 : 0);

  const largest = concentration.largest;
  document.getElementById('summaryLargestHoldingValue').textContent = `${pctFormatter.format(pctOf(largest.exposureEUR))}%`;
  document.getElementById('summaryLargestHoldingDetail').textContent = largest.company;

  const topSector = industryAgg[0];
  document.getElementById('summaryLargestSectorValue').textContent = topSector ? `${pctFormatter.format(pctOf(topSector.exposureEUR))}%` : '—';
  document.getElementById('summaryLargestSectorDetail').textContent = topSector ? topSector.industry : '';

  const topCountry = countryAgg[0];
  document.getElementById('summaryLargestCountryValue').textContent = topCountry ? `${pctFormatter.format(pctOf(topCountry.exposureEUR))}%` : '—';
  document.getElementById('summaryLargestCountryDetail').textContent = topCountry ? (COUNTRY_NAMES[topCountry.country] || topCountry.country) : '';

  // Effective holdings only makes sense on the merged (Combined) look-through
  // - on the ETF/Direct tabs it's hidden entirely rather than shown filtered.
  const diversificationCard = document.getElementById('summaryDiversificationCard');
  if (sourceFilter === 'Combined') {
    diversificationCard.hidden = false;
    document.getElementById('summaryDiversificationValue').textContent = `effectively ${concentration.effectiveN.toFixed(1)} holdings`;
    document.getElementById('summaryDiversificationDetail').textContent = `of ${concentration.nominalN} nominal — ${concentration.hhiLabel}`;
  } else {
    diversificationCard.hidden = true;
  }
}

function buildStatRow(label, valueText, subNode, labelIcon) {
  const row = document.createElement('div');
  row.className = 'stat-row';

  const left = document.createElement('div');
  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.append(label);
  if (labelIcon) labelEl.appendChild(labelIcon);
  left.appendChild(labelEl);
  if (subNode) left.appendChild(subNode);

  const valueEl = document.createElement('span');
  valueEl.className = 'stat-value accent';
  valueEl.textContent = valueText;

  row.appendChild(left);
  row.appendChild(valueEl);
  return row;
}

function buildEurSub(prefix, eurValue) {
  const sub = document.createElement('div');
  sub.className = 'stat-sub';
  sub.append(`${prefix} — `);
  const eurSpan = document.createElement('span');
  setMaskable(eurSpan, formatEUR(eurValue));
  sub.appendChild(eurSpan);
  return sub;
}

function buildTextSub(text) {
  const sub = document.createElement('div');
  sub.className = 'stat-sub';
  sub.textContent = text;
  return sub;
}

function renderConcentration(concentration, totalInvested) {
  const empty = document.getElementById('concentrationEmpty');
  const body = document.getElementById('concentrationBody');

  if (!concentration) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  body.innerHTML = '';

  const largestPct = totalInvested > 0 ? (concentration.largest.exposureEUR / totalInvested) * 100 : 0;

  body.appendChild(buildStatRow('Top 5 holdings', `${pctFormatter.format(concentration.top5Pct)}%`));
  body.appendChild(buildStatRow('Top 10 holdings', `${pctFormatter.format(concentration.top10Pct)}%`));
  body.appendChild(
    buildStatRow('Largest single holding', `${pctFormatter.format(largestPct)}%`, buildEurSub(concentration.largest.company, concentration.largest.exposureEUR))
  );
  body.appendChild(buildStatRow('Concentration (HHI)', concentration.hhi.toFixed(3), buildTextSub(concentration.hhiLabel)));

  // Effective holdings only makes sense on the merged (Combined) look-through
  // - hidden entirely on the ETF/Direct tabs rather than shown filtered.
  if (sourceFilter === 'Combined') {
    body.appendChild(
      buildStatRow(
        'Effective holdings',
        `effectively ${concentration.effectiveN.toFixed(1)} holdings`,
        buildTextSub(`of ${concentration.nominalN} nominal`),
        buildInfoIcon(EFFECTIVE_HOLDINGS_EXPLANATION)
      )
    );
  }
}

function renderOverlap(overlapCompanies, etfPairOverlap, holdingsCount, totalInvested) {
  const tileEmpty = document.getElementById('overlapEmpty');
  const content = document.getElementById('overlapContent');

  if (holdingsCount < 2) {
    tileEmpty.hidden = false;
    content.hidden = true;
    return;
  }
  tileEmpty.hidden = true;
  content.hidden = false;

  const companyEmpty = document.getElementById('overlapCompanyEmpty');
  const companyTable = document.getElementById('overlapCompanyTable');
  const companyBody = document.getElementById('overlapCompanyBody');
  companyBody.innerHTML = '';

  if (overlapCompanies.length === 0) {
    companyEmpty.hidden = false;
    companyTable.hidden = true;
  } else {
    companyEmpty.hidden = true;
    companyTable.hidden = false;

    overlapCompanies.forEach((row) => {
      const tr = document.createElement('tr');

      const companyTd = document.createElement('td');
      companyTd.textContent = row.company;

      const exposureTd = document.createElement('td');
      exposureTd.className = 'eur-value';
      setMaskable(exposureTd, formatEUR(row.exposureEUR));

      const pctTd = document.createElement('td');
      const pct = totalInvested > 0 ? (row.exposureEUR / totalInvested) * 100 : 0;
      pctTd.textContent = `${pctFormatter.format(pct)}%`;

      const sourcesTd = document.createElement('td');
      sourcesTd.className = 'sources-cell';
      sourcesTd.textContent = Array.from(row.sources).join(', ');

      tr.appendChild(companyTd);
      tr.appendChild(exposureTd);
      tr.appendChild(pctTd);
      tr.appendChild(sourcesTd);
      companyBody.appendChild(tr);
    });
  }

  const pairEmpty = document.getElementById('overlapPairEmpty');
  const pairTable = document.getElementById('overlapPairTable');
  const pairBody = document.getElementById('overlapPairBody');
  pairBody.innerHTML = '';

  if (etfPairOverlap.length === 0) {
    pairEmpty.hidden = false;
    pairTable.hidden = true;
  } else {
    pairEmpty.hidden = true;
    pairTable.hidden = false;

    etfPairOverlap.forEach((pair) => {
      const tr = document.createElement('tr');

      const pairTd = document.createElement('td');
      pairTd.textContent = `${pair.tickerA} ∩ ${pair.tickerB}`;

      const pctTd = document.createElement('td');
      pctTd.className = 'eur-value';
      pctTd.textContent = `${pctFormatter.format(pair.overlapPct)}%`;

      tr.appendChild(pairTd);
      tr.appendChild(pctTd);
      pairBody.appendChild(tr);
    });
  }
}

// --- New: source-type toggle + headline -------------------------------

function renderSourceToggleUI() {
  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.filter === sourceFilter);
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === sourceFilter));
  });
}

function renderHeadline(etfTotal, directTotal, totalInvested) {
  const el = document.getElementById('sourceHeadline');
  if (totalInvested <= 0) {
    el.textContent = '';
    return;
  }
  const etfPct = pctFormatter.format((etfTotal / totalInvested) * 100);
  const directPct = pctFormatter.format((directTotal / totalInvested) * 100);
  el.textContent = `${etfPct}% of portfolio is ETF-driven, ${directPct}% stock-driven.`;
}

// --- New: divergence panel ---------------------------------------------

function renderDivergenceList(idPrefix, rows) {
  const empty = document.getElementById(`${idPrefix}Empty`);
  const list = document.getElementById(`${idPrefix}List`);
  list.innerHTML = '';

  const shown = rows.filter((r) => r.gap > 0.05).slice(0, 5);

  if (shown.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    return;
  }
  empty.hidden = true;
  list.hidden = false;

  shown.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'divergence-item';

    const label = document.createElement('div');
    label.className = 'divergence-label';
    label.textContent = r.label;

    const bars = document.createElement('div');
    bars.className = 'divergence-bars';
    bars.innerHTML = `
      <span class="divergence-figure">${pctFormatter.format(r.directPct)}% stocks</span>
      <span class="divergence-vs">vs</span>
      <span class="divergence-figure">${pctFormatter.format(r.etfPct)}% ETF</span>
      <span class="divergence-gap">Δ${pctFormatter.format(r.gap)}pp</span>
    `;

    item.appendChild(label);
    item.appendChild(bars);
    list.appendChild(item);
  });
}

function renderDivergence(divergence, directTotal, etfTotal) {
  const empty = document.getElementById('divergenceEmpty');
  const content = document.getElementById('divergenceContent');

  if (directTotal <= 0 || etfTotal <= 0) {
    empty.hidden = false;
    content.hidden = true;
    empty.textContent = directTotal <= 0
      ? 'No stock holdings yet — add one to compare against your ETF exposure.'
      : 'No ETF holdings yet — add one to compare against your stock picks.';
    return;
  }
  empty.hidden = true;
  content.hidden = false;

  renderDivergenceList('divergenceCompanies', divergence.companies);
  renderDivergenceList('divergenceSectors', divergence.sectors);
  renderDivergenceList('divergenceCountries', divergence.countries);
}

// --- New: overall country split (always combined) ----------------------

function renderOverallCountry(countryAgg, totalInvested) {
  renderBreakdownTable('overallCountry', countryAgg, totalInvested, 'country', {
    displayNames: COUNTRY_NAMES, hoverAttr: 'country',
  });
}

// --- New: country -> industry accordion trees --------------------------

function renderCountryIndustryTree(idPrefix, tree, totalInvested, flatIndustryAgg) {
  const empty = document.getElementById(`${idPrefix}Empty`);
  const container = document.getElementById(`${idPrefix}Body`);
  container.innerHTML = '';

  if (tree.length === 0) {
    empty.hidden = false;
    container.hidden = true;
    return;
  }
  empty.hidden = true;
  container.hidden = false;

  const contributionsByIndustry = new Map();
  flatIndustryAgg.forEach((r) => contributionsByIndustry.set(r.industry, r.contributions));

  tree.forEach((countryRow) => {
    const countryPct = totalInvested > 0 ? (countryRow.exposureEUR / totalInvested) * 100 : 0;

    const node = document.createElement('div');
    node.className = 'tree-country';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tree-country-head';
    head.innerHTML = `
      <span class="tree-caret">▸</span>
      <span class="tree-country-name">${COUNTRY_NAMES[countryRow.country] || countryRow.country}</span>
      <span class="tree-country-figures"><span class="eur-value tree-eur"></span><span class="tree-pct">${pctFormatter.format(countryPct)}%</span></span>
    `;
    setMaskable(head.querySelector('.tree-eur'), formatEUR(countryRow.exposureEUR));

    const industryList = document.createElement('div');
    industryList.className = 'tree-industries';
    industryList.hidden = true;

    countryRow.industries.forEach((industryRow) => {
      const industryPct = totalInvested > 0 ? (industryRow.exposureEUR / totalInvested) * 100 : 0;
      const row = document.createElement('div');
      row.className = 'tree-industry-row drilldown-row';
      row._contributions = contributionsByIndustry.get(industryRow.industry);
      row.innerHTML = `
        <span class="tree-industry-name">${industryRow.industry}</span>
        <span class="tree-industry-figures"><span class="eur-value tree-eur"></span><span class="tree-pct">${pctFormatter.format(industryPct)}%</span></span>
      `;
      setMaskable(row.querySelector('.tree-eur'), formatEUR(industryRow.exposureEUR));
      industryList.appendChild(row);
    });

    head.addEventListener('click', () => {
      const isOpen = !industryList.hidden;
      industryList.hidden = isOpen;
      head.querySelector('.tree-caret').textContent = isOpen ? '▸' : '▾';
    });

    node.appendChild(head);
    node.appendChild(industryList);
    container.appendChild(node);
  });
}

// --- Map (sequential palette + zoom) ------------------------------------

function buildSequentialSteps() {
  const dark = isDarkMode();
  const hue = 174;
  const sat = dark ? 55 : 60;
  const lightStart = dark ? 22 : 88;
  const lightEnd = dark ? 68 : 28;
  const steps = 13;
  const arr = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    arr.push(`hsl(${hue} ${sat}% ${Math.round(lightStart + (lightEnd - lightStart) * t)}%)`);
  }
  return arr;
}
const SEQUENTIAL_STEPS = buildSequentialSteps();
const MAP_BASE_FILL = cssVar('--border-strong', '#d7dad9');
const MAP_HIGHLIGHT_FILL = cssVar('--accent-bright', '#14b8a6');

function sequentialColor(ratio) {
  const idx = Math.round(Math.max(0, Math.min(1, ratio)) * (SEQUENTIAL_STEPS.length - 1));
  return SEQUENTIAL_STEPS[idx];
}

let worldMapInstance = null;
let countryColorByCode = {};
let countryDataByCode = {};

function renderWorldMap(countryAgg, totalInvested) {
  const empty = document.getElementById('mapEmpty');
  const wrap = document.getElementById('mapWrap');

  const held = countryAgg.filter((c) => /^[A-Z]{2}$/.test(c.country) && c.country !== 'XX');

  if (held.length === 0) {
    empty.hidden = false;
    wrap.hidden = true;
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  const maxExposure = Math.max(...held.map((c) => c.exposureEUR));

  countryDataByCode = {};
  countryColorByCode = {};
  held.forEach((c) => {
    const pct = totalInvested > 0 ? (c.exposureEUR / totalInvested) * 100 : 0;
    countryDataByCode[c.country] = { exposureEUR: c.exposureEUR, pct, sources: Array.from(c.sources).join(', ') };
    countryColorByCode[c.country] = sequentialColor(maxExposure > 0 ? c.exposureEUR / maxExposure : 0);
  });

  if (typeof jsVectorMap === 'undefined') {
    empty.hidden = false;
    empty.textContent = 'Map library failed to load (check your connection) — country table above is still accurate.';
    wrap.hidden = true;
    return;
  }

  if (!worldMapInstance) {
    worldMapInstance = new jsVectorMap({
      selector: '#worldMap',
      map: 'world',
      zoomButtons: true,
      zoomOnScroll: true,
      regionStyle: {
        initial: { fill: MAP_BASE_FILL, fillOpacity: 1, stroke: 'none' },
        hover: { fillOpacity: 0.85, cursor: 'pointer' },
      },
      onRegionTooltipShow(event, tooltip, code) {
        const d = countryDataByCode[code];
        if (!d) {
          tooltip.text(COUNTRY_NAMES[code] || code, true);
          return;
        }
        const valueText = isBlurred ? '••••' : `${formatEUR(d.exposureEUR)} (${pctFormatter.format(d.pct)}%)`;
        tooltip.text(
          `<strong>${COUNTRY_NAMES[code] || code}</strong><br>${valueText}<br><span style="opacity:.75">${d.sources}</span>`,
          true
        );
      },
    });
  }

  paintMapColors();
}

function paintMapColors() {
  if (!worldMapInstance || !worldMapInstance.regions) return;
  Object.keys(worldMapInstance.regions).forEach((code) => {
    const region = worldMapInstance.regions[code];
    if (!region || !region.element) return;
    const color = countryColorByCode[code] || MAP_BASE_FILL;
    region.element.setStyle('fill', color);
  });
}

function highlightCountry(code) {
  if (!worldMapInstance || !worldMapInstance.regions || !code) return;
  const region = worldMapInstance.regions[code];
  if (region && region.element) region.element.setStyle('fill', MAP_HIGHLIGHT_FILL);
}

function unhighlightCountry(code) {
  if (!worldMapInstance || !worldMapInstance.regions || !code) return;
  const region = worldMapInstance.regions[code];
  if (region && region.element) region.element.setStyle('fill', countryColorByCode[code] || MAP_BASE_FILL);
}

function handleMapReset() {
  if (worldMapInstance && typeof worldMapInstance.reset === 'function') {
    worldMapInstance.reset();
    paintMapColors();
  }
}

function applyBlurButtonState() {
  const btn = document.getElementById('blurToggle');
  btn.setAttribute('aria-pressed', String(isBlurred));
  btn.textContent = isBlurred ? '🙈' : '👁️';
  btn.title = isBlurred ? 'Show amounts' : 'Hide amounts';
}

// --- New: snapshots + history charts ------------------------------------

function computeSnapshotDerived(holdings, aggregated, countryAgg, industryAgg, concentration, totalInvested) {
  const perTicker = {};
  holdings.forEach((h) => { perTicker[h.ticker] = h.amountEUR; });

  const countryPct = {};
  countryAgg.forEach((r) => { countryPct[r.country] = totalInvested > 0 ? (r.exposureEUR / totalInvested) * 100 : 0; });

  const industryPct = {};
  industryAgg.forEach((r) => { industryPct[r.industry] = totalInvested > 0 ? (r.exposureEUR / totalInvested) * 100 : 0; });

  const topCompanyPct = {};
  aggregated.slice(0, 10).forEach((r) => { topCompanyPct[r.company] = totalInvested > 0 ? (r.exposureEUR / totalInvested) * 100 : 0; });

  return {
    totalInvested,
    perTicker,
    allocation: { country: countryPct, industry: industryPct, topCompany: topCompanyPct },
    diversification: concentration ? { hhi: concentration.hhi, effectiveN: concentration.effectiveN, nominalN: concentration.nominalN } : null,
  };
}

function recordSnapshot(dateStr) {
  const snaps = loadSnapshots();
  const derived = computeSnapshotDerived(lastHoldings, lastAggregatedAll, lastCountryAggAll, lastIndustryAggAll, lastConcentrationAll, lastTotalInvestedAll);
  const entry = {
    date: dateStr,
    holdings: lastHoldings.map((h) => ({ ticker: h.ticker, type: h.type, amountEUR: h.amountEUR })),
    derived,
  };
  const idx = snaps.findIndex((s) => s.date === dateStr);
  if (idx !== -1) snaps[idx] = entry; else snaps.push(entry);
  snaps.sort((a, b) => a.date.localeCompare(b.date));
  saveSnapshots(snaps);
  return snaps;
}

function renderSnapshotList(snapshots) {
  const empty = document.getElementById('snapshotListEmpty');
  const table = document.getElementById('snapshotListTable');
  const body = document.getElementById('snapshotListBody');
  body.innerHTML = '';

  if (snapshots.length === 0) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  // Most recent first for the list (charts below sort ascending themselves).
  [...snapshots].reverse().forEach((snap) => {
    const tr = document.createElement('tr');
    tr.dataset.date = snap.date;

    const dateTd = document.createElement('td');
    dateTd.className = 'snapshot-date-cell';
    dateTd.textContent = snap.date;

    const totalTd = document.createElement('td');
    totalTd.className = 'eur-value';
    setMaskable(totalTd, formatEUR(snap.derived.totalInvested));

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-cell';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'link-btn edit-snapshot-btn';
    editBtn.textContent = 'Edit date';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'link-btn delete-snapshot-btn';
    deleteBtn.textContent = 'Delete';

    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(dateTd);
    tr.appendChild(totalTd);
    tr.appendChild(actionsTd);
    body.appendChild(tr);
  });
}

function startSnapshotDateEdit(tr, date) {
  const dateTd = tr.querySelector('.snapshot-date-cell');
  const actionsTd = tr.querySelector('.actions-cell');

  dateTd.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'date';
  input.value = date;
  input.className = 'edit-amount-input';
  dateTd.appendChild(input);
  input.focus();

  actionsTd.innerHTML = '';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'link-btn';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'link-btn';
  cancelBtn.textContent = 'Cancel';

  actionsTd.appendChild(saveBtn);
  actionsTd.appendChild(cancelBtn);

  const commit = () => {
    const newDate = input.value;
    if (!newDate) { input.focus(); return; }
    const snaps = loadSnapshots();
    const idx = snaps.findIndex((s) => s.date === date);
    if (idx === -1) return;
    const [entry] = snaps.splice(idx, 1);
    entry.date = newDate;
    const collisionIdx = snaps.findIndex((s) => s.date === newDate);
    if (collisionIdx !== -1) snaps[collisionIdx] = entry; else snaps.push(entry);
    snaps.sort((a, b) => a.date.localeCompare(b.date));
    saveSnapshots(snaps);
    renderSnapshotSection();
  };

  saveBtn.addEventListener('click', commit);
  cancelBtn.addEventListener('click', () => renderSnapshotSection());
}

function handleSnapshotListClick(e) {
  const tr = e.target.closest('tr[data-date]');
  if (!tr) return;
  const date = tr.dataset.date;

  if (e.target.classList.contains('delete-snapshot-btn')) {
    if (!confirm(`Delete the snapshot recorded on ${date}?`)) return;
    const snaps = loadSnapshots().filter((s) => s.date !== date);
    saveSnapshots(snaps);
    renderSnapshotSection();
    return;
  }

  if (e.target.classList.contains('edit-snapshot-btn')) {
    startSnapshotDateEdit(tr, date);
  }
}

let historyTotalChart = null;
let historyPerTickerChart = null;
let historyDriftChart = null;
let historyDiversificationChart = null;
let driftDimension = 'country';

function destroyHistoryCharts() {
  [historyTotalChart, historyPerTickerChart, historyDriftChart, historyDiversificationChart].forEach((c) => {
    if (c) c.destroy();
  });
  historyTotalChart = null;
  historyPerTickerChart = null;
  historyDriftChart = null;
  historyDiversificationChart = null;
}

function baseLineOptions() {
  const textSecondary = cssVar('--text-secondary', '#4b5157');
  const border = cssVar('--border', '#e5e7e6');
  const cardBg = cssVar('--card-bg', '#ffffff');
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { color: border } },
      y: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { color: border } },
    },
    plugins: {
      legend: { labels: { color: textSecondary, font: { size: 11 }, boxWidth: 10 } },
      tooltip: { backgroundColor: cardBg, titleColor: cssVar('--text', '#16181b'), bodyColor: textSecondary, borderColor: border, borderWidth: 1 },
    },
  };
}

function renderHistoryCharts(snapshots) {
  const notice = document.getElementById('historyEmpty');
  const content = document.getElementById('historyContent');

  if (snapshots.length < 2) {
    notice.hidden = false;
    content.hidden = true;
    destroyHistoryCharts();
    return;
  }
  notice.hidden = true;
  content.hidden = false;

  const dates = snapshots.map((s) => s.date);
  const colors = palette(8);

  // 1) Total invested over time
  {
    const canvas = document.getElementById('historyTotalChart');
    const cfg = {
      type: 'line',
      data: { labels: dates, datasets: [{ label: 'Total invested (€)', data: snapshots.map((s) => s.derived.totalInvested), borderColor: colors[0], backgroundColor: colors[0], tension: 0.15 }] },
      options: {
        ...baseLineOptions(),
        plugins: {
          ...baseLineOptions().plugins,
          tooltip: { ...baseLineOptions().plugins.tooltip, callbacks: { label: (ctx) => (isBlurred ? '••••' : formatEUR(ctx.parsed.y)) } },
        },
        scales: { ...baseLineOptions().scales, y: { ...baseLineOptions().scales.y, ticks: { ...baseLineOptions().scales.y.ticks, callback: () => (isBlurred ? '••••' : '') } } },
      },
    };
    if (historyTotalChart) { historyTotalChart.data = cfg.data; historyTotalChart.options = cfg.options; historyTotalChart.update(); }
    else historyTotalChart = new Chart(canvas.getContext('2d'), cfg);
  }

  // 2) Per-ticker amount over time - null (not 0) for dates a ticker wasn't
  // held yet, so lines start/stop cleanly instead of faking a drop to zero.
  {
    const allTickers = Array.from(new Set(snapshots.flatMap((s) => Object.keys(s.derived.perTicker))));
    const tickerColors = palette(Math.max(allTickers.length, 1));
    const datasets = allTickers.map((ticker, i) => ({
      label: ticker,
      data: snapshots.map((s) => (ticker in s.derived.perTicker ? s.derived.perTicker[ticker] : null)),
      borderColor: tickerColors[i],
      backgroundColor: tickerColors[i],
      spanGaps: false,
      tension: 0.15,
    }));
    const canvas = document.getElementById('historyPerTickerChart');
    const cfg = {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        ...baseLineOptions(),
        plugins: {
          ...baseLineOptions().plugins,
          tooltip: { ...baseLineOptions().plugins.tooltip, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${isBlurred ? '••••' : formatEUR(ctx.parsed.y)}` } },
        },
        scales: { ...baseLineOptions().scales, y: { ...baseLineOptions().scales.y, ticks: { ...baseLineOptions().scales.y.ticks, callback: () => (isBlurred ? '••••' : '') } } },
      },
    };
    if (historyPerTickerChart) { historyPerTickerChart.data = cfg.data; historyPerTickerChart.options = cfg.options; historyPerTickerChart.update(); }
    else historyPerTickerChart = new Chart(canvas.getContext('2d'), cfg);
  }

  // 3) Allocation drift - selectable dimension, true 0% where a category
  // genuinely had no exposure that day (a real value, not a gap).
  renderDriftChart(snapshots, dates, colors);

  // 4) Diversification over time
  {
    const canvas = document.getElementById('historyDiversificationChart');
    const withDiv = snapshots.filter((s) => s.derived.diversification);
    const cfg = {
      type: 'line',
      data: {
        labels: withDiv.map((s) => s.date),
        datasets: [
          { label: 'Effective holdings', data: withDiv.map((s) => s.derived.diversification.effectiveN), borderColor: colors[0], backgroundColor: colors[0], yAxisID: 'y', tension: 0.15 },
          { label: 'HHI', data: withDiv.map((s) => s.derived.diversification.hhi), borderColor: colors[1], backgroundColor: colors[1], yAxisID: 'y1', tension: 0.15 },
        ],
      },
      options: {
        ...baseLineOptions(),
        scales: {
          x: baseLineOptions().scales.x,
          y: { ...baseLineOptions().scales.y, position: 'left' },
          y1: { ...baseLineOptions().scales.y, position: 'right', grid: { display: false } },
        },
      },
    };
    if (historyDiversificationChart) { historyDiversificationChart.data = cfg.data; historyDiversificationChart.options = cfg.options; historyDiversificationChart.update(); }
    else historyDiversificationChart = new Chart(canvas.getContext('2d'), cfg);
  }
}

function renderDriftChart(snapshots, dates, colors) {
  const dimensionMap = { country: 'country', sector: 'industry', company: 'topCompany' };
  const allocKey = dimensionMap[driftDimension];

  // Pick the top categories by the latest snapshot's weight, to keep the
  // chart legible regardless of how many countries/sectors/companies exist.
  const latest = snapshots[snapshots.length - 1].derived.allocation[allocKey] || {};
  const topKeys = Object.entries(latest)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k);

  const driftColors = palette(Math.max(topKeys.length, 1));
  const datasets = topKeys.map((key, i) => ({
    label: driftDimension === 'country' ? (COUNTRY_NAMES[key] || key) : key,
    data: snapshots.map((s) => {
      const alloc = s.derived.allocation[allocKey] || {};
      return key in alloc ? alloc[key] : 0; // real 0, not a gap - allocation % is always defined once a snapshot exists
    }),
    borderColor: driftColors[i],
    backgroundColor: driftColors[i],
    fill: driftDimension !== 'company',
    tension: 0.15,
  }));

  const canvas = document.getElementById('historyDriftChart');
  const cfg = {
    type: 'line',
    data: { labels: dates, datasets },
    options: {
      ...baseLineOptions(),
      plugins: { ...baseLineOptions().plugins, tooltip: { ...baseLineOptions().plugins.tooltip, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${pctFormatter.format(ctx.parsed.y)}%` } } },
      scales: { ...baseLineOptions().scales, y: { ...baseLineOptions().scales.y, stacked: driftDimension !== 'company' } },
    },
  };
  if (historyDriftChart) { historyDriftChart.data = cfg.data; historyDriftChart.options = cfg.options; historyDriftChart.update(); }
  else historyDriftChart = new Chart(canvas.getContext('2d'), cfg);
}

function renderSnapshotSection() {
  const snaps = loadSnapshots();
  renderSnapshotList(snaps);
  renderHistoryCharts(snaps);
}


/* -------------------------------------------------------------------- */
/* 6. MAIN                                                              */
/* -------------------------------------------------------------------- */

let lastHoldings = [];

// Always-combined (independent of the Direct/ETF/Combined toggle).
let lastAggregatedAll = [];
let lastCountryAggAll = [];
let lastIndustryAggAll = [];
let lastConcentrationAll = null;
let lastOverlapCompanies = [];
let lastEtfPairOverlap = [];
let lastTotalInvestedAll = 0;

// Fixed-source-type, unaffected by the toggle (pre-existing protected tiles).
let lastCountryAggEtf = [];
let lastCountryAggStock = [];
let lastIndustryAggEtf = [];
let lastIndustryAggStock = [];
let lastTreeEtf = [];
let lastTreeStock = [];
let lastDivergence = { companies: [], sectors: [], countries: [] };
let lastEtfTotal = 0;
let lastDirectTotal = 0;

// Per-ETF itemized holdings detail (ticker -> {holdings, approxConstituents}),
// for the ETF-tab-only per-fund country-wise + top-companies tables.
let lastEtfHoldingsDetail = new Map();

// Toggle-filtered (company table, map, summary cards).
let lastAggregatedFiltered = [];
let lastCountryAggFiltered = [];
let lastIndustryAggFiltered = [];
let lastConcentrationFiltered = null;
let lastTotalInvestedFiltered = 0;

// Pie chart units (my holdings, tab-filtered) - one slice per ETF/stock.
let lastPieUnits = [];

// Cached raw sources so the toggle can re-filter without re-fetching.
let cachedAllSources = [];
let cachedEtfSources = [];
let cachedStockSources = [];

function applySourceFilter() {
  const filtered = sourceFilter === 'ETF' ? cachedEtfSources : sourceFilter === 'Direct' ? cachedStockSources : cachedAllSources;
  lastTotalInvestedFiltered = filtered.reduce((s, src) => s + src.amountEUR, 0);
  lastAggregatedFiltered = aggregateExposure(filtered);
  lastCountryAggFiltered = aggregateByCountry(filtered);
  lastIndustryAggFiltered = aggregateByIndustry(filtered);
  lastConcentrationFiltered = computeConcentration(lastAggregatedFiltered, lastTotalInvestedFiltered);
  // Pie units are the same tab-filtered sources, one slice per ETF/stock
  // (my invested amount) - never underlying look-through companies.
  lastPieUnits = filtered.map((src) => ({ label: src.ticker, amountEUR: src.amountEUR }));
}

function renderAll() {
  applyBlurButtonState();
  renderSourceToggleUI();
  renderHeadline(lastEtfTotal, lastDirectTotal, lastTotalInvestedAll);
  renderTotal(lastTotalInvestedAll);
  // Tab-scoped: ETF tab lists only ETF holdings, Stocks tab only stocks,
  // Combined lists everything.
  const holdingsForTab = sourceFilter === 'ETF'
    ? lastHoldings.filter((h) => h.type === 'ETF')
    : sourceFilter === 'Direct'
      ? lastHoldings.filter((h) => h.type === 'Stock')
      : lastHoldings;
  const holdingsEmptyMessage = lastHoldings.length > 0 && holdingsForTab.length === 0
    ? (sourceFilter === 'ETF' ? 'No ETF holdings yet on this tab.' : 'No stock holdings yet on this tab.')
    : undefined;
  renderHoldingsTable(holdingsForTab, holdingsEmptyMessage);

  renderLookthrough(lastAggregatedFiltered, lastTotalInvestedFiltered);
  renderChart(lastPieUnits);
  renderWorldMap(lastCountryAggFiltered, lastTotalInvestedFiltered);
  renderSummaryCards(lastAggregatedFiltered, lastCountryAggFiltered, lastIndustryAggFiltered, lastTotalInvestedFiltered, lastConcentrationFiltered);
  renderEtfDetail();

  // Tab-scoped full-width rows (item 7): reflect the active Combined/ETF/
  // Stocks filter, so % is always of that tab's own total.
  renderBreakdownTable('countryExposure', lastCountryAggFiltered, lastTotalInvestedFiltered, 'country', { displayNames: COUNTRY_NAMES, hoverAttr: 'country' });
  renderBreakdownTable('industryExposure', lastIndustryAggFiltered, lastTotalInvestedFiltered, 'industry', { drilldown: true });

  renderOverallCountry(lastCountryAggAll, lastTotalInvestedAll);
  renderDivergence(lastDivergence, lastDirectTotal, lastEtfTotal);
  renderCountryIndustryTree('treeEtf', lastTreeEtf, lastTotalInvestedAll, lastIndustryAggEtf);
  renderCountryIndustryTree('treeStock', lastTreeStock, lastTotalInvestedAll, lastIndustryAggStock);

  renderConcentration(lastConcentrationAll, lastTotalInvestedAll);
  renderOverlap(lastOverlapCompanies, lastEtfPairOverlap, lastHoldings.length, lastTotalInvestedAll);

  renderSnapshotSection();
}

async function refreshAll() {
  lastHoldings = loadHoldings();
  lastTotalInvestedAll = lastHoldings.reduce((s, h) => s + h.amountEUR, 0);

  if (lastHoldings.length === 0) {
    lastAggregatedAll = [];
    lastCountryAggAll = [];
    lastIndustryAggAll = [];
    lastConcentrationAll = null;
    lastOverlapCompanies = [];
    lastEtfPairOverlap = [];
    lastCountryAggEtf = [];
    lastCountryAggStock = [];
    lastIndustryAggEtf = [];
    lastIndustryAggStock = [];
    lastTreeEtf = [];
    lastTreeStock = [];
    lastDivergence = { companies: [], sectors: [], countries: [] };
    lastEtfTotal = 0;
    lastDirectTotal = 0;
    lastEtfHoldingsDetail = new Map();
    cachedAllSources = [];
    cachedEtfSources = [];
    cachedStockSources = [];
    applySourceFilter();
    renderAll();
    return;
  }

  const sources = await Promise.all(
    lastHoldings.map(async (h) => {
      const [components, allocation] = await Promise.all([
        resolveComponents(h.ticker, h.type),
        resolveAllocationComponents(h.ticker, h.type),
      ]);
      return {
        ticker: h.ticker,
        type: h.type,
        amountEUR: h.amountEUR,
        components,
        countryComponents: allocation.countryComponents,
        industryComponents: allocation.industryComponents,
        countryIndustryJoint: allocation.countryIndustryJoint,
      };
    })
  );

  const etfSources = sources.filter((s) => s.type === 'ETF');
  const stockSources = sources.filter((s) => s.type === 'Stock');
  cachedAllSources = sources;
  cachedEtfSources = etfSources;
  cachedStockSources = stockSources;

  // Per-ETF itemized holdings detail (real rows only, no residual line) for
  // the per-ETF country-wise + top-companies tables on the ETF tab.
  const detailEntries = await Promise.all(
    etfSources.map(async (s) => [s.ticker, await resolveEtfHoldingsDetail(s.ticker)])
  );
  lastEtfHoldingsDetail = new Map(detailEntries.filter(([, v]) => v));

  lastAggregatedAll = aggregateExposure(sources);
  lastCountryAggAll = aggregateByCountry(sources);
  lastIndustryAggAll = aggregateByIndustry(sources);
  lastConcentrationAll = computeConcentration(lastAggregatedAll, lastTotalInvestedAll);
  lastOverlapCompanies = computeOverlapCompanies(lastAggregatedAll);
  lastEtfPairOverlap = computeEtfPairOverlap(etfSources);

  lastCountryAggEtf = aggregateByCountry(etfSources);
  lastCountryAggStock = aggregateByCountry(stockSources);
  lastIndustryAggEtf = aggregateByIndustry(etfSources);
  lastIndustryAggStock = aggregateByIndustry(stockSources);

  lastTreeEtf = buildCountryIndustryTree(etfSources);
  lastTreeStock = buildCountryIndustryTree(stockSources);

  lastEtfTotal = etfSources.reduce((s, src) => s + src.amountEUR, 0);
  lastDirectTotal = stockSources.reduce((s, src) => s + src.amountEUR, 0);
  lastDivergence = {
    companies: buildDivergenceList(aggregateExposure(stockSources), aggregateExposure(etfSources), 'company', lastDirectTotal, lastEtfTotal),
    sectors: buildDivergenceList(lastIndustryAggStock, lastIndustryAggEtf, 'industry', lastDirectTotal, lastEtfTotal),
    countries: buildDivergenceList(lastCountryAggStock, lastCountryAggEtf, 'country', lastDirectTotal, lastEtfTotal),
  };

  applySourceFilter();
  renderAll();
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.hidden = false;
}

function clearFormError() {
  const el = document.getElementById('formError');
  el.hidden = true;
  el.textContent = '';
}

function handleAddSubmit(e) {
  e.preventDefault();
  clearFormError();

  const tickerInput = document.getElementById('tickerInput');
  const amountInput = document.getElementById('amountInput');

  const tickerUpper = tickerInput.value.trim().toUpperCase();
  const amountEUR = Number(amountInput.value);

  if (!tickerUpper) {
    showFormError('Enter a ticker.');
    return;
  }
  if (!Number.isFinite(amountEUR) || amountEUR <= 0) {
    showFormError('Enter an amount greater than 0.');
    return;
  }

  const holdings = loadHoldings();
  if (holdings.some((h) => h.ticker === tickerUpper)) {
    showFormError(`${tickerUpper} is already in your holdings — edit or delete the existing row instead.`);
    return;
  }

  const type = inferType(tickerUpper);
  holdings.push({ ticker: tickerUpper, type, amountEUR, lastUpdated: todayStr() });
  saveHoldings(holdings);

  tickerInput.value = '';
  amountInput.value = '';
  tickerInput.focus();

  refreshAll();
}

function handleHoldingsClick(e) {
  const tr = e.target.closest('tr[data-ticker]');
  if (!tr) return;
  const ticker = tr.dataset.ticker;

  if (e.target.classList.contains('delete-btn')) {
    if (!confirm(`Delete ${ticker} from your holdings?`)) return;
    const holdings = loadHoldings().filter((h) => h.ticker !== ticker);
    saveHoldings(holdings);
    refreshAll();
    return;
  }

  if (e.target.classList.contains('edit-btn')) {
    startEdit(tr, ticker);
  }
}

function startEdit(tr, ticker) {
  const holdings = loadHoldings();
  const holding = holdings.find((h) => h.ticker === ticker);
  if (!holding) return;

  const amountTd = tr.querySelector('.amount-cell');
  const actionsTd = tr.querySelector('.actions-cell');

  amountTd.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.01';
  input.value = holding.amountEUR;
  input.className = 'edit-amount-input';
  amountTd.appendChild(input);
  input.focus();
  input.select();

  actionsTd.innerHTML = '';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'link-btn';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'link-btn';
  cancelBtn.textContent = 'Cancel';

  actionsTd.appendChild(saveBtn);
  actionsTd.appendChild(cancelBtn);

  const commit = () => {
    const newAmount = Number(input.value);
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      input.focus();
      return;
    }
    const current = loadHoldings();
    const idx = current.findIndex((h) => h.ticker === ticker);
    if (idx !== -1) {
      current[idx].amountEUR = newAmount;
      current[idx].lastUpdated = todayStr();
      saveHoldings(current);
    }
    refreshAll();
  };

  saveBtn.addEventListener('click', commit);
  cancelBtn.addEventListener('click', () => refreshAll());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') commit();
    if (ev.key === 'Escape') refreshAll();
  });
}

function handleBlurToggle() {
  isBlurred = !isBlurred;
  saveBlurState(isBlurred);
  renderAll();
}

function handleSourceFilterClick(e) {
  const btn = e.target.closest('.segmented-btn');
  if (!btn) return;
  const filter = btn.dataset.filter;
  if (filter === sourceFilter) return;
  sourceFilter = filter;
  saveSourceFilter(sourceFilter);
  applySourceFilter();
  renderAll();
}

function handleRowHoverIn(e) {
  const tr = e.target.closest('tr[data-country]');
  if (tr) highlightCountry(tr.dataset.country);
}

function handleRowHoverOut(e) {
  const tr = e.target.closest('tr[data-country]');
  if (tr) unhighlightCountry(tr.dataset.country);
}

function handleDrilldownClick(e) {
  const tr = e.target.closest('tr.drilldown-row, .tree-industry-row.drilldown-row');
  if (!tr) return;
  // Industry exposure is tab-scoped (item 7/8: % of that tab's own total);
  // the country -> industry trees are always ETF-only/Stock-only regardless
  // of the tab, so they keep using the whole-portfolio total as before.
  const isTabScoped = !!tr.closest('#industryExposureBody');
  toggleDrilldown(tr, isTabScoped ? lastTotalInvestedFiltered : lastTotalInvestedAll);
}

function handleSnapshotSubmit(e) {
  e.preventDefault();
  const dateInput = document.getElementById('snapshotDate');
  const dateStr = dateInput.value || todayStr();
  recordSnapshot(dateStr);
  renderSnapshotSection();
}

function handleDriftDimensionChange(e) {
  driftDimension = e.target.value;
  renderHistoryCharts(loadSnapshots());
}

function init() {
  buildAutocompleteOptions();
  renderStatus();

  document.getElementById('addForm').addEventListener('submit', handleAddSubmit);
  document.getElementById('holdingsBody').addEventListener('click', handleHoldingsClick);
  document.getElementById('blurToggle').addEventListener('click', handleBlurToggle);
  document.getElementById('sourceToggle').addEventListener('click', handleSourceFilterClick);
  document.getElementById('mapResetBtn').addEventListener('click', handleMapReset);
  document.getElementById('snapshotForm').addEventListener('submit', handleSnapshotSubmit);
  document.getElementById('snapshotListBody').addEventListener('click', handleSnapshotListClick);
  document.getElementById('driftDimension').addEventListener('change', handleDriftDimensionChange);

  const dateInput = document.getElementById('snapshotDate');
  dateInput.value = todayStr();
  dateInput.max = todayStr();

  // Hovering a company/country row highlights that country on the map.
  ['lookthroughBody', 'countryExposureBody', 'overallCountryBody'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('mouseover', handleRowHoverIn);
    el.addEventListener('mouseout', handleRowHoverOut);
  });

  // Clicking an industry row (breakdown tables or tree leaves) drills down
  // into which holdings contribute. Delegated once per container.
  ['industryExposureBody', 'treeEtfBody', 'treeStockBody'].forEach((id) => {
    document.getElementById(id).addEventListener('click', handleDrilldownClick);
  });

  refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
