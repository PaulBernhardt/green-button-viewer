# Green Button Energy Viewer

A privacy-first, browser-based viewer for [Green Button](https://www.greenbuttonalliance.org/green-button) electricity usage data. Upload your XML export from your utility and instantly see interactive charts, billing breakdowns, and time-of-use analysis — **all data stays in your browser, nothing is uploaded anywhere.**

**Live site:** https://PaulBernhardt.github.io/green-button-viewer/

---

## What is Green Button?

Green Button is a standard that lets electricity customers download their usage data directly from their utility in a standard XML format. Most Ontario utilities (Alectra, Hydro One, Toronto Hydro, etc.) provide a Green Button export from their online portal.

[Learn more about Green Button →](https://www.greenbuttonalliance.org/green-button)

---

## How to get your data

1. Log in to your utility's customer portal
2. Look for "Green Button", "Download My Data", or "Usage Data Export"
3. Download the XML file to your computer

For Ontario utilities:
- **Alectra / PowerStream / Enersource / Horizon** — My Account portal → Energy Usage → Green Button Download
- **Hydro One** — My Account → Usage → Download Usage Data
- **Toronto Hydro** — MyAccount → Energy Use → Download My Data

---

## How to use the viewer

1. Open the [live site](https://pbernhardt.github.io/green-button-viewer/)
2. Drag and drop your Green Button XML file onto the upload zone, **or** click **"Upload my Green Button export"** and browse for the file
3. Your data will be parsed and displayed immediately across five views:

| Tab | What you'll see |
|---|---|
| **Dashboard** | Key metrics (total usage, total billed, average daily) + daily bar chart + TOU donut |
| **Hourly / Daily** | Daily consumption bar chart (filter by date range) or an hourly heatmap |
| **Monthly Billing** | Month-by-month kWh and cost charts + full itemized billing table |
| **Time of Use** | Peak / Mid-Peak / Off-Peak split by kWh and cost, monthly stacked bar |
| **Cost Analysis** | Daily cost line, effective rate per TOU tier, cumulative cost curve |

---

## Privacy

This tool runs entirely in your browser. Your energy data is **never sent to any server**. The only external request is loading the [Chart.js](https://www.chartjs.org/) library from a CDN.

---

## Local development

No build step required. Just open the files directly:

```
# Test with synthetic data (no real file needed):
open test.html

# Full app:
open index.html
```

Or serve with any static file server:

```bash
npx serve .
# or
python -m http.server 8080
```

---

## File structure

```
green-button-viewer/
├── index.html          # Main app (upload + tabbed viewer)
├── app.js              # XML parser, data model, chart rendering, UI
├── styles.css          # All styling
├── synthetic-data.js   # Generates 12 months of synthetic Ontario data
├── test.html           # Dev harness — auto-loads synthetic data
└── README.md           # This file
```

---

## Deploying to GitHub Pages

1. Push to `main` branch
2. Go to repo Settings → Pages → Source: **Deploy from a branch** → `main` / `(root)`
3. GitHub will serve `index.html` at `https://PaulBernhardt.github.io/green-button-viewer/`

---

## Supported data format

Green Button XML following the [NAESB ESPI 1.1](https://www.naesb.org/espi.asp) standard (Atom feed format). Tested with Alectra Guelph exports. Should work with any compliant Ontario utility export containing:

- Hourly `IntervalReading` elements with `value`, `cost` (rate code), and `tou` fields
- `UsageSummary` entries for monthly billing data (optional but recommended)
- `LocalTimeParameters` for timezone information
