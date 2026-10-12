// Combined cross-channel reports: `noro this google.csv meta.csv amazon.csv` makes ONE report.
//   - ingestAll: sources per file, one currency (no FX), aligned periods, no report mixed in;
//   - compute: the channel scope (per-platform totals, changes, shares; blended "all channels"),
//     hand-checked, deterministic, and single-file tables byte-identical to before;
//   - classify and draft see words only (platform names are identifiers), never values;
//   - the run key hashes every file, resume works, the real Python check passes and every
//     number in the combined report traces to a fact; CLI and MCP take several paths.
// Offline: both models are mocked. The fixtures share dates (Sep 29 – Oct 12) and USD.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { check, runEngine } from '../../src/check/index.js';
import { buildJevRequests, classifyByRules } from '../../src/classify/index.js';
import { describeFact } from '../../src/classify/describe.js';
import { computeFacts } from '../../src/compute/index.js';
import { loadConfig } from '../../src/config.js';
import { buildDraftPrompt, buildPanelPrompt, buildRevisePrompt } from '../../src/draft/index.js';
import { CROSS_CHANNEL_RULES } from '../../src/draft/prompts.js';
import { FactsUsageError, factsFor, formatFacts } from '../../src/facts.js';
import { STEPS, StopAfterError, UsageError, runKeyFor, runNoro } from '../../src/harness/index.js';
import type { NoroReport, StepName } from '../../src/harness/index.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import { CombineError, IngestWarningError, MixedCurrencyError, blockingWarnings, ingest, ingestAll } from '../../src/ingest/index.js';
import { createNoroMcpServer } from '../../src/mcp/index.js';
import type { Fact, FactsTable } from '../../src/schema.js';
import { assertNoNumbers, maskNames, promptNames } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');
const EX = (n: string) => join(ROOT, 'fixtures/exports', n);
const GOOGLE = EX('google-ads.csv');
const META = EX('meta.csv');
const AMAZON = EX('amazon-dsp.csv');
const THREE = [GOOGLE, META, AMAZON];
const config = { ...loadConfig({}), apiKey: undefined };
const tmp = (p = 'noro-combined-') => mkdtempSync(join(tmpdir(), p));
const clients = () => ({ chat: createMockChat(), jev: createMockJev() });

/** A copy of a fixture with each data line passed through `edit` (return null to drop it). Lines without a date are kept. */
function variant(src: string, name: string, edit: (cells: string[], iso: string) => string[] | null): string {
  const out: string[] = [];
  for (const line of readFileSync(src, 'utf8').split('\n')) {
    const cells = line.split(',');
    const m = line.match(/(?:^|,)(?:(\d{4}-\d{2}-\d{2})|(\d{2})\/(\d{2})\/(\d{4}))(?:,|$)/);
    if (!m) {
      out.push(line);
      continue;
    }
    const iso = m[1] ?? `${m[4]}-${m[2]}-${m[3]}`;
    const next = edit(cells, iso);
    if (next) out.push(next.join(','));
  }
  const p = join(tmp(), name);
  writeFileSync(p, out.join('\n'));
  return p;
}

/** Meta with its current-week spend doubled (Oct 6–12): Meta's share of spend jumps. Every amount stays whole cents. */
const metaShift = () =>
  variant(META, 'meta.csv', (c, iso) => {
    if (iso >= '2026-10-06' && c[3]) c[5] = (Number(c[5]) * 2).toFixed(2);
    return c;
  });

const byKey = (t: FactsTable, key: string): Fact => {
  const f = t.facts.find((x) => x.key === key);
  if (!f) throw new Error(`no fact ${key}`);
  return f;
};

/** A jev request as text, without the bare fact ids it addresses facts by ("f12" keys, f12__label, `facts.f12`). */
const jevText = (r: { state: unknown; questions: unknown }) =>
  JSON.stringify({ state: r.state, questions: r.questions }).replace(/(?<![\p{L}\p{Nd}])f\d+(?!\p{Nd})/gu, ' ');

const shownAs = (display: string) => (/^[+\-−]/.test(display) ? [display, display.slice(1)] : [display]);

async function engineNumbers(text: string): Promise<string[]> {
  const p = join(tmp(), 'final.md');
  writeFileSync(p, text);
  return (await runEngine(['extract', p])).json.numbers.map((n: { raw: string }) => n.raw);
}

/** Every number in the report is a fact display (or a signed change shown without its sign), and the engine finds exactly those. */
async function assertTraced(report: NoroReport, facts: FactsTable) {
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  expect(report.traces.length).toBeGreaterThan(0);
  for (const t of report.traces) expect(shownAs(byId.get(t.factId)!.display)).toContain(t.raw);
  expect((await engineNumbers(report.text)).sort()).toEqual(report.traces.map((t) => t.raw).sort());
}

let combined: FactsTable;
beforeAll(async () => {
  combined = computeFacts(await ingestAll(THREE));
});

// ------------------------------------------------------------------- ingest

describe('ingestAll', () => {
  it('reads three exports into one dataset with a source entry per file', async () => {
    const ds = await ingestAll(THREE);
    expect(ds.adapter).toBe('combined');
    expect(ds.currency).toBe('USD');
    expect(ds.platform).toBe('Amazon DSP + Google Ads + Meta');
    expect(ds.mapping).toEqual({});
    expect(ds.sources!.map((s) => [s.platform, s.adapter, s.currency, s.rows])).toEqual([
      ['Amazon DSP', 'amazon-dsp', 'USD', 56],
      ['Google Ads', 'google-ads', 'USD', 56],
      ['Meta', 'meta', 'USD', 56],
    ]);
    expect(ds.rows).toHaveLength(168);
    // Each file keeps its own mapping and warnings; the dataset's warnings name the file.
    expect(ds.sources![1].mapping.spend).toBe('Cost (micros)');
    expect(ds.sources![1].warnings.some((w) => w.startsWith('Converted "Cost (micros)"'))).toBe(true);
    expect(ds.warnings).toContain('google-ads.csv: Converted "Cost (micros)" from micros to major currency units (divided by 1,000,000).');
    expect(blockingWarnings(ds)).toEqual([]);
  });

  it('one file is the same dataset ingest() gives, plus sources', async () => {
    const one = await ingestAll([GOOGLE]);
    const { sources, ...rest } = one;
    expect(rest).toEqual(await ingest(GOOGLE));
    expect(sources).toHaveLength(1);
    expect(sources![0]).toMatchObject({ file: GOOGLE, platform: 'Google Ads', adapter: 'google-ads', currency: 'USD', rows: 56 });
  });

  it('refuses exports in different currencies: no conversion, code would have to invent a rate', async () => {
    const eur = join(tmp(), 'meta-eur.csv');
    writeFileSync(eur, readFileSync(META, 'utf8').replace('Amount spent (USD)', 'Amount spent (EUR)'));
    expect((await ingest(eur)).currency).toBe('EUR');
    const err = await ingestAll([GOOGLE, eur]).catch((e) => e);
    expect(err).toBeInstanceOf(MixedCurrencyError);
    expect(err.message).toContain('google-ads.csv: USD, meta-eur.csv: EUR');
    expect(err.message).toMatch(/no currency conversion/);
    await expect(runNoro({ files: [GOOGLE, eur], cwd: ROOT, config, stateDir: tmp(), clients: clients() })).rejects.toBeInstanceOf(MixedCurrencyError);
  });

  it('partially overlapping dates: cut to the shared window, with a blocking warning', async () => {
    const late = variant(AMAZON, 'amazon-late.csv', (c, iso) => (iso >= '2026-10-01' ? c : null));
    const ds = await ingestAll([GOOGLE, META, late]);
    const blocking = blockingWarnings(ds);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toContain('amazon-late.csv 2026-10-01 to 2026-10-12');
    expect(blocking[0]).toContain('using only the dates every export covers, 2026-10-01 to 2026-10-12');
    // Google and Meta lose their first two days (4 campaigns × 2 days each).
    expect(blocking[0]).toContain('dropped 16 rows');
    expect(ds.rows.every((r) => r.date! >= '2026-10-01')).toBe(true);
    expect(ds.sources!.map((s) => s.rows)).toEqual([48, 48, 48]);
    // The windows are then the same days on every channel (12 days → two halves of six).
    const t = computeFacts(ds);
    expect(t.periods).toEqual({ current: 'Oct 7–12', previous: 'Oct 1–6' });
    // The run stops before any model call unless the warning is accepted.
    const log: MockLog = { chat: [], jev: [] };
    const c = { chat: createMockChat({ log }), jev: createMockJev(log) };
    await expect(runNoro({ files: [GOOGLE, META, late], cwd: ROOT, config, stateDir: tmp(), clients: c })).rejects.toBeInstanceOf(IngestWarningError);
    expect(log.chat.length + log.jev.length).toBe(0);
    const report = await runNoro({ files: [GOOGLE, META, late], cwd: ROOT, config, stateDir: tmp(), clients: c, acceptWarnings: true });
    expect(report.warnings).toContain(blocking[0]);
  });

  it('dates with no day in common are refused: one report would compare different weeks', async () => {
    const early = variant(GOOGLE, 'google-early.csv', (c, iso) => (iso <= '2026-10-05' ? c : null));
    const late = variant(META, 'meta-late.csv', (c, iso) => (iso >= '2026-10-06' ? c : null));
    const err = await ingestAll([early, late]).catch((e) => e);
    expect(err).toBeInstanceOf(CombineError);
    expect(err.message).toMatch(/no day in common \(google-early\.csv 2026-09-29 to 2026-10-05, meta-late\.csv 2026-10-06 to 2026-10-12\)/);
  });

  it('the same export twice is refused (every row would count twice)', async () => {
    const copy = join(tmp(), 'copy.csv');
    writeFileSync(copy, readFileSync(META));
    await expect(ingestAll([META, copy])).rejects.toThrow(/same export/);
  });

  it('a written report cannot be mixed with exports', async () => {
    const md = join(ROOT, 'bench/corpus/01-weekly-email-hedges/original.md');
    const err = await runNoro({ files: [GOOGLE, md], cwd: ROOT, config, stateDir: tmp(), clients: clients() }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/audited on its own/);
    await expect(factsFor([GOOGLE, md])).rejects.toBeInstanceOf(FactsUsageError);
  });
});

// ------------------------------------------------------------------ compute

describe('compute: the channel scope', () => {
  it('blended totals across platforms are labelled "all channels" (hand-checked)', () => {
    // Weekly spend per platform: Google 13,440.00 → 13,678.30; Meta (×0.8) 10,752.00 → 10,942.64;
    // Amazon DSP (×1.5) 20,160.00 → 20,517.45. Conversions 487 → 443 on each. Value 46,800 → 42,630 on each.
    const spendCur = 13678.3 + 10942.64 + 20517.45; // 45,138.39
    const spendPrev = 13440 + 10752 + 20160; // 44,352
    expect(byKey(combined, 'spend:account:period=current')).toMatchObject({ label: 'Spend, all channels, current week', value: 45138.39, display: '$45,138' });
    expect(byKey(combined, 'spend:account:period=previous').value).toBe(spendPrev);
    expect(byKey(combined, 'conversions:account:period=current').value).toBe(1329);
    const cpa = byKey(combined, 'cpa:account:period=current');
    expect(cpa.value).toBeCloseTo(spendCur / 1329, 6); // 33.964176
    expect(cpa).toMatchObject({ label: 'CPA, all channels, current week', display: '$33.96' });
    expect(byKey(combined, 'cpa:account:period=previous').value).toBeCloseTo(44352 / 1461, 6); // 30.35729
    expect(byKey(combined, 'cpa:account:change=pct').value).toBeCloseTo(((45138.39 / 1329 - 44352 / 1461) / (44352 / 1461)) * 100, 4);
    const roas = byKey(combined, 'roas:account:period=current');
    expect(roas.value).toBeCloseTo((42630 * 3) / spendCur, 6); // 2.833287
    expect(roas.display).toBe('2.8x');
    expect(byKey(combined, 'roas:account:period=previous').value).toBeCloseTo((46800 * 3) / 44352, 6);
    // Blended is not the average of the channel CPAs: it is total spend over total conversions.
    const avg = (13678.3 / 443 + 10942.64 / 443 + 20517.45 / 443) / 3;
    expect(avg).toBeCloseTo(cpa.value!, 6); // equal here only because every channel has 443 conversions
  });

  it('per-platform totals, rates and week-over-week changes', () => {
    expect(combined.channels).toEqual(['Amazon DSP', 'Google Ads', 'Meta']);
    const meta = (k: string) => byKey(combined, k.replace('@', 'platform=Meta'));
    expect(meta('spend:@:period=current')).toMatchObject({ label: 'Spend, Meta channel, current week', value: 10942.64, scope: { metric: 'spend', platform: 'Meta', period: 'current' } });
    expect(meta('cpa:@:period=current').value).toBeCloseTo(10942.64 / 443, 6); // 24.701219
    expect(meta('cpa:@:period=previous').value).toBeCloseTo(10752 / 487, 6);
    expect(meta('cpa:@:change=pct').label).toBe('CPA, Meta channel, percent change, previous to current week (up)');
    expect(meta('ctr:@:change=pp').scope).toMatchObject({ platform: 'Meta', dimension: 'pp_change' });
    expect(meta('roas:@:period=current').value).toBeCloseTo(42630 / 10942.64, 6);
    for (const p of combined.channels!) for (const m of ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'ctr', 'cpc', 'cpa', 'cvr', 'roas']) {
      for (const k of ['period=current', 'period=previous', 'change=pct']) byKey(combined, `${m}:platform=${p}:${k}`);
    }
  });

  it("each channel's share of total spend and of conversions: current, previous and pp change", () => {
    const share = byKey(combined, 'spend_share:platform=Meta:period=current');
    expect(share.label).toBe('Share of total spend, Meta channel, current week');
    expect(share.value).toBeCloseTo((10942.64 / 45138.39) * 100, 4); // 24.2424 (Meta is 0.8 / 3.3 of spend)
    expect(share.formula).toBe('channel spend / all-channel spend * 100 = 10942.64 / 45138.39 * 100');
    expect(byKey(combined, 'spend_share:platform=Amazon DSP:period=previous').value).toBeCloseTo((20160 / 44352) * 100, 4); // 45.4545
    expect(byKey(combined, 'conversions_share:platform=Google Ads:period=current').value).toBeCloseTo((443 / 1329) * 100, 4);
    const pp = byKey(combined, 'spend_share:platform=Meta:change=pp');
    expect(pp.kind).toBe('pp');
    expect(pp.inputs).toEqual([byKey(combined, 'spend_share:platform=Meta:period=previous').id, share.id]);
    // The fixtures scale spend the same both weeks, so shares hold.
    expect(pp.display).toBe('0.00 pp');
    expect(pp.label).toMatch(/\(no change\)$/);
    // Shares of a whole add up to the whole.
    const sum = combined.channels!.reduce((s, p) => s + byKey(combined, `spend_share:platform=${p}:period=current`).value!, 0);
    expect(sum).toBeCloseTo(100, 4);
  });

  it('a moved share, hand-checked: Meta doubles its current-week spend', async () => {
    const t = computeFacts(await ingestAll([GOOGLE, metaShift(), AMAZON]));
    const metaCur = 10942.64 * 2; // 21,885.28
    const total = 13678.3 + metaCur + 20517.45; // 56,081.03
    expect(byKey(t, 'spend:platform=Meta:period=current').value).toBeCloseTo(metaCur, 6);
    expect(byKey(t, 'spend:account:period=current').value).toBeCloseTo(total, 6);
    const pp = byKey(t, 'spend_share:platform=Meta:change=pp');
    expect(pp.value).toBeCloseTo((metaCur / total) * 100 - (10752 / 44352) * 100, 4); // 39.0244 - 24.2424 = +14.78
    expect(pp.display).toBe('+14.8 pp');
    expect(pp.label).toBe('Share of total spend, Meta channel, change in percentage points, previous to current week (up)');
    expect(byKey(t, 'spend_share:platform=Amazon DSP:change=pp').value).toBeCloseTo((20517.45 / total) * 100 - (20160 / 44352) * 100, 4);
    expect(byKey(t, 'cpa:account:period=current').value).toBeCloseTo(total / 1329, 6); // blended CPA 42.20
    // The conversion shares did not move: only Meta's cost did.
    expect(byKey(t, 'conversions_share:platform=Meta:change=pp').display).toBe('0.00 pp');
    // Rules put the moved share up front (a headline candidate), with Meta's CPA change as a signal.
    const labels = new Map(classifyByRules(t).map((c) => [c.factId, c]));
    expect(labels.get(pp.id)).toMatchObject({ label: 'signal', priority: 1 });
    expect(labels.get(byKey(t, 'cpa:platform=Meta:change=pct').id)!.label).toBe('signal');
    expect(describeFact(pp)).toMatchObject({ scope: 'channel', platform: 'Meta', change: 'share change', direction: 'up', magnitude: 'large' });
  });

  it('campaign facts stay per platform and name it; campaign shares are of their channel', () => {
    const f = byKey(combined, 'cpa:platform=Meta:campaign=PR-07 Prospecting:period=current');
    expect(f.label).toBe('CPA, Meta campaign PR-07 Prospecting, current week');
    expect(f.scope).toEqual({ metric: 'cpa', platform: 'Meta', campaign: 'PR-07 Prospecting', period: 'current' });
    expect(f.value).toBeCloseTo(33.12, 6); // 6,210 × 0.8 / 150
    expect(byKey(combined, 'cpa:platform=Google Ads:campaign=PR-07 Prospecting:period=current').value).toBeCloseTo(41.4, 6);
    const s = byKey(combined, 'spend_share:platform=Meta:campaign=PR-07 Prospecting:period=current');
    expect(s.label).toBe('Share of Meta channel spend, Meta campaign PR-07 Prospecting, current week');
    expect(s.value).toBeCloseTo(((6210 * 0.8) / 10942.64) * 100, 4);
  });

  it('ids and keys are deterministic: unique, the same on every run and in any argument order', async () => {
    const keys = combined.facts.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(combined.facts.map((f) => f.id)).toEqual(combined.facts.map((_, i) => `f${i + 1}`));
    const again = computeFacts(await ingestAll([AMAZON, GOOGLE, META]));
    expect(JSON.stringify(again)).toBe(JSON.stringify(combined));
    // Order: blended first, then each channel, then each channel's campaigns, then the shares.
    expect(combined.facts[0].key).toBe('spend:account:period=current');
    expect(combined.facts[40].key).toBe('spend:platform=Amazon DSP:period=current');
  });

  it('single-file facts are byte-identical to before the channel scope (run keys stay valid)', async () => {
    // sha256 of JSON.stringify(computeFacts(ingest(fixture))), recorded before combined runs existed.
    const pinned: Record<string, string> = {
      'google-ads.csv': '03828914eaf12c13f9aae4bd97729dde691f54ceecde9871585241e1680ee000',
      'meta.csv': '1221903958d0294f5d52e20d280c23ca7926c156183297418f0f735d53daf853',
      'amazon-dsp.csv': 'aaa26d4d46ebbd94fe8d867991857d8c4aa3a2bfdcd5399aab7abb18a33ac5c4',
      'google-ads.xlsx': '03828914eaf12c13f9aae4bd97729dde691f54ceecde9871585241e1680ee000',
    };
    for (const [name, hash] of Object.entries(pinned)) {
      const t = computeFacts(await ingest(EX(name)));
      expect(createHash('sha256').update(JSON.stringify(t)).digest('hex'), name).toBe(hash);
      expect(t.channels).toBeUndefined();
      expect(t.facts.some((f) => f.scope.platform !== undefined)).toBe(false);
      // Through ingestAll (what runs use now) the table is the same.
      expect(JSON.stringify(computeFacts(await ingestAll([EX(name)])))).toBe(JSON.stringify(t));
    }
    // Two exports of one platform are one channel: no channel scope, accounts are "all accounts" as before.
    const other = join(tmp(), 'google-b.csv');
    writeFileSync(other, readFileSync(GOOGLE, 'utf8').replaceAll('Acme Outdoor', 'Acme Kids'));
    const two = computeFacts(await ingestAll([GOOGLE, other]));
    expect(two.channels).toBeUndefined();
    expect(two.facts[0].label).toBe('Spend, all accounts, current week');
  });
});

// ---------------------------------------------------------- what models see

describe('prompts for a combined run carry words only', () => {
  it('jev state: channel scope and platform in words, no values', () => {
    const reqs = buildJevRequests(combined, 'typesafe/jev-1.13');
    expect(reqs.length).toBeGreaterThan(1);
    const first = reqs[0].state as Record<string, any>;
    expect(first.channels).toEqual(['Amazon DSP', 'Google Ads', 'Meta']);
    expect(first.combined).toMatch(/cross-channel story/);
    const all = Object.assign({}, ...reqs.map((r) => (r.state as any).facts));
    const meta = all[byKey(combined, 'spend_share:platform=Meta:change=pp').id];
    expect(meta).toMatchObject({ scope: 'channel', platform: 'Meta', change: 'share change' });
    for (const r of reqs) assertNoNumbers(jevText(r), combined);
  });

  it('the draft prompt names the channels and asks to lead with the cross-channel story; single-file prompts are unchanged', async () => {
    const labels = classifyByRules(combined);
    const p = buildDraftPrompt({ facts: combined, labels });
    expect(p.system).toContain(CROSS_CHANNEL_RULES);
    expect(p.system).toMatch(/lead with that cross-channel story/);
    expect(p.user).toContain('Channels (one report across platforms): Amazon DSP, Google Ads, Meta.');
    assertNoNumbers(`${p.system}\n${p.user}`, combined);
    const single = computeFacts(await ingest(GOOGLE));
    const s = buildDraftPrompt({ facts: single, labels: classifyByRules(single) });
    expect(s.system).not.toContain('CROSS-CHANNEL');
    expect(s.user).not.toContain('Channels');
    for (const q of [
      buildRevisePrompt({ template: 'CPA rose {{f31}}.', notes: [], facts: combined, labels, task: 'apply' }),
      buildPanelPrompt({ persona: 'cfo', personaText: 'A finance reader.', template: 'CPA rose {{f31}}.', facts: combined, labels }),
    ]) {
      expect(q.user).toContain('Amazon DSP, Google Ads, Meta');
      assertNoNumbers(`${q.system}\n${q.user}`, combined);
    }
  });

  it('a full combined run: no request to either model carries a digit or a fact value', async () => {
    const log: MockLog = { chat: [], jev: [] };
    await runNoro({ files: THREE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat({ log }), jev: createMockJev(log) } });
    expect(log.chat.length).toBeGreaterThan(0);
    expect(log.jev.length).toBeGreaterThan(0);
    const texts = [...log.chat.map((r) => `${r.system}\n${r.user}`), ...log.jev.map(jevText)];
    const displays = combined.facts.filter((f) => f.value !== null && /\d/.test(f.display)).map((f) => f.display);
    for (const t of texts) {
      assertNoNumbers(t, combined);
      const masked = maskNames(t.replace(/\{\{\s*f\d+\s*\}\}/g, ' '), promptNames(combined));
      for (const d of displays) expect(masked.includes(d), `display ${d} reached a model`).toBe(false);
    }
  });
});

// ------------------------------------------------------------ end to end

describe('noro this with several exports (mocked models, real check)', () => {
  it('one report across Google Ads, Meta and Amazon DSP; every number traces to a combined fact', async () => {
    const report = await runNoro({ files: THREE, cwd: ROOT, config, stateDir: tmp(), clients: clients() });
    expect(report.text).toMatch(/^CPA for PR-07 Prospecting on Amazon DSP rose \d/);
    expect(report.text).toMatch(/Blended CPA across all channels rose 12% to \$33\.96\./);
    expect(report.text).toContain('Spend across all channels landed at $45,138.');
    expect(report.sources!.map((s) => s.platform)).toEqual(['Amazon DSP', 'Google Ads', 'Meta']);
    await assertTraced(report, combined);
    const c = await check({ text: report.text, mode: 'generate', facts: combined });
    expect(c.untraced).toEqual([]);
    expect(c.pass).toBe(true);
  });

  it('the channel story: when one platform takes share, the report leads with it', async () => {
    const files = [GOOGLE, metaShift(), AMAZON];
    const facts = computeFacts(await ingestAll(files));
    const report = await runNoro({ files, cwd: ROOT, config, stateDir: tmp(), clients: clients() });
    expect(report.text.split('\n')[0]).toBe("Meta's share of total spend rose 14.8 pp to 39%.");
    expect(report.text).toMatch(/CPA on Meta rose \d+%\./);
    expect(report.text).toMatch(/ on Meta rose /);
    await assertTraced(report, facts);
    expect((await check({ text: report.text, mode: 'generate', facts })).pass).toBe(true);
  });

  it('the run key hashes every file, in any order; one file keys exactly as before', () => {
    const key = (f: string | string[]) => runKeyFor(f, 'generate', 'one-page', config, { injected: { chat: true, jev: true } });
    // Recorded before combined runs existed.
    expect(key(GOOGLE)).toBe('6de66180a89a1df0e57eb907ac797d83');
    expect(runKeyFor(META, 'generate', 'slack', config, {})).toBe('35d32c6da2cd47e243a54cac13497679');
    expect(key([GOOGLE])).toBe(key(GOOGLE));
    expect(key(THREE)).toBe(key([AMAZON, META, GOOGLE]));
    expect(key(THREE)).not.toBe(key([GOOGLE, META]));
    expect(key(THREE)).not.toBe(runKeyFor(THREE, 'generate', 'slack', config, { injected: { chat: true, jev: true } }));
    expect(key([GOOGLE, metaShift(), AMAZON])).not.toBe(key(THREE));
  });

  it('resume: a combined run stopped after classify continues at draft, even with the files in another order', async () => {
    const stateDir = tmp();
    const log: MockLog = { chat: [], jev: [] };
    const c = { chat: createMockChat({ log }), jev: createMockJev(log) };
    const first: StepName[] = [];
    await expect(runNoro({ files: THREE, cwd: ROOT, config, stateDir, clients: c, stopAfter: 'classify', onStep: (s) => first.push(s) })).rejects.toBeInstanceOf(StopAfterError);
    expect(first).toEqual(['ingest', 'compute', 'classify']);
    const jevCalls = log.jev.length;
    const second: StepName[] = [];
    const report = await runNoro({ files: [AMAZON, META, GOOGLE], cwd: ROOT, config, stateDir, clients: c, onStep: (s) => second.push(s) });
    expect(second).toEqual(['draft', 'check', 'panel', 'deliver']);
    expect(log.jev.length).toBe(jevCalls);
    expect(report.summary.resumed).toBe(true);
    expect(report.sources).toHaveLength(3);
    await assertTraced(report, combined);
    // Decisions on a finished combined run rerun deliver only.
    const steps: StepName[] = [];
    const decided = await runNoro({ files: THREE, cwd: ROOT, config, stateDir, clients: c, decisions: [{ flagId: report.flags[0].id, action: 'keep' }], onStep: (s) => steps.push(s) });
    expect(steps).toEqual(['deliver']);
    expect(decided.text).toBe(report.text);
    // A single file in the same state folder is its own run.
    const single: StepName[] = [];
    await runNoro({ file: GOOGLE, cwd: ROOT, config, stateDir, clients: c, onStep: (s) => single.push(s) });
    expect(single).toEqual([...STEPS]);
  });
});

// ------------------------------------------------------------ noro facts, CLI, MCP

describe('noro facts and the CLI with several files', () => {
  const cli = (args: string[]) => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^NORO_/.test(k)) clean[k] = v;
    return spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input: '',
      env: { ...clean, HOME: tmp('noro-home-'), NORO_STATE_DIR: tmp(), NORO_MOCK_MODELS: '1' },
      timeout: 120_000,
    });
  };

  it('factsFor with several exports: the combined table, its sources and a text header naming them', async () => {
    const r = await factsFor(THREE);
    expect(r.adapter).toBe('combined');
    expect(r.channels).toEqual(['Amazon DSP', 'Google Ads', 'Meta']);
    expect(r.facts).toEqual(combined.facts);
    expect(r.sources).toHaveLength(3);
    const text = formatFacts(r);
    expect(text.split('\n')[0]).toBe(`Amazon DSP + Google Ads + Meta (combined), USD, Oct 6–12 vs Sep 29–Oct 5: ${combined.facts.length} facts`);
    expect(text.split('\n')[1]).toBe('Sources: amazon-dsp.csv (Amazon DSP, 56 rows), google-ads.csv (Google Ads, 56 rows), meta.csv (Meta, 56 rows)');
    expect((await factsFor(GOOGLE)).sources).toHaveLength(1);
  });

  it('noro facts a.csv b.csv c.csv --json includes sources and channels', () => {
    const r = cli(['facts', 'fixtures/exports/google-ads.csv', 'fixtures/exports/meta.csv', 'fixtures/exports/amazon-dsp.csv', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.channels).toEqual(['Amazon DSP', 'Google Ads', 'Meta']);
    expect(out.sources.map((s: { platform: string; rows: number }) => [s.platform, s.rows])).toEqual([
      ['Amazon DSP', 56],
      ['Google Ads', 56],
      ['Meta', 56],
    ]);
    expect(r.stderr).toContain('noro: warning: meta.csv: Skipped 1 summary row');
  });

  it('noro this a.csv b.csv c.csv --yes --json: one traced report with sources', async () => {
    const r = cli(['this', 'fixtures/exports/google-ads.csv', 'fixtures/exports/meta.csv', 'fixtures/exports/amazon-dsp.csv', '--yes', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as NoroReport;
    expect(report.sources!.map((s) => s.file.split('/').pop())).toEqual(['amazon-dsp.csv', 'google-ads.csv', 'meta.csv']);
    await assertTraced(report, combined);
  });

  it('usage errors: a missing file, and a report mixed with exports, exit 1', () => {
    const missing = cli(['this', 'fixtures/exports/google-ads.csv', 'no/such.csv', '--yes']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("can't find no/such.csv");
    const mixed = cli(['this', 'fixtures/exports/google-ads.csv', 'bench/corpus/01-weekly-email-hedges/original.md', '--yes']);
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toMatch(/audited on its own/);
  });
});

describe('MCP paths[]', () => {
  async function connect(deps: Parameters<typeof createNoroMcpServer>[0]) {
    const server = createNoroMcpServer(deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, (m: any) => void>();
    clientSide.onmessage = (m: any) => {
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)!(m);
        pending.delete(m.id);
      }
    };
    await server.connect(serverSide);
    await clientSide.start();
    let id = 0;
    const request = (method: string, params?: unknown) =>
      new Promise<any>((done) => {
        const n = ++id;
        pending.set(n, done);
        void clientSide.send({ jsonrpc: '2.0', id: n, method, ...(params ? { params } : {}) } as never);
      });
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
    return { request, close: () => server.close() };
  }
  const mcpConfig = { ...config, python: 'python3' };
  const call = (c: Awaited<ReturnType<typeof connect>>, name: string, args: unknown) => c.request('tools/call', { name, arguments: args }).then((m) => m.result);

  it('noro_facts and noro_this take paths for one combined result; path still works; both or neither is an error', async () => {
    const c = await connect({ config: mcpConfig, clients: clients(), cwd: tmp(), log: () => {} });
    try {
      const facts = await call(c, 'noro_facts', { paths: THREE });
      expect(facts.isError, facts.content?.[0]?.text).toBeFalsy();
      expect(facts.structuredContent.channels).toEqual(['Amazon DSP', 'Google Ads', 'Meta']);
      expect(facts.structuredContent.sources).toEqual([
        { file: AMAZON, platform: 'Amazon DSP', adapter: 'amazon-dsp', currency: 'USD', rows: 56 },
        { file: GOOGLE, platform: 'Google Ads', adapter: 'google-ads', currency: 'USD', rows: 56 },
        { file: META, platform: 'Meta', adapter: 'meta', currency: 'USD', rows: 56 },
      ]);
      expect(facts.structuredContent.facts).toHaveLength(combined.facts.length);
      expect((await call(c, 'noro_facts', { path: GOOGLE })).structuredContent.sources).toHaveLength(1);

      const run = await call(c, 'noro_this', { paths: THREE });
      expect(run.isError, run.content?.[0]?.text).toBeFalsy();
      expect(run.structuredContent.sources).toHaveLength(3);
      await assertTraced(run.structuredContent as NoroReport, combined);
      // Decisions on the combined run: only deliver reruns.
      const again = await call(c, 'noro_this', { paths: [META, AMAZON, GOOGLE], decisions: [{ flagId: run.structuredContent.flags[0].id, action: 'cut' }] });
      expect(again.isError, again.content?.[0]?.text).toBeFalsy();
      expect(again.content[0].text).toContain('Flags (decisions applied):');

      expect((await call(c, 'noro_this', { path: GOOGLE, paths: THREE })).content[0].text).toMatch(/either path or paths/);
      expect((await call(c, 'noro_facts', {})).content[0].text).toMatch(/Give path/);
      const rel = await call(c, 'noro_facts', { paths: [GOOGLE, 'fixtures/exports/meta.csv'] });
      expect(rel.isError).toBe(true);
      expect(rel.content[0].text).toMatch(/absolute/);
    } finally {
      await c.close();
    }
  });
});
