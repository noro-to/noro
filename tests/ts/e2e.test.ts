// End to end: `noro this <export>` with jev and the chat model mocked, run
// through the REAL Python check (engine/noro.py). Also: revision mode on a
// pasted report, the CLI itself (spawned with the test-only
// NORO_MOCK_MODELS=1 switch), and unit tests for buildFlags and deliver.
// No network, no API key.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { check, runEngine } from '../../src/check/index.js';
import { computeFacts } from '../../src/compute/index.js';
import { loadConfig } from '../../src/config.js';
import { buildFlags, deliver, sentenceSpan } from '../../src/deliver/index.js';
import { allowedIdentifiers, maskIdentifiers, renderTemplate } from '../../src/draft/index.js';
import { CheckFailedError, runNoro } from '../../src/harness/index.js';
import type { NoroReport } from '../../src/harness/index.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import { ingest } from '../../src/ingest/index.js';
import type { ChatRequest, CheckReport, Decision, FactsTable, Flag } from '../../src/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const config = { ...loadConfig({}), apiKey: undefined };
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-e2e-'));

async function engineNumbers(text: string): Promise<string[]> {
  const p = join(tmp(), 'final.md');
  writeFileSync(p, text);
  return (await runEngine(['extract', p])).json.numbers.map((n: { raw: string }) => n.raw);
}

/** How a fact can appear in text: its display, or a signed change's display without the sign ("rose 38%"). */
const shownAs = (display: string) => (/^[+\-−]/.test(display) ? [display, display.slice(1)] : [display]);

async function assertTraced(report: NoroReport, facts: FactsTable) {
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  for (const t of report.traces) expect(shownAs(byId.get(t.factId)!.display)).toContain(t.raw);
  const found = await engineNumbers(report.text);
  expect(found.length).toBeGreaterThan(0);
  expect(found.sort()).toEqual(report.traces.map((t) => t.raw).sort());
  expect(report.summary.checked).toBe(report.traces.length);
}

describe('noro this <export> (mocked models, real check)', () => {
  it.each(['google-ads.csv', 'meta.csv', 'amazon-dsp.csv', 'google-ads.xlsx'])('%s → a delivered report with every number traced', async (name) => {
    const file = join(ROOT, 'fixtures/exports', name);
    const facts = computeFacts(await ingest(file));
    const report = await runNoro({ file, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() } });
    // "rose +38%" renders as "rose 38%": the direction word already says the sign.
    expect(report.text).toMatch(/^CPA for PR-07 Prospecting rose \d/);
    expect(report.decisions).toHaveLength(report.flags.length);
    await assertTraced(report, facts);
    // The real engine agrees: nothing untraced, no rule errors.
    const c = await check({ text: report.text, mode: 'generate', facts });
    expect(c.untraced).toEqual([]);
    expect(c.pass).toBe(true);
  });

  it('flags carry no number that is not a fact display', async () => {
    const file = join(ROOT, 'fixtures/exports/google-ads.csv');
    const facts = computeFacts(await ingest(file));
    const report = await runNoro({ file, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() } });
    // A change after "rose"/"fell" renders without its sign, and a flag quoting that sentence shows it so.
    const displays = new Set(facts.facts.flatMap((f) => [f.display, f.display.replace(/^[+\-]/, '')]));
    for (const f of report.flags) {
      const masked = maskIdentifiers(f.text, allowedIdentifiers(facts));
      for (const m of masked.matchAll(/[$€£+\-]?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|pp|x))?/g)) expect(displays.has(m[0].trim()), `flag ${f.id}: ${m[0]}`).toBe(true);
    }
  });
});

describe('check gate (generate mode)', () => {
  const FILE = join(ROOT, 'fixtures/exports/google-ads.csv');
  const sloppy = (req: ChatRequest) => {
    const m = req.user.match(/\{\{(f\d+)\}\} \| CPA, campaign PR-07 Prospecting, percent change/)!;
    return `It's worth noting that CPA for PR-07 Prospecting rose {{${m[1]}}}.\nNext: the media buyer reviews PR-07 Prospecting bids by Friday.`;
  };

  it('a draft with an error-level tell gets one automatic revision from the check notes', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const base = createMockChat({ log, draft: sloppy });
    const chat = {
      async complete(req: ChatRequest) {
        if (req.json && req.system.includes('revising a draft report after review') && req.user.includes('Filler opener')) {
          const t = req.user.match(/"""\n([\s\S]*?)\n"""/)![1];
          return JSON.stringify({ template: t.replace("It's worth noting that CPA", 'CPA'), applied: ['A'], rejected: [] });
        }
        return base.complete(req);
      },
    };
    const report = await runNoro({ file: FILE, cwd: ROOT, config, stateDir: tmp(), clients: { chat, jev: createMockJev() } });
    expect(report.text).toMatch(/^CPA for PR-07 Prospecting rose \d/);
    expect(report.text).not.toContain('worth noting');
  });

  it('when the revision does not fix it, the run fails with CheckFailedError', async () => {
    const chat = createMockChat({ draft: sloppy }); // the canned reviser returns the template unchanged
    await expect(runNoro({ file: FILE, cwd: ROOT, config, stateDir: tmp(), clients: { chat, jev: createMockJev() } })).rejects.toBeInstanceOf(CheckFailedError);
  });
});

describe('revision mode (.md enters at check)', () => {
  const FILE = join(ROOT, 'bench/corpus/01-weekly-email-hedges/original.md');

  /** A reviser that cuts the pasted report to two lines, using only the references it was shown. */
  function rewriter(log: ChatRequest[]) {
    const base = createMockChat();
    return {
      async complete(req: ChatRequest) {
        log.push(req);
        if (req.json && req.system.includes('editing a paid-media report')) {
          const t = req.user.match(/"""\n([\s\S]*?)\n"""/)![1];
          const a = t.match(/Spend came in at \{\{(f\d+)\}\}, which represents a \{\{(f\d+)\}\}/)!;
          const c = t.match(/CPA improved to \{\{(f\d+)\}\} from \{\{(f\d+)\}\}/)!;
          return JSON.stringify({
            template: `Spend rose {{${a[2]}}} to {{${a[1]}}}, and CPA improved to {{${c[1]}}} from {{${c[2]}}}.\nNext: raise the daily budget on Search – NB – Cat Litter, which is limited by budget.`,
            applied: ['B', 'C'],
            rejected: [],
          });
        }
        return base.complete(req);
      },
    };
  }

  it('rewrites shorter, every number traces to the original, and no model saw a number', async () => {
    const log: ChatRequest[] = [];
    const steps: string[] = [];
    const report = await runNoro({ file: FILE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: rewriter(log), jev: createMockJev() }, onStep: (s) => steps.push(s) });
    expect(steps).toEqual(['check', 'panel', 'deliver']);
    expect(report.summary.mode).toBe('revise');
    expect(report.summary.words.final).toBeLessThan(report.summary.words.original!);
    expect(report.text).toContain('$8,412');
    const original = (await import('node:fs')).readFileSync(FILE, 'utf8');
    for (const n of await engineNumbers(report.text)) expect(original).toContain(n);
    expect(report.traces.map((t) => t.raw).sort()).toEqual((await engineNumbers(report.text)).sort());
    // The original's numbers never reached a model: only {{fN}}, and "Oct 5–11" / "Oct 6" as names.
    expect(log.length).toBeGreaterThan(0);
    for (const req of log) {
      const text = `${req.system}\n${req.user}`.replace(/\{\{\s*f\d+\s*\}\}/g, ' ').replace(/Oct 5–11|Oct 6/g, ' ');
      expect(text.match(/.{0,20}\d.{0,20}/)?.[0] ?? null).toBeNull();
    }
  });
});

describe('CLI (test-only NORO_MOCK_MODELS=1)', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('npx', ['tsx', 'src/cli.ts', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, OPENROUTER_API_KEY: '', NORO_STATE_DIR: tmp(), ...env },
      timeout: 120_000,
    });

  it('noro this fixtures/exports/google-ads.csv --yes --json prints a traced Report', async () => {
    const r = cli(['this', 'fixtures/exports/google-ads.csv', '--yes', '--json'], { NORO_MOCK_MODELS: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('NORO_MOCK_MODELS=1');
    const report = JSON.parse(r.stdout) as NoroReport;
    const facts = computeFacts(await ingest(join(ROOT, 'fixtures/exports/google-ads.csv')));
    await assertTraced(report, facts);
  });

  it('prints the report and the footer', () => {
    const r = cli(['this', 'fixtures/exports/google-ads.csv', '--yes'], { NORO_MOCK_MODELS: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^CPA for PR-07 Prospecting rose/);
    expect(r.stdout).toMatch(/Checked: \d+ numbers traced\. Panel: \d+ notes?, \d+ applied\./);
    expect(r.stdout).not.toMatch(/\b1 notes\b|\b1 numbers\b/);
  });

  it('without a key (and no mock) it explains how to set one, exit 1', () => {
    const r = cli(['this', 'fixtures/exports/google-ads.csv', '--yes'], { NORO_MOCK_MODELS: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('OPENROUTER_API_KEY is not set');
  });

  it('usage errors exit 1; a check that cannot pass exits 2', () => {
    expect(cli(['that', 'x.csv']).status).toBe(1);
    expect(cli(['this', 'no/such/file.csv'], { NORO_MOCK_MODELS: '1' }).status).toBe(1);
    // The canned reviser only halves a pasted report, so the real check rejects it: exit 2.
    const r = cli(['this', 'bench/corpus/01-weekly-email-hedges/original.md', '--yes'], { NORO_MOCK_MODELS: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Check failed');
  });
});

describe('buildFlags and deliver', () => {
  let facts: FactsTable;
  beforeAll(async () => {
    facts = computeFacts(await ingest(join(ROOT, 'fixtures/exports/google-ads.csv')));
  });
  const id = (re: RegExp) => facts.facts.find((f) => re.test(f.label))!.id;

  const draftFor = () =>
    renderTemplate(
      `CPA for PR-07 Prospecting rose {{${id(/^CPA, campaign PR-07 Prospecting, percent change/)}}}. DG-05 Demand Gen CPA moved {{${id(/^CPA, campaign DG-05 Demand Gen, percent change/)}}}. Next: review bids by Friday.`,
      facts,
    );

  const checkReport = (match: string): CheckReport => ({
    pass: true,
    mode: 'generate',
    untraced: [],
    length: null,
    findings: [{ rule: 'T-x', name: 'Example rule', category: 'tells', severity: 'warning', match, span: [0, 1], message: `Example: '${match}'`, fix: "Say it plainly: 'based on 38 conversions'." }],
    engine: null,
  });

  it('builds check, panel and watchout flags; stray numbers in rule text become N', () => {
    const d = draftFor();
    const labels = facts.facts.map((f) => ({ factId: f.id, label: (f.flags.includes('small_sample') ? 'luck_risk' : 'signal') as 'luck_risk' | 'signal', priority: 1 as const, watchouts: f.flags.includes('small_sample') ? ['W-small-sample-size'] : [] }));
    const flags = buildFlags(checkReport('Next: review bids'), [{ persona: 'media-buyer', quote: d.template.split('. ')[0], note: 'Say {{f1}} in context; 41 is not a fact.', severity: 'should' }], labels, { facts, draft: d });
    expect(flags.map((f) => f.source)).toEqual(['check', 'panel', 'watchout']);
    expect(flags.map((f) => f.id)).toEqual(['F1', 'F2', 'F3']);
    expect(flags[0].text).toContain("'based on N conversions'");
    expect(flags[1].text).toContain(facts.facts[0].display); // {{f1}} rendered
    expect(flags[1].text).toContain('N is not a fact');
    expect(flags[1].quote).toBe(d.rendered.split('. ')[0]);
    expect(flags[2].text).toContain('luck risk');
    expect(flags[2].quote).toContain('DG-05 Demand Gen CPA moved');
    // Every flag with a quote names the whole sentence that cut removes and reword replaces.
    expect(flags[0].sentence).toBe('Next: review bids by Friday.');
    expect(flags[0].text).toContain('Cut removes the sentence; reword replaces it: "Next: review bids by Friday."');
    expect(flags[1].sentence).toBe(`${flags[1].quote}.`);
    expect(flags[1].text).toContain('Cut removes this sentence; reword replaces it.');
  });

  it('deliver: keep leaves the text, cut removes the sentence, reword replaces the same whole sentence', async () => {
    const d = draftFor();
    const [s1, s2] = d.rendered.split(/(?<=\.) /);
    const flags: Flag[] = [
      { id: 'F1', source: 'check', text: 'keep me', quote: 'Next: review bids' },
      { id: 'F2', source: 'watchout', text: 'cut me', quote: 'DG-05 Demand Gen CPA moved' },
      { id: 'F3', source: 'panel', text: 'reword me', quote: 'rose' },
    ];
    const answers: Record<string, Decision> = {
      F1: { flagId: 'F1', action: 'keep' },
      F2: { flagId: 'F2', action: 'cut' },
      F3: { flagId: 'F3', action: 'reword', text: 'PR-07 Prospecting cost more per conversion' },
    };
    const report = await deliver({ text: d.rendered, facts, flags, decide: async (f) => answers[f.id] });
    // The reword replaced the whole first sentence (not just "rose"); the sentence's period is kept.
    expect(s1).toContain('rose');
    expect(report.text).toBe('PR-07 Prospecting cost more per conversion. Next: review bids by Friday.');
    expect(report.text).not.toContain('DG-05');
    expect(s2).toContain('DG-05');
    expect(report.decisions.map((x) => x.action)).toEqual(['keep', 'cut', 'reword']);
    expect(report.traces).toEqual([]);
  });

  it('deliver: a reword sentence keeps its own punctuation and traces its cited facts', async () => {
    const d = draftFor();
    const fid = d.factIds[0];
    const display = facts.facts.find((f) => f.id === fid)!.display;
    const report = await deliver({
      text: d.rendered,
      facts,
      flags: [{ id: 'F1', source: 'panel', text: 'reword me', quote: 'rose' }],
      decide: async () => ({ flagId: 'F1', action: 'reword', text: `CPA moved {{${fid}}}!` }),
    });
    expect(report.text.startsWith(`CPA moved ${display}! `)).toBe(true);
    expect(report.text).not.toContain('rose');
    expect(report.traces[0]).toEqual({ raw: display, factId: fid });
  });

  it('deliver: a reword may cite {{fN}} or an exact display; any other number is refused and asked again', async () => {
    const d = draftFor();
    const asked: Flag[] = [];
    const tries = ['rose 41%', `rose {{${d.factIds[0]}}} again`];
    const report = await deliver({
      text: d.rendered,
      facts,
      flags: [{ id: 'F1', source: 'panel', text: 'reword', quote: 'rose' }],
      decide: async (f) => {
        asked.push(f);
        return { flagId: f.id, action: 'reword', text: tries[asked.length - 1] };
      },
    });
    expect(asked).toHaveLength(2);
    expect(asked[1].text).toContain('refused');
    expect(asked[1].text).not.toContain('41');
    expect(report.decisions[0]).toEqual({ flagId: 'F1', action: 'reword', text: `rose ${facts.facts.find((f) => f.id === d.factIds[0])!.display} again` });
  });

  it('sentenceSpan does not split on decimal points', () => {
    const t = 'CPA hit $41.40 this week. Spend held.';
    const [s, e] = sentenceSpan(t, t.indexOf('$41'), t.indexOf('$41') + 3);
    expect(t.slice(s, e)).toBe('CPA hit $41.40 this week.');
  });
});

describe('mock log sanity', () => {
  it('the CLI mock switch is off by default', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
    expect(src).toContain("process.env.NORO_MOCK_MODELS === '1'");
    const log: MockLog = { chat: [], jev: [] };
    await createMockChat({ log }).complete({ model: 'm', system: 's', user: 'u' });
    expect(log.chat).toHaveLength(1);
  });
});
