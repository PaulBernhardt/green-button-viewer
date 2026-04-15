/**
 * app.js — Green Button Energy Viewer
 *
 * Sections:
 *   A. Constants
 *   B. XML Parser
 *   C. Data Aggregation
 *   D. Chart Rendering
 *   E. UI / Event Handling
 *   F. Utility / Formatting
 */

'use strict';

/* ===================================================
   A. CONSTANTS
   =================================================== */

const TOU_LABELS = { 1: 'Peak', 2: 'Mid-Peak', 3: 'Off-Peak' };
const TOU_COLORS = { 1: '#ef4444', 2: '#f59e0b', 3: '#22c55e' };
const TOU_BG     = { 1: 'rgba(239,68,68,0.15)', 2: 'rgba(245,158,11,0.15)', 3: 'rgba(34,197,94,0.15)' };

const CHART_REGISTRY = {}; // canvasId -> Chart instance

// State
let _appData = null;
let _hourlyView  = 'daily';
let _hourlyRange = 'all';

/* ===================================================
   B. XML PARSER
   =================================================== */

/**
 * Namespace-agnostic element helpers.
 * The ESPI documents declare both xmlns and xmlns:espi on the same element,
 * so localName matching is the safest approach.
 */
function getEl(parent, localName) {
  if (!parent) return null;
  for (const child of parent.children) {
    if (child.localName === localName) return child;
  }
  return null;
}

function getElText(parent, localName) {
  const el = getEl(parent, localName);
  return el ? el.textContent.trim() : null;
}

function getAllEls(parent, localName) {
  if (!parent) return [];
  return Array.from(parent.getElementsByTagName('*'))
    .filter(el => el.localName === localName);
}

/**
 * Find the primary MeterReading ID: the one linked to a ReadingType
 * with flowDirection=1 (delivered) and intervalLength=3600 (hourly).
 * Returns the ID string (e.g. "S01207200100460") or null.
 */
function findPrimaryMeterReadingId(readingTypeEntries, meterReadingEntries) {
  // Strategy 1: find a ReadingType with flowDirection=1 & intervalLength=3600,
  //             extract its ID from the self-link, and match to a MeterReading.
  for (const rtEntry of readingTypeEntries) {
    const content = getEl(rtEntry, 'content');
    if (!content || !content.children.length) continue;
    const rt = content.children[0];
    const flow     = parseInt(getElText(rt, 'flowDirection') || '0');
    const interval = parseInt(getElText(rt, 'intervalLength') || '0');
    if (flow === 1 && interval === 3600) {
      // Extract ID from <link rel="self" href=".../ReadingType/S01207200100460">
      const links = Array.from(rtEntry.getElementsByTagName('link'));
      for (const link of links) {
        if (link.getAttribute('rel') !== 'self') continue;
        const href = link.getAttribute('href') || '';
        const match = href.match(/ReadingType\/([^/]+)$/);
        if (match) return match[1]; // e.g. "S01207200100460"
      }
    }
  }

  // Strategy 2: use the first MeterReading entry (often the primary one)
  if (meterReadingEntries.length > 0) {
    const links = Array.from(meterReadingEntries[0].getElementsByTagName('link'));
    for (const link of links) {
      if (link.getAttribute('rel') !== 'self') continue;
      const href = link.getAttribute('href') || '';
      const match = href.match(/MeterReading\/([^/]+)$/);
      if (match) return match[1];
    }
  }

  return null; // couldn't identify — caller will use all IntervalBlocks as fallback
}

/**
 * Parse a Green Button XML string.
 * Returns { readings, summaries, meta } or throws an Error.
 */
function parseGreenButtonXML(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  // Check for parse errors
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error('XML parse error: ' + parseErr.textContent.slice(0, 200));
  }

  // Categorise all <entry> elements
  const entries = Array.from(doc.getElementsByTagName('entry'));
  const byType = {
    LocalTimeParameters: [],
    ReadingType: [],
    MeterReading: [],
    IntervalBlock: [],
    UsageSummary: [],
  };

  for (const entry of entries) {
    const content = getEl(entry, 'content');
    if (!content || !content.children.length) continue;
    const typeName = content.children[0].localName;
    if (byType[typeName]) byType[typeName].push(entry);
  }

  // Parse timezone
  const meta = { tzOffset: -18000, dstOffset: 3600 };
  if (byType.LocalTimeParameters.length) {
    const ltp = byType.LocalTimeParameters[0];
    const content = getEl(ltp, 'content');
    const tz = parseInt(getElText(content, 'tzOffset') || '-18000');
    const dst = parseInt(getElText(content, 'dstOffset') || '3600');
    if (!isNaN(tz))  meta.tzOffset  = tz;
    if (!isNaN(dst)) meta.dstOffset = dst;
  }

  // Identify the primary ReadingType: flowDirection=1 (delivered) and hourly interval (3600s).
  // Files often contain multiple reading sets (delivered, received, green, daily) and we only
  // want the primary delivered-hourly readings.
  const primaryMeterReadingId = findPrimaryMeterReadingId(byType.ReadingType, byType.MeterReading);

  // Filter IntervalBlocks to only those belonging to the primary MeterReading.
  // Each IntervalBlock <entry> has a <link rel="up"> whose href contains its parent MeterReading path.
  const filteredBlocks = primaryMeterReadingId
    ? byType.IntervalBlock.filter(entry => {
        const links = Array.from(entry.getElementsByTagName('link'));
        return links.some(link =>
          link.getAttribute('rel') === 'up' &&
          link.getAttribute('href') &&
          link.getAttribute('href').includes('MeterReading/' + primaryMeterReadingId + '/')
        );
      })
    : byType.IntervalBlock; // fallback: use all if we can't identify primary

  // Parse interval blocks -> readings
  const readings = [];
  for (const entry of filteredBlocks) {
    const parsed = parseOneIntervalBlock(entry, meta.tzOffset);
    for (const r of parsed) readings.push(r);
  }

  if (readings.length === 0) {
    throw new Error('No interval readings found. Make sure this is a valid Green Button XML export.');
  }

  // Sort by start time
  readings.sort((a, b) => a.startUnix - b.startUnix);

  // Parse usage summaries
  const summaries = [];
  for (const entry of byType.UsageSummary) {
    const s = parseOneUsageSummary(entry, meta.tzOffset);
    if (s) summaries.push(s);
  }

  return { readings, summaries, meta };
}

function parseOneIntervalBlock(entry, tzOffset) {
  const content = getEl(entry, 'content');
  const block = content ? content.children[0] : null;
  if (!block) return [];

  const irEls = getAllEls(block, 'IntervalReading');
  const out = [];

  for (const ir of irEls) {
    const tp = getEl(ir, 'timePeriod');
    if (!tp) continue;

    const startUnix = parseInt(getElText(tp, 'start'));
    if (isNaN(startUnix)) continue;

    const valueRaw  = parseInt(getElText(ir, 'value') || '0');
    const costCode  = parseInt(getElText(ir, 'cost')  || '0');
    const touRaw    = parseInt(getElText(ir, 'tou')   || '0');
    const tou       = (touRaw === 1 || touRaw === 2 || touRaw === 3) ? touRaw : 3;

    // uom=72 is Wh; powerOfTenMultiplier=-3 means value × 10^-3 = Wh; divide by 1000 for kWh
    const kwh = valueRaw * 1e-6;

    // Actual cost in dollars: kWh × rate, where rateCode × 10^-5 = $/kWh (e.g. 7600 → $0.076/kWh)
    const costDol = kwh * costCode * 1e-5;

    // Local time (fixed offset, no DST recalculation — TOU tier is authoritative)
    const localDate = new Date((startUnix + tzOffset) * 1000);
    const hour = localDate.getUTCHours();

    // Build day/month keys from UTC representation of the shifted date
    const y   = localDate.getUTCFullYear();
    const mo  = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const d   = String(localDate.getUTCDate()).padStart(2, '0');
    const dayKey   = `${y}-${mo}-${d}`;
    const monthKey = `${y}-${mo}`;

    out.push({ startUnix, kwh, costDol, tou, hour, dayKey, monthKey, localDate });
  }

  return out;
}

function parseOneUsageSummary(entry, tzOffset) {
  const content = getEl(entry, 'content');
  const su = content ? content.children[0] : null;
  if (!su) return null;

  const bp = getEl(su, 'billingPeriod');
  const billStart    = bp ? parseInt(getElText(bp, 'start') || '0') : 0;
  const billDuration = bp ? parseInt(getElText(bp, 'duration') || '0') : 0;

  // billLastPeriod is in "mills" (1/1000 dollar). Divide by 1000 for dollars.
  const billRaw     = parseInt(getElText(su, 'billLastPeriod') || '0');
  const totalBill   = billRaw / 1000;

  // Local time for month key
  const localDate  = new Date((billStart + tzOffset) * 1000);
  const y  = localDate.getUTCFullYear();
  const mo = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const monthKey = `${y}-${mo}`;

  // Itemized charges: each costAdditionalDetailLastPeriod has its own multiplier
  const chargeEls = getAllEls(su, 'costAdditionalDetailLastPeriod');
  const charges = { amountDue: 0, totalCharges: 0, balanceForward: 0, energy: 0, delivery: 0, regulatory: 0, hst: 0, rebate: 0, other: 0 };

  for (const cel of chargeEls) {
    const note      = getElText(cel, 'note') || '';
    const amtRaw    = parseInt(getElText(cel, 'amount') || '0');
    const meas      = getEl(cel, 'measurement');
    const mult      = meas ? parseInt(getElText(meas, 'powerOfTenMultiplier') || '0') : 0;
    const amtDol    = amtRaw * Math.pow(10, mult);

    const lc = note.toLowerCase();
    if      (lc.includes('amount due'))           charges.amountDue      = amtDol;
    else if (lc.includes('total charges'))        charges.totalCharges   = amtDol;
    else if (lc.includes('balance forward'))      charges.balanceForward = amtDol;
    else if (lc.includes('electricity charge') ||
             lc.includes('energy'))               charges.energy         = amtDol;
    else if (lc.includes('delivery'))             charges.delivery       = amtDol;
    else if (lc.includes('regulatory'))           charges.regulatory     = amtDol;
    else if (lc.includes('hst'))                  charges.hst            = amtDol;
    else if (lc.includes('rebate') ||
             lc.includes('oer'))                  charges.rebate         = amtDol;
  }

  // Use "Total Charges" (actual period charges) rather than "Amount Due" (which may include balance forward)
  const periodBill = charges.totalCharges > 0 ? charges.totalCharges : totalBill;

  return { monthKey, billStart, billDuration, totalBill: periodBill, amountDue: totalBill, balanceForward: charges.balanceForward, charges };
}

/* ===================================================
   C. DATA AGGREGATION
   =================================================== */

function buildAppData(readings, summaries, meta) {
  const daily   = buildDailyAggregates(readings);
  const monthly = buildMonthlyAggregates(readings);
  const tou     = buildTOUTotals(readings);

  // Merge UsageSummary billing data into monthly aggregates
  const summaryMap = new Map(summaries.map(s => [s.monthKey, s]));
  for (const m of monthly) {
    const s = summaryMap.get(m.monthKey);
    if (s) {
      m.totalBill   = s.totalBill;
      m.charges     = s.charges;
      m.hasSummary  = true;
    }
  }

  const dateRangeStart = new Date(readings[0].startUnix * 1000);
  const dateRangeEnd   = new Date((readings[readings.length - 1].startUnix + 3600) * 1000);

  return {
    meta: { ...meta, dateRangeStart, dateRangeEnd, totalReadings: readings.length },
    readings,
    daily,
    monthly,
    summaries,
    tou,
  };
}

function buildDailyAggregates(readings) {
  const map = new Map();
  for (const r of readings) {
    if (!map.has(r.dayKey)) {
      map.set(r.dayKey, {
        dayKey: r.dayKey,
        date: r.localDate,
        kwh: 0, costDol: 0,
        peakKwh: 0, midKwh: 0, offKwh: 0,
        peakCost: 0, midCost: 0, offCost: 0,
        readings: [],
      });
    }
    const d = map.get(r.dayKey);
    d.kwh     += r.kwh;
    d.costDol += r.costDol;
    if (r.tou === 1) { d.peakKwh += r.kwh; d.peakCost += r.costDol; }
    if (r.tou === 2) { d.midKwh  += r.kwh; d.midCost  += r.costDol; }
    if (r.tou === 3) { d.offKwh  += r.kwh; d.offCost  += r.costDol; }
    d.readings.push(r);
  }
  return Array.from(map.values()).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

function buildMonthlyAggregates(readings) {
  const map = new Map();
  for (const r of readings) {
    if (!map.has(r.monthKey)) {
      map.set(r.monthKey, {
        monthKey: r.monthKey,
        label: formatMonthLabel(r.monthKey),
        kwh: 0, costDol: 0,
        peakKwh: 0, midKwh: 0, offKwh: 0,
        peakCost: 0, midCost: 0, offCost: 0,
        totalBill: null, charges: null, hasSummary: false,
      });
    }
    const m = map.get(r.monthKey);
    m.kwh     += r.kwh;
    m.costDol += r.costDol;
    if (r.tou === 1) { m.peakKwh += r.kwh; m.peakCost += r.costDol; }
    if (r.tou === 2) { m.midKwh  += r.kwh; m.midCost  += r.costDol; }
    if (r.tou === 3) { m.offKwh  += r.kwh; m.offCost  += r.costDol; }
  }
  return Array.from(map.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}

function buildTOUTotals(readings) {
  const t = {
    peak:    { kwh: 0, costDol: 0, count: 0 },
    midpeak: { kwh: 0, costDol: 0, count: 0 },
    offpeak: { kwh: 0, costDol: 0, count: 0 },
  };
  for (const r of readings) {
    const key = r.tou === 1 ? 'peak' : r.tou === 2 ? 'midpeak' : 'offpeak';
    t[key].kwh    += r.kwh;
    t[key].costDol += r.costDol;
    t[key].count  += 1;
  }
  return t;
}

/* ===================================================
   D. CHART RENDERING
   =================================================== */

function destroyChart(canvasId) {
  if (CHART_REGISTRY[canvasId]) {
    CHART_REGISTRY[canvasId].destroy();
    delete CHART_REGISTRY[canvasId];
  }
}

function createChart(canvasId, config) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const chart = new Chart(canvas, config);
  CHART_REGISTRY[canvasId] = chart;
  return chart;
}

const baseChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
  },
};

// ── Dashboard ──────────────────────────────────────

function renderDashboardKPIs(data) {
  const totalKwh  = data.daily.reduce((s, d) => s + d.kwh, 0);
  const totalCost = data.daily.reduce((s, d) => s + d.costDol, 0);
  // Use sum of totalBill from summaries if available
  const billedTotal = data.summaries.length
    ? data.summaries.reduce((s, su) => s + su.totalBill, 0)
    : null;
  const avgDaily  = totalKwh / data.daily.length;
  const peakDay   = data.daily.reduce((best, d) => d.kwh > best.kwh ? d : best, data.daily[0]);

  setKPI('kpi-total-kwh',  formatKwh(totalKwh, 0),  'over the full period');
  setKPI('kpi-total-cost',
    billedTotal != null ? formatCost(billedTotal) : formatCost(totalCost),
    billedTotal != null ? 'from billing summaries' : 'computed from rates');
  setKPI('kpi-avg-daily',  formatKwh(avgDaily),      'per day');
  setKPI('kpi-peak-day',   formatKwh(peakDay.kwh),   peakDay.dayKey);
  setKPI('kpi-date-range',
    formatDate(data.meta.dateRangeStart) + ' –',
    formatDate(data.meta.dateRangeEnd));
  setKPI('kpi-months', String(data.monthly.length), 'billing months');
}

function setKPI(id, value, sub) {
  const card = document.getElementById(id);
  if (!card) return;
  card.querySelector('.kpi-value').textContent = value;
  card.querySelector('.kpi-sub').textContent   = sub || '';
}

function renderDashboardDailyChart(data) {
  const days   = data.daily;
  const labels = days.map(d => d.dayKey);
  const kwhArr = days.map(d => +d.kwh.toFixed(3));
  const costArr = days.map(d => +d.costDol.toFixed(4));

  createChart('chart-dashboard-daily', {
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'kWh',
          data: kwhArr,
          backgroundColor: 'rgba(59,130,246,0.6)',
          borderColor: 'rgba(59,130,246,0.9)',
          borderWidth: 1,
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line',
          label: 'Cost ($)',
          data: costArr,
          borderColor: '#f59e0b',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          yAxisID: 'y2',
          order: 1,
        },
      ],
    },
    options: {
      ...baseChartOptions,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label === 'kWh'
              ? ` ${formatKwh(ctx.parsed.y)}`
              : ` ${formatCost(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: 10 } }, grid: { display: false } },
        y:  { position: 'left',  title: { display: true, text: 'kWh', font: { size: 11 } }, beginAtZero: true },
        y2: { position: 'right', title: { display: true, text: 'Cost ($)', font: { size: 11 } }, beginAtZero: true, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderDashboardTOUPie(data) {
  const { tou } = data;
  createChart('chart-dashboard-tou-pie', {
    type: 'doughnut',
    data: {
      labels: ['Peak', 'Mid-Peak', 'Off-Peak'],
      datasets: [{
        data: [tou.peak.kwh, tou.midpeak.kwh, tou.offpeak.kwh].map(v => +v.toFixed(2)),
        backgroundColor: [TOU_COLORS[1], TOU_COLORS[2], TOU_COLORS[3]],
        borderWidth: 2,
        borderColor: '#fff',
      }],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              return ` ${formatKwh(ctx.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// ── Hourly / Daily ─────────────────────────────────

function renderHourlyTab(data) {
  const view  = _hourlyView;
  const range = _hourlyRange;

  let filteredDays = data.daily;
  if (range !== 'all') {
    const n = parseInt(range);
    filteredDays = data.daily.slice(-n);
  }

  document.getElementById('hourly-bar-card').style.display    = view === 'daily'   ? '' : 'none';
  document.getElementById('hourly-heatmap-card').style.display = view === 'heatmap' ? '' : 'none';

  if (view === 'daily') {
    renderDailyBarChart(filteredDays);
  } else {
    renderHourlyHeatmap(data, filteredDays);
  }
}

function renderDailyBarChart(days) {
  const avgKwh = days.reduce((s, d) => s + d.kwh, 0) / days.length;
  const colors = days.map(d => d.kwh > avgKwh ? 'rgba(245,158,11,0.7)' : 'rgba(59,130,246,0.6)');
  const borders = days.map(d => d.kwh > avgKwh ? 'rgba(245,158,11,0.9)' : 'rgba(59,130,246,0.9)');

  const title = document.getElementById('hourly-bar-title');
  if (title) title.textContent = `Daily Consumption (kWh) — amber = above average (${formatKwh(avgKwh)}/day)`;

  createChart('chart-hourly-bar', {
    type: 'bar',
    data: {
      labels: days.map(d => d.dayKey),
      datasets: [{
        label: 'kWh',
        data: days.map(d => +d.kwh.toFixed(3)),
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1,
      }],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${formatKwh(ctx.parsed.y)}  |  ${formatCost(days[ctx.dataIndex].costDol)}`,
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 14, font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: 'kWh', font: { size: 11 } } },
      },
    },
  });
}

function renderHourlyHeatmap(data, filteredDays) {
  const canvas = document.getElementById('chart-hourly-heatmap');
  if (!canvas) return;

  // Remove old mousemove listener by replacing the canvas element clone trick
  const newCanvas = canvas.cloneNode(false);
  canvas.parentNode.replaceChild(newCanvas, canvas);
  newCanvas.id = 'chart-hourly-heatmap';

  const days = filteredDays.slice(-90); // cap at 90 for readability
  const HOURS = 24;
  const LABEL_W = 38; // px for hour labels
  const LABEL_H = 20; // px for day labels at bottom
  const CELL_H  = 14;
  const MIN_CELL_W = 6;

  const containerWidth = newCanvas.parentElement.clientWidth || 700;
  const CELL_W = Math.max(MIN_CELL_W, Math.floor((containerWidth - LABEL_W) / days.length));

  newCanvas.width  = LABEL_W + days.length * CELL_W;
  newCanvas.height = HOURS * CELL_H + LABEL_H + 4;

  const ctx = newCanvas.getContext('2d');
  ctx.clearRect(0, 0, newCanvas.width, newCanvas.height);

  // Build hour → kWh lookup per day index
  const dayHourMap = days.map(day => {
    const m = new Array(HOURS).fill(0);
    for (const r of day.readings) m[r.hour] = r.kwh;
    return m;
  });

  // Find max kWh for color scale
  const maxKwh = Math.max(...dayHourMap.flatMap(h => h), 0.01);

  // Draw cells
  for (let h = 0; h < HOURS; h++) {
    // Hour label
    ctx.fillStyle = '#718096';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${String(h).padStart(2, '0')}:00`, LABEL_W - 4, h * CELL_H + CELL_H - 3);

    for (let di = 0; di < days.length; di++) {
      const kwh = dayHourMap[di][h];
      const t   = kwh / maxKwh;
      // Color: light blue (0) → deep orange-red (max)
      const hue  = Math.round(220 - t * 200);
      const sat  = Math.round(40 + t * 50);
      const lit  = Math.round(92 - t * 55);
      ctx.fillStyle = `hsl(${hue},${sat}%,${lit}%)`;
      ctx.fillRect(LABEL_W + di * CELL_W, h * CELL_H, CELL_W - 1, CELL_H - 1);
    }
  }

  // Day labels (every Nth day to avoid crowding)
  const labelEvery = Math.max(1, Math.ceil(days.length / 20));
  ctx.fillStyle = '#718096';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  for (let di = 0; di < days.length; di += labelEvery) {
    const x = LABEL_W + di * CELL_W + CELL_W / 2;
    const y = HOURS * CELL_H + LABEL_H - 4;
    ctx.fillText(days[di].dayKey.slice(5), x, y); // show MM-DD
  }

  // Tooltip
  const tooltip = document.getElementById('heatmap-tooltip');
  newCanvas.addEventListener('mousemove', e => {
    const rect = newCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const di = Math.floor((mx - LABEL_W) / CELL_W);
    const h  = Math.floor(my / CELL_H);
    if (di >= 0 && di < days.length && h >= 0 && h < HOURS) {
      const kwh = dayHourMap[di][h];
      tooltip.style.display = 'block';
      tooltip.style.left    = (e.clientX + 12) + 'px';
      tooltip.style.top     = (e.clientY - 10) + 'px';
      tooltip.innerHTML     =
        `<strong>${days[di].dayKey}</strong> ${String(h).padStart(2,'0')}:00–${String(h+1).padStart(2,'0')}:00<br>${formatKwh(kwh)}`;
    } else {
      tooltip.style.display = 'none';
    }
  });
  newCanvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

// ── Monthly Billing ────────────────────────────────

function renderMonthlyTab(data) {
  renderMonthlyKwhChart(data);
  renderMonthlyCostChart(data);
  renderMonthlyTable(data);
}

function renderMonthlyKwhChart(data) {
  const months = data.monthly;
  createChart('chart-monthly-kwh', {
    type: 'bar',
    data: {
      labels: months.map(m => m.label),
      datasets: [
        { label: 'Peak',     data: months.map(m => +m.peakKwh.toFixed(2)), backgroundColor: TOU_COLORS[1], stack: 'kwh' },
        { label: 'Mid-Peak', data: months.map(m => +m.midKwh.toFixed(2)),  backgroundColor: TOU_COLORS[2], stack: 'kwh' },
        { label: 'Off-Peak', data: months.map(m => +m.offKwh.toFixed(2)),  backgroundColor: TOU_COLORS[3], stack: 'kwh' },
      ],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatKwh(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'kWh', font: { size: 11 } } },
      },
    },
  });
}

function renderMonthlyCostChart(data) {
  const months = data.monthly;
  const hasBills = months.some(m => m.hasSummary);

  const datasets = [
    {
      type: 'bar',
      label: 'Computed cost',
      data: months.map(m => +m.costDol.toFixed(2)),
      backgroundColor: 'rgba(59,130,246,0.6)',
      borderColor: 'rgba(59,130,246,0.9)',
      borderWidth: 1,
      order: 2,
    },
  ];

  if (hasBills) {
    datasets.push({
      type: 'line',
      label: 'Billed total',
      data: months.map(m => m.hasSummary ? +m.totalBill.toFixed(2) : null),
      borderColor: '#ef4444',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 4,
      tension: 0.2,
      order: 1,
      spanGaps: false,
    });
  }

  createChart('chart-monthly-cost', {
    data: { labels: months.map(m => m.label), datasets },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: hasBills, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatCost(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: '$', font: { size: 11 } } },
      },
    },
  });
}

function renderMonthlyTable(data) {
  const tbody = document.querySelector('#monthly-breakdown-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  let totKwh = 0, totEnergy = 0, totDel = 0, totReg = 0, totHst = 0, totRebate = 0, totBill = 0;

  for (const m of data.monthly) {
    const ch = m.charges || {};
    const billVal = m.hasSummary ? m.totalBill : m.costDol;

    totKwh    += m.kwh;
    totEnergy += ch.energy      || m.costDol;
    totDel    += ch.delivery    || 0;
    totReg    += ch.regulatory  || 0;
    totHst    += ch.hst         || 0;
    totRebate += ch.rebate      || 0;
    totBill   += billVal;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${m.label}</td>
      <td class="num">${m.kwh.toFixed(1)}</td>
      <td class="num">${formatCost(ch.energy    || m.costDol)}</td>
      <td class="num">${formatCost(ch.delivery  || 0)}</td>
      <td class="num">${formatCost(ch.regulatory|| 0)}</td>
      <td class="num">${formatCost(ch.hst       || 0)}</td>
      <td class="num">${ch.rebate ? formatCost(ch.rebate) : '—'}</td>
      <td class="num"><strong>${formatCost(billVal)}</strong></td>
    `;
    tbody.appendChild(tr);
  }

  setText('tbl-total-kwh',        totKwh.toFixed(1));
  setText('tbl-total-energy',     formatCost(totEnergy));
  setText('tbl-total-delivery',   formatCost(totDel));
  setText('tbl-total-regulatory', formatCost(totReg));
  setText('tbl-total-hst',        formatCost(totHst));
  setText('tbl-total-rebate',     totRebate ? formatCost(totRebate) : '—');
  setText('tbl-total-bill',       formatCost(totBill));
}

// ── Time of Use ─────────────────────────────────────

function renderTOUTab(data) {
  const { tou } = data;
  const totalKwh  = tou.peak.kwh  + tou.midpeak.kwh  + tou.offpeak.kwh;
  const totalCost = tou.peak.costDol + tou.midpeak.costDol + tou.offpeak.costDol;

  function pct(v, tot) { return tot > 0 ? ((v / tot) * 100).toFixed(1) + '%' : '—'; }

  setKPI('kpi-tou-peak',
    formatKwh(tou.peak.kwh, 0),
    pct(tou.peak.kwh, totalKwh) + ' of usage');
  setKPI('kpi-tou-mid',
    formatKwh(tou.midpeak.kwh, 0),
    pct(tou.midpeak.kwh, totalKwh) + ' of usage');
  setKPI('kpi-tou-off',
    formatKwh(tou.offpeak.kwh, 0),
    pct(tou.offpeak.kwh, totalKwh) + ' of usage');

  renderTOUDonut(data);
  renderTOUCostDonut(data);
  renderTOUMonthlyStacked(data);
}

function renderTOUDonut(data) {
  const { tou } = data;
  createChart('chart-tou-donut', {
    type: 'doughnut',
    data: {
      labels: ['Peak', 'Mid-Peak', 'Off-Peak'],
      datasets: [{
        data: [tou.peak.kwh, tou.midpeak.kwh, tou.offpeak.kwh].map(v => +v.toFixed(2)),
        backgroundColor: [TOU_COLORS[1], TOU_COLORS[2], TOU_COLORS[3]],
        borderWidth: 2, borderColor: '#fff',
      }],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
              return ` ${formatKwh(ctx.parsed)} (${((ctx.parsed / total) * 100).toFixed(1)}%)`;
            },
          },
        },
      },
    },
  });
}

function renderTOUCostDonut(data) {
  const { tou } = data;
  createChart('chart-tou-cost-donut', {
    type: 'doughnut',
    data: {
      labels: ['Peak', 'Mid-Peak', 'Off-Peak'],
      datasets: [{
        data: [tou.peak.costDol, tou.midpeak.costDol, tou.offpeak.costDol].map(v => +v.toFixed(2)),
        backgroundColor: [TOU_COLORS[1], TOU_COLORS[2], TOU_COLORS[3]],
        borderWidth: 2, borderColor: '#fff',
      }],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
              return ` ${formatCost(ctx.parsed)} (${((ctx.parsed / total) * 100).toFixed(1)}%)`;
            },
          },
        },
      },
    },
  });
}

function renderTOUMonthlyStacked(data) {
  const months = data.monthly;
  createChart('chart-tou-monthly-stacked', {
    type: 'bar',
    data: {
      labels: months.map(m => m.label),
      datasets: [
        { label: 'Peak',     data: months.map(m => +m.peakKwh.toFixed(2)), backgroundColor: TOU_COLORS[1], stack: 'tou' },
        { label: 'Mid-Peak', data: months.map(m => +m.midKwh.toFixed(2)),  backgroundColor: TOU_COLORS[2], stack: 'tou' },
        { label: 'Off-Peak', data: months.map(m => +m.offKwh.toFixed(2)),  backgroundColor: TOU_COLORS[3], stack: 'tou' },
      ],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatKwh(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'kWh', font: { size: 11 } } },
      },
    },
  });
}

// ── Cost Analysis ───────────────────────────────────

function renderCostTab(data) {
  renderCostDailyChart(data);
  renderCostRateBar(data);
  renderCostCumulativeChart(data);
}

function renderCostDailyChart(data) {
  const days = data.daily;
  createChart('chart-cost-daily', {
    type: 'line',
    data: {
      labels: days.map(d => d.dayKey),
      datasets: [{
        label: 'Daily Cost ($)',
        data: days.map(d => +d.costDol.toFixed(4)),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.1)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${formatCost(ctx.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: '$', font: { size: 11 } } },
      },
    },
  });
}

function renderCostRateBar(data) {
  const { tou } = data;
  function effectiveRate(tier) {
    return tier.kwh > 0 ? (tier.costDol / tier.kwh * 100) : 0; // cents/kWh
  }
  const rates = [
    effectiveRate(tou.peak),
    effectiveRate(tou.midpeak),
    effectiveRate(tou.offpeak),
  ];
  const blended = (tou.peak.costDol + tou.midpeak.costDol + tou.offpeak.costDol) /
                  (tou.peak.kwh + tou.midpeak.kwh + tou.offpeak.kwh) * 100;

  createChart('chart-cost-rate-bar', {
    type: 'bar',
    data: {
      labels: ['Peak', 'Mid-Peak', 'Off-Peak'],
      datasets: [{
        label: 'Effective rate (¢/kWh)',
        data: rates.map(r => +r.toFixed(2)),
        backgroundColor: [TOU_COLORS[1], TOU_COLORS[2], TOU_COLORS[3]],
        borderWidth: 0,
        borderRadius: 4,
      }],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(2)} ¢/kWh` } },
        annotation: {},
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: '¢/kWh', font: { size: 11 } } },
      },
    },
  });

  // Add blended rate note under the chart
  const card = document.getElementById('chart-cost-rate-bar').closest('.chart-card');
  let note = card.querySelector('.blended-note');
  if (!note) {
    note = document.createElement('p');
    note.className = 'chart-subtitle blended-note';
    card.appendChild(note);
  }
  note.textContent = `Blended average: ${blended.toFixed(2)} ¢/kWh`;
}

function renderCostCumulativeChart(data) {
  const days = data.daily;
  let cumulative = 0;
  const cumData = days.map(d => { cumulative += d.costDol; return +cumulative.toFixed(2); });

  createChart('chart-cost-cumulative', {
    type: 'line',
    data: {
      labels: days.map(d => d.dayKey),
      datasets: [{
        label: 'Cumulative Cost ($)',
        data: cumData,
        borderColor: '#3b82f6',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0,
      }],
    },
    options: {
      ...baseChartOptions,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${formatCost(ctx.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: '$', font: { size: 11 } } },
      },
    },
  });
}

// ── Render all ─────────────────────────────────────

function renderAllTabs(data) {
  renderDashboardKPIs(data);
  renderDashboardDailyChart(data);
  renderDashboardTOUPie(data);
  renderHourlyTab(data);
  renderMonthlyTab(data);
  renderTOUTab(data);
  renderCostTab(data);
}

/* ===================================================
   E. UI / EVENT HANDLING
   =================================================== */

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function activateTab(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === 'tab-' + name);
  });
}

function showError(msg) {
  const el = document.getElementById('upload-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  const el = document.getElementById('upload-error');
  if (el) el.classList.add('hidden');
}

function updateHeaderMeta(data) {
  const el = document.getElementById('header-date-range');
  if (el) {
    el.textContent = formatDate(data.meta.dateRangeStart) + ' – ' + formatDate(data.meta.dateRangeEnd);
  }
}

function processXML(xmlString) {
  clearError();
  let parsed;
  try {
    parsed = parseGreenButtonXML(xmlString);
  } catch (e) {
    showError('Could not parse file: ' + e.message);
    return;
  }

  let data;
  try {
    data = buildAppData(parsed.readings, parsed.summaries, parsed.meta);
  } catch (e) {
    showError('Error processing data: ' + e.message);
    return;
  }

  _appData = data;

  // Reset hourly controls
  _hourlyView  = 'daily';
  _hourlyRange = 'all';
  const hvs = document.getElementById('hourly-view-select');
  const hrs = document.getElementById('hourly-range-select');
  if (hvs) hvs.value = 'daily';
  if (hrs) hrs.value = 'all';

  showScreen('app-screen');
  activateTab('dashboard');
  updateHeaderMeta(data);
  renderAllTabs(data);
}

function handleFileSelect(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.xml') && file.type && !file.type.includes('xml')) {
    showError('Please select an XML file exported from your utility\'s Green Button portal.');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => processXML(e.target.result);
  reader.onerror = () => showError('Could not read file. Please try again.');
  reader.readAsText(file, 'utf-8');
}

function initUI() {
  // File input
  const fileInput = document.getElementById('file-input');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      if (e.target.files.length) handleFileSelect(e.target.files[0]);
    });
  }

  // Drop zone
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    });
    dropZone.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') fileInput && fileInput.click();
    });
  }

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Reset button
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      // Destroy all charts
      for (const id of Object.keys(CHART_REGISTRY)) destroyChart(id);
      _appData = null;
      // Clear file input
      if (fileInput) fileInput.value = '';
      clearError();
      showScreen('upload-screen');
    });
  }

  // Hourly view controls
  const hourlyViewSelect  = document.getElementById('hourly-view-select');
  const hourlyRangeSelect = document.getElementById('hourly-range-select');

  if (hourlyViewSelect) {
    hourlyViewSelect.addEventListener('change', e => {
      _hourlyView = e.target.value;
      if (_appData) renderHourlyTab(_appData);
    });
  }
  if (hourlyRangeSelect) {
    hourlyRangeSelect.addEventListener('change', e => {
      _hourlyRange = e.target.value;
      if (_appData) renderHourlyTab(_appData);
    });
  }

  // Synthetic data button
  const testBtn = document.getElementById('load-test-data-btn');
  if (testBtn) {
    testBtn.addEventListener('click', () => {
      if (typeof window.generateSyntheticGreenButtonXML === 'function') {
        processXML(window.generateSyntheticGreenButtonXML());
      } else {
        showError('Synthetic data generator not loaded. Please refresh the page.');
      }
    });
  }
}

/* ===================================================
   F. UTILITY / FORMATTING
   =================================================== */

function formatKwh(value, decimals = 1) {
  return value.toFixed(decimals) + ' kWh';
}

function formatCost(value) {
  if (value == null || isNaN(value)) return '—';
  return '$' + Math.abs(value).toFixed(2);
}

function formatDate(date) {
  if (!date) return '—';
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  const date = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, 1));
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', timeZone: 'UTC' });
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/* ===================================================
   INIT
   =================================================== */

document.addEventListener('DOMContentLoaded', initUI);

// Expose for test.html
window.processXML = processXML;
