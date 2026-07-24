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
    return [...components, { company: `${tickerUpper} — other/unlisted holdings`, weight: remainder }];
  }
  return components;
}

// Resolves one user holding into {company, weight}[] summing to ~100.
// This is the only function the rest of the app needs to know about when
// a new data source (auto-fetch, paste-UI, etc.) is added later.
async function resolveComponents(tickerUpper, type) {
  if (type === 'Stock') {
    const company = STOCK_NAME_MAP[tickerUpper] || tickerUpper;
    return [{ company, weight: 100 }];
  }

  const raw = await fetchHoldingsFile(tickerUpper);
  if (!raw || raw.length === 0) {
    return [{ company: `${tickerUpper} — no holdings data available`, weight: 100 }];
  }
  return padToFull(raw, tickerUpper);
}


/* -------------------------------------------------------------------- */
/* 4. ENGINE (pure)                                                     */
/* -------------------------------------------------------------------- */

// sources: [{ ticker, amountEUR, components: [{company, weight}] }]
// returns: [{ company, exposureEUR, sources: Set<ticker> }] sorted desc.
function aggregateExposure(sources) {
  const byCompany = new Map();

  for (const src of sources) {
    for (const comp of src.components) {
      const exposureEUR = src.amountEUR * (comp.weight / 100);
      if (!byCompany.has(comp.company)) {
        byCompany.set(comp.company, { company: comp.company, exposureEUR: 0, sources: new Set() });
      }
      const entry = byCompany.get(comp.company);
      entry.exposureEUR += exposureEUR;
      entry.sources.add(src.ticker);
    }
  }

  return Array.from(byCompany.values()).sort((a, b) => b.exposureEUR - a.exposureEUR);
}


/* -------------------------------------------------------------------- */
/* 5. RENDER                                                            */
/* -------------------------------------------------------------------- */

let isBlurred = loadBlurState();
let chartInstance = null;

const eurFormatter = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFormatter = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

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
  for (let i = 0; i < n; i++) {
    const hue = Math.round((360 / Math.max(n, 1)) * i);
    colors.push(`hsl(${hue} 65% 55%)`);
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

  const config = {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 1 }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
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
let lastTotalInvested = 0;

function renderAll() {
  applyBlurButtonState();
  renderTotal(lastTotalInvested);
  renderHoldingsTable(lastHoldings);
  renderLookthrough(lastAggregated, lastTotalInvested);
  renderChart(lastAggregated);
}

async function refreshAll() {
  lastHoldings = loadHoldings();
  lastTotalInvested = lastHoldings.reduce((s, h) => s + h.amountEUR, 0);

  if (lastHoldings.length === 0) {
    lastAggregated = [];
    renderAll();
    return;
  }

  const sources = await Promise.all(
    lastHoldings.map(async (h) => ({
      ticker: h.ticker,
      amountEUR: h.amountEUR,
      components: await resolveComponents(h.ticker, h.type),
    }))
  );

  lastAggregated = aggregateExposure(sources);
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

function init() {
  buildAutocompleteOptions();
  renderStatus();

  document.getElementById('addForm').addEventListener('submit', handleAddSubmit);
  document.getElementById('holdingsBody').addEventListener('click', handleHoldingsClick);
  document.getElementById('blurToggle').addEventListener('click', handleBlurToggle);

  refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
