import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, factsToLedger, runEngine } from '../../src/check/index.js';
import { computeFacts, dateRangeLabel } from '../../src/compute/index.js';
import { formatDisplay } from '../../src/compute/format.js';
import * as ops from '../../src/compute/ops.js';
import type { Dataset, Fact, FactKind, FactsTable, Row } from '../../src/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------- dataset helpers

function day(start: string, offset: number): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function row(p: Partial<Row>): Row {
  return {
    platform: 'google-ads',
    account: 'Acme',
    campaign: 'PR-03 Brand',
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversionValue: 0,
    extra: {},
    ...p,
  };
}

function dataset(rows: Row[], currency = 'USD'): Dataset {
  return { source: 'inline', platform: 'google-ads', adapter: 'google-ads', currency, mapping: {}, rows, warnings: [] };
}

/**
 * 14 days, Sep 29 – Oct 12 2026, two campaigns. Per day:
 *   PR-03 Brand    previous: spend 100, impr 1000, clicks 50, conv 5, value 400
 *                  current:  spend 120, impr 1000, clicks 60, conv 4, value 480
 *   PR-07 Generic  previous: spend 50,  impr 2000, clicks 20, conv 0, value 0
 *                  current:  spend 60,  impr 2000, clicks 30, conv 1, value 100
 */
function twoWeeks(): Dataset {
  const rows: Row[] = [];
  for (let i = 0; i < 14; i++) {
    const cur = i >= 7;
    const date = day('2026-09-29', i);
    rows.push(row({ date, campaign: 'PR-03 Brand', spend: cur ? 120 : 100, impressions: 1000, clicks: cur ? 60 : 50, conversions: cur ? 4 : 5, conversionValue: cur ? 480 : 400 }));
    rows.push(row({ date, campaign: 'PR-07 Generic', spend: cur ? 60 : 50, impressions: 2000, clicks: cur ? 30 : 20, conversions: cur ? 1 : 0, conversionValue: cur ? 100 : 0 }));
  }
  return dataset(rows);
}

function byKey(t: FactsTable, key: string): Fact {
  const f = t.facts.find((x) => x.key === key);
  if (!f) throw new Error(`no fact ${key}`);
  return f;
}

// ---------------------------------------------------------------- ops

describe('ops: hand-checked arithmetic', () => {
  it('pctChange = (to - from) / from * 100', () => {
    // (48213 - 43047) / 43047 * 100 = 5166 / 43047 * 100 = 12.00083...
    expect(ops.pctChange(43047, 48213).value).toBeCloseTo(12.00084, 4);
    expect(ops.pctChange(20, 30)).toEqual({ value: 50, flags: [] });
    expect(ops.pctChange(30, 20).value).toBeCloseTo(-33.3333, 4);
  });
  it('diff = to - from', () => {
    expect(ops.diff(10, 7.5)).toEqual({ value: -2.5, flags: [] });
    expect(ops.diff(700, 840).value).toBe(140);
  });
  it('ratio and share', () => {
    expect(ops.ratio(10, 4).value).toBe(2.5);
    expect(ops.share(25, 200).value).toBe(12.5);
    expect(ops.share(840, 1260).value).toBeCloseTo(66.6667, 4);
  });
  it('CTR, CPC, CPA, CVR, ROAS', () => {
    expect(ops.ctr(30, 1200).value).toBe(2.5); // 30 / 1200 * 100
    expect(ops.cpc(100, 40).value).toBe(2.5); // 100 / 40
    expect(ops.cpa(48213, 790).value).toBeCloseTo(61.02911, 5); // 48213 / 790
    expect(ops.cvr(5, 200).value).toBe(2.5); // 5 / 200 * 100
    expect(ops.roas(4000, 1000).value).toBe(4); // 4000 / 1000
  });
  it('divide by zero → null + divide_by_zero', () => {
    for (const r of [ops.pctChange(0, 5), ops.ratio(1, 0), ops.share(1, 0), ops.ctr(1, 0), ops.cpc(1, 0), ops.cpa(100, 0), ops.cvr(1, 0), ops.roas(1, 0)]) {
      expect(r).toEqual({ value: null, flags: ['divide_by_zero'] });
    }
  });
  it('a missing input gives null with no new flag', () => {
    expect(ops.pctChange(null, 5)).toEqual({ value: null, flags: [] });
    expect(ops.cpa(100, null)).toEqual({ value: null, flags: [] });
    expect(ops.diff(1, null)).toEqual({ value: null, flags: [] });
  });
});

// ---------------------------------------------------------------- computeFacts

describe('computeFacts', () => {
  const t = computeFacts(twoWeeks());

  it('splits 14 days into the latest 7 vs the 7 before and labels the windows', () => {
    expect(t.periods).toEqual({ current: 'Oct 6–12', previous: 'Sep 29–Oct 5' });
    expect(t.currency).toBe('USD');
    expect(byKey(t, 'spend:account:period=current').formula).toContain('over 14 rows');
  });

  it('sums and derived metrics, account level', () => {
    expect(byKey(t, 'spend:account:period=previous').value).toBe(1050); // (100 + 50) * 7
    expect(byKey(t, 'spend:account:period=current').value).toBe(1260); // (120 + 60) * 7
    expect(byKey(t, 'conversions:account:period=current').value).toBe(35); // (4 + 1) * 7
    expect(byKey(t, 'cpa:account:period=previous').value).toBe(30); // 1050 / 35
    expect(byKey(t, 'cpa:account:period=current').value).toBe(36); // 1260 / 35
    expect(byKey(t, 'cpa:account:change=pct').value).toBe(20); // (36 - 30) / 30 * 100
    expect(byKey(t, 'cpa:account:change=diff').value).toBe(6);
    expect(byKey(t, 'roas:account:period=current').value).toBeCloseTo(3.222222, 6); // 3360+700=4060 / 1260
    expect(byKey(t, 'ctr:account:period=current').value).toBe(3); // 630 / 21000 * 100
    expect(byKey(t, 'ctr:account:period=previous').value).toBeCloseTo(2.333333, 6); // 490 / 21000 * 100
  });

  it('campaign facts, pp change for rates, share of spend', () => {
    const cpaPrev = byKey(t, 'cpa:campaign=PR-03 Brand:period=previous');
    const cpaCur = byKey(t, 'cpa:campaign=PR-03 Brand:period=current');
    expect(cpaPrev.value).toBe(20); // 700 / 35
    expect(cpaCur.value).toBe(30); // 840 / 28
    expect(cpaCur.display).toBe('$30.00');
    expect(cpaCur.label).toBe('CPA, campaign PR-03 Brand, current week');
    expect(cpaCur.formula).toBe('spend / conversions = 840 / 28');
    const pct = byKey(t, 'cpa:campaign=PR-03 Brand:change=pct');
    expect(pct.value).toBe(50);
    expect(pct.display).toBe('+50%');
    expect(pct.inputs).toEqual([cpaPrev.id, cpaCur.id]);
    expect(pct.label).toBe('CPA, campaign PR-03 Brand, percent change, previous to current week (up)');

    const ctrPp = byKey(t, 'ctr:campaign=PR-03 Brand:change=pp');
    expect(ctrPp.kind).toBe('pp');
    expect(ctrPp.value).toBe(1); // 6% - 5%
    expect(ctrPp.display).toBe('+1.0 pp');
    const cvrPp = byKey(t, 'cvr:campaign=PR-03 Brand:change=pp');
    expect(cvrPp.value).toBeCloseTo(-3.333333, 6); // 28/420*100 - 35/350*100
    expect(cvrPp.display).toBe('-3.3 pp');
    expect(cvrPp.label).toMatch(/\(down\)$/);

    const share = byKey(t, 'spend_share:campaign=PR-03 Brand:period=current');
    expect(share.value).toBeCloseTo(66.666667, 6); // 840 / 1260 * 100
    expect(share.display).toBe('67%');
    expect(share.kind).toBe('percent');
    const shareChange = byKey(t, 'spend_share:campaign=PR-03 Brand:change=pp');
    expect(shareChange.value).toBe(0);
    expect(shareChange.label).toMatch(/\(no change\)$/);

    const spendDiff = byKey(t, 'spend:campaign=PR-03 Brand:change=diff');
    expect(spendDiff.value).toBe(140);
    expect(spendDiff.display).toBe('+$140.00');
  });

  it('flags divide by zero and carries it to the change facts', () => {
    const prevCpa = byKey(t, 'cpa:campaign=PR-07 Generic:period=previous');
    expect(prevCpa.value).toBeNull(); // 350 / 0
    expect(prevCpa.display).toBe('n/a');
    expect(prevCpa.flags).toContain('divide_by_zero');
    const pct = byKey(t, 'cpa:campaign=PR-07 Generic:change=pct');
    expect(pct.value).toBeNull();
    expect(pct.flags).toContain('divide_by_zero');
    expect(byKey(t, 'conversions:campaign=PR-07 Generic:change=pct').flags).toContain('divide_by_zero'); // from 0
    expect(byKey(t, 'conversions:campaign=PR-07 Generic:change=diff').value).toBe(7);
    // null facts never enter the ledger
    const ledger = factsToLedger(t);
    expect(ledger.numbers.find((n) => n.id === prevCpa.id)).toBeUndefined();
  });

  it('sample sizes and small_sample flags (default 30 conversions)', () => {
    const cur = byKey(t, 'cpa:campaign=PR-03 Brand:period=current');
    const prev = byKey(t, 'cpa:campaign=PR-03 Brand:period=previous');
    expect(cur.sampleSize).toBe(28);
    expect(cur.flags).toContain('small_sample');
    expect(prev.sampleSize).toBe(35);
    expect(prev.flags).not.toContain('small_sample');
    expect(byKey(t, 'cpa:campaign=PR-03 Brand:change=pct').sampleSize).toBe(28); // min of the windows
    expect(byKey(t, 'cpa:campaign=PR-03 Brand:change=pct').flags).toContain('small_sample');
    expect(byKey(t, 'ctr:campaign=PR-03 Brand:period=current').sampleSize).toBe(420); // clicks
    expect(byKey(t, 'spend:account:period=current').sampleSize).toBeUndefined();
    expect(byKey(t, 'cpa:account:period=current').flags).not.toContain('small_sample'); // 35
    const strict = computeFacts(twoWeeks(), { smallSample: 40 });
    expect(byKey(strict, 'cpa:account:period=current').flags).toContain('small_sample');
    const loose = computeFacts(twoWeeks(), { smallSample: 10 });
    expect(byKey(loose, 'cpa:campaign=PR-03 Brand:period=current').flags).not.toContain('small_sample');
  });

  it('assigns ids f1..fN deterministically, independent of row order', () => {
    expect(t.facts.map((f) => f.id)).toEqual(t.facts.map((_, i) => `f${i + 1}`));
    expect(new Set(t.facts.map((f) => f.key)).size).toBe(t.facts.length);
    const shuffled = twoWeeks();
    shuffled.rows.reverse();
    expect(computeFacts(shuffled)).toEqual(t);
    expect(t.facts[0].key).toBe('spend:account:period=current');
    expect(t.facts[1].key).toBe('spend:account:period=previous');
  });

  it('inputs point at earlier facts or rows', () => {
    const seen = new Set<string>();
    for (const f of t.facts) {
      for (const i of f.inputs) expect(i.startsWith('row:') || seen.has(i)).toBe(true);
      seen.add(f.id);
    }
  });

  it('labels contain no numbers except names from the data', () => {
    for (const f of t.facts) {
      const stripped = f.label.replaceAll('PR-03 Brand', '').replaceAll('PR-07 Generic', '');
      expect(stripped, f.label).not.toMatch(/\d/);
    }
  });

  it('splits fewer than 14 days into equal halves, dropping the oldest odd day', () => {
    const rows = Array.from({ length: 11 }, (_, i) => row({ date: day('2026-10-02', i), spend: i + 1, conversions: 1, clicks: 1, impressions: 10 }));
    const f = computeFacts(dataset(rows));
    expect(f.periods).toEqual({ current: 'Oct 8–12', previous: 'Oct 3–7' });
    expect(byKey(f, 'spend:account:period=current').value).toBe(7 + 8 + 9 + 10 + 11);
    expect(byKey(f, 'spend:account:period=previous').value).toBe(2 + 3 + 4 + 5 + 6);
    expect(byKey(f, 'spend:account:period=current').label).toBe('Spend, account, current period');
  });

  it('one day only: no comparisons, every fact flagged no_baseline', () => {
    const f = computeFacts(dataset([row({ date: '2026-10-12', spend: 10, clicks: 5, impressions: 100, conversions: 1 })]));
    expect(f.periods).toEqual({ current: 'Oct 12' });
    expect(f.facts.every((x) => x.flags.includes('no_baseline'))).toBe(true);
    expect(f.facts.some((x) => x.scope.period !== 'current')).toBe(false);
  });

  it('period labels: the last two distinct periods, numeric-aware order', () => {
    const rows = ['2026-W9', '2026-W10', '2026-W11'].map((period, i) => row({ period, spend: (i + 1) * 100, conversions: 10 }));
    const f = computeFacts(dataset(rows));
    expect(f.periods).toEqual({ current: '2026-W11', previous: '2026-W10' });
    expect(byKey(f, 'spend:account:change=pct').value).toBe(50); // 200 → 300
    const single = computeFacts(dataset([row({ period: '2026-09', spend: 5 })]));
    expect(single.facts.every((x) => x.flags.includes('no_baseline'))).toBe(true);
  });

  it('date range labels', () => {
    expect(dateRangeLabel('2026-10-06', '2026-10-12')).toBe('Oct 6–12');
    expect(dateRangeLabel('2026-09-29', '2026-10-05')).toBe('Sep 29–Oct 5');
    expect(dateRangeLabel('2025-12-29', '2026-01-04')).toBe('Dec 29, 2025–Jan 4, 2026');
    expect(dateRangeLabel('2026-10-12', '2026-10-12')).toBe('Oct 12');
  });
});

// ---------------------------------------------------------------- display formatting

describe('display formatting', () => {
  it('follows the rule', () => {
    expect(formatDisplay(61.0291, 'currency', 'USD')).toBe('$61.03');
    expect(formatDisplay(48213.4, 'currency', 'USD')).toBe('$48,213');
    expect(formatDisplay(-1234.6, 'currency', 'USD', true)).toBe('-$1,235');
    expect(formatDisplay(140, 'currency', 'USD', true)).toBe('+$140.00');
    expect(formatDisplay(12.5, 'currency', 'EUR')).toBe('€12.50');
    expect(formatDisplay(1204.5, 'currency', 'CAD')).toBe('CAD 1,205');
    expect(formatDisplay(1204.5, 'currency', 'JPY')).toBe('1,205 JPY');
    expect(formatDisplay(38.4, 'percent', '%')).toBe('38%');
    expect(formatDisplay(-12.2, 'percent', '%', true)).toBe('-12%');
    expect(formatDisplay(3.24, 'percent', '%')).toBe('3.2%');
    expect(formatDisplay(0.456, 'percent', '%')).toBe('0.46%');
    expect(formatDisplay(0.3, 'pp', 'pp', true)).toBe('+0.3 pp');
    expect(formatDisplay(-0.04, 'pp', 'pp', true)).toBe('-0.04 pp');
    expect(formatDisplay(-0.001, 'pp', 'pp', true)).toBe('0.00 pp');
    expect(formatDisplay(4.12, 'multiplier', 'x')).toBe('4.1x');
    expect(formatDisplay(0.853, 'multiplier', 'x')).toBe('0.85x');
    expect(formatDisplay(1284, 'count', '')).toBe('1,284');
    expect(formatDisplay(790.5, 'count', '')).toBe('790.5');
    expect(formatDisplay(790.04, 'count', '')).toBe('790');
    expect(formatDisplay(null, 'currency', 'USD')).toBe('n/a');
  });
});

// ---------------------------------------------------------------- round trip through the engine

/** Half a unit of the last digit shown in a display ("$61.03" → 0.005, "38%" → 0.5). */
function halfUnit(display: string): number {
  const m = display.match(/\d[\d,]*(?:\.(\d+))?/);
  if (!m) throw new Error(`no digits in ${display}`);
  return 0.5 * 10 ** -(m[1]?.length ?? 0);
}

/** Every non-null display goes through `extract`; each must come back as one number that traces to its fact. */
async function expectDisplaysTrace(table: FactsTable): Promise<void> {
  const facts = table.facts.filter((f) => f.value !== null);
  const ledger = factsToLedger(table);
  const text = facts.map((f) => `Metric reads ${f.display} now.`).join('\n') + '\n';
  const dir = await mkdtemp(join(tmpdir(), 'noro-rt-'));
  try {
    const p = join(dir, 'displays.md');
    await writeFile(p, text, 'utf8');
    const { json } = await runEngine(['extract', p]);
    expect(json.numbers.length).toBe(facts.length);
    facts.forEach((f, i) => {
      const n = json.numbers[i];
      const entry = ledger.numbers.find((e) => e.id === f.id)!;
      // A currency the engine doesn't know ("1,205 JPY") comes back as the bare count "1,205".
      expect(n.raw, f.key).toBe(entry.kind === f.kind ? f.display : f.display.replace(` ${f.unit}`, ''));
      expect(n.kind, f.display).toBe(entry.kind);
      expect(n.unit, f.display).toBe(entry.unit);
      expect(Math.abs(n.value - (f.value as number)), `${f.display} vs ${f.value}`).toBeLessThanOrEqual(halfUnit(f.display) * (1 + 1e-9) + 1e-12);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // and the whole set passes the engine's own tracing against the facts ledger
  const report = await check({ text, mode: 'generate', facts: table });
  expect(report.untraced).toEqual([]);
}

function syntheticTable(): FactsTable {
  const cases: [number, FactKind, string, boolean][] = [
    [0.004, 'currency', 'USD', false],
    [999.996, 'currency', 'USD', false],
    [1999.5, 'currency', 'USD', false],
    [2026, 'currency', 'USD', false],
    [12345678.9, 'currency', 'USD', false],
    [-61.0291, 'currency', 'USD', true],
    [61.0291, 'currency', 'EUR', true],
    [-1204.5, 'currency', 'GBP', true],
    [1204.5, 'currency', 'CAD', false],
    [-12.345, 'currency', 'AUD', true],
    [1204.5, 'currency', 'JPY', false],
    [0.004, 'percent', '%', false],
    [9.96, 'percent', '%', false],
    [-0.456, 'percent', '%', true],
    [12.000836, 'percent', '%', true],
    [-1234.5, 'percent', '%', true],
    [0.04, 'pp', 'pp', true],
    [-0.001, 'pp', 'pp', true],
    [-3.333333, 'pp', 'pp', true],
    [4.12, 'multiplier', 'x', false],
    [0.853, 'multiplier', 'x', false],
    [-0.3, 'multiplier', 'x', true],
    [1999, 'count', '', false],
    [2026, 'count', '', false],
    [790.04, 'count', '', false],
    [790.55, 'count', '', true],
    [-1034, 'count', '', true],
    [7, 'count', '', false],
  ];
  return {
    currency: 'USD',
    periods: { current: 'Oct 6–12' },
    facts: cases.map(([value, kind, unit, signed], i) => ({
      id: `f${i + 1}`,
      key: `case:${i}`,
      label: `case`,
      value,
      kind,
      unit,
      display: formatDisplay(value, kind, unit, signed),
      formula: '',
      inputs: [],
      scope: { metric: 'case' },
      flags: [],
    })),
  };
}

describe('display round trip through the real engine', () => {
  it('every fact display of a computed table extracts and traces', async () => {
    await expectDisplaysTrace(computeFacts(twoWeeks()));
  });

  it('edge-case displays (boundaries, signs, currencies, year-like counts) extract and trace', async () => {
    await expectDisplaysTrace(syntheticTable());
  });

  it('a non-USD dataset traces too', async () => {
    const ds = twoWeeks();
    await expectDisplaysTrace(computeFacts({ ...ds, currency: 'EUR' }));
    await expectDisplaysTrace(computeFacts({ ...ds, currency: 'JPY' }));
  });

  it('period labels in the text are not read as numbers', async () => {
    const t = computeFacts(twoWeeks());
    const report = await check({ text: `Spend for ${t.periods.current} versus ${t.periods.previous}.`, mode: 'generate', facts: t });
    expect(report.untraced).toEqual([]);
  });

  const ingestPath = join(ROOT, 'src/ingest/index.ts');
  const fixture = join(ROOT, 'fixtures/exports/google-ads.csv');
  it.skipIf(!existsSync(ingestPath) || !existsSync(fixture))('the google-ads fixture (if builder A ingest exists) computes facts that trace', async () => {
    const mod = await import(pathToFileURL(ingestPath).href);
    const ds: Dataset = await mod.ingest(fixture);
    const t = computeFacts(ds);
    expect(t.facts.length).toBeGreaterThan(0);
    expect(t.periods.previous).toBeDefined();
    await expectDisplaysTrace(t);
  });
});
