// The arithmetic rule, end to end and unit by unit:
//   - every number in the final report resolves to a fact id in the facts table;
//   - a model that writes a raw number fails the run;
//   - renderTemplate's digit rule;
//   - no prompt sent to the chat model or to jev carries a fact value or display.
// No network, no API key: both models are mocked and every request is captured.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runEngine } from '../../src/check/index.js';
import { buildJevRequests, classify, batchFacts } from '../../src/classify/index.js';
import { computeFacts } from '../../src/compute/index.js';
import { loadConfig } from '../../src/config.js';
import {
  RawNumberError,
  buildDraftPrompt,
  draft,
  renderTemplate,
  scrubNumbers,
  templateQuote,
  traceNumbers,
} from '../../src/draft/index.js';
import { runNoro } from '../../src/harness/index.js';
import { createMockChat, createMockJev, mockDraftFrom } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import { ingest } from '../../src/ingest/index.js';
import type { ChatRequest, FactsTable } from '../../src/schema.js';
import { assertNoNumbers, maskNames, promptNames } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');
const config = { ...loadConfig({}), apiKey: undefined };

let facts: FactsTable;
beforeAll(async () => {
  facts = computeFacts(await ingest(FIXTURE));
});

const tmp = () => mkdtempSync(join(tmpdir(), 'noro-trace-'));

/** Every number the engine's own extractor finds in a text. */
async function engineNumbers(text: string): Promise<string[]> {
  const dir = tmp();
  const p = join(dir, 'final.md');
  writeFileSync(p, text);
  const ex = await runEngine(['extract', p]);
  return ex.json.numbers.map((n: { raw: string }) => n.raw);
}

/** No fact's display or value appears as a standalone token. */
function assertNoValues(raw: string, table: FactsTable, allow: string[] = []) {
  // Names and period labels may coincide with a display ("12" in "Oct 6–12"); they are not leaks.
  const text = maskNames(raw.replace(/\{\{\s*f\d+\s*\}\}/g, ' '), promptNames(table, allow));
  for (const f of table.facts) {
    if (f.value === null) continue;
    const esc = f.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(new RegExp(`(^|[^\\p{L}\\p{Nd}{])${esc}(?![\\p{Nd}])`, 'u').test(text), `display ${f.display} of ${f.id} leaked`).toBe(false);
    expect(text.includes(String(f.value)) && /\d{2,}/.test(String(f.value)) && !/\{\{f\d+\}\}/.test(String(f.value)) ? text.match(new RegExp(`(^|[^\\p{Nd}.f])${String(f.value).replace('.', '\\.')}(?![\\p{Nd}])`, 'u')) : null).toBeNull();
  }
}

describe('final report traceability', () => {
  it('every number in the delivered report resolves to a fact id with that display', async () => {
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() } });
    const byId = new Map(facts.facts.map((f) => [f.id, f]));
    expect(report.traces.length).toBeGreaterThan(0);
    for (const t of report.traces) {
      expect(byId.has(t.factId)).toBe(true);
      const display = byId.get(t.factId)!.display;
      // A signed change shows without its sign right after "rose" / "fell" ("rose 38%").
      expect(/^[+\-]/.test(display) ? [display, display.slice(1)] : [display]).toContain(t.raw);
    }
    // Independent of noro's own tracer: the engine's extractor finds exactly the traced numbers.
    const found = await engineNumbers(report.text);
    expect(found.length).toBeGreaterThan(0);
    expect(found.sort()).toEqual(report.traces.map((t) => t.raw).sort());
  });

  it('a draft that sneaks in a raw number fails the run (after one retry)', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const chat = createMockChat({ log, draft: 'CPA rose 41% for PR-07 Prospecting.\nNext: review bids by Friday.' });
    await expect(runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat, jev: createMockJev() } })).rejects.toBeInstanceOf(RawNumberError);
    const draftCalls = log.chat.filter((r) => r.system.includes('FORMAT:'));
    expect(draftCalls).toHaveLength(2);
    // The retry is told why, without the raw number being echoed back.
    expect(draftCalls[1].user).toContain('rejected by the number check');
    expect(draftCalls[1].user).not.toContain('41%');
  });

  it('a draft that fixes itself on the retry goes through', async () => {
    const chat = createMockChat({ draft: (req, attempt) => (attempt === 0 ? 'CPA rose 41%.' : mockDraftFrom(req.user)) });
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat, jev: createMockJev() } });
    expect(report.text).not.toContain('41%');
    expect(report.traces.length).toBeGreaterThan(0);
  });

  it('a reviser that adds a number is refused; the checked draft stands', async () => {
    const base = createMockChat({ panel: (p, t) => (p === 'media-buyer' ? [{ quote: t.split('\n')[0], problem: 'Add the total.', fix: 'say it', severity: 'should' }] : []) });
    const chat = {
      async complete(req: ChatRequest) {
        if (req.json && req.system.includes('"template"')) return JSON.stringify({ template: 'CPA rose 41% overall.', applied: ['A'], rejected: [] });
        return base.complete(req);
      },
    };
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat, jev: createMockJev() } });
    expect(report.text).not.toContain('41%');
    expect(report.summary.panel).toEqual({ notes: 1, applied: 0 });
    expect(report.flags.some((f) => f.source === 'panel')).toBe(true);
  });

  it('a user reword with an untraced number is refused and asked again', async () => {
    const asked: string[] = [];
    const report = await runNoro({
      file: FIXTURE,
      cwd: ROOT,
      config,
      stateDir: tmp(),
      clients: { chat: createMockChat(), jev: createMockJev() },
      decide: async (f) => {
        asked.push(f.text);
        if (f.source !== 'panel') return { flagId: f.id, action: 'keep' };
        return asked.filter((t) => t.includes('refused')).length === 0
          ? { flagId: f.id, action: 'reword', text: 'CPA for PR-07 Prospecting rose 41%.' }
          : { flagId: f.id, action: 'reword', text: 'CPA for PR-07 Prospecting rose {{f191}}, an early read.' };
      },
    });
    expect(asked.some((t) => t.includes('refused'))).toBe(true);
    expect(report.text).toContain('an early read');
    expect(report.text).not.toContain('41%');
    for (const n of await engineNumbers(report.text)) expect(report.traces.map((t) => t.raw)).toContain(n);
  });
});

describe('renderTemplate (the digit rule)', () => {
  const f = (id: string) => facts.facts.find((x) => x.id === id)!;

  it('renders references as displays and lists cited ids', () => {
    const d = renderTemplate('CPA for PR-07 Prospecting rose {{f191}} to {{ f189 }} in Oct 6–12. Spend: {{f1}}.', facts);
    // f191 is "+38%": after "rose" the sign is redundant and dropped.
    expect(f('f191').display.startsWith('+')).toBe(true);
    expect(d.rendered).toBe(`CPA for PR-07 Prospecting rose ${f('f191').display.slice(1)} to ${f('f189').display} in Oct 6–12. Spend: ${f('f1').display}.`);
    expect(d.factIds).toEqual(['f191', 'f189', 'f1']);
  });

  it.each([
    ['CPA rose 41%.', 'raw_number'],
    ['Spend hit $13,678 ({{f1}}).', 'raw_number'],
    ['Over the last 7 days CPA rose {{f191}}.', 'raw_number'],
    ['CPA for PR-07% rose.', 'raw_number'],
    ['CPA doubled.', 'spelled_number'],
    ['CPA rose forty percent.', 'spelled_number'],
    ['Clicks were three times higher.', 'spelled_number'],
    ['CPA rose {{f9999}}.', 'unknown_fact'],
    ['CPA rose {{f191.value}}.', 'bad_reference'],
    ['CPA rose {{n1}}.', 'bad_reference'],
  ])('rejects %j (%s)', (template, kind) => {
    try {
      renderTemplate(template, facts);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RawNumberError);
      expect((err as RawNumberError).kind).toBe(kind);
    }
  });

  it('allows digits only inside campaign names and period labels', () => {
    expect(() => renderTemplate('PR-07 Prospecting, PR-03 Brand and DG-05 Demand Gen, Sep 29–Oct 5 vs Oct 6–12: {{f1}}.', facts)).not.toThrow();
  });

  it('refuses to cite a fact with no value', () => {
    const table: FactsTable = { ...facts, facts: [...facts.facts, { ...facts.facts[0], id: 'f9000', value: null, display: 'n/a' }] };
    expect(() => renderTemplate('CPA was {{f9000}}.', table)).toThrow(/no value/);
  });

  it('maps rendered quotes back to template form without displays', () => {
    const d = renderTemplate('CPA for PR-07 Prospecting rose {{f191}} to {{f189}}. Next: review bids.', facts);
    const q = templateQuote(d, facts, `rose ${f('f191').display.slice(1)} to`);
    expect(q).toBe('rose {{f191}} to');
    expect(templateQuote(d, facts, f('f189').display.slice(1))).toBe('{{f189}}');
  });

  it('scrubs stray numbers but keeps references and names', () => {
    expect(scrubNumbers('PR-07 Prospecting rose {{f191}}; based on 38 conversions at $41.40.', facts)).toBe('PR-07 Prospecting rose {{f191}}; based on N conversions at N.');
  });

  it('traceNumbers prefers cited facts and reports untraced digits', () => {
    const t = traceNumbers(`Spend ${f('f1').display}, CPA ${f('f189').display}, and 41% more.`, facts, { prefer: ['f189'] });
    expect(t.traces.map((x) => x.factId)).toEqual(['f1', 'f189']);
    expect(t.untraced).toEqual(['41%']);
  });
});

describe('what the models see', () => {
  it('no chat or jev request in a full run carries a fact value or display', async () => {
    const log: MockLog = { chat: [], jev: [] };
    await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat({ log }), jev: createMockJev(log) } });
    expect(log.chat.length).toBeGreaterThanOrEqual(7); // draft + five personas + reviser
    expect(log.jev.length).toBeGreaterThan(0);
    for (const req of log.chat) {
      assertNoNumbers(`${req.system}\n${req.user}`, facts);
      assertNoValues(`${req.system}\n${req.user}`, facts);
    }
    for (const req of log.jev) {
      // jev addresses facts by bare id: "f12" keys, f12__label question ids, `facts.f12` paths.
      const text = JSON.stringify({ state: req.state, questions: req.questions }).replace(/(?<![\p{L}\p{Nd}])f\d+(?!\p{Nd})/gu, ' ');
      assertNoNumbers(text, facts);
      assertNoValues(text, facts);
      expect(text).not.toMatch(/"(value|display|formula|sampleSize)"/);
    }
  });

  it('the draft prompt has ids, labels and classification, and no formula or display', () => {
    const labels = facts.facts.map((x) => ({ factId: x.id, label: 'signal' as const, priority: 1 as const, watchouts: ['W-small-sample-size'] }));
    const p = buildDraftPrompt({ facts, labels, format: 'slack' });
    const pr07 = facts.facts.find((x) => x.label.startsWith('CPA, campaign NB-11 Generic, percent change'))!;
    expect(p.user).toContain(`{{${pr07.id}}} | ${pr07.label} | signal, priority one, watchouts: W-small-sample-size`);
    expect(p.user).not.toContain(pr07.formula);
    assertNoNumbers(p.system + p.user, facts);
    assertNoValues(p.system + p.user, facts);
  });

  it('jev requests fit the context budget and carry coarse descriptors only', async () => {
    const reqs = buildJevRequests(facts, 'typesafe/jev-1.13');
    expect(reqs.length).toBe(batchFacts(facts).length);
    for (const r of reqs) expect(JSON.stringify(r).length / 3.5).toBeLessThan(32_000);
    const first = Object.values(reqs[0].state.facts as Record<string, Record<string, unknown>>)[0];
    expect(Object.keys(first).sort()).toEqual(expect.arrayContaining(['label', 'metric', 'direction', 'magnitude', 'sample']));
    const labels = await classify(facts, createMockJev(), { model: 'typesafe/jev-1.13' });
    expect(labels).toHaveLength(facts.facts.length);
    const dg05 = facts.facts.find((x) => x.label.startsWith('CPA, campaign DG-05 Demand Gen, percent change'))!;
    const c = labels.find((l) => l.factId === dg05.id)!;
    expect(c.label).toBe('luck_risk');
    expect(c.watchouts).toContain('W-small-sample-size');
  });

  it('draft() retries once with the error, then throws RawNumberError', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const chat = createMockChat({ log, draft: 'Spend was 13678 dollars.' });
    await expect(draft({ facts, labels: [], chat, model: 'm' })).rejects.toThrow(RawNumberError);
    expect(log.chat).toHaveLength(2);
  });
});
