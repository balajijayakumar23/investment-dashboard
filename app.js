'use strict';

/* =========================================================================
 * ETF Look-Through Dashboard
 *
 * Sections in this file (kept in one file per project layout, but logically
 * separated so any piece can be swapped later without touching the others):
 *
 *   1. REGISTRY   - known ETFs / stock name aliases, used for autocomplete
 *                   and for turning a ticker into a display company name.
 *   2. STORAGE     - reads/writes the user's holdings + UI prefs to localStorage.
 *   3. INGESTION   - resolves a single holding into {company, weight}[] that
 *                    sum to 100. Today this reads seeded JSON files under
 *                    data/etf-holdings/. Later it could hit a live API or a
 *                    paste-parser instead - nothing outside this section
 *                    would need to change.
 *   4. ENGINE      - pure aggregation: sources -> per-company exposure.
 *                    Only ever sees {company, weight} pairs, so it has no
 *                    idea where the data came from.
 *   5. RENDER      - DOM + chart output. Reads engine output, writes pixels.
 *   6. MAIN        - wiring: form handling, edit/delete, blur toggle, boot.
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

// Company display name -> ISO 3166-1 alpha-2 country code, used for the
// country-level breakdown and world map. A company with no entry here
// (e.g. a residual "remaining holdings (not itemized)" bucket) is grouped under the
// 'XX' (unclassified) bucket instead of guessed at.
const COMPANY_COUNTRY = {
  Apple: 'US',
  Microsoft: 'US',
  Nvidia: 'US',
  Amazon: 'US',
  Alphabet: 'US',
  'Meta Platforms': 'US',
  Broadcom: 'US',
  'Berkshire Hathaway': 'US',
  Tesla: 'US',
  'JPMorgan Chase': 'US',
  'Eli Lilly': 'US',
  Visa: 'US',
  'UnitedHealth Group': 'US',
  ExxonMobil: 'US',
  Netflix: 'US',
  'Micron Technology': 'US',
  AMD: 'US',
  Intel: 'US',
  'Lam Research': 'US',
  'Applied Materials': 'US',
  'Taiwan Semiconductor Manufacturing (TSMC)': 'TW',
  MediaTek: 'TW',
  'Delta Electronics': 'TW',
  'Hon Hai Precision Industry': 'TW',
  'SK Hynix': 'KR',
  'Samsung Electronics': 'KR',
  'Samsung Electro-Mechanics': 'KR',
  'ASML Holding': 'NL',
  'HDFC Bank': 'IN',
  'ICICI Bank': 'IN',
  'Reliance Industries': 'IN',
  'Bharti Airtel': 'IN',
  'Larsen & Toubro': 'IN',
  'State Bank of India': 'IN',
  'Axis Bank': 'IN',
  Infosys: 'IN',
  'Kotak Mahindra Bank': 'IN',
  'ITC Limited': 'IN',
  'Mahindra & Mahindra': 'IN',
  'Bajaj Finance': 'IN',
  'Tata Consultancy Services': 'IN',
  'Sun Pharmaceutical Industries': 'IN',
  Eternal: 'IN',
  'HSBC Holdings': 'GB',
  AstraZeneca: 'GB',
  Shell: 'GB',
  'Royal Bank of Canada': 'CA',
  'Roche Holding': 'CH',
  Novartis: 'CH',
  'Nestlé': 'CH',
  Siemens: 'DE',
  'BHP Group': 'AU',
  'Höegh Autoliners': 'NO',
  'Novo Nordisk': 'DK',
};

// Country code -> display name shown in the country table and map tooltips.
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
  XX: 'Unclassified / other holdings',
};

// Company display name -> sector (GICS-style, simplified). Same key set and
// same "unmapped stays unmapped" rule as COMPANY_COUNTRY — a company with no
// entry here is grouped under 'Unclassified' rather than guessed.
const COMPANY_INDUSTRY = {
  Apple: 'Technology',
  Microsoft: 'Technology',
  Nvidia: 'Technology',
  Amazon: 'Consumer Discretionary',
  Alphabet: 'Communication Services',
  'Meta Platforms': 'Communication Services',
  Broadcom: 'Technology',
  'Berkshire Hathaway': 'Financials',
  Tesla: 'Consumer Discretionary',
  'JPMorgan Chase': 'Financials',
  'Eli Lilly': 'Health Care',
  Visa: 'Financials',
  'UnitedHealth Group': 'Health Care',
  ExxonMobil: 'Energy',
  Netflix: 'Communication Services',
  'Micron Technology': 'Technology',
  AMD: 'Technology',
  Intel: 'Technology',
  'Lam Research': 'Technology',
  'Applied Materials': 'Technology',
  'Taiwan Semiconductor Manufacturing (TSMC)': 'Technology',
  MediaTek: 'Technology',
  'Delta Electronics': 'Technology',
  'Hon Hai Precision Industry': 'Technology',
  'SK Hynix': 'Technology',
  'Samsung Electronics': 'Technology',
  'Samsung Electro-Mechanics': 'Technology',
  'ASML Holding': 'Technology',
  'HDFC Bank': 'Financials',
  'ICICI Bank': 'Financials',
  'Reliance Industries': 'Energy',
  'Bharti Airtel': 'Communication Services',
  'Larsen & Toubro': 'Industrials',
  'State Bank of India': 'Financials',
  'Axis Bank': 'Financials',
  Infosys: 'Technology',
  'Kotak Mahindra Bank': 'Financials',
  'ITC Limited': 'Consumer Staples',
  'Mahindra & Mahindra': 'Consumer Discretionary',
  'Bajaj Finance': 'Financials',
  'Tata Consultancy Services': 'Technology',
  'Sun Pharmaceutical Industries': 'Health Care',
  Eternal: 'Consumer Discretionary',
  'HSBC Holdings': 'Financials',
  AstraZeneca: 'Health Care',
  Shell: 'Energy',
  'Royal Bank of Canada': 'Financials',
  'Roche Holding': 'Health Care',
  Novartis: 'Health Care',
  'Nestlé': 'Consumer Staples',
  Siemens: 'Industrials',
  'BHP Group': 'Materials',
  'Höegh Autoliners': 'Industrials',
  'Novo Nordisk': 'Health Care',
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


/* -------------------------------------------------------------------- */
/* 3. INGESTION                                                         */
/* -------------------------------------------------------------------- */

const holdingsFileCache = new Map(); // ticker -> Promise<{company, weight}[] | null>

function fetchHoldingsFile(tickerUpper) {
  if (holdingsFileCache.has(tickerUpper)) return holdingsFileCache.get(tickerUpper);

  const promise = (async () => {
    try {
      const res = await fetch(`data/etf-holdings/${tickerUpper}.json`, { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      if (!Array.isArray(json.holdings)) return null;
      return json.holdings
        .filter((h) => h && typeof h.company === 'string' && Number.isFinite(Number(h.weight)))
        .map((h) => ({ company: h.company.trim(), weight: Number(h.weight) }));
    } catch (err) {
      console.warn(`Could not load holdings file for ${tickerUpper}:`, err);
      return null;
    }
  })();

  holdingsFileCache.set(tickerUpper, promise);
  return promise;
}

// Pads a partial/missing holdings list up to 100% with a clearly-labelled
// residual bucket, so exposure totals always match the amount invested.
function padToFull(components, tickerUpper, tolerance = 0.5) {
  const sum = components.reduce((s, c) => s + c.weight, 0);
  const remainder = 100 - sum;
  if (remainder > tolerance) {
    return [...components, { company: `${tickerUpper} — remaining holdings (not itemized)`, weight: remainder }];
  }
  return components;
}

// Resolves one user holding into {company, weight, country, industry}[]
// summing to ~100. This is the only function the rest of the app needs to
// know about when a new data source (auto-fetch, paste-UI, etc.) is added
// later. `country`/`industry` are looked up by company name, so they're
// always derived from the same single source of truth as the company-level
// data rather than duplicated per ETF file.
async function resolveComponents(tickerUpper, type) {
  const withMeta = (company, weight) => ({
    company,
    weight,
    country: COMPANY_COUNTRY[company] || 'XX',
    industry: COMPANY_INDUSTRY[company] || 'Unclassified',
  });

  if (type === 'Stock') {
    const company = STOCK_NAME_MAP[tickerUpper] || tickerUpper;
    return [withMeta(company, 100)];
  }

  const raw = await fetchHoldingsFile(tickerUpper);
  if (!raw || raw.length === 0) {
    return [withMeta(`${tickerUpper} — no holdings data available`, 100)];
  }
  return padToFull(raw, tickerUpper).map((c) => withMeta(c.company, c.weight));
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

// Same sources, aggregated by an arbitrary per-component string field
// (e.g. 'country', 'industry') instead of company. A component missing that
// field is grouped under unclassifiedValue rather than guessed.
// returns: [{ [field]: key, exposureEUR, sources: Set<ticker> }] sorted desc.
function aggregateByField(sources, field, unclassifiedValue) {
  const byKey = new Map();

  for (const src of sources) {
    for (const comp of src.components) {
      const exposureEUR = src.amountEUR * (comp.weight / 100);
      const key = comp[field] || unclassifiedValue;
      if (!byKey.has(key)) {
        byKey.set(key, { [field]: key, exposureEUR: 0, sources: new Set() });
      }
      const entry = byKey.get(key);
      entry.exposureEUR += exposureEUR;
      entry.sources.add(src.ticker);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.exposureEUR - a.exposureEUR);
}

function aggregateByCountry(sources) {
  return aggregateByField(sources, 'country', 'XX');
}

function aggregateByIndustry(sources) {
  return aggregateByField(sources, 'industry', 'Unclassified');
}


/* -------------------------------------------------------------------- */
/* 4b. ANALYSIS (pure - consumes the engine's own output above; no new   */
/*     ingestion or aggregation, just math over {exposureEUR, sources})  */
/* -------------------------------------------------------------------- */

// Concentration/diversification metrics from the company-level aggregate.
// aggregated is aggregateExposure()'s output, already sorted desc by
// exposureEUR - nothing here re-touches ingestion or resolveComponents.
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

  return {
    largest: aggregated[0],
    top5Pct,
    top10Pct,
    hhi,
    hhiLabel,
    effectiveN,
    nominalN: aggregated.length,
  };
}

// Companies contributed to by more than one holding (ETF look-through or
// direct stock) - a straight filter of the same aggregate, so it's already
// sorted desc by exposureEUR and its totals already match the look-through
// table exactly.
function computeOverlapCompanies(aggregated) {
  return aggregated.filter((r) => r.sources.size > 1);
}

// A single ETF's own company -> weight% map, built from that source's raw
// components (fund composition, independent of how much EUR the user put
// into it) - used only for pairwise fund-overlap, not for any exposure math.
function buildWeightMap(source) {
  const m = new Map();
  source.components.forEach((c) => {
    m.set(c.company, (m.get(c.company) || 0) + c.weight);
  });
  return m;
}

// Pairwise overlap % between every two held ETFs: sum over companies present
// in both funds' holdings of min(weight in A, weight in B). Higher = the two
// funds duplicate more of each other. Sorted desc.
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


/* -------------------------------------------------------------------- */
/* 5. RENDER                                                            */
/* -------------------------------------------------------------------- */

let isBlurred = loadBlurState();
let chartInstance = null;

const eurFormatter = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFormatter = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Reads a color token from style.css's :root so Chart.js/jsVectorMap (which
// paint via JS-supplied color values, not CSS) stay in sync with the theme.
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

// Sets text on an element that shows a EUR amount, respecting the blur toggle.
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

function renderHoldingsTable(holdings) {
  const empty = document.getElementById('holdingsEmpty');
  const table = document.getElementById('holdingsTable');
  const body = document.getElementById('holdingsBody');
  body.innerHTML = '';

  if (holdings.length === 0) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  holdings.forEach((h) => {
    const tr = document.createElement('tr');
    tr.dataset.ticker = h.ticker;

    const tickerTd = document.createElement('td');
    tickerTd.textContent = h.ticker;

    const typeTd = document.createElement('td');
    typeTd.innerHTML = `<span class="badge badge-${h.type.toLowerCase()}">${h.type}</span>`;

    const amountTd = document.createElement('td');
    amountTd.className = 'eur-value amount-cell';
    setMaskable(amountTd, formatEUR(h.amountEUR));

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-cell';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'link-btn edit-btn';
    editBtn.textContent = 'Edit';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'link-btn delete-btn';
    deleteBtn.textContent = 'Delete';

    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(tickerTd);
    tr.appendChild(typeTd);
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
    if (row.country && row.country !== 'XX') tr.dataset.country = row.country;

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

// Anchored at the teal accent hue (174deg) and rotated through the spectrum
// for differentiation across many companies; calmer saturation/lightness
// than a raw rainbow to match the "calm, restrained" palette.
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

function renderChart(aggregated) {
  const empty = document.getElementById('chartEmpty');
  const wrap = document.getElementById('chartWrap');
  const canvas = document.getElementById('allocationChart');

  if (aggregated.length === 0) {
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

  const labels = aggregated.map((a) => a.company);
  const data = aggregated.map((a) => a.exposureEUR);
  const total = data.reduce((s, v) => s + v, 0);
  const colors = palette(aggregated.length);

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
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 }, color: textSecondary } },
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

// Renders a breakdown table (country or industry, ETF/Stock/combined variant)
// from an aggregateByField() result. idPrefix picks the DOM ids, e.g.
// 'countryEtf' -> #countryEtfEmpty/#countryEtfTable/#countryEtfBody.
// keyField is which property of each row holds the group key ('country' or
// 'industry'). options.displayNames optionally maps key -> display text
// (used for country codes; industry names are already display-ready).
// options.hoverAttr + options.unclassified opt a table into the
// hover-highlights-the-map behavior (country tables only).
function renderBreakdownTable(idPrefix, agg, totalInvested, keyField, options = {}) {
  const { displayNames, hoverAttr, unclassified } = options;
  const empty = document.getElementById(`${idPrefix}Empty`);
  const table = document.getElementById(`${idPrefix}Table`);
  const body = document.getElementById(`${idPrefix}Body`);
  body.innerHTML = '';

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
    if (hoverAttr && key !== unclassified) tr.dataset[hoverAttr] = key;

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
  document.getElementById('summaryLargestHoldingCaption').textContent = `Largest holding — ${largest.company}`;

  const topSector = industryAgg[0];
  document.getElementById('summaryLargestSectorValue').textContent = topSector ? `${pctFormatter.format(pctOf(topSector.exposureEUR))}%` : '—';
  document.getElementById('summaryLargestSectorCaption').textContent = topSector ? `Largest sector — ${topSector.industry}` : 'Largest sector';

  const topCountry = countryAgg[0];
  document.getElementById('summaryLargestCountryValue').textContent = topCountry ? `${pctFormatter.format(pctOf(topCountry.exposureEUR))}%` : '—';
  document.getElementById('summaryLargestCountryCaption').textContent = topCountry
    ? `Largest country — ${COUNTRY_NAMES[topCountry.country] || topCountry.country}`
    : 'Largest country';

  document.getElementById('summaryDiversificationValue').textContent = `~${concentration.effectiveN.toFixed(1)}`;
  document.getElementById('summaryDiversificationCaption').textContent =
    `Effective holdings of ${concentration.nominalN} — ${concentration.hhiLabel}`;
}

// subNode is an optional pre-built `<div class="stat-sub">` (see
// buildEurSub/plain text below) shown under the label.
function buildStatRow(label, valueText, subNode) {
  const row = document.createElement('div');
  row.className = 'stat-row';

  const left = document.createElement('div');
  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;
  left.appendChild(labelEl);
  if (subNode) left.appendChild(subNode);

  const valueEl = document.createElement('span');
  valueEl.className = 'stat-value accent';
  valueEl.textContent = valueText;

  row.appendChild(left);
  row.appendChild(valueEl);
  return row;
}

// A stat-sub line of "<prefix text> — <maskable € amount>".
function buildEurSub(prefix, eurValue) {
  const sub = document.createElement('div');
  sub.className = 'stat-sub';
  sub.append(`${prefix} — `);
  const eurSpan = document.createElement('span');
  setMaskable(eurSpan, formatEUR(eurValue));
  sub.appendChild(eurSpan);
  return sub;
}

// A plain-text stat-sub line (no € figure, so nothing to mask).
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
  body.appendChild(
    buildStatRow('Concentration (HHI)', concentration.hhi.toFixed(3), buildTextSub(concentration.hhiLabel))
  );
  body.appendChild(
    buildStatRow('Effective holdings', `~${concentration.effectiveN.toFixed(1)}`, buildTextSub(`of ${concentration.nominalN} nominal`))
  );
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

  // Companies held via multiple funds/stocks
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

  // Pairwise ETF overlap
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
      pctTd.className = 'eur-value'; // reuse right-align + tabular-nums, no masking needed (not a € figure)
      pctTd.textContent = `${pctFormatter.format(pair.overlapPct)}%`;

      tr.appendChild(pairTd);
      tr.appendChild(pctTd);
      pairBody.appendChild(tr);
    });
  }
}

// Sequential single-hue ramp (teal, matching --accent-bright) for continuous
// magnitude encoding on the choropleth map: near-zero recedes toward the
// surface, max exposure stands out darkest/most saturated (inverted on dark
// surfaces, where "stands out" means brightest instead of darkest).
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
const MAP_BASE_FILL = cssVar('--border-strong', '#d7dad9'); // countries with no exposure
const MAP_HIGHLIGHT_FILL = cssVar('--accent-bright', '#14b8a6'); // hover highlight

function sequentialColor(ratio) {
  const idx = Math.round(Math.max(0, Math.min(1, ratio)) * (SEQUENTIAL_STEPS.length - 1));
  return SEQUENTIAL_STEPS[idx];
}

let worldMapInstance = null;
let countryColorByCode = {}; // code -> currently-painted (non-highlight) color, for restoring after hover
let countryDataByCode = {}; // code -> { exposureEUR, pct, sources } for tooltips

function renderWorldMap(countryAgg, totalInvested) {
  const empty = document.getElementById('mapEmpty');
  const wrap = document.getElementById('mapWrap');

  const held = countryAgg.filter((c) => c.country !== 'XX');

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
      zoomButtons: false,
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

function applyBlurButtonState() {
  const btn = document.getElementById('blurToggle');
  btn.setAttribute('aria-pressed', String(isBlurred));
  btn.textContent = isBlurred ? '🙈' : '👁️';
  btn.title = isBlurred ? 'Show amounts' : 'Hide amounts';
}


/* -------------------------------------------------------------------- */
/* 6. MAIN                                                              */
/* -------------------------------------------------------------------- */

let lastHoldings = [];
let lastAggregated = [];
let lastCountryAgg = [];        // combined ETF + stock, drives the map
let lastCountryAggEtf = [];     // ETF holdings only
let lastCountryAggStock = [];   // stock holdings only
let lastIndustryAgg = [];       // combined ETF + stock, drives the summary cards
let lastIndustryAggEtf = [];    // ETF holdings only
let lastIndustryAggStock = [];  // stock holdings only
let lastConcentration = null;
let lastOverlapCompanies = [];
let lastEtfPairOverlap = [];
let lastTotalInvested = 0;

function renderAll() {
  applyBlurButtonState();
  renderTotal(lastTotalInvested);
  renderHoldingsTable(lastHoldings);
  renderLookthrough(lastAggregated, lastTotalInvested);
  renderChart(lastAggregated);
  renderBreakdownTable('countryEtf', lastCountryAggEtf, lastTotalInvested, 'country', {
    displayNames: COUNTRY_NAMES, hoverAttr: 'country', unclassified: 'XX',
  });
  renderBreakdownTable('countryStock', lastCountryAggStock, lastTotalInvested, 'country', {
    displayNames: COUNTRY_NAMES, hoverAttr: 'country', unclassified: 'XX',
  });
  renderWorldMap(lastCountryAgg, lastTotalInvested);
  renderBreakdownTable('industryEtf', lastIndustryAggEtf, lastTotalInvested, 'industry', { unclassified: 'Unclassified' });
  renderBreakdownTable('industryStock', lastIndustryAggStock, lastTotalInvested, 'industry', { unclassified: 'Unclassified' });
  renderSummaryCards(lastAggregated, lastCountryAgg, lastIndustryAgg, lastTotalInvested, lastConcentration);
  renderConcentration(lastConcentration, lastTotalInvested);
  renderOverlap(lastOverlapCompanies, lastEtfPairOverlap, lastHoldings.length, lastTotalInvested);
}

async function refreshAll() {
  lastHoldings = loadHoldings();
  lastTotalInvested = lastHoldings.reduce((s, h) => s + h.amountEUR, 0);

  if (lastHoldings.length === 0) {
    lastAggregated = [];
    lastCountryAgg = [];
    lastCountryAggEtf = [];
    lastCountryAggStock = [];
    lastIndustryAgg = [];
    lastIndustryAggEtf = [];
    lastIndustryAggStock = [];
    lastConcentration = null;
    lastOverlapCompanies = [];
    lastEtfPairOverlap = [];
    renderAll();
    return;
  }

  const sources = await Promise.all(
    lastHoldings.map(async (h) => ({
      ticker: h.ticker,
      type: h.type,
      amountEUR: h.amountEUR,
      components: await resolveComponents(h.ticker, h.type),
    }))
  );

  const etfSources = sources.filter((s) => s.type === 'ETF');
  const stockSources = sources.filter((s) => s.type === 'Stock');

  lastAggregated = aggregateExposure(sources);
  lastCountryAgg = aggregateByCountry(sources);
  lastCountryAggEtf = aggregateByCountry(etfSources);
  lastCountryAggStock = aggregateByCountry(stockSources);
  lastIndustryAgg = aggregateByIndustry(sources);
  lastIndustryAggEtf = aggregateByIndustry(etfSources);
  lastIndustryAggStock = aggregateByIndustry(stockSources);
  lastConcentration = computeConcentration(lastAggregated, lastTotalInvested);
  lastOverlapCompanies = computeOverlapCompanies(lastAggregated);
  lastEtfPairOverlap = computeEtfPairOverlap(etfSources);
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
  holdings.push({ ticker: tickerUpper, type, amountEUR });
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

function handleRowHoverIn(e) {
  const tr = e.target.closest('tr[data-country]');
  if (tr) highlightCountry(tr.dataset.country);
}

function handleRowHoverOut(e) {
  const tr = e.target.closest('tr[data-country]');
  if (tr) unhighlightCountry(tr.dataset.country);
}

function init() {
  buildAutocompleteOptions();
  renderStatus();

  document.getElementById('addForm').addEventListener('submit', handleAddSubmit);
  document.getElementById('holdingsBody').addEventListener('click', handleHoldingsClick);
  document.getElementById('blurToggle').addEventListener('click', handleBlurToggle);

  // Hovering a company or country row highlights that country on the map.
  // mouseover/mouseout (not mouseenter/mouseleave) so delegation works.
  ['lookthroughBody', 'countryEtfBody', 'countryStockBody'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('mouseover', handleRowHoverIn);
    el.addEventListener('mouseout', handleRowHoverOut);
  });

  refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
