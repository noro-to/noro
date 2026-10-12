// Regressions for the v0.2 hardening review of the digit rule (template check, revision-mode
// allow list, rewords at deliver). Each block names the defect it pins down. No network,
// no API key: models are mocked, the check is the real engine.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { check, runEngine } from '../../src/check/index.js';
import { computeFacts } from '../../src/compute/index.js';
import { loadConfig } from '../../src/config.js';
import { deliver } from '../../src/deliver/index.js';
import {
  RawNumberError,
  allowedIdentifiers,
  isIdentifierShape,
  renderTemplate,
  templatize,
  traceNumbers,
  validateTemplate,
} from '../../src/draft/index.js';
import type { FoundNumber } from '../../src/draft/index.js';
import { CheckFailedError, runNoro } from '../../src/harness/index.js';
import { createMockChat, createMockJev, mockDraftFrom } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import { ingest } from '../../src/ingest/index.js';
import type { Decision, FactsTable, Flag } from '../../src/schema.js';
import { assertNoNumbers } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');
const config = { ...loadConfig({}), apiKey: undefined };
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-hard-'));

let facts: FactsTable;
beforeAll(async () => {
  facts = computeFacts(await ingest(FIXTURE));
});
const id = (re: RegExp) => facts.facts.find((f) => re.test(f.label))!.id;
const fact = (fid: string) => facts.facts.find((f) => f.id === fid)!;
const CPA_UP = () => id(/^CPA, campaign PR-07 Prospecting, percent change/); // +38%
const CPA_NOW = () => id(/^CPA, campaign PR-07 Prospecting, current week/); // $41.40
const CPC_DOWN = () => id(/^CPC, campaign PR-07 Prospecting, percent change/); // -0.64%

/** The kind of RawNumberError a template raises, or 'ok'. */
function verdict(template: string, opts: Parameters<typeof validateTemplate>[2] = {}): string {
  try {
    validateTemplate(template, facts, opts);
    return 'ok';
  } catch (err) {
    if (err instanceof RawNumberError) return err.kind;
    throw err;
  }
}

/** The report.md the reviewer used for revision mode. */
const REPORT_MD = `Weekly update for Q4 2025, week 41.

CPA rose from $30 to $41.40 (38%) between Oct 6–12 and the week before. Conversions came in at 1,234 vs 980 the prior week. ROAS held at 4.2x and spend hit 12k. CTR moved up 1.2pp. 3 of 5 campaigns improved, and PR-07 drove most of it on 2025-10-06. We saw 1e3 extra clicks and around 15 percent more impressions, a 2:1 ratio of new to returning, with frequency at 3.5/week and CPM £7. Budget is €1.2m for H2 and 30k for FY26.

It's worth noting that overall things are trending and we will keep monitoring moving forward.
`;
const EX_MD =
  'Top 5 campaigns. Ranked #1 overall. CPA is 3rd best and up 2x. Spend x2 vs plan. 1/3 of budget. 3-for-1 deal. Scaled 10X. Down to 1k. Up 25 pct. Ratio 3:2. A 50/50 split. Frequency 2.5 per user. 7-day window. 30 day trial. Day 14 of 30. 1e3 clicks. 4.2e2 impressions. v2 creative. Item 12. Line 4 cost.\n';

async function extracted(text: string): Promise<FoundNumber[]> {
  const p = join(tmp(), 'r.md');
  writeFileSync(p, text);
  return (await runEngine(['extract', p])).json.numbers.map((n: FoundNumber) => ({ raw: n.raw, span: n.span, value: n.value, kind: n.kind, unit: n.unit }));
}

describe('defect 1: numbers spelled out in words are refused', () => {
  it.each([
    'at forty-one dollars a conversion.',
    'and Brand spend is double last week.',
    'and Brand spend could quadruple.',
    'at twice the Brand CPA.',
    'a two-fold rise.',
    'a threefold rise.',
    'and spend rose by a third.',
    'and clicks fell by half.',
    'with CVR cut in half.',
    'with one in five clicks wasted.',
    'about a dozen conversions.',
    'only three conversions.',
    'two thirds of spend.',
    'spend halved.',
    'a quarter of spend.',
    'CPA is the second highest.',
    'the first week of the test.',
    'a ten-fold jump.',
    'only one campaign moved.',
    'a million impressions.',
  ])('rejects %j', (tail) => {
    expect(verdict(`CPA for PR-07 Prospecting rose {{${CPA_UP()}}}, ${tail}`)).toBe('spelled_number');
  });

  it.each([
    'No one changed bids on PR-07 Prospecting.',
    'PR-07 Prospecting is one of the main contributors.',
    'Third-party cookies and first-party audiences held.',
    'Double-check the tracking before the next quarter.',
    'A one-off spike this quarter; the campaigns support one another.',
    'Why: likely bids.\nNext: the media buyer reviews bids by Friday.',
    'Attribution is first-click. Watch time is in seconds. Often, someone notices.',
    'The tenant often scaffolds an unfolded plan.',
  ])('keeps ordinary prose %j', (text) => {
    expect(verdict(text)).toBe('ok');
  });

  it('a campaign name with a number word is still a name', () => {
    const table: FactsTable = { ...facts, facts: facts.facts.map((f) => (f.scope.campaign === 'PR-03 Brand' ? { ...f, scope: { ...f.scope, campaign: 'First Party Half Price' } } : f)) };
    expect(() => validateTemplate('First Party Half Price held.', table)).not.toThrow();
  });

  it('a draft that says "twice the Brand CPA" never reaches the report (one retry, then RawNumberError)', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const chat = createMockChat({ log, draft: (req) => `${mockDraftFrom(req.user)}\nPR-07 Prospecting now costs twice the Brand CPA.` });
    await expect(runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat, jev: createMockJev() } })).rejects.toBeInstanceOf(RawNumberError);
    expect(log.chat.filter((r) => r.system.includes('FORMAT:'))).toHaveLength(2);
    expect(log.chat[1].user).toContain('rejected by the number check');
  });

  it('the mock draft and the writing prompt stay valid', async () => {
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() } });
    expect(report.text).toContain('Why:');
    expect(report.text).toContain('Next:');
  });
});

describe('defect 2: non-decimal numerals and invisible characters', () => {
  it.each(['⁴¹', '½', 'Ⅳ', '④', '٤١', '４１', '𝟒𝟏', '₄'])('rejects the numeral %j', (n) => {
    expect(verdict(`CPA for PR-07 Prospecting rose {{${CPA_UP()}}}, near ${n}.`)).toBe('raw_number');
  });

  it('a zero-width character or a soft hyphen does not hide a number word', () => {
    expect(verdict('Brand spend dou​bled.')).toBe('spelled_number');
    expect(verdict('Brand spend dou­bled.')).toBe('spelled_number');
    expect(verdict('Brand spend tw⁠ice the rest.')).toBe('spelled_number');
    expect(verdict('Brand spend ｄｏｕｂｌｅｄ.')).toBe('spelled_number'); // fullwidth letters, NFKC
  });

  it('renderTemplate stores and renders the cleaned template', () => {
    const d = renderTemplate(`Spend​ landed at {{${'f1'}}}.`, facts);
    expect(d.template).toBe('Spend landed at {{f1}}.');
    expect(d.rendered).toBe(`Spend landed at ${fact('f1').display}.`);
  });

  it('traceNumbers and deliver report any numeral that is not a display', async () => {
    expect(traceNumbers('CPA near ⁴¹ and ½ of Brand.', facts).untraced.length).toBeGreaterThan(0);
    expect(traceNumbers(`Spend ${fact('f1').display}, a Ⅳ jump.`, facts).untraced.length).toBe(1);
    await expect(deliver({ text: 'CPA near ⁴¹ this week.', facts, flags: [], decide: async (f) => ({ flagId: f.id, action: 'keep' }) })).rejects.toBeInstanceOf(RawNumberError);
  });
});

describe('defect 3: revision mode allows only strict identifiers', () => {
  it('templatize turns every digit run that is not an identifier into a fact (report.md)', async () => {
    const t = templatize(REPORT_MD, await extracted(REPORT_MD));
    expect(t.allow.sort()).toEqual(['2025', '2025-10-06', 'FY26', 'H2', 'Oct 6–12', 'PR-07', 'Q4'].sort());
    for (const a of t.allow) expect(isIdentifierShape(a), a).toBe(true);
    const displays = t.facts.facts.map((f) => f.display);
    for (const raw of ['41', '1e3', '2:1']) expect(displays).toContain(raw);
    // What's left in the template besides references is identifiers only.
    assertNoNumbers(t.template, t.facts, t.allow);
    // The original renders back exactly.
    expect(renderTemplate(t.template, t.facts, { allow: t.allow }).rendered).toBe(REPORT_MD);
  });

  it('templatize on the reviewer ex.md allows nothing', async () => {
    const t = templatize(EX_MD, await extracted(EX_MD));
    expect(t.allow).toEqual([]);
    for (const raw of ['5', '#1', '3rd', 'x2', '1/3', '3-for-1', '3:2', '50/50', '1e3', '4.2e2', 'v2', '12']) expect(t.facts.facts.map((f) => f.display)).toContain(raw);
    assertNoNumbers(t.template, t.facts, t.allow);
    expect(renderTemplate(t.template, t.facts, { allow: t.allow }).rendered).toBe(EX_MD);
  });

  it('allowedIdentifiers ignores extras that are not identifier shapes', () => {
    const empty: FactsTable = { currency: '', periods: { current: '' }, facts: [] };
    expect(allowedIdentifiers(empty, ['1e3', 'a 2:1', 'x2', 'X2', 'plan 1/3', 'Ratio 3:2', 'A 50/50', '4.2e2', 'Top 5', 'Item 12', 'week 41', 'for-1', '3rd'])).toEqual([]);
    expect(allowedIdentifiers(empty, ['Q4', 'H2', 'FY26', 'W45', 'PR-07', 'NB-11', '2025', '2025-10-06', 'Oct 6–12', 'Sep 29–Oct 5']).sort()).toEqual(
      ['Q4', 'H2', 'FY26', 'W45', 'PR-07', 'NB-11', '2025', '2025-10-06', 'Oct 6–12', 'Sep 29–Oct 5'].sort(),
    );
  });

  it('a revision run shows the models no digit outside strict identifiers', async () => {
    const dir = tmp();
    const file = join(dir, 'report.md');
    writeFileSync(file, REPORT_MD);
    const log: MockLog = { chat: [], jev: [] };
    const t = templatize(REPORT_MD, await extracted(REPORT_MD));
    try {
      await runNoro({ file, cwd: dir, config, stateDir: tmp(), clients: { chat: createMockChat({ log }), jev: createMockJev(log) } });
    } catch (err) {
      if (!(err instanceof CheckFailedError)) throw err;
    }
    expect(log.chat.length).toBeGreaterThan(0);
    for (const req of log.chat) {
      expect(req.user).not.toMatch(/"(?:a 2:1|1e3|week 41|Top 5|x2)"/);
      assertNoNumbers(`${req.system}\n${req.user}`, t.facts, t.allow);
    }
  });
});

describe('defect 4: rewords at deliver get the full template check', () => {
  const quote = 'CPA for PR-07 Prospecting';
  const run = (attempts: string[]) => {
    const d = renderTemplate(`CPA for PR-07 Prospecting rose {{${CPA_UP()}}} to {{${CPA_NOW()}}}.`, facts);
    const asked: Flag[] = [];
    return {
      asked,
      report: deliver({
        text: d.rendered,
        facts,
        flags: [{ id: 'F1', source: 'panel', text: 'reword', quote }],
        decide: async (f): Promise<Decision> => {
          asked.push(f);
          return { flagId: f.id, action: 'reword', text: attempts[Math.min(asked.length - 1, attempts.length - 1)] };
        },
      }),
    };
  };

  it.each(['CPA, forty-one percent higher', 'CPA, which doubled', 'CPA, now double', 'CPA ½', 'CPA, up by a third', 'CPA ⁴¹', 'CPA dou​bled', 'CPA {{f13}}{{f53}}', 'CPA {{f13}}x', 'CPA at -{{f189}}'])(
    'refuses %j three times, then RawNumberError',
    async (text) => {
      const r = run([text]);
      await expect(r.report).rejects.toBeInstanceOf(RawNumberError);
      expect(r.asked).toHaveLength(3);
      expect(r.asked[1].text).toContain('refused');
    },
  );

  it('still accepts a reference or an exact display', async () => {
    const r = run(['CPA (twice as high)', `CPA, now ${fact(CPA_NOW()).display},`]);
    const report = await r.report;
    expect(r.asked).toHaveLength(2);
    expect(r.asked[1].text).toContain('numbers in words');
    expect(report.text).toContain(`CPA, now ${fact(CPA_NOW()).display},`);
  });
});

describe('defect 6: references run into digits, units or other references', () => {
  it.each(['{{f13}}{{f53}}', '{{f13}} {{f53}}0', '{{f13}}k', '{{f13}}%', '{{f13}}x', '{{f13}}M', '-{{f189}}', '+{{f13}}', '${{f189}}', 'PR{{f13}}', '{{f13}}.{{f53}}', '{{f13}}/{{f53}}', '{{f13}},{{f53}}', '{{f13}}-{{f53}}', '{{f13}}th'])(
    'rejects %j',
    (ref) => {
      expect(verdict(`Conversions were ${ref} this week.`)).toBe('bad_reference');
    },
  );

  it.each(['({{f13}})', '{{f13}}.', '{{f13}}, then', '{{f13}}/week', 'a {{f53}}-day window', '"{{f13}}"', 'at {{f13}}—up {{f12}}'])('allows %j', (ref) => {
    expect(verdict(`Conversions were ${ref}`)).toBe('ok');
  });
});

describe('nit: a redundant sign after a direction word', () => {
  it('a change after "rose" / "fell" renders without its sign, and both tracers accept it', async () => {
    const up = fact(CPA_UP());
    const down = fact(CPC_DOWN());
    expect(up.display).toMatch(/^\+/);
    expect(down.display).toMatch(/^-/);
    const d = renderTemplate(`CPA for PR-07 Prospecting rose {{${up.id}}}; CPC fell by {{${down.id}}}. CPC is down {{${down.id}}}.`, facts);
    expect(d.rendered).toBe(`CPA for PR-07 Prospecting rose ${up.display.slice(1)}; CPC fell by ${down.display.slice(1)}. CPC is down ${down.display.slice(1)}.`);
    const t = traceNumbers(d.rendered, facts, { prefer: d.factIds });
    expect(t.untraced).toEqual([]);
    expect(t.traces.map((x) => x.factId)).toEqual([up.id, down.id, down.id]);
    const c = await check({ text: d.rendered, mode: 'generate', facts });
    expect(c.untraced).toEqual([]);
  });

  it('the sign stays when the direction word disagrees or is absent, and a contradiction never traces', () => {
    const up = fact(CPA_UP());
    const down = fact(CPC_DOWN());
    const d = renderTemplate(`CPA moved {{${up.id}}}; CPC rose {{${down.id}}}.`, facts);
    expect(d.rendered).toBe(`CPA moved ${up.display}; CPC rose ${down.display}.`);
    expect(traceNumbers(`CPA fell ${up.display.slice(1)}.`, facts).untraced).toEqual([up.display.slice(1)]);
  });

  it('numbers as written in a pasted report keep their sign', () => {
    const t = templatize('CPA rose +38% this week.', [{ raw: '+38%', span: [9, 13], value: 38, kind: 'percent', unit: '%' }]);
    expect(renderTemplate(t.template, t.facts).rendered).toBe('CPA rose +38% this week.');
  });
});
