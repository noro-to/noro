// Adapters and ingest: every fixture maps onto the standard schema, micros
// are converted, totals are skipped, unknown exports go through the guess
// path, and broken adapter files fail with clear errors.
//
// Fixture numbers come from fixtures/generate.ts; its header comment has the
// weekly totals these assertions check.

import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingest, readTable, MappingError, UnknownExportError, type GuessedMapping } from '../../src/ingest/index.js';
import { AdapterValidationError, detectAdapter, loadAdapterFile, loadAdapters } from '../../src/adapters/loader.js';
import { guessMapping, serializeAdapter } from '../../src/adapters/guess.js';
import { parseDate, parseNumber } from '../../src/ingest/values.js';
import type { Dataset, Row } from '../../src/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORTS = resolve(HERE, '../../fixtures/exports');
const fx = (name: string) => join(EXPORTS, name);

const tmp = mkdtempSync(join(tmpdir(), 'noro-adapters-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Sum a metric for one campaign over one week (prev = Sep 29–Oct 5, cur = Oct 6–12). */
function weekly(ds: Dataset, campaign: string, week: 'prev' | 'cur', metric: 'spend' | 'conversions' | 'clicks' | 'impressions' | 'conversionValue'): number {
  const rows = ds.rows.filter((r) => r.campaign === campaign && (week === 'prev' ? r.date! < '2026-10-06' : r.date! >= '2026-10-06'));
  return round2(rows.reduce((a, r) => a + r[metric], 0));
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const CAMPAIGNS = ['PR-03 Brand', 'PR-07 Prospecting', 'NB-11 Generic', 'DG-05 Demand Gen'];

/** Shape checks every mapped dataset must pass. */
function expectSchemaRows(rows: Row[]) {
  for (const r of rows) {
    expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.period).toBeUndefined();
    expect(CAMPAIGNS).toContain(r.campaign);
    expect(r.account).toBe('Acme Outdoor');
    for (const k of ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'] as const) {
      expect(typeof r[k]).toBe('number');
      expect(Number.isFinite(r[k])).toBe(true);
    }
  }
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  expect(dates).toHaveLength(14);
  expect(dates[0]).toBe('2026-09-29');
  expect(dates[13]).toBe('2026-10-12');
}

describe('Google Ads CSV (micros, preamble, totals)', () => {
  let ds: Dataset;
  beforeAll(async () => {
    ds = await ingest(fx('google-ads.csv'));
  });

  it('detects the adapter and maps 14 days × 4 campaigns', () => {
    expect(ds.adapter).toBe('google-ads');
    expect(ds.platform).toBe('Google Ads');
    expect(ds.currency).toBe('USD');
    expect(ds.rows).toHaveLength(56);
    expectSchemaRows(ds.rows);
  });

  it('skips the preamble and the two Total rows', () => {
    expect(ds.warnings).toContain('Header row found on line 3; skipped 2 preamble line(s) above it.');
    expect(ds.warnings).toContain('Skipped 2 total rows (lines 60, 61).');
    expect(ds.rows.some((r) => /total/i.test(r.campaign) || /total/i.test(r.date ?? ''))).toBe(false);
  });

  it('converts Cost (micros) to dollars', () => {
    expect(ds.mapping.spend).toBe('Cost (micros)');
    expect(ds.rows[0]).toMatchObject({ date: '2026-09-29', campaign: 'PR-03 Brand', spend: 300, impressions: 2000, clicks: 400 });
    expect(ds.rows[2]).toMatchObject({ campaign: 'NB-11 Generic', spend: 552.86 }); // raw 552860000
    expect(Math.max(...ds.rows.map((r) => r.spend))).toBeLessThan(10_000);
    expect(ds.warnings.some((w) => w.includes('"Cost (micros)" from micros'))).toBe(true);
  });

  it('maps primary Conversions, keeps All conv. under extra', () => {
    expect(ds.mapping.conversions).toBe('Conversions');
    expect(ds.mapping.extra?.allConversions).toBe('All conv.');
    expect(ds.rows[0].conversions).toBe(25);
    expect(ds.rows[0].extra.allConversions).toBe(32.5);
    expect(ds.rows[0].conversionValue).toBe(2000); // "2,000.00"
    expect(ds.rows[0].extra.campaignType).toBe('Search');
  });

  it('carries the fixture story: PR-07 CPA +38%, DG-05 small sample', () => {
    expect(weekly(ds, 'PR-07 Prospecting', 'prev', 'spend')).toBe(6000);
    expect(weekly(ds, 'PR-07 Prospecting', 'prev', 'conversions')).toBe(200);
    expect(weekly(ds, 'PR-07 Prospecting', 'cur', 'spend')).toBe(6210);
    expect(weekly(ds, 'PR-07 Prospecting', 'cur', 'conversions')).toBe(150);
    // CPA 30.00 → 41.40 = +38%.
    expect(round2(6210 / 150 / (6000 / 200) - 1)).toBe(0.38);
    expect(weekly(ds, 'PR-03 Brand', 'cur', 'spend')).toBe(2192.4);
    expect(weekly(ds, 'NB-11 Generic', 'cur', 'spend')).toBe(4365.9);
    expect(weekly(ds, 'DG-05 Demand Gen', 'prev', 'conversions')).toBe(12);
    expect(weekly(ds, 'DG-05 Demand Gen', 'cur', 'conversions')).toBe(14);
    expect(round2(ds.rows.reduce((a, r) => a + r.spend, 0))).toBe(27118.3); // matches the skipped Total row
  });
});

describe('Meta CSV (currency in header, summary row, blank zeros)', () => {
  let ds: Dataset;
  beforeAll(async () => {
    ds = await ingest(fx('meta.csv'));
  });

  it('maps to the schema', () => {
    expect(ds.adapter).toBe('meta');
    expect(ds.platform).toBe('Meta');
    expect(ds.rows).toHaveLength(56);
    expectSchemaRows(ds.rows);
    expect(ds.mapping).toMatchObject({
      date: 'Reporting starts',
      campaign: 'Campaign name',
      adGroup: 'Ad set name',
      spend: 'Amount spent (USD)',
      clicks: 'Link clicks',
      conversions: 'Purchases',
      conversionValue: 'Purchases conversion value',
    });
    expect(ds.rows[1]).toMatchObject({ campaign: 'PR-07 Prospecting', adGroup: 'PR-07 | US 25-54', spend: 768, impressions: 19200, conversions: 32 });
    expect(ds.rows[0].extra.reach).toBe(1429);
  });

  it('reads the currency from "Amount spent (USD)"', () => {
    expect(ds.currency).toBe('USD');
  });

  it('skips the summary row and reads blank purchases as 0', () => {
    expect(ds.warnings).toContain('Skipped 1 summary row (line 2).');
    expect(ds.warnings).toContain('Read 2 blank or placeholder values in "Purchases" as 0.');
    expect(ds.rows.filter((r) => r.campaign === 'DG-05 Demand Gen' && r.conversions === 0)).toHaveLength(2);
  });

  it('keeps the story at 0.8× spend', () => {
    expect(weekly(ds, 'PR-07 Prospecting', 'prev', 'spend')).toBe(4800);
    expect(weekly(ds, 'PR-07 Prospecting', 'cur', 'spend')).toBe(4968);
    expect(weekly(ds, 'PR-07 Prospecting', 'cur', 'conversions')).toBe(150);
  });
});

describe('Amazon DSP CSV (BOM, $ formatting, US dates)', () => {
  let ds: Dataset;
  beforeAll(async () => {
    ds = await ingest(fx('amazon-dsp.csv'));
  });

  it('maps to the schema', () => {
    expect(ds.adapter).toBe('amazon-dsp');
    expect(ds.rows).toHaveLength(56);
    expectSchemaRows(ds.rows);
    expect(ds.mapping.date).toBe('Date'); // not "﻿Date"
    expect(ds.mapping).toMatchObject({ account: 'Advertiser', campaign: 'Order', adGroup: 'Line item', spend: 'Total cost', clicks: 'Click-throughs' });
  });

  it('parses "$1,440.00", "19,200" and 09/29/2026', () => {
    expect(ds.rows[1]).toMatchObject({ date: '2026-09-29', campaign: 'PR-07 Prospecting', spend: 1440, impressions: 19200, conversionValue: 3040 });
    expect(ds.rows[1].extra.orderId).toBe('5811903347'); // IDs stay text
    expect(ds.rows[1].extra.totalRoas).toBe(2.11);
  });

  it('skips the Total row', () => {
    expect(ds.warnings).toContain('Skipped 1 total row (line 58).');
    expect(weekly(ds, 'PR-07 Prospecting', 'cur', 'spend')).toBe(9315);
  });
});

describe('XLSX path', () => {
  it('reads the first sheet, real date cells and plain Cost, and matches the CSV', async () => {
    const xlsx = await ingest(fx('google-ads.xlsx'));
    const csv = await ingest(fx('google-ads.csv'));
    expect(xlsx.adapter).toBe('google-ads');
    expect(xlsx.mapping.spend).toBe('Cost');
    expect(xlsx.warnings).toContain('Skipped 1 total row (line 60).');
    expect(xlsx.warnings.some((w) => w.includes('micros'))).toBe(false);
    expect(xlsx.rows).toEqual(csv.rows);
  });
});

describe('unknown export → guess path', () => {
  const file = fx('unknown-platform.csv');

  it('throws UnknownExportError carrying a sensible guess', async () => {
    const err = await ingest(file).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownExportError);
    const guess = (err as UnknownExportError).guess;
    expect(guess.mapping).toEqual({
      date: 'Date',
      account: 'Advertiser name',
      campaign: 'Campaign name',
      adGroup: 'Ad group name',
      spend: 'Cost',
      impressions: 'Impressions',
      clicks: 'Clicks (destination)',
      conversions: 'Conversions',
      conversionValue: 'Total purchase value',
      extra: { currency: 'Currency' },
    });
    expect(guess.unmapped).toEqual(['CTR']); // a ratio column is never mapped
    for (const c of Object.values(guess.confidence)) expect(c).toBeGreaterThanOrEqual(0.8);
    expect((err as Error).message).toContain('unknown-platform.csv');
  });

  it('succeeds when confirmMapping returns the guess', async () => {
    let seen: GuessedMapping | undefined;
    const ds = await ingest(file, { confirmMapping: async (g) => ((seen = g), g.mapping) });
    expect(seen?.headers).toContain('Clicks (destination)');
    expect(ds.adapter).toBe('guessed');
    expect(ds.currency).toBe('USD');
    expect(ds.rows).toHaveLength(56);
    expectSchemaRows(ds.rows);
    expect(ds.rows[1]).toMatchObject({ campaign: 'PR-07 Prospecting', spend: 480, clicks: 576, conversions: 32, conversionValue: 3040 });
    expect(weekly(ds, 'PR-07 Prospecting', 'cur', 'spend')).toBe(3105);
  });

  it('aborts with UnknownExportError when confirmMapping returns null', async () => {
    await expect(ingest(file, { confirmMapping: async () => null })).rejects.toBeInstanceOf(UnknownExportError);
  });

  it('rejects a confirmed mapping that misses a required field or names a missing header', async () => {
    await expect(
      ingest(file, { confirmMapping: async (g) => ({ ...g.mapping, spend: undefined }) }),
    ).rejects.toThrow(/missing required fields: spend/);
    await expect(
      ingest(file, { confirmMapping: async (g) => ({ ...g.mapping, spend: 'Spend' }) }),
    ).rejects.toBeInstanceOf(MappingError);
  });

  it('saves the confirmed mapping as an adapter that recognises the export next time', async () => {
    const dir = join(tmp, 'saved');
    const target = join(dir, 'tiktok.yaml');
    const ds = await ingest(file, { confirmMapping: async (g) => g.mapping, saveAdapterAs: target });
    expect(ds.warnings.some((w) => w.includes(target))).toBe(true);
    expect(existsSync(target)).toBe(true);
    const saved = loadAdapterFile(target);
    expect(saved.id).toBe('tiktok');
    expect(saved.columns.clicks).toEqual(['Clicks (destination)']);
    const again = await ingest(file, { adaptersDir: dir });
    expect(again.adapter).toBe('tiktok');
    expect(again.rows).toEqual(ds.rows.map((r) => ({ ...r, platform: 'tiktok' })));
  });
});

describe('detection', () => {
  const adapters = loadAdapters();

  it('loads the three built-in adapters', () => {
    expect(adapters.map((a) => a.id)).toEqual(['amazon-dsp', 'google-ads', 'meta']);
  });

  it('picks the right adapter from each header row, and none for the unknown export', async () => {
    const header = async (f: string, line = 0) => (await readTable(fx(f)))[line];
    expect(detectAdapter(await header('google-ads.csv', 2), adapters)?.adapter.id).toBe('google-ads');
    expect(detectAdapter(await header('meta.csv'), adapters)?.adapter.id).toBe('meta');
    expect(detectAdapter(await header('amazon-dsp.csv'), adapters)?.adapter.id).toBe('amazon-dsp');
    expect(detectAdapter(await header('unknown-platform.csv'), adapters)).toBeNull();
    expect(detectAdapter(['Campaign report'], adapters)).toBeNull(); // a preamble line
  });

  it('is deterministic: equal scores go to the id that sorts first', () => {
    const dir = mkdtempSync(join(tmp, 'tie-'));
    const yaml = (id: string) =>
      `id: ${id}\nplatform: X\ndetect:\n  required: [Day, Campaign]\ncolumns:\n  date: Day\n  campaign: Campaign\n  spend: Cost\n  impressions: Impr.\n  clicks: Clicks\n  conversions: Conversions\n`;
    writeFileSync(join(dir, 'a.yaml'), yaml('zeta'));
    writeFileSync(join(dir, 'b.yaml'), yaml('alpha'));
    const headers = ['Day', 'Campaign', 'Cost', 'Impr.', 'Clicks', 'Conversions'];
    const list = loadAdapters(dir);
    expect(detectAdapter(headers, list)?.adapter.id).toBe('alpha');
    expect(detectAdapter(headers, [...list].reverse())?.adapter.id).toBe('alpha');
  });
});

describe('adapter validation errors', () => {
  const write = (name: string, body: string) => {
    const f = join(tmp, name);
    writeFileSync(f, body);
    return f;
  };

  it('names the file and every bad field', () => {
    const f = write(
      'broken.yaml',
      'id: Google Ads\nplatform: Google Ads\ndetect:\n  required: [Campaign]\ncolumns:\n  campaign: Campaign\n  cost: Cost\n  impressions: 3\nsurprise: true\n',
    );
    let err: unknown;
    try {
      loadAdapterFile(f);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AdapterValidationError);
    const msg = (err as Error).message;
    expect(msg).toContain(f);
    expect(msg).toContain('field "id" must be a lowercase slug');
    expect(msg).toContain('field "columns.cost" is not a schema field');
    expect(msg).toContain('field "columns.impressions" must be a header name');
    expect(msg).toContain('field "columns.spend" is required');
    expect(msg).toContain('field "columns.date" or "columns.period" is required');
    expect(msg).toContain('unknown field "surprise"');
  });

  it('reports YAML syntax errors with the file name', () => {
    const f = write('syntax.yaml', 'id: [unclosed\n');
    expect(() => loadAdapterFile(f)).toThrow(new RegExp(`Invalid adapter ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\n  - not valid YAML`));
  });

  it('rejects bad skip rules and duplicate ids', () => {
    const f = write(
      'skip.yaml',
      'id: x\nplatform: X\ndetect: {required: [Day]}\ncolumns: {date: Day, campaign: C, spend: S, impressions: I, clicks: K, conversions: V}\nskipRows:\n  - {firstColumn: true, field: campaign, match: "^Total"}\n  - {any: true, match: "(["}\n',
    );
    expect(() => loadAdapterFile(f)).toThrow(/skipRows\[0\]" needs exactly one of field, column, firstColumn, any/);
    expect(() => loadAdapterFile(f)).toThrow(/skipRows\[1\]\.match" is not a valid regular expression/);

    const dir = mkdtempSync(join(tmp, 'dup-'));
    const ok = readFileSync(resolve(HERE, '../../src/adapters/meta.yaml'), 'utf8');
    writeFileSync(join(dir, 'one.yaml'), ok);
    writeFileSync(join(dir, 'two.yaml'), ok);
    expect(() => loadAdapters(dir)).toThrow(/id "meta" is already used by/);
  });

  it('accepts what serializeAdapter writes', () => {
    const guess = guessMapping(['Day', 'Campaign', 'Spend', 'Impressions', 'Clicks', 'Conversions'], [['2026-10-01', 'A', '1.00', '10', '1', '0']]);
    const f = write('roundtrip.yaml', serializeAdapter(guess.mapping, { id: 'roundtrip' }));
    expect(loadAdapterFile(f).columns.spend).toEqual(['Spend']);
  });
});

describe('format edge cases', () => {
  it('parses platform number formats', () => {
    expect(parseNumber('$1,234.56').value).toBe(1234.56);
    expect(parseNumber('"1,234"'.slice(1, -1)).value).toBe(1234);
    expect(parseNumber('--')).toEqual({ kind: 'zero', value: 0 });
    expect(parseNumber('')).toEqual({ kind: 'zero', value: 0 });
    expect(parseNumber('(45.00)').value).toBe(-45);
    expect(parseNumber('12.5%').value).toBe(12.5);
    expect(parseNumber('USD 3.20').value).toBe(3.2);
    expect(parseNumber('€1.234,56', { thousands: '.', decimal: ',', zero: [''] }).value).toBe(1234.56);
    expect(parseNumber('n/a', { thousands: ',', decimal: '.', zero: [] }).kind).toBe('invalid');
  });

  it('parses platform date formats', () => {
    expect(parseDate('2026-09-29')).toBe('2026-09-29');
    expect(parseDate('09/29/2026')).toBe('2026-09-29');
    expect(parseDate('29/09/2026')).toBe('2026-09-29'); // first part > 12 → day first
    expect(parseDate('03/04/2026', 'dmy')).toBe('2026-04-03');
    expect(parseDate('Sep 29, 2026')).toBe('2026-09-29');
    expect(parseDate('Tuesday, September 29, 2026')).toBe('2026-09-29');
    expect(parseDate('29 Sep 2026')).toBe('2026-09-29');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('Total: Account')).toBeNull();
  });

  it('reads a UTF-16 tab-separated Google Ads export (the "CSV for Excel" download)', async () => {
    const text = [
      'Campaign report',
      'October 6, 2026 - October 7, 2026',
      'Day\tCampaign\tCost\tImpr.\tClicks\tConversions\tCurrency code',
      '2026-10-06\tPR-03 Brand\t310.20\t2,050\t410\t26.00\tEUR',
      '2026-10-07\tPR-03 Brand\t305.00\t1,990\t398\t25.00\tEUR',
      'Total: Account\t--\t615.20\t4,040\t808\t51.00\tEUR',
    ].join('\r\n');
    const f = join(tmp, 'utf16.csv');
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    const ds = await ingest(f);
    expect(ds.adapter).toBe('google-ads');
    expect(ds.currency).toBe('EUR');
    expect(ds.rows).toHaveLength(2);
    expect(ds.rows[0]).toMatchObject({ date: '2026-10-06', spend: 310.2, impressions: 2050, account: '(not in export)' });
    expect(ds.warnings).toContain('No conversion value column in this export; conversionValue is 0 on every row.');
  });

  it('warns when a plain cost column looks like micros', async () => {
    const f = join(tmp, 'looks-like-micros.csv');
    writeFileSync(
      f,
      'Day,Campaign,Cost,Impr.,Clicks,Conversions\n2026-10-06,PR-03 Brand,310200000,2050,410,26\n2026-10-07,PR-03 Brand,305000000,1990,398,25\n',
    );
    const ds = await ingest(f);
    expect(ds.rows[0].spend).toBe(310200000); // not silently changed
    expect(ds.warnings.some((w) => w.includes('looks like micros'))).toBe(true);
  });

  it('turns a Meta row whose start and end differ into a period', async () => {
    const f = join(tmp, 'meta-weekly.csv');
    writeFileSync(
      f,
      'Reporting starts,Reporting ends,Account name,Campaign name,Amount spent (EUR),Impressions,Link clicks,Purchases\n2026-09-29,2026-10-05,Acme Outdoor,PR-03 Brand,1680.00,14000,2800,175\n',
    );
    const ds = await ingest(f);
    expect(ds.currency).toBe('EUR');
    expect(ds.rows[0].date).toBeUndefined();
    expect(ds.rows[0].period).toBe('2026-09-29/2026-10-05');
  });
});
