// Platform adapters: YAML files that say how one ad platform's export maps
// onto the standard schema (src/schema.ts, docs/schema.md).
//
// This module loads and validates adapter files and picks the adapter that
// fits a header row. It never touches row values; that is src/ingest's job.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ColumnMapping, SchemaField } from '../schema.js';

/** Schema fields in a fixed order, used for deterministic iteration. */
export const SCHEMA_FIELDS: readonly SchemaField[] = [
  'date',
  'period',
  'account',
  'campaign',
  'adGroup',
  'spend',
  'impressions',
  'clicks',
  'conversions',
  'conversionValue',
];

/** Fields an export must provide (plus one of date / period) to be usable. */
export const REQUIRED_FIELDS: readonly SchemaField[] = ['campaign', 'spend', 'impressions', 'clicks', 'conversions'];

/** Schema fields that hold numbers. */
export const NUMERIC_FIELDS: readonly SchemaField[] = ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'];

/** A rule for rows to drop before mapping (totals, summary rows). Exactly one target is set. */
export interface SkipRule {
  /** Test the column mapped to this schema field. */
  field?: SchemaField;
  /** Test this raw header. */
  column?: string;
  /** Test the first column of the row, whatever it is. */
  firstColumn?: boolean;
  /** Test every cell of the row. */
  any?: boolean;
  /** Case-insensitive regular expression the cell must match. */
  match?: string;
  /** Match when the cell is blank. */
  blank?: boolean;
  /** Shown in ingest warnings, e.g. "total row". */
  reason: string;
}

/** A validated adapter. Header lists are alternatives: the first one present wins. */
export interface Adapter {
  id: string;
  platform: string;
  /** File it was loaded from, or "<guessed>" for an adapter built from a confirmed mapping. */
  file: string;
  detect: { required: string[]; distinctive: string[] };
  columns: Partial<Record<SchemaField, string[]>>;
  extra: Record<string, string[]>;
  /** End-of-range column (Meta "Reporting ends"). See meta.yaml. */
  dateEnd: string[];
  micros: string[];
  currency: { column: string[]; fromHeader: boolean; default: string };
  numbers: { thousands: string; decimal: string; zero: string[] };
  dates: { order: 'mdy' | 'dmy' };
  skipRows: SkipRule[];
}

/** Thrown when an adapter file is malformed. The message names the file and every bad field. */
export class AdapterValidationError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`Invalid adapter ${file}:\n  - ${problems.join('\n  - ')}`);
    this.name = 'AdapterValidationError';
  }
}

// ------------------------------------------------------------------ loading

/**
 * Directory holding the built-in adapters. In a source checkout (tsx, vitest)
 * this is the directory of this file. tsc does not copy YAML into dist/, so a
 * compiled build falls back to ../../src/adapters next to dist/.
 */
export function builtinAdaptersDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (hasYaml(here)) return here;
  const fromDist = resolve(here, '../../src/adapters');
  if (hasYaml(fromDist)) return fromDist;
  return here;
}

/** Where adapters saved from a confirmed guess go by default, relative to the working directory. */
export const USER_ADAPTERS_DIR = join('.noro', 'adapters');

function hasYaml(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => /\.ya?ml$/i.test(f));
}

/**
 * Load every *.yaml / *.yml adapter in the given directories (default: the
 * built-in directory). Files are read in name order so results are
 * deterministic. Missing directories are skipped. Duplicate ids are an error.
 */
export function loadAdapters(dirs: string | string[] = builtinAdaptersDir()): Adapter[] {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  const adapters: Adapter[] = [];
  const seen = new Map<string, string>();
  for (const dir of list) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort();
    for (const f of files) {
      const adapter = loadAdapterFile(join(dir, f));
      const prev = seen.get(adapter.id);
      if (prev) {
        throw new AdapterValidationError(adapter.file, [`id "${adapter.id}" is already used by ${prev}`]);
      }
      seen.set(adapter.id, adapter.file);
      adapters.push(adapter);
    }
  }
  return adapters;
}

/** Read, parse and validate one adapter file. */
export function loadAdapterFile(file: string): Adapter {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new AdapterValidationError(file, [`not valid YAML: ${(err as Error).message}`]);
  }
  return validateAdapter(raw, file);
}

/**
 * Check a parsed adapter object and fill in defaults. Collects every problem
 * before throwing, so a contributor sees all of them at once.
 */
export function validateAdapter(raw: unknown, file: string): Adapter {
  const problems: string[] = [];
  if (!isObject(raw)) throw new AdapterValidationError(file, ['the file must contain a YAML mapping (key: value)']);

  const known = new Set(['id', 'platform', 'detect', 'columns', 'extra', 'dateEnd', 'micros', 'currency', 'numbers', 'dates', 'skipRows']);
  for (const key of Object.keys(raw)) if (!known.has(key)) problems.push(`unknown field "${key}"`);

  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    problems.push(`field "id" must be a lowercase slug like "google-ads" (got ${show(id)})`);
  }
  const platform = raw.platform;
  if (typeof platform !== 'string' || platform.trim() === '') problems.push(`field "platform" must be a non-empty string (got ${show(platform)})`);

  // detect
  let detect: Adapter['detect'] = { required: [], distinctive: [] };
  if (!isObject(raw.detect)) {
    problems.push('field "detect" is required and must have "required" (list of headers)');
  } else {
    const required = headerList(raw.detect.required, 'detect.required', problems);
    if (required.length === 0 && !problems.some((p) => p.includes('detect.required'))) {
      problems.push('field "detect.required" must list at least one header');
    }
    detect = { required, distinctive: headerList(raw.detect.distinctive, 'detect.distinctive', problems, true) };
  }

  // columns
  const columns: Adapter['columns'] = {};
  if (!isObject(raw.columns)) {
    problems.push('field "columns" is required (schema field → header or list of headers)');
  } else {
    for (const [key, value] of Object.entries(raw.columns)) {
      if (!(SCHEMA_FIELDS as readonly string[]).includes(key)) {
        problems.push(`field "columns.${key}" is not a schema field (expected one of: ${SCHEMA_FIELDS.join(', ')})`);
        continue;
      }
      columns[key as SchemaField] = headerList(value, `columns.${key}`, problems);
    }
    for (const f of REQUIRED_FIELDS) if (!columns[f]?.length) problems.push(`field "columns.${f}" is required`);
    if (!columns.date?.length && !columns.period?.length) problems.push('field "columns.date" or "columns.period" is required');
  }

  // extra
  const extra: Record<string, string[]> = {};
  if (raw.extra !== undefined && raw.extra !== null) {
    if (!isObject(raw.extra)) problems.push('field "extra" must be a mapping of name → header(s)');
    else
      for (const [key, value] of Object.entries(raw.extra)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) problems.push(`field "extra.${key}" must be a camelCase name`);
        extra[key] = headerList(value, `extra.${key}`, problems);
      }
  }

  const dateEnd = headerList(raw.dateEnd, 'dateEnd', problems, true);
  const micros = headerList(raw.micros, 'micros', problems, true);

  // currency
  const currency: Adapter['currency'] = { column: [], fromHeader: false, default: 'USD' };
  if (raw.currency !== undefined) {
    if (!isObject(raw.currency)) problems.push('field "currency" must be a mapping');
    else {
      currency.column = headerList(raw.currency.column, 'currency.column', problems, true);
      if (raw.currency.fromHeader !== undefined) {
        if (typeof raw.currency.fromHeader !== 'boolean') problems.push('field "currency.fromHeader" must be true or false');
        else currency.fromHeader = raw.currency.fromHeader;
      }
      if (raw.currency.default !== undefined) {
        if (typeof raw.currency.default !== 'string' || !/^[A-Z]{3}$/.test(raw.currency.default)) {
          problems.push(`field "currency.default" must be an ISO 4217 code like "USD" (got ${show(raw.currency.default)})`);
        } else currency.default = raw.currency.default;
      }
    }
  }

  // numbers
  const numbers: Adapter['numbers'] = { thousands: ',', decimal: '.', zero: ['', '--'] };
  if (raw.numbers !== undefined) {
    if (!isObject(raw.numbers)) problems.push('field "numbers" must be a mapping');
    else {
      for (const k of ['thousands', 'decimal'] as const) {
        const v = raw.numbers[k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || v.length > 1) problems.push(`field "numbers.${k}" must be a single character or "" (got ${show(v)})`);
        else numbers[k] = v;
      }
      if (numbers.decimal === '' || numbers.decimal === numbers.thousands) {
        problems.push('field "numbers.decimal" must be one character and differ from "numbers.thousands"');
      }
      if (raw.numbers.zero !== undefined) numbers.zero = stringList(raw.numbers.zero, 'numbers.zero', problems);
    }
  }

  // dates
  const dates: Adapter['dates'] = { order: 'mdy' };
  if (raw.dates !== undefined) {
    if (!isObject(raw.dates) || (raw.dates.order !== undefined && raw.dates.order !== 'mdy' && raw.dates.order !== 'dmy')) {
      problems.push('field "dates.order" must be "mdy" or "dmy"');
    } else if (raw.dates.order) dates.order = raw.dates.order as 'mdy' | 'dmy';
  }

  // skipRows
  const skipRows: SkipRule[] = [];
  if (raw.skipRows !== undefined && raw.skipRows !== null) {
    if (!Array.isArray(raw.skipRows)) problems.push('field "skipRows" must be a list');
    else
      raw.skipRows.forEach((rule, i) => {
        const at = `skipRows[${i}]`;
        if (!isObject(rule)) return problems.push(`field "${at}" must be a mapping`);
        const targets = ['field', 'column', 'firstColumn', 'any'].filter((k) => rule[k] !== undefined && rule[k] !== false);
        if (targets.length !== 1) problems.push(`field "${at}" needs exactly one of field, column, firstColumn, any`);
        if (rule.field !== undefined && !(SCHEMA_FIELDS as readonly string[]).includes(String(rule.field))) {
          problems.push(`field "${at}.field" is not a schema field (got ${show(rule.field)})`);
        }
        if (rule.match === undefined && rule.blank !== true) problems.push(`field "${at}" needs "match" (regex) or "blank: true"`);
        if (rule.match !== undefined) {
          try {
            new RegExp(String(rule.match), 'i');
          } catch {
            problems.push(`field "${at}.match" is not a valid regular expression (got ${show(rule.match)})`);
          }
        }
        skipRows.push({
          field: rule.field as SchemaField | undefined,
          column: typeof rule.column === 'string' ? rule.column : undefined,
          firstColumn: rule.firstColumn === true || undefined,
          any: rule.any === true || undefined,
          match: rule.match === undefined ? undefined : String(rule.match),
          blank: rule.blank === true || undefined,
          reason: typeof rule.reason === 'string' ? rule.reason : 'skipped row',
        });
      });
  }

  if (problems.length) throw new AdapterValidationError(file, problems);
  return {
    id: id as string,
    platform: platform as string,
    file,
    detect,
    columns,
    extra,
    dateEnd,
    micros,
    currency,
    numbers,
    dates,
    skipRows,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  return v === undefined ? 'nothing' : JSON.stringify(v);
}

/** A header field may be one string or a list of strings. */
function headerList(v: unknown, field: string, problems: string[], optional = false): string[] {
  if (v === undefined || v === null) {
    if (!optional) problems.push(`field "${field}" is required`);
    return [];
  }
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.some((h) => typeof h !== 'string' || h.trim() === '')) {
    problems.push(`field "${field}" must be a header name or a list of header names (got ${show(v)})`);
    return [];
  }
  return list as string[];
}

function stringList(v: unknown, field: string, problems: string[]): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    problems.push(`field "${field}" must be a list of strings (got ${show(v)})`);
    return [];
  }
  return v as string[];
}

// ------------------------------------------------------------------ headers

/** Normalise a header for comparison: trim, collapse whitespace, lowercase. */
export function normHeader(h: string): string {
  return h.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Does a header pattern from an adapter match a raw header? Case-insensitive.
 * A "*" in the pattern matches any text, e.g. "Amount spent (*)".
 */
export function headerMatches(pattern: string, header: string): boolean {
  const p = normHeader(pattern);
  const h = normHeader(header);
  if (!p.includes('*')) return p === h;
  const re = new RegExp('^' + p.split('*').map(escapeRegex).join('.*') + '$');
  return re.test(h);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first header in `headers` matched by any alternative, trying alternatives in order. */
export function findHeader(alternatives: string[], headers: string[]): string | undefined {
  for (const alt of alternatives) {
    const hit = headers.find((h) => headerMatches(alt, h));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Resolve an adapter's alternatives against actual headers. Returns the
 * concrete ColumnMapping (one raw header per field) and the required fields
 * that couldn't be found. A header is only ever used once: schema fields are
 * resolved first, then extra fields from what is left.
 */
export function resolveMapping(adapter: Adapter, headers: string[]): { mapping: ColumnMapping; missing: string[] } {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const field of SCHEMA_FIELDS) {
    const alts = adapter.columns[field];
    if (!alts) continue;
    const hit = findHeader(alts, headers.filter((h) => !used.has(h)));
    if (hit !== undefined) {
      mapping[field] = hit;
      used.add(hit);
    }
  }
  const extra: Record<string, string> = {};
  for (const [name, alts] of Object.entries(adapter.extra)) {
    const hit = findHeader(alts, headers.filter((h) => !used.has(h)));
    if (hit !== undefined) {
      extra[name] = hit;
      used.add(hit);
    }
  }
  if (Object.keys(extra).length) mapping.extra = extra;
  return { mapping, missing: missingFields(mapping) };
}

/** Required schema fields a mapping leaves out ("date or period" counts as one). */
export function missingFields(mapping: ColumnMapping): string[] {
  const missing: string[] = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  if (!mapping.date && !mapping.period) missing.unshift('date or period');
  return missing;
}

// ---------------------------------------------------------------- detection

export interface Detection {
  adapter: Adapter;
  mapping: ColumnMapping;
  score: number;
}

/**
 * Pick the adapter whose signature best fits a header row, or null.
 *
 * An adapter is a candidate only if every `detect.required` header is
 * present and its columns cover the required schema fields. Candidates are
 * scored: 10 per required header, 3 per distinctive header present, 1 per
 * mapped schema or extra column. Highest score wins; ties go to the adapter id
 * that sorts first, so the result never depends on file order.
 */
export function detectAdapter(headers: string[], adapters: Adapter[] = loadAdapters()): Detection | null {
  const clean = headers.map((h) => String(h ?? '')).filter((h) => h.trim() !== '');
  let best: Detection | null = null;
  for (const adapter of adapters) {
    if (!adapter.detect.required.every((r) => clean.some((h) => headerMatches(r, h)))) continue;
    const { mapping, missing } = resolveMapping(adapter, clean);
    if (missing.length) continue;
    const distinctive = adapter.detect.distinctive.filter((d) => clean.some((h) => headerMatches(d, h))).length;
    const mapped = SCHEMA_FIELDS.filter((f) => mapping[f]).length + Object.keys(mapping.extra ?? {}).length;
    const score = 10 * adapter.detect.required.length + 3 * distinctive + mapped;
    if (!best || score > best.score || (score === best.score && adapter.id < best.adapter.id)) {
      best = { adapter, mapping, score };
    }
  }
  return best;
}

// ----------------------------------------------------- adapters from mappings

/**
 * Build an in-memory adapter from a confirmed ColumnMapping (the unknown-export
 * path). It uses generic number and date rules and skips "Total" rows.
 */
export function adapterFromMapping(mapping: ColumnMapping, opts: { id?: string; platform?: string } = {}): Adapter {
  const columns: Adapter['columns'] = {};
  for (const f of SCHEMA_FIELDS) {
    const h = mapping[f];
    if (h) columns[f] = [h];
  }
  const extra: Record<string, string[]> = {};
  for (const [k, h] of Object.entries(mapping.extra ?? {})) extra[k] = [h];
  const currencyCol = mapping.extra?.currency ?? mapping.extra?.currencyCode;
  return {
    id: opts.id ?? 'guessed',
    platform: opts.platform ?? 'unknown',
    file: '<guessed>',
    detect: { required: SCHEMA_FIELDS.map((f) => mapping[f]).filter((h): h is string => !!h), distinctive: [] },
    columns,
    extra,
    dateEnd: [],
    micros: [],
    currency: { column: currencyCol ? [currencyCol] : [], fromHeader: true, default: 'USD' },
    numbers: { thousands: ',', decimal: '.', zero: ['', '--', '-', 'N/A'] },
    dates: { order: 'mdy' },
    skipRows: [{ firstColumn: true, match: '^\\s*Total\\b', reason: 'total row' }],
  };
}
