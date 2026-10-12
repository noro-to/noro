// Compute: Dataset → FactsTable. This is the single source of numbers in a
// report. Models never see `value`, `display` or `formula`; they see fact ids
// and labels, and code renders `display` in place of {{fN}}.
//
// Windows
//   Daily data (every row has a date): take the distinct dates present, sorted.
//   k = min(7, floor(n / 2)); current = the latest k dates, previous = the k
//   dates before them. So 14+ dates give the latest 7 vs the 7 before; fewer
//   give two equal halves (with an odd count the oldest date is left out, so
//   the windows stay the same length). One date only → one window, no
//   comparisons, every fact flagged 'no_baseline'.
//   Period data (any row without a date): rows group by `period` (or date when
//   a row has no period); current = the last distinct period, previous = the
//   one before it (sorted with numeric-aware string order). One period → no_baseline.
//   Rows outside both windows are not used.
//
// Facts, in this order (ids f1..fN follow it, so the same dataset always gives
// the same ids): the account scope first, then each campaign sorted by name
// (code-point order). Per scope, for each metric in METRICS order: current
// value, previous value, percent change, then the absolute change (pp change
// for CTR and CVR). Then, per campaign, share of account spend for current,
// previous and its pp change.
//
// Sample sizes (Fact.sampleSize, and what 'small_sample' is judged on)
//   conversions, conversion value, CPA, CVR, ROAS → conversions in that window
//   CTR, CPC                                      → clicks in that window
//   change facts                                  → the smaller of the two windows
//   spend, impressions, clicks, share             → none (sums, not estimates)
//   'small_sample' when sampleSize < opts.smallSample (default 30).
//
// Labels hold no numbers except names from the data (campaign codes). Change
// labels end with the direction in words, read off the display: (up), (down)
// or (no change) when the display rounds to zero; nothing when the value is null.

import type { Dataset, Fact, FactFlag, FactKind, FactsTable, Row } from '../schema.js';
import { formatDisplay, plain, round6 } from './format.js';
import * as ops from './ops.js';
import type { OpResult } from './ops.js';

export { formatDisplay } from './format.js';

export interface ComputeOptions {
  /** Facts whose sample is under this get the 'small_sample' flag. Default 30. */
  smallSample?: number;
}

type SumField = 'spend' | 'impressions' | 'clicks' | 'conversions' | 'conversionValue';
type MetricKey = 'spend' | 'impressions' | 'clicks' | 'conversions' | 'conversion_value' | 'ctr' | 'cpc' | 'cpa' | 'cvr' | 'roas';
type WindowKey = 'current' | 'previous';

interface MetricDef {
  key: MetricKey;
  name: string;
  kind: 'currency' | 'count' | 'percent' | 'multiplier';
  /** Sum straight off the rows. */
  field?: SumField;
  /** Derived from other metrics in the same window. */
  derive?: { op: (a: number | null, b: number | null) => OpResult; inputs: [MetricKey, MetricKey]; formula: string };
  /** Which count is the sample behind this metric. */
  sample?: 'conversions' | 'clicks';
  /** Rate metrics get a pp change instead of an absolute diff. */
  rate?: boolean;
}

const METRICS: MetricDef[] = [
  { key: 'spend', name: 'Spend', kind: 'currency', field: 'spend' },
  { key: 'impressions', name: 'Impressions', kind: 'count', field: 'impressions' },
  { key: 'clicks', name: 'Clicks', kind: 'count', field: 'clicks' },
  { key: 'conversions', name: 'Conversions', kind: 'count', field: 'conversions', sample: 'conversions' },
  { key: 'conversion_value', name: 'Conversion value', kind: 'currency', field: 'conversionValue', sample: 'conversions' },
  { key: 'ctr', name: 'CTR', kind: 'percent', rate: true, sample: 'clicks',
    derive: { op: ops.ctr, inputs: ['clicks', 'impressions'], formula: 'clicks / impressions * 100' } },
  { key: 'cpc', name: 'CPC', kind: 'currency', sample: 'clicks',
    derive: { op: ops.cpc, inputs: ['spend', 'clicks'], formula: 'spend / clicks' } },
  { key: 'cpa', name: 'CPA', kind: 'currency', sample: 'conversions',
    derive: { op: ops.cpa, inputs: ['spend', 'conversions'], formula: 'spend / conversions' } },
  { key: 'cvr', name: 'Conversion rate', kind: 'percent', rate: true, sample: 'conversions',
    derive: { op: ops.cvr, inputs: ['conversions', 'clicks'], formula: 'conversions / clicks * 100' } },
  { key: 'roas', name: 'ROAS', kind: 'multiplier', sample: 'conversions',
    derive: { op: ops.roas, inputs: ['conversion_value', 'spend'], formula: 'conversion value / spend' } },
];

interface Window {
  key: WindowKey;
  rows: Row[];
  /** Human label for FactsTable.periods, e.g. "Oct 6–12". */
  label: string;
  /** Short description for formulas, e.g. "2026-10-06..2026-10-12". */
  span: string;
}

interface Windows {
  current: Window;
  previous?: Window;
  /** "week" when both windows are 7 days of daily data, otherwise "period". */
  word: 'week' | 'period';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoDay(row: Row): string | undefined {
  return row.date ? row.date.slice(0, 10) : undefined;
}

/** "Oct 6–12", "Sep 29–Oct 5", "Oct 12", or with years when they differ. */
export function dateRangeLabel(first: string, last: string): string {
  const parse = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return { y, m, day };
  };
  const a = parse(first);
  const b = parse(last);
  const md = (x: { m: number; day: number }) => `${MONTHS[x.m - 1] ?? '?'} ${x.day}`;
  if (first === last) return md(a);
  if (a.y !== b.y) return `${md(a)}, ${a.y}–${md(b)}, ${b.y}`;
  if (a.m === b.m) return `${md(a)}–${b.day}`;
  return `${md(a)}–${md(b)}`;
}

function splitWindows(rows: Row[]): Windows {
  const daily = rows.length > 0 && rows.every((r) => isoDay(r));
  if (daily) {
    const dates = [...new Set(rows.map((r) => isoDay(r) as string))].sort();
    const n = dates.length;
    const k = Math.min(7, Math.floor(n / 2));
    const make = (key: WindowKey, ds: string[]): Window => {
      const set = new Set(ds);
      return {
        key,
        rows: rows.filter((r) => set.has(isoDay(r) as string)),
        label: dateRangeLabel(ds[0], ds[ds.length - 1]),
        span: ds[0] === ds[ds.length - 1] ? ds[0] : `${ds[0]}..${ds[ds.length - 1]}`,
      };
    };
    if (k === 0) return { current: make('current', dates), word: 'period' };
    return {
      current: make('current', dates.slice(n - k)),
      previous: make('previous', dates.slice(n - 2 * k, n - k)),
      word: k === 7 ? 'week' : 'period',
    };
  }
  const keyOf = (r: Row) => r.period ?? isoDay(r) ?? '';
  const periods = [...new Set(rows.map(keyOf))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const make = (key: WindowKey, p: string): Window => ({
    key,
    rows: rows.filter((r) => keyOf(r) === p),
    label: p || 'all rows',
    span: p || 'all rows',
  });
  if (periods.length < 2) return { current: make('current', periods[0] ?? ''), word: 'period' };
  return {
    current: make('current', periods[periods.length - 1]),
    previous: make('previous', periods[periods.length - 2]),
    word: 'period',
  };
}

function sum(rows: Row[], field: SumField): number {
  let s = 0;
  for (const r of rows) {
    const v = r[field];
    if (typeof v === 'number' && Number.isFinite(v)) s += v;
  }
  return round6(s);
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Direction in words, read off the signed display so label and display agree ("0.00 pp" is no change). */
function direction(display: string): string {
  if (display.startsWith('+')) return ' (up)';
  if (display.startsWith('-')) return ' (down)';
  return /\d/.test(display) ? ' (no change)' : '';
}

/** Build the facts table for a dataset. Deterministic: same dataset, same facts and ids. */
export function computeFacts(ds: Dataset, opts: ComputeOptions = {}): FactsTable {
  const threshold = opts.smallSample ?? 30;
  const currency = (ds.currency || 'USD').toUpperCase();
  const win = splitWindows(ds.rows);
  const hasBaseline = !!win.previous;
  const windows: Window[] = win.previous ? [win.current, win.previous] : [win.current];
  const facts: Fact[] = [];

  const unitFor = (kind: FactKind): string =>
    kind === 'currency' ? currency : kind === 'percent' ? '%' : kind === 'pp' ? 'pp' : kind === 'multiplier' || kind === 'ratio' ? 'x' : '';

  function push(f: Omit<Fact, 'id' | 'unit' | 'display' | 'flags' | 'value'> & { value: number | null; flags: FactFlag[]; signed?: boolean }): Fact {
    const { signed, ...rest } = f;
    const value = rest.value === null ? null : round6(rest.value);
    const flags = new Set<FactFlag>(rest.flags);
    if (rest.sampleSize !== undefined && rest.sampleSize < threshold) flags.add('small_sample');
    if (!hasBaseline) flags.add('no_baseline');
    const unit = unitFor(rest.kind);
    const display = formatDisplay(value, rest.kind, unit, !!signed);
    const fact: Fact = {
      ...rest,
      // change facts (the signed ones) end their label with the direction
      label: signed ? rest.label + direction(display) : rest.label,
      id: `f${facts.length + 1}`,
      value,
      unit,
      display,
      flags: (['divide_by_zero', 'small_sample', 'no_baseline'] as FactFlag[]).filter((x) => flags.has(x)),
    };
    if (fact.sampleSize === undefined) delete fact.sampleSize;
    facts.push(fact);
    return fact;
  }

  const accounts = uniq(ds.rows.map((r) => r.account)).filter(Boolean);
  const accountWord = accounts.length > 1 ? 'all accounts' : 'account';
  const campaigns = uniq(ds.rows.map((r) => r.campaign ?? '')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  interface Scope {
    label: string;
    keyPart: string;
    campaign?: string;
    filter: (r: Row) => boolean;
  }
  const scopes: Scope[] = [
    { label: accountWord, keyPart: 'account', filter: () => true },
    ...campaigns.map((c) => ({
      label: `campaign ${c || '(none)'}`,
      keyPart: `campaign=${c}`,
      campaign: c,
      filter: (r: Row) => (r.campaign ?? '') === c,
    })),
  ];

  const winName = (w: WindowKey) => `${w} ${win.word}`;
  const changeName = `previous to current ${win.word}`;
  // facts by scope keyPart → metric → window, for inputs and shares
  const byScope = new Map<string, Map<string, Fact>>();

  for (const scope of scopes) {
    const got = new Map<string, Fact>();
    byScope.set(scope.keyPart, got);
    const scoped = windows.map((w) => ({ w, rows: w.rows.filter(scope.filter) }));

    for (const m of METRICS) {
      const level: Partial<Record<WindowKey, Fact>> = {};
      for (const { w, rows } of scoped) {
        const base = {
          key: `${m.key}:${scope.keyPart}:period=${w.key}`,
          label: `${m.name}, ${scope.label}, ${winName(w.key)}`,
          kind: m.kind as FactKind,
          scope: { metric: m.key, ...(scope.campaign !== undefined ? { campaign: scope.campaign } : {}), period: w.key },
        };
        const sampleFact = m.sample ? got.get(`${m.sample}:${w.key}`) : undefined;
        const sampleSize = m.key === 'conversions' ? undefined : sampleFact?.value ?? undefined;
        let fact: Fact;
        if (m.field) {
          const v = sum(rows, m.field);
          fact = push({
            ...base,
            value: v,
            formula: `sum of ${m.field} over ${rows.length} rows (${w.span}) = ${plain(v)}`,
            inputs: [`row:${m.field}`],
            flags: [],
            ...(m.key === 'conversions' ? { sampleSize: v } : sampleSize !== undefined ? { sampleSize } : {}),
          });
        } else {
          const d = m.derive!;
          const a = got.get(`${d.inputs[0]}:${w.key}`)!;
          const b = got.get(`${d.inputs[1]}:${w.key}`)!;
          const r = d.op(a.value, b.value);
          fact = push({
            ...base,
            value: r.value,
            formula: `${d.formula} = ${plain(a.value)} / ${plain(b.value)}${d.formula.endsWith('* 100') ? ' * 100' : ''}`,
            inputs: [a.id, b.id],
            flags: [...r.flags, ...a.flags.filter((x) => x === 'divide_by_zero'), ...b.flags.filter((x) => x === 'divide_by_zero')],
            ...(sampleSize !== undefined ? { sampleSize } : {}),
          });
        }
        got.set(`${m.key}:${w.key}`, fact);
        level[w.key] = fact;
      }

      if (!level.previous || !level.current) continue;
      const prev = level.previous;
      const cur = level.current;
      const carried = uniq([...prev.flags, ...cur.flags].filter((x) => x === 'divide_by_zero'));
      const sampleSize =
        prev.sampleSize !== undefined && cur.sampleSize !== undefined ? Math.min(prev.sampleSize, cur.sampleSize) : undefined;
      const sampleProp = sampleSize !== undefined ? { sampleSize } : {};
      const scopeBase = { metric: m.key, ...(scope.campaign !== undefined ? { campaign: scope.campaign } : {}), period: 'previous_to_current' };

      const pct = ops.pctChange(prev.value, cur.value);
      push({
        key: `${m.key}:${scope.keyPart}:change=pct`,
        label: `${m.name}, ${scope.label}, percent change, ${changeName}`,
        value: pct.value,
        kind: 'percent',
        formula: `(current - previous) / previous * 100 = (${plain(cur.value)} - ${plain(prev.value)}) / ${plain(prev.value)} * 100`,
        inputs: [prev.id, cur.id],
        scope: { ...scopeBase, dimension: 'pct_change' },
        ...sampleProp,
        flags: uniq([...pct.flags, ...carried]),
        signed: true,
      });

      const dv = ops.diff(prev.value, cur.value);
      push({
        key: `${m.key}:${scope.keyPart}:change=${m.rate ? 'pp' : 'diff'}`,
        label: m.rate
          ? `${m.name}, ${scope.label}, change in percentage points, ${changeName}`
          : `${m.name}, ${scope.label}, change, ${changeName}`,
        value: dv.value,
        kind: m.rate ? 'pp' : (m.kind as FactKind),
        formula: `current - previous = ${plain(cur.value)} - ${plain(prev.value)}`,
        inputs: [prev.id, cur.id],
        scope: { ...scopeBase, dimension: m.rate ? 'pp_change' : 'diff' },
        ...sampleProp,
        flags: uniq([...dv.flags, ...carried]),
        signed: true,
      });
    }
  }

  // Campaign share of account spend.
  const account = byScope.get('account')!;
  for (const scope of scopes.slice(1)) {
    const got = byScope.get(scope.keyPart)!;
    const shares: Partial<Record<WindowKey, Fact>> = {};
    for (const w of windows) {
      const part = got.get(`spend:${w.key}`)!;
      const whole = account.get(`spend:${w.key}`)!;
      const r = ops.share(part.value, whole.value);
      shares[w.key] = push({
        key: `spend_share:${scope.keyPart}:period=${w.key}`,
        label: `Share of total spend, ${scope.label}, ${winName(w.key)}`,
        value: r.value,
        kind: 'percent',
        formula: `campaign spend / account spend * 100 = ${plain(part.value)} / ${plain(whole.value)} * 100`,
        inputs: [part.id, whole.id],
        scope: { metric: 'spend', campaign: scope.campaign, period: w.key, dimension: 'share' },
        flags: r.flags,
      });
    }
    if (shares.previous && shares.current) {
      const dv = ops.diff(shares.previous.value, shares.current.value);
      push({
        key: `spend_share:${scope.keyPart}:change=pp`,
        label: `Share of total spend, ${scope.label}, change in percentage points, ${changeName}`,
        value: dv.value,
        kind: 'pp',
        formula: `current - previous = ${plain(shares.current.value)} - ${plain(shares.previous.value)}`,
        inputs: [shares.previous.id, shares.current.id],
        scope: { metric: 'spend', campaign: scope.campaign, period: 'previous_to_current', dimension: 'share_pp_change' },
        flags: uniq([...dv.flags, ...shares.previous.flags, ...shares.current.flags].filter((x) => x === 'divide_by_zero')),
        signed: true,
      });
    }
  }

  return {
    currency,
    periods: win.previous ? { current: win.current.label, previous: win.previous.label } : { current: win.current.label },
    facts,
  };
}
