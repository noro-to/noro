// Step 1 of the pipeline: read a raw ad-platform export (CSV or XLSX) and map
// it onto the standard schema (src/schema.ts, docs/schema.md).
//
//   file → table of cells → header row + adapter → Row[] → Dataset
//
// Ingest converts units (micros → major currency units) and number formats
// ("$1,234.56", "--") but computes nothing: sums, ratios and comparisons are
// src/compute's job.

import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import type { ColumnMapping, Dataset, Row, SchemaField } from '../schema.js';
import {
  type Adapter,
  type SkipRule,
  NUMERIC_FIELDS,
  USER_ADAPTERS_DIR,
  adapterFromMapping,
  builtinAdaptersDir,
  detectAdapter,
  findHeader,
  headerMatches,
  loadAdapters,
  missingFields,
} from '../adapters/loader.js';
import { type GuessedMapping, guessMapping, saveAdapter } from '../adapters/guess.js';
import { excelSerialToIso, parseDate, parseNumber } from './values.js';

export type { GuessedMapping } from '../adapters/guess.js';

export interface IngestOptions {
  /**
   * Directory of adapter YAML files. When set it replaces the default search
   * path, which is the built-in src/adapters/ plus ./.noro/adapters/ (where
   * saveAdapterAs writes) under the working directory. A list searches each
   * directory in order (a later adapter id may not repeat an earlier one).
   */
  adaptersDir?: string | string[];
  /**
   * Called when no adapter matches. Show the guess to the user and return the
   * mapping they confirm (possibly edited), or null to abort.
   */
  confirmMapping?: (g: GuessedMapping) => Promise<ColumnMapping | null>;
  /**
   * After a confirmed guess, save the mapping as a new adapter. An id like
   * "tiktok" writes ./.noro/adapters/tiktok.yaml; a path ending in .yaml is
   * written as given (relative to the working directory).
   */
  saveAdapterAs?: string;
}

/** No adapter recognised the export. `guess` holds the proposed mapping. */
export class UnknownExportError extends Error {
  constructor(
    readonly file: string,
    readonly guess: GuessedMapping,
    reason = 'no adapter matches its header row',
  ) {
    const lines = Object.entries(guess.mapping)
      .filter(([k]) => k !== 'extra')
      .map(([field, header]) => `  ${field} ← "${header}" (confidence ${guess.confidence[field as SchemaField] ?? '?'})`);
    const missing = missingFields(guess.mapping);
    super(
      `Unknown export ${file}: ${reason}.\nGuessed mapping:\n${lines.join('\n') || '  (nothing)'}` +
        (missing.length ? `\nNot found: ${missing.join(', ')}` : '') +
        (guess.unmapped.length ? `\nUnmapped headers: ${guess.unmapped.join(', ')}` : '') +
        '\nConfirm the mapping interactively, or add an adapter (see CONTRIBUTING.md, "Add a platform adapter").',
    );
    this.name = 'UnknownExportError';
  }
}

/** Marks an ingest warning that should stop a run until the user accepts it. */
const MICROS_SUSPECT = 'which looks like micros';

/**
 * Warnings serious enough to stop a run before any model call: a plain cost column whose values
 * look like micros (every money number in the report would be a million times too big).
 */
export function blockingWarnings(d: Pick<Dataset, 'warnings'>): string[] {
  return d.warnings.filter((w) => w.includes(MICROS_SUSPECT));
}

/** Ingest found something that would make every number wrong; the user has to accept it to go on. */
export class IngestWarningError extends Error {
  constructor(readonly warnings: string[]) {
    super(
      `The export looks wrong, so nothing was sent to a model:\n${warnings.map((w) => `  - ${w}`).join('\n')}\n` +
        'Fix the export (or its adapter), or rerun with --accept-warnings to report on it as it is.',
    );
    this.name = 'IngestWarningError';
  }
}

/** A confirmed mapping that can't be used (a required field is missing or names a header the file doesn't have). */
export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

/** Read an export and return it in the standard schema. */
export async function ingest(file: string, opts: IngestOptions = {}): Promise<Dataset> {
  const table = await readTable(file);
  const adapters = loadAdapters(opts.adaptersDir ?? [builtinAdaptersDir(), resolve(USER_ADAPTERS_DIR)]);
  const warnings: string[] = [];

  // 1. Find the header row and the adapter. Some platforms put a preamble
  //    (report name, date range) above the header, so look a few rows down.
  let headerIndex = -1;
  let adapter: Adapter | undefined;
  let adapterId: string;
  let mapping: ColumnMapping;
  for (let i = 0; i < Math.min(table.length, 30); i++) {
    const det = detectAdapter(table[i], adapters);
    if (det) {
      headerIndex = i;
      adapter = det.adapter;
      mapping = det.mapping;
      break;
    }
  }

  if (adapter) {
    adapterId = adapter.id;
    mapping = mapping!;
    if (opts.saveAdapterAs) warnings.push(`saveAdapterAs ignored: the export matched the "${adapter.id}" adapter.`);
  } else {
    // 2. Unknown export: guess, then ask (or give up with the guess attached).
    headerIndex = guessHeaderRow(table);
    if (headerIndex < 0) throw new UnknownExportError(file, guessMapping([], []), 'no header row found');
    const headers = table[headerIndex];
    const sample = table.slice(headerIndex + 1).filter((r) => !isBlankRow(r)).slice(0, 20);
    const guess = guessMapping(headers, sample);
    if (!opts.confirmMapping) throw new UnknownExportError(file, guess);
    const confirmed = await opts.confirmMapping(guess);
    if (!confirmed) throw new UnknownExportError(file, guess, 'the guessed mapping was not confirmed');
    checkConfirmed(confirmed, headers);
    adapter = adapterFromMapping(confirmed);
    adapterId = 'guessed';
    mapping = confirmed;
    if (opts.saveAdapterAs) {
      const saved = saveAdapter(confirmed, opts.saveAdapterAs, { source: file });
      warnings.push(`Saved the confirmed mapping as adapter ${saved}.`);
    }
  }

  if (headerIndex > 0) warnings.push(`Header row found on line ${headerIndex + 1}; skipped ${headerIndex} preamble line(s) above it.`);

  const rows = mapRows(table, headerIndex, adapter, mapping, warnings);
  const currency = detectCurrency(table, headerIndex, adapter, mapping, rows.kept, warnings);
  if (!rows.rows.length) warnings.push('No data rows found below the header.');

  return {
    source: file,
    platform: adapter.platform,
    adapter: adapterId,
    currency,
    mapping,
    rows: rows.rows,
    warnings,
  };
}

// ------------------------------------------------------------ reading files

/** Read a CSV/TSV or XLSX file into a table of trimmed string cells. */
export async function readTable(file: string): Promise<string[][]> {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const ext = extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return readXlsx(file);
  if (ext === '.xls') throw new Error(`${file}: legacy .xls is not supported; save it as .xlsx or .csv.`);
  return readCsv(file);
}

/** CSV with UTF-8/UTF-16 BOM handling, delimiter sniffing (comma, tab, semicolon) and ragged rows. */
export function readCsv(file: string): string[][] {
  const buf = readFileSync(file);
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = swap16(buf.subarray(2)).toString('utf16le');
  else text = buf.toString('utf8');
  text = text.replace(/^﻿/, '');

  const records = parseCsv(text, {
    delimiter: sniffDelimiter(text),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  });
  return records.map((r) => r.map((c) => String(c ?? '').trim()));
}

function swap16(b: Buffer): Buffer {
  const out = Buffer.alloc(b.length - (b.length % 2));
  for (let i = 0; i + 1 < b.length; i += 2) {
    out[i] = b[i + 1];
    out[i + 1] = b[i];
  }
  return out;
}

/** Pick the delimiter that appears most in the first lines, ignoring quoted text. */
function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
  const counts: Record<string, number> = { ',': 0, '\t': 0, ';': 0 };
  for (const line of lines) {
    const bare = line.replace(/"[^"]*"/g, '');
    for (const d of Object.keys(counts)) counts[d] += bare.split(d).length - 1;
  }
  // Highest count wins; ties keep the order above (comma first).
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

/** First worksheet of an XLSX workbook. Dates become YYYY-MM-DD, numbers plain digits. */
export async function readXlsx(file: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`${file}: the workbook has no worksheets.`);
  const table: string[][] = [];
  const width = ws.columnCount;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value));
    if (!isBlankRow(cells)) table.push(cells);
  }
  return table;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue); // formula
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
    if ('text' in v) return String(v.text).trim(); // hyperlink
    if ('error' in v) return '';
  }
  return String(v);
}

// --------------------------------------------------------------- header row

function isBlankRow(r: string[]): boolean {
  return r.every((c) => String(c ?? '').trim() === '');
}

/**
 * For unknown exports: the first row in the top 30 that is mostly filled,
 * holds only text (headers aren't numbers or dates) and has data below it.
 */
function guessHeaderRow(table: string[][]): number {
  const top = table.slice(0, 30);
  const width = Math.max(0, ...top.map((r) => r.filter((c) => c !== '').length));
  for (let i = 0; i < top.length - 1; i++) {
    const filled = top[i].filter((c) => c !== '');
    if (filled.length < Math.max(2, Math.ceil(width * 0.6))) continue;
    if (filled.some((c) => parseNumber(c).kind === 'number' || parseDate(c))) continue;
    return i;
  }
  return table.length ? 0 : -1;
}

function checkConfirmed(mapping: ColumnMapping, headers: string[]): void {
  const missing = missingFields(mapping);
  if (missing.length) throw new MappingError(`The confirmed mapping is missing required fields: ${missing.join(', ')}.`);
  const named = [...Object.entries(mapping).filter(([k]) => k !== 'extra'), ...Object.entries(mapping.extra ?? {})] as [string, string][];
  for (const [field, header] of named) {
    if (!headers.includes(header)) throw new MappingError(`The confirmed mapping sends ${field} to "${header}", which is not a header in this file.`);
  }
}

// -------------------------------------------------------------- row mapping

function mapRows(
  table: string[][],
  headerIndex: number,
  adapter: Adapter,
  mapping: ColumnMapping,
  warnings: string[],
): { rows: Row[]; kept: string[][] } {
  const headers = table[headerIndex];
  const col = (h: string | undefined) => (h === undefined ? -1 : headers.indexOf(h));
  const cell = (r: string[], h: string | undefined) => {
    const i = col(h);
    return i < 0 ? '' : String(r[i] ?? '').trim();
  };
  const isMicros = (h: string) => adapter.micros.some((p) => headerMatches(p, h));
  const dateEndHeader = findHeader(adapter.dateEnd, headers);

  const rows: Row[] = [];
  const kept: string[][] = [];
  const skipped = new Map<string, number[]>();
  const zeroed = new Map<string, number>();
  const invalid = new Map<string, { count: number; example: string; line: number }>();
  let unparsedDates = 0;

  for (let i = headerIndex + 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    if (isBlankRow(r)) continue;
    // A repeated header row (some exports concatenate sections).
    if (r.every((c, j) => c === (headers[j] ?? ''))) continue;

    const rule = adapter.skipRows.find((s) => skipMatches(s, r, headers, mapping));
    if (rule) {
      skipped.set(rule.reason, [...(skipped.get(rule.reason) ?? []), line]);
      continue;
    }

    const num = (field: SchemaField): number => {
      const header = mapping[field];
      if (!header) return 0;
      const raw = cell(r, header);
      const p = parseNumber(raw, adapter.numbers);
      if (p.kind === 'zero') {
        zeroed.set(header, (zeroed.get(header) ?? 0) + 1);
        return 0;
      }
      if (p.kind === 'invalid') {
        const prev = invalid.get(header);
        invalid.set(header, { count: (prev?.count ?? 0) + 1, example: prev?.example ?? raw, line: prev?.line ?? line });
        return 0;
      }
      return isMicros(header) ? fromMicros(p.value) : p.value;
    };

    const row: Row = {
      platform: adapter.platform,
      account: cell(r, mapping.account) || '(not in export)',
      campaign: cell(r, mapping.campaign),
      spend: num('spend'),
      impressions: num('impressions'),
      clicks: num('clicks'),
      conversions: num('conversions'),
      conversionValue: num('conversionValue'),
      extra: {},
    };
    const adGroup = cell(r, mapping.adGroup);
    if (mapping.adGroup) row.adGroup = adGroup;

    // Date, or a period label when the row isn't a single day.
    if (mapping.date) {
      const raw = cell(r, mapping.date);
      let date = parseDate(raw, adapter.dates.order);
      if (!date && /^\d+(\.\d+)?$/.test(raw) && +raw > 20000 && +raw < 80000) date = excelSerialToIso(+raw);
      const end = dateEndHeader ? parseDate(cell(r, dateEndHeader), adapter.dates.order) : null;
      if (date && end && end !== date) row.period = `${date}/${end}`;
      else if (date) row.date = date;
      else {
        row.period = raw;
        unparsedDates++;
      }
    } else if (mapping.period) {
      row.period = cell(r, mapping.period);
    }

    for (const [name, header] of Object.entries(mapping.extra ?? {})) {
      row.extra[name] = /\bid\b/i.test(header) ? cell(r, header) : extraValue(cell(r, header), isMicros(header), adapter);
    }

    rows.push(row);
    kept.push(r);
  }

  // Warnings, one line per kind of thing, so the user can scan them.
  for (const [reason, lines] of skipped) {
    warnings.push(`Skipped ${lines.length} ${reason}${lines.length === 1 ? '' : 's'} (line${lines.length === 1 ? '' : 's'} ${lines.join(', ')}).`);
  }
  for (const field of NUMERIC_FIELDS) {
    const h = mapping[field];
    if (h && isMicros(h)) warnings.push(`Converted "${h}" from micros to major currency units (divided by 1,000,000).`);
  }
  for (const [name, h] of Object.entries(mapping.extra ?? {})) {
    if (isMicros(h)) warnings.push(`Converted "${h}" (extra.${name}) from micros (divided by 1,000,000).`);
  }
  for (const [h, n] of zeroed) warnings.push(`Read ${n} blank or placeholder value${n === 1 ? '' : 's'} in "${h}" as 0.`);
  for (const [h, x] of invalid) {
    warnings.push(`${x.count} value${x.count === 1 ? '' : 's'} in "${h}" ${x.count === 1 ? 'is' : 'are'} not a number and ${x.count === 1 ? 'was' : 'were'} read as 0 (first: "${x.example}" on line ${x.line}).`);
  }
  if (unparsedDates) warnings.push(`${unparsedDates} value${unparsedDates === 1 ? '' : 's'} in "${mapping.date}" ${unparsedDates === 1 ? 'is' : 'are'} not a date; kept as the row's period label.`);
  if (!mapping.conversionValue) warnings.push('No conversion value column in this export; conversionValue is 0 on every row.');
  if (!mapping.account) warnings.push('No account column in this export; account is "(not in export)".');

  // The micros trap: a cost column that is not declared as micros but looks like it.
  const spendHeader = mapping.spend;
  if (spendHeader && !isMicros(spendHeader) && rows.length) {
    const sorted = rows.map((r) => r.spend).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median >= 1_000_000) {
      warnings.push(`"${spendHeader}" has a median of ${median} per row, ${MICROS_SUSPECT} (1,000,000 = 1 unit). Check the export; if it is micros, map it as a micros column.`);
    }
  }
  return { rows, kept };
}

/** micros → major units, rounded to 6 decimals to drop float noise. */
function fromMicros(v: number): number {
  return Math.round(v) / 1_000_000;
}

/** Extra fields: numbers when they parse, else the raw string. ID columns and values with leading zeros stay text; blank stays "". */
function extraValue(raw: string, micros: boolean, adapter: Adapter): string | number {
  if (raw === '') return '';
  if (/^0\d/.test(raw)) return raw;
  const p = parseNumber(raw, adapter.numbers);
  if (p.kind === 'number') return micros ? fromMicros(p.value) : p.value;
  if (p.kind === 'zero') return 0;
  return raw;
}

function skipMatches(rule: SkipRule, r: string[], headers: string[], mapping: ColumnMapping): boolean {
  let cells: string[];
  if (rule.any) cells = r;
  else if (rule.firstColumn) cells = [r[0] ?? ''];
  else {
    const header = rule.field ? mapping[rule.field] : findHeader([rule.column ?? ''], headers);
    if (!header) return false;
    cells = [r[headers.indexOf(header)] ?? ''];
  }
  const re = rule.match ? new RegExp(rule.match, 'i') : null;
  return cells.some((c) => {
    const v = String(c ?? '').trim();
    return (rule.blank && v === '') || (re !== null && re.test(v));
  });
}

// ----------------------------------------------------------------- currency

/**
 * The dataset currency, in order: the adapter's currency column (most common
 * value), a code in the spend header like "Amount spent (USD)", the adapter
 * default.
 */
function detectCurrency(
  table: string[][],
  headerIndex: number,
  adapter: Adapter,
  mapping: ColumnMapping,
  kept: string[][],
  warnings: string[],
): string {
  const headers = table[headerIndex];
  const colHeader = findHeader(adapter.currency.column, headers);
  if (colHeader) {
    const idx = headers.indexOf(colHeader);
    const counts = new Map<string, number>();
    for (const r of kept) {
      const v = String(r[idx] ?? '').trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked.length > 1) {
      warnings.push(`The export mixes currencies (${ranked.map(([c]) => c).join(', ')}); using ${ranked[0][0]}. Totals across currencies are not meaningful.`);
    }
    if (ranked.length) return ranked[0][0];
  }
  if (adapter.currency.fromHeader) {
    for (const h of [mapping.spend, mapping.conversionValue]) {
      const m = h ? /\(([A-Z]{3})\)/.exec(h) : null;
      if (m) return m[1];
    }
  }
  if (adapter.file === '<guessed>') warnings.push(`No currency found in the export; assuming ${adapter.currency.default}.`);
  return adapter.currency.default;
}
