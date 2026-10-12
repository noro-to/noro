// Guess a column mapping for an export no adapter recognises.
//
// Two signals: header names (synonym lists per schema field) and values
// (do the first rows look like dates, money, whole numbers, text?). The guess
// is only a proposal: ingest shows it to the user (opts.confirmMapping) and
// uses whatever mapping they confirm. A confirmed mapping can be saved as a
// new adapter YAML with serializeAdapter / saveAdapter.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import type { ColumnMapping, SchemaField } from '../schema.js';
import { parseDate, parseNumber } from '../ingest/values.js';
import { SCHEMA_FIELDS, USER_ADAPTERS_DIR } from './loader.js';

/** A proposed mapping for an unknown export. Re-exported by src/ingest. */
export interface GuessedMapping {
  /** The header row as found in the file. */
  headers: string[];
  mapping: ColumnMapping;
  /** 0..1 per mapped schema field. Below about 0.6 deserves a second look. */
  confidence: Partial<Record<SchemaField, number>>;
  /** Headers not used by the mapping (blank headers left out). */
  unmapped: string[];
}

/**
 * Synonyms per field, compared against normalised headers (lowercase, words
 * only). Longer synonyms are tried first so "conversion value" beats
 * "conversion" for a header like "Conversion value".
 */
const SYNONYMS: Record<SchemaField, string[]> = {
  date: ['date', 'day', 'reporting starts', 'start date', 'report date', 'by day', 'stat time day', 'date utc', 'segments date'],
  period: ['week', 'month', 'period', 'quarter', 'reporting period'],
  account: ['account', 'account name', 'advertiser', 'advertiser name', 'customer', 'customer name', 'ad account', 'profile'],
  campaign: ['campaign', 'campaign name', 'order', 'order name', 'insertion order'],
  adGroup: ['ad group', 'ad group name', 'adgroup', 'ad set', 'ad set name', 'line item', 'line item name', 'ad squad', 'ad squad name'],
  spend: ['cost', 'spend', 'amount spent', 'total cost', 'total spent', 'total spend', 'media cost', 'spent', 'amount', 'cost micros'],
  impressions: ['impressions', 'impr', 'impression', 'imps', 'paid impressions'],
  clicks: ['clicks', 'link clicks', 'click throughs', 'clicks destination', 'clicks all', 'swipes', 'swipe ups'],
  conversions: ['conversions', 'conv', 'results', 'purchases', 'total purchases', 'orders', 'conversion', 'leads', 'complete payment', 'total conversions'],
  conversionValue: [
    'conversion value', 'conv value', 'conversions value', 'revenue', 'sales', 'total sales', 'purchase value',
    'purchases conversion value', 'total purchase value', 'purchases value', 'total revenue', 'value',
  ],
};

/** Words that mark a derived ratio column ("Cost per conversion", "Conv. rate", "CTR"). Never mapped to a schema field. */
const RATIO_WORDS = /\b(per|rate|ctr|cpc|cpm|cpa|cpv|roas|avg|average|share|frequency|percent|pct)\b|%/i;

const TEXT_FIELDS: SchemaField[] = ['account', 'campaign', 'adGroup', 'period'];
const NUMBER_FIELDS: SchemaField[] = ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'];

/** Lowercase, drop punctuation, collapse spaces: "Impr." → "impr", "Click-throughs" → "click throughs". */
function words(h: string): string {
  return h
    .toLowerCase()
    .replace(/\([^)]*\)/g, (m) => (/micros/.test(m) ? ' micros ' : ' ')) // "(USD)" is noise, "(micros)" is not
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface ColumnProfile {
  dates: number; // share of non-blank sample values that parse as dates
  numbers: number; // share that parse as numbers
  integers: number; // share that are whole numbers
  money: number; // share with a currency symbol or two decimals
  mean: number; // mean of numeric values
  filled: number; // non-blank sample values
}

function profile(values: string[]): ColumnProfile {
  const filled = values.map((v) => String(v ?? '').trim()).filter((v) => v !== '' && v !== '--');
  const n = filled.length || 1;
  let dates = 0;
  let numbers = 0;
  let integers = 0;
  let money = 0;
  let sum = 0;
  for (const v of filled) {
    if (parseDate(v)) dates++;
    const p = parseNumber(v);
    if (p.kind === 'number' && !/%$/.test(v) && !parseDate(v)) {
      numbers++;
      sum += p.value;
      if (Number.isInteger(p.value) && !/[.]\d/.test(v)) integers++;
      if (/[$€£¥]/.test(v) || /\.\d{2}$/.test(v)) money++;
    }
  }
  return { dates: dates / n, numbers: numbers / n, integers: integers / n, money: money / n, mean: numbers ? sum / numbers : 0, filled: filled.length };
}

/**
 * Guess a ColumnMapping from a header row and a few sample data rows.
 * Deterministic: the same input always gives the same guess.
 */
export function guessMapping(headers: string[], sampleRows: string[][]): GuessedMapping {
  const profiles = headers.map((_, i) => profile(sampleRows.map((r) => r[i] ?? '')));
  const candidates: { field: SchemaField; col: number; conf: number }[] = [];

  headers.forEach((header, col) => {
    const w = words(header);
    if (!w) return;
    const p = profiles[col];
    const ratio = RATIO_WORDS.test(header);
    for (const field of SCHEMA_FIELDS) {
      if (ratio && field !== 'date' && field !== 'period') continue;
      let conf = 0;
      const syns = [...SYNONYMS[field]].sort((a, b) => b.length - a.length);
      for (const syn of syns) {
        if (w === syn) conf = Math.max(conf, 0.9);
        else if (new RegExp(`(^| )${syn}( |$)`).test(w)) conf = Math.max(conf, 0.55 + Math.min(syn.length, 20) / 100);
      }
      if (conf === 0) continue;
      // Value sniffing: confirm or demote the header guess.
      if (p.filled > 0) {
        if (field === 'date') conf += p.dates >= 0.8 ? 0.08 : -0.5;
        else if (NUMBER_FIELDS.includes(field)) conf += p.numbers >= 0.8 ? 0.05 : -0.5;
        else if (TEXT_FIELDS.includes(field)) conf += p.numbers < 0.5 && p.dates < 0.5 ? 0.05 : -0.4;
        if (field === 'spend' && p.money >= 0.5) conf += 0.03;
        if ((field === 'impressions' || field === 'clicks') && p.integers < 0.8) conf -= 0.2;
      }
      if (conf > 0.2) candidates.push({ field, col, conf: Math.min(0.99, round2(conf)) });
    }
  });

  // Values-only fallbacks for fields no header named: a date column.
  headers.forEach((h, col) => {
    const p = profiles[col];
    if (h.trim() && p.filled > 0 && p.dates >= 0.9) candidates.push({ field: 'date', col, conf: 0.5 });
  });

  // Greedy assignment: best confidence first; ties by field order, then column order.
  candidates.sort(
    (a, b) => b.conf - a.conf || SCHEMA_FIELDS.indexOf(a.field) - SCHEMA_FIELDS.indexOf(b.field) || a.col - b.col,
  );
  const chosen: Partial<Record<SchemaField, { col: number; conf: number }>> = {};
  const usedCols = new Set<number>();
  for (const c of candidates) {
    if (chosen[c.field] !== undefined || usedCols.has(c.col)) continue;
    if (c.field === 'period' && chosen.date) continue; // a daily export doesn't need a period
    if (c.field === 'date' && chosen.period) continue;
    chosen[c.field] = { col: c.col, conf: c.conf };
    usedCols.add(c.col);
  }
  // Emit in schema order so the guess reads the same way every time.
  const mapping: ColumnMapping = {};
  const confidence: Partial<Record<SchemaField, number>> = {};
  for (const f of SCHEMA_FIELDS) {
    const c = chosen[f];
    if (!c) continue;
    mapping[f] = headers[c.col];
    confidence[f] = c.conf;
  }

  // A currency column is useful but isn't a schema field: keep it under extra.
  const currencyCol = headers.findIndex((h, i) => !usedCols.has(i) && /^(currency|currency code)$/.test(words(h)));
  if (currencyCol >= 0) {
    mapping.extra = { currency: headers[currencyCol] };
    usedCols.add(currencyCol);
  }

  const unmapped = headers.filter((h, i) => !usedCols.has(i) && h.trim() !== '');
  return { headers, mapping, confidence, unmapped };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------- saving as an adapter

/**
 * Serialise a confirmed mapping as adapter YAML that loader.ts accepts. The
 * signature requires every mapped header, so the adapter only matches exports
 * with the same columns.
 */
export function serializeAdapter(mapping: ColumnMapping, opts: { id: string; platform?: string; source?: string }): string {
  const columns: Record<string, string[]> = {};
  for (const f of SCHEMA_FIELDS) if (mapping[f]) columns[f] = [mapping[f] as string];
  const extra: Record<string, string[]> = {};
  for (const [k, h] of Object.entries(mapping.extra ?? {})) extra[k] = [h];
  const required = SCHEMA_FIELDS.map((f) => mapping[f]).filter((h): h is string => !!h);
  const currencyCol = mapping.extra?.currency ?? mapping.extra?.currencyCode;

  const doc: Record<string, unknown> = {
    id: opts.id,
    platform: opts.platform ?? opts.id,
    detect: { required, distinctive: [] },
    columns,
    ...(Object.keys(extra).length ? { extra } : {}),
    micros: [],
    currency: { ...(currencyCol ? { column: [currencyCol] } : {}), fromHeader: true, default: 'USD' },
    numbers: { thousands: ',', decimal: '.', zero: ['', '--', '-', 'N/A'] },
    dates: { order: 'mdy' },
    skipRows: [{ firstColumn: true, match: '^\\s*Total\\b', reason: 'total row' }],
  };
  const header =
    `# Adapter saved by noro from a confirmed column mapping${opts.source ? ` (first seen in ${basename(opts.source)})` : ''}.\n` +
    '# Review it, then copy it into src/adapters/ and open a PR if the platform is useful to others.\n';
  return header + toYaml(doc);
}

/**
 * Where `saveAdapterAs` writes. A value ending in .yaml/.yml is a file path
 * (relative to cwd); anything else is an adapter id saved as
 * .noro/adapters/<id>.yaml under cwd. ingest loads that directory by default,
 * so the next run of the same export is recognised without asking.
 */
export function adapterSaveTarget(saveAs: string, cwd: string = process.cwd()): { id: string; file: string } {
  if (/\.ya?ml$/i.test(saveAs)) {
    const file = resolve(cwd, saveAs);
    return { id: slug(basename(file, extname(file))), file };
  }
  const id = slug(saveAs);
  return { id, file: resolve(cwd, USER_ADAPTERS_DIR, `${id}.yaml`) };
}

/** Write a confirmed mapping as adapter YAML. Returns the file written. */
export function saveAdapter(mapping: ColumnMapping, saveAs: string, opts: { platform?: string; source?: string; cwd?: string } = {}): string {
  const { id, file } = adapterSaveTarget(saveAs, opts.cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeAdapter(mapping, { id, platform: opts.platform, source: opts.source }));
  return file;
}

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'custom';
}
