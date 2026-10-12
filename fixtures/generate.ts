// Generates the synthetic exports in fixtures/exports/. All names and numbers
// are invented. Run from the repo root:
//
//   npx tsx fixtures/generate.ts
//
// THE STORY (weekly totals; previous week = Sep 29–Oct 5 2026, current week =
// Oct 6–12 2026). Every file tells the same story; only spend is scaled per
// platform (Google Ads ×1, Meta ×0.8, Amazon DSP ×1.5, unknown ×0.5), so CPA
// changes are identical across platforms. Google Ads values:
//
//   campaign            spend prev → current    conv prev → cur   CPA prev → cur
//   PR-03 Brand         2,100.00 → 2,192.40     175 → 180         12.00 → 12.18  (+1.5%, stable)
//   PR-07 Prospecting   6,000.00 → 6,210.00     200 → 150         30.00 → 41.40  (+38.0%, the story)
//   NB-11 Generic       4,500.00 → 4,365.90     100 → 99          45.00 → 44.10  (−2.0%, stable)
//   DG-05 Demand Gen      840.00 →   910.00      12 → 14          70.00 → 65.00  (small sample: < 30 conv)
//
// Account (Google Ads): spend 13,440.00 → 13,678.30, conversions 487 → 443,
// CPA 27.60 → 30.88. Conversion value per conversion is fixed per campaign
// (80, 95, 120, 150), so value = conversions × that.
//
// Daily rows are spread over the 7 days with fixed weights and
// largest-remainder rounding, so daily rows sum exactly to the weekly totals.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'exports');
const ACCOUNT = 'Acme Outdoor';

interface Week {
  spend: number; // major units
  impressions: number;
  clicks: number;
  conversions: number;
}
interface Campaign {
  name: string;
  type: string;
  valuePerConv: number;
  weights: number[];
  prev: Week;
  cur: Week;
}

const BASE = [1.0, 1.08, 1.12, 1.02, 0.86, 0.8, 1.12];
const rotate = (a: number[], n: number) => [...a.slice(n), ...a.slice(0, n)];

const CAMPAIGNS: Campaign[] = [
  {
    name: 'PR-03 Brand', type: 'Search', valuePerConv: 80, weights: BASE,
    prev: { spend: 2100.0, impressions: 14000, clicks: 2800, conversions: 175 },
    cur: { spend: 2192.4, impressions: 14350, clicks: 2870, conversions: 180 },
  },
  {
    name: 'PR-07 Prospecting', type: 'Performance Max', valuePerConv: 95, weights: rotate(BASE, 2),
    prev: { spend: 6000.0, impressions: 120000, clicks: 3600, conversions: 200 },
    cur: { spend: 6210.0, impressions: 125000, clicks: 3750, conversions: 150 },
  },
  {
    name: 'NB-11 Generic', type: 'Search', valuePerConv: 120, weights: rotate(BASE, 4),
    prev: { spend: 4500.0, impressions: 60000, clicks: 2400, conversions: 100 },
    cur: { spend: 4365.9, impressions: 59000, clicks: 2380, conversions: 99 },
  },
  {
    name: 'DG-05 Demand Gen', type: 'Demand Gen', valuePerConv: 150, weights: [0.4, 2.0, 0.3, 1.8, 0.5, 1.6, 0.4],
    prev: { spend: 840.0, impressions: 45000, clicks: 600, conversions: 12 },
    cur: { spend: 910.0, impressions: 47000, clicks: 640, conversions: 14 },
  },
];

/** 14 consecutive days starting Tue Sep 29 2026. */
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 29 + i)).toISOString().slice(0, 10));

/** Split an integer total over weights with largest-remainder rounding (ties → earlier day). */
function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i]++;
  return out;
}

interface DailyRow {
  date: string;
  campaign: Campaign;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number; // whole currency units
}

/** Daily rows for one platform, spend scaled by `scale` (kept to whole cents). */
function dailyRows(scale: number): DailyRow[] {
  const rows: DailyRow[] = [];
  for (const [w, week] of (['prev', 'cur'] as const).entries()) {
    const perCampaign = CAMPAIGNS.map((c) => {
      const t = c[week];
      return {
        c,
        spend: split(Math.round(t.spend * scale * 100), c.weights),
        impr: split(t.impressions, c.weights),
        clicks: split(t.clicks, c.weights),
        conv: split(t.conversions, c.weights),
      };
    });
    for (let d = 0; d < 7; d++) {
      for (const p of perCampaign) {
        rows.push({
          date: DAYS[w * 7 + d],
          campaign: p.c,
          spendCents: p.spend[d],
          impressions: p.impr[d],
          clicks: p.clicks[d],
          conversions: p.conv[d],
          value: p.conv[d] * p.c.valuePerConv,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------- formatting

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells: (string | number)[]) => cells.map(csvCell).join(',');
const money = (cents: number) => (cents / 100).toFixed(2);
const grouped = (n: number, decimals = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const allConv = (conv: number) => Math.round(conv * 1.3 * 100) / 100;

// ------------------------------------------------------------------ writers

/** Google Ads UI-style CSV, cost in micros, preamble and total rows. */
function googleAdsCsv(): string {
  const rows = dailyRows(1);
  const lines = [
    'Campaign report',
    csvLine(['September 29, 2026 - October 12, 2026']),
    csvLine(['Day', 'Account name', 'Campaign', 'Campaign type', 'Currency code', 'Cost (micros)', 'Impr.', 'Clicks', 'Conversions', 'All conv.', 'Conv. value']),
  ];
  for (const r of rows) {
    lines.push(
      csvLine([
        r.date, ACCOUNT, r.campaign.name, r.campaign.type, 'USD',
        r.spendCents * 10_000, // cents → micros
        grouped(r.impressions), grouped(r.clicks), r.conversions.toFixed(2), allConv(r.conversions).toFixed(2), grouped(r.value, 2),
      ]),
    );
  }
  const total = (label: string) =>
    csvLine([
      label, '--', '--', '--', 'USD', sum(rows, (r) => r.spendCents) * 10_000,
      grouped(sum(rows, (r) => r.impressions)), grouped(sum(rows, (r) => r.clicks)), sum(rows, (r) => r.conversions).toFixed(2),
      sum(rows, (r) => allConv(r.conversions)).toFixed(2), grouped(sum(rows, (r) => r.value), 2),
    ]);
  lines.push(total('Total: Campaigns'), total('Total: Account'));
  return lines.join('\n') + '\n';
}

/** Meta Ads Manager CSV: summary row first, blanks for zero purchases. */
function metaCsv(): string {
  const rows = dailyRows(0.8);
  const adSet = (c: Campaign) => `${c.name.slice(0, 5)} | US 25-54`;
  const reach = (impr: number) => Math.round(impr / 1.4);
  const blank0 = (n: number, s: string) => (n === 0 ? '' : s);
  const lines = [
    csvLine(['Reporting starts', 'Reporting ends', 'Account name', 'Campaign name', 'Ad set name', 'Amount spent (USD)', 'Impressions', 'Reach', 'Link clicks', 'Purchases', 'Purchases conversion value']),
    csvLine([
      DAYS[0], DAYS[13], '', '', '', money(sum(rows, (r) => r.spendCents)), sum(rows, (r) => r.impressions), '',
      sum(rows, (r) => r.clicks), sum(rows, (r) => r.conversions), sum(rows, (r) => r.value).toFixed(2),
    ]),
  ];
  for (const r of rows) {
    lines.push(
      csvLine([
        r.date, r.date, ACCOUNT, r.campaign.name, adSet(r.campaign), money(r.spendCents), r.impressions, reach(r.impressions),
        r.clicks, blank0(r.conversions, String(r.conversions)), blank0(r.value, r.value.toFixed(2)),
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

/** Amazon DSP CSV: UTF-8 BOM, US dates, "$1,234.56" money, a Total row. */
function amazonDspCsv(): string {
  const rows = dailyRows(1.5);
  const ids = new Map(CAMPAIGNS.map((c, i) => [c.name, { order: `58${i}1903347`, line: `77${i}4410921` }]));
  const usd = (cents: number) => `$${grouped(cents / 100, 2)}`;
  const roas = (value: number, cents: number) => (cents ? (value / (cents / 100)).toFixed(2) : '0.00');
  const lines = [
    csvLine(['Date', 'Advertiser', 'Order', 'Order ID', 'Line item', 'Line item ID', 'Total cost', 'Impressions', 'Click-throughs', 'Total purchases', 'Total sales', 'Total ROAS']),
  ];
  for (const r of rows) {
    const id = ids.get(r.campaign.name)!;
    lines.push(
      csvLine([
        usDate(r.date), ACCOUNT, r.campaign.name, id.order, `${r.campaign.name} - Audience`, id.line, usd(r.spendCents),
        grouped(r.impressions), r.clicks, r.conversions, usd(r.value * 100), roas(r.value, r.spendCents),
      ]),
    );
  }
  const cents = sum(rows, (r) => r.spendCents);
  const value = sum(rows, (r) => r.value);
  lines.push(
    csvLine(['Total', '', '', '', '', '', usd(cents), grouped(sum(rows, (r) => r.impressions)), sum(rows, (r) => r.clicks), sum(rows, (r) => r.conversions), usd(value * 100), roas(value, cents)]),
  );
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** An export from a platform with no adapter (TikTok-ish headers), so the guess path runs. */
function unknownCsv(): string {
  const rows = dailyRows(0.5);
  const lines = [
    csvLine(['Date', 'Advertiser name', 'Campaign name', 'Ad group name', 'Cost', 'Impressions', 'Clicks (destination)', 'CTR', 'Conversions', 'Total purchase value', 'Currency']),
  ];
  for (const r of rows) {
    lines.push(
      csvLine([
        r.date, ACCOUNT, r.campaign.name, `${r.campaign.name.slice(0, 5)} - All placements`, money(r.spendCents), r.impressions, r.clicks,
        `${((r.clicks / r.impressions) * 100).toFixed(2)}%`, r.conversions, r.value.toFixed(2), 'USD',
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

/** The Google Ads data as an XLSX workbook: "Cost" in major units, real date cells, preamble and total row. */
async function googleAdsXlsx(file: string): Promise<void> {
  const rows = dailyRows(1);
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(Date.UTC(2026, 9, 12));
  wb.modified = wb.created;
  const ws = wb.addWorksheet('Campaign report');
  ws.addRow(['Campaign report']);
  ws.addRow(['September 29, 2026 - October 12, 2026']);
  ws.addRow(['Day', 'Account name', 'Campaign', 'Campaign type', 'Currency code', 'Cost', 'Impr.', 'Clicks', 'Conversions', 'All conv.', 'Conv. value']);
  for (const r of rows) {
    const row = ws.addRow([
      new Date(`${r.date}T00:00:00Z`), ACCOUNT, r.campaign.name, r.campaign.type, 'USD', r.spendCents / 100, r.impressions, r.clicks,
      r.conversions, allConv(r.conversions), r.value,
    ]);
    row.getCell(1).numFmt = 'yyyy-mm-dd';
    row.getCell(6).numFmt = '#,##0.00';
  }
  ws.addRow([
    'Total: Account', '--', '--', '--', 'USD', sum(rows, (r) => r.spendCents) / 100, sum(rows, (r) => r.impressions), sum(rows, (r) => r.clicks),
    sum(rows, (r) => r.conversions), sum(rows, (r) => allConv(r.conversions)), sum(rows, (r) => r.value),
  ]);
  await wb.xlsx.writeFile(file);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'google-ads.csv'), googleAdsCsv());
writeFileSync(join(OUT, 'meta.csv'), metaCsv());
writeFileSync(join(OUT, 'amazon-dsp.csv'), amazonDspCsv());
writeFileSync(join(OUT, 'unknown-platform.csv'), unknownCsv());
await googleAdsXlsx(join(OUT, 'google-ads.xlsx'));
console.log(`Wrote 5 fixtures to ${OUT}`);
