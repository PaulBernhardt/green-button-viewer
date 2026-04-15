/**
 * synthetic-data.js
 * Generates a valid NAESB ESPI 1.1 / Green Button XML string with
 * 12 months of realistic Ontario electricity usage data (Jan–Dec 2024).
 *
 * Exposed as: window.generateSyntheticGreenButtonXML()
 */
(function () {
  'use strict';

  const TZ_OFFSET = -18000; // EST: -5h in seconds
  const DST_OFFSET = 3600;

  // Ontario TOU rate codes (stored as integers, rate = code × 1e-5 $/kWh)
  const RATE = { 1: 15800, 2: 12200, 3: 7600 };

  /** Return Ontario TOU tier (1=Peak, 2=Mid, 3=Off) for a local-time Date */
  function assignTOU(localDate) {
    const day = localDate.getDay(); // 0=Sun, 6=Sat
    const h = localDate.getHours();
    if (day === 0 || day === 6) return 3; // weekends always off-peak
    if (h >= 7 && h < 11) return 2;      // mid-peak morning
    if (h >= 11 && h < 17) return 1;     // peak midday
    if (h >= 17 && h < 19) return 2;     // mid-peak evening
    return 3;                             // off-peak otherwise
  }

  /** Simulate kWh consumption for one hour */
  function simulateKwh(localDate) {
    const h = localDate.getHours();
    const m = localDate.getMonth(); // 0-based
    const day = localDate.getDay();

    let base = 0.5;
    if (h >= 7 && h <= 9)  base += 1.5;  // morning startup
    if (h >= 18 && h <= 21) base += 2.0; // evening peak

    // Seasonal multiplier
    const isWinter = (m <= 1 || m === 11);
    const isSummer = (m >= 5 && m <= 7);
    const season = isWinter ? 1.8 : isSummer ? 1.4 : 1.0;

    // Weekend multiplier (home all day)
    const weekend = (day === 0 || day === 6) ? 1.2 : 1.0;

    // Gaussian-ish noise
    const noise = 0.85 + Math.random() * 0.30;

    return Math.max(0.1, base * season * weekend * noise);
  }

  /** Generate all hourly readings for 2024 */
  function generateReadings() {
    const readings = [];
    // Start: Jan 1 2024 00:00 EST = Unix 1704067200 + 18000 = 1704085200?
    // Actually: Jan 1 2024 00:00 UTC = 1704067200. EST = UTC-5 = 1704067200+18000 = 1704085200
    // We want local midnight Jan 1 EST: that is UTC 05:00 Jan 1 = 1704067200 + 5*3600 = 1704085200
    // Simpler: 2024-01-01T05:00:00Z = local midnight EST
    const startUnix = Date.UTC(2024, 0, 1, 5, 0, 0) / 1000; // Jan 1 2024 00:00 EST
    const endUnix   = Date.UTC(2024, 11, 31, 28, 0, 0) / 1000; // Dec 31 2024 23:00 EST = Jan 1 2025 04:00 UTC

    for (let unix = startUnix; unix < endUnix; unix += 3600) {
      // Build a Date representing local (EST) time for TOU/consumption logic
      const localDate = new Date((unix + TZ_OFFSET) * 1000);
      const tou = assignTOU(localDate);
      const kwh = simulateKwh(localDate);
      const valueRaw = Math.round(kwh * 1e6);     // uom=72 (Wh), multiplier=-3 → store kWh×10^6 as raw Wh×10^3
      const costCode = RATE[tou];                 // rate in units of 1e-5 $/kWh

      readings.push({ unix, localDate, tou, kwh, valueRaw, costCode });
    }
    return readings;
  }

  /** Group readings into days keyed by 'YYYY-MM-DD' (local time) */
  function groupByDay(readings) {
    const days = new Map();
    for (const r of readings) {
      const key = r.localDate.toISOString().slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(r);
    }
    return days;
  }

  /** Group readings into months keyed by 'YYYY-MM' (local time) */
  function groupByMonth(readings) {
    const months = new Map();
    for (const r of readings) {
      const key = r.localDate.toISOString().slice(0, 7);
      if (!months.has(key)) months.set(key, []);
      months.get(key).push(r);
    }
    return months;
  }

  /** Format an integer as a padded UUID-ish identifier */
  let _uidCounter = 1000;
  function uid() { return 'synth-' + (_uidCounter++); }

  /** Render one IntervalBlock entry for a single day */
  function renderIntervalBlockEntry(dayReadings) {
    const dayStart = dayReadings[0].unix;
    const dayDuration = dayReadings.length * 3600;

    const readingsXml = dayReadings.map(r => `        <espi:IntervalReading>
          <espi:cost>${r.costCode}</espi:cost>
          <espi:ReadingQuality>
            <espi:quality>0</espi:quality>
          </espi:ReadingQuality>
          <espi:timePeriod>
            <espi:duration>3600</espi:duration>
            <espi:start>${r.unix}</espi:start>
          </espi:timePeriod>
          <espi:tou>${r.tou}</espi:tou>
          <espi:value>${r.valueRaw}</espi:value>
        </espi:IntervalReading>`).join('\n');

    return `  <entry>
    <id>urn:uuid:${uid()}</id>
    <title>Hourly Interval Data</title>
    <content>
      <espi:IntervalBlock xmlns="http://naesb.org/espi" xmlns:espi="http://naesb.org/espi">
        <espi:interval>
          <espi:duration>${dayDuration}</espi:duration>
          <espi:start>${dayStart}</espi:start>
        </espi:interval>
${readingsXml}
      </espi:IntervalBlock>
    </content>
  </entry>`;
  }

  /** Render one UsageSummary entry for a calendar month */
  function renderUsageSummaryEntry(monthKey, monthReadings) {
    const totalKwh  = monthReadings.reduce((s, r) => s + r.kwh, 0);
    const energyCost = monthReadings.reduce((s, r) => s + r.kwh * r.costCode * 1e-5, 0);

    // Ontario billing components
    const delivery   = 25.00 + totalKwh * 0.03;
    const regulatory = 6.50;
    const subtotal   = energyCost + delivery + regulatory;
    const hst        = subtotal * 0.13;
    const rebate     = 30.00;
    const amountDue  = subtotal + hst - rebate;

    // billLastPeriod stored in "mills" (1/1000 of a dollar = 0.1 cent)
    const billLastPeriod = Math.round(amountDue * 1000);

    // billingPeriod: first and last reading timestamps
    const billStart    = monthReadings[0].unix;
    const billEnd      = monthReadings[monthReadings.length - 1].unix + 3600;
    const billDuration = billEnd - billStart;

    // Helper: amount stored as integer with given powerOfTenMultiplier
    // amountDue uses multiplier=-1 (amount/10 = dollars)
    // others use multiplier=-2 (amount/100 = dollars)
    const amountDue_raw  = Math.round(amountDue * 10);
    const hst_raw        = Math.round(hst * 100);
    const delivery_raw   = Math.round(delivery * 100);
    const regulatory_raw = Math.round(regulatory * 100);
    const rebate_raw     = Math.round(rebate * 100);
    const energy_raw     = Math.round(energyCost * 100);

    return `  <entry>
    <id>urn:uuid:${uid()}</id>
    <title>Usage Summary ${monthKey}</title>
    <content>
      <espi:UsageSummary xmlns="http://naesb.org/espi" xmlns:espi="http://naesb.org/espi">
        <espi:billingPeriod>
          <espi:duration>${billDuration}</espi:duration>
          <espi:start>${billStart}</espi:start>
        </espi:billingPeriod>
        <espi:billLastPeriod>${billLastPeriod}</espi:billLastPeriod>
        <espi:billToDate>0</espi:billToDate>
        <espi:costAdditionalLastPeriod>${billLastPeriod}</espi:costAdditionalLastPeriod>
        <espi:costAdditionalDetailLastPeriod>
          <espi:amount>${amountDue_raw}</espi:amount>
          <espi:note>Amount Due</espi:note>
          <espi:measurement>
            <espi:powerOfTenMultiplier>-1</espi:powerOfTenMultiplier>
            <espi:uom>80</espi:uom>
          </espi:measurement>
          <espi:itemKind>10</espi:itemKind>
          <espi:unitCost>0</espi:unitCost>
          <espi:itemPeriod>
            <espi:duration>${billDuration}</espi:duration>
            <espi:start>${billStart}</espi:start>
          </espi:itemPeriod>
        </espi:costAdditionalDetailLastPeriod>
        <espi:costAdditionalDetailLastPeriod>
          <espi:amount>${energy_raw}</espi:amount>
          <espi:note>Electricity charge</espi:note>
          <espi:measurement>
            <espi:powerOfTenMultiplier>-2</espi:powerOfTenMultiplier>
            <espi:uom>80</espi:uom>
          </espi:measurement>
          <espi:itemKind>10</espi:itemKind>
          <espi:unitCost>0</espi:unitCost>
          <espi:itemPeriod>
            <espi:duration>${billDuration}</espi:duration>
            <espi:start>${billStart}</espi:start>
          </espi:itemPeriod>
        </espi:costAdditionalDetailLastPeriod>
        <espi:costAdditionalDetailLastPeriod>
          <espi:amount>${delivery_raw}</espi:amount>
          <espi:note>Delivery charge</espi:note>
          <espi:measurement>
            <espi:powerOfTenMultiplier>-2</espi:powerOfTenMultiplier>
            <espi:uom>80</espi:uom>
          </espi:measurement>
          <espi:itemKind>10</espi:itemKind>
          <espi:unitCost>0</espi:unitCost>
          <espi:itemPeriod>
            <espi:duration>${billDuration}</espi:duration>
            <espi:start>${billStart}</espi:start>
          </espi:itemPeriod>
        </espi:costAdditionalDetailLastPeriod>
        <espi:costAdditionalDetailLastPeriod>
          <espi:amount>${regulatory_raw}</espi:amount>
          <espi:note>Regulatory charge</espi:note>
          <espi:measurement>
            <espi:powerOfTenMultiplier>-2</espi:powerOfTenMultiplier>
            <espi:uom>80</espi:uom>
          </espi:measurement>
          <espi:itemKind>10</espi:itemKind>
          <espi:unitCost>0</espi:unitCost>
          <espi:itemPeriod>
            <espi:duration>${billDuration}</espi:duration>
            <espi:start>${billStart}</espi:start>
          </espi:itemPeriod>
        </espi:costAdditionalDetailLastPeriod>
        <espi:costAdditionalDetailLastPeriod>
          <espi:amount>${hst_raw}</espi:amount>
          <espi:note>HST</espi:note>
          <espi:measurement>
            <espi:powerOfTenMultiplier>-2</espi:powerOfTenMultiplier>
            <espi:uom>80</espi:uom>
          </espi:measurement>
          <espi:itemKind>10</espi:itemKind>
          <espi:unitCost>0</espi:unitCost>
          <espi:itemPeriod>
            <espi:duration>${billDuration}</espi:duration>
            <espi:start>${billStart}</espi:start>
          </espi:itemPeriod>
        </espi:costAdditionalDetailLastPeriod>
        <espi:costAdditionalDetailLastPeriod>
          <espi:amount>${rebate_raw}</espi:amount>
          <espi:note>Ontario Electricity Rebate</espi:note>
          <espi:measurement>
            <espi:powerOfTenMultiplier>-2</espi:powerOfTenMultiplier>
            <espi:uom>80</espi:uom>
          </espi:measurement>
          <espi:itemKind>10</espi:itemKind>
          <espi:unitCost>0</espi:unitCost>
          <espi:itemPeriod>
            <espi:duration>${billDuration}</espi:duration>
            <espi:start>${billStart}</espi:start>
          </espi:itemPeriod>
        </espi:costAdditionalDetailLastPeriod>
      </espi:UsageSummary>
    </content>
  </entry>`;
  }

  /** Build the complete XML string */
  function buildXMLString(readings) {
    const days   = groupByDay(readings);
    const months = groupByMonth(readings);

    const intervalBlockEntries = [];
    for (const [, dayReadings] of days) {
      intervalBlockEntries.push(renderIntervalBlockEntry(dayReadings));
    }

    const summaryEntries = [];
    for (const [monthKey, monthReadings] of months) {
      summaryEntries.push(renderUsageSummaryEntry(monthKey, monthReadings));
    }

    const now = new Date().toISOString();

    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns:schemaLocation="http://naesb.org/copyright/espi.xsd" xmlns="http://www.w3.org/2005/Atom">
  <id>urn:uuid:synthetic-green-button-2024</id>
  <title>Energy Usage Feed (Synthetic Data)</title>
  <updated>${now}</updated>
  <entry>
    <id>urn:uuid:synth-local-time</id>
    <title>DST For North America</title>
    <content>
      <espi:LocalTimeParameters xmlns="http://naesb.org/espi" xmlns:espi="http://naesb.org/espi">
        <espi:dstEndRule>B40E2000</espi:dstEndRule>
        <espi:dstOffset>${DST_OFFSET}</espi:dstOffset>
        <espi:dstStartRule>360E2000</espi:dstStartRule>
        <espi:tzOffset>${TZ_OFFSET}</espi:tzOffset>
      </espi:LocalTimeParameters>
    </content>
  </entry>
  <entry>
    <id>urn:uuid:synth-usage-point</id>
    <title>Meter: Electricity Hourly Usage (Synthetic)</title>
    <content>
      <espi:UsagePoint xmlns="http://naesb.org/espi" xmlns:espi="http://naesb.org/espi">
        <espi:ServiceCategory>
          <espi:kind>0</espi:kind>
        </espi:ServiceCategory>
      </espi:UsagePoint>
    </content>
  </entry>
  <entry>
    <id>urn:uuid:synth-reading-type</id>
    <title>KWH Interval Data</title>
    <content>
      <espi:ReadingType xmlns="http://naesb.org/espi" xmlns:espi="http://naesb.org/espi">
        <espi:accumulationBehaviour>4</espi:accumulationBehaviour>
        <espi:commodity>1</espi:commodity>
        <espi:currency>124</espi:currency>
        <espi:dataQualifier>12</espi:dataQualifier>
        <espi:flowDirection>1</espi:flowDirection>
        <espi:intervalLength>3600</espi:intervalLength>
        <espi:kind>12</espi:kind>
        <espi:powerOfTenMultiplier>-3</espi:powerOfTenMultiplier>
        <espi:uom>72</espi:uom>
      </espi:ReadingType>
    </content>
  </entry>
${intervalBlockEntries.join('\n')}
${summaryEntries.join('\n')}
</feed>`;
  }

  /** Public entry point */
  function generateSyntheticGreenButtonXML() {
    _uidCounter = 1000; // reset for deterministic-ish output
    const readings = generateReadings();
    return buildXMLString(readings);
  }

  window.generateSyntheticGreenButtonXML = generateSyntheticGreenButtonXML;
}());
