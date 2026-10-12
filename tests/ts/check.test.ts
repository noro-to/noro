import { describe, expect, it } from 'vitest';
import { check, EngineError, factsToLedger, grade } from '../../src/check/index.js';
import { computeFacts } from '../../src/compute/index.js';
import type { Dataset, FactsTable, Row } from '../../src/schema.js';

function dataset(): Dataset {
  const rows: Row[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.UTC(2026, 8, 29 + i)).toISOString().slice(0, 10);
    const cur = i >= 7;
    rows.push({ date: d, platform: 'google-ads', account: 'Acme', campaign: 'PR-03 Brand', spend: cur ? 6887.6 : 6149.6, impressions: 41000, clicks: cur ? 1240 : 1180, conversions: cur ? 112.86 : 125.4, conversionValue: cur ? 28000 : 27500, extra: {} });
    rows.push({ date: d, platform: 'google-ads', account: 'Acme', campaign: 'PR-07 Generic', spend: 950, impressions: 18000, clicks: 300, conversions: 4, conversionValue: 1200, extra: {} });
  }
  return { source: 'inline', platform: 'google-ads', adapter: 'google-ads', currency: 'USD', mapping: {}, rows, warnings: [] };
}

const facts: FactsTable = computeFacts(dataset());
const d = (key: string) => {
  const f = facts.facts.find((x) => x.key === key);
  if (!f) throw new Error(`no fact ${key}`);
  return f.display;
};

function draft(): string {
  return [
    `Spend was ${d('spend:account:period=current')} for ${facts.periods.current}, ${d('spend:account:change=pct')} on the week before.`,
    `CPA on PR-03 Brand moved to ${d('cpa:campaign=PR-03 Brand:period=current')} (${d('cpa:campaign=PR-03 Brand:change=pct')}), on ${d('conversions:campaign=PR-03 Brand:period=current')} conversions.`,
    `CTR changed ${d('ctr:account:change=pp')} and ROAS sits at ${d('roas:account:period=current')}.`,
    `PR-07 Generic took ${d('spend_share:campaign=PR-07 Generic:period=current')} of spend.`,
  ].join(' ');
}

describe('factsToLedger', () => {
  it('writes one confirmed entry per non-null fact in the engine ledger shape', () => {
    const ledger = factsToLedger(facts);
    const nonNull = facts.facts.filter((f) => f.value !== null);
    expect(ledger.numbers.length).toBe(nonNull.length);
    const f = nonNull[0];
    expect(ledger.numbers[0]).toEqual({
      id: f.id, raw: f.display, value: f.value, unit: 'USD', kind: 'currency',
      context: f.label, span: null, origin: 'facts', confirmed: true,
    });
  });
});

describe('check, generate mode', () => {
  it('a draft whose numbers are all fact displays passes', async () => {
    const r = await check({ text: draft(), mode: 'generate', facts });
    expect(r.untraced).toEqual([]);
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.mode).toBe('generate');
    expect(r.length).toBeNull();
  });

  it('a stray number fails and is listed in untraced', async () => {
    const text = `${draft()} Budget for next week is $9,999.`;
    const r = await check({ text, mode: 'generate', facts });
    expect(r.pass).toBe(false);
    expect(r.untraced.map((u) => u.raw)).toEqual(['$9,999']);
    const u = r.untraced[0];
    expect(u.value).toBe(9999);
    expect(text.slice(u.span[0], u.span[1])).toBe('$9,999');
    expect(u.nearest?.id).toMatch(/^f\d+$/);
  });

  it('an unrendered {{fN}} reference fails as an error-severity tell', async () => {
    const r = await check({ text: `${draft()} CPA was {{f8}}.`, mode: 'generate', facts });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.rule === 'T-scaffold-left-in')).toBe(true);
  });

  it('an error-severity tell fails even when every number traces', async () => {
    const r = await check({ text: `It's important to note that ${draft()}`, mode: 'generate', facts });
    expect(r.untraced).toEqual([]);
    expect(r.pass).toBe(false);
    const f = r.findings.find((x) => x.rule === 'T-filler-openers');
    expect(f?.severity).toBe('error');
  });

  it('watchouts are added to findings and never change pass', async () => {
    const r = await check({ text: `${draft()} This was our best week ever.`, mode: 'generate', facts, watchouts: true });
    expect(r.findings.some((f) => f.category === 'watchout' && f.rule === 'W-best-period-only')).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('needs the facts table', async () => {
    await expect(check({ text: 'x', mode: 'generate' })).rejects.toThrow(/facts/);
  });
});

describe('check, revise mode', () => {
  const original = [
    'Weekly performance update for the account.',
    'Spend increased to $48,213 this week compared with $43,047 the week before.',
    'CPA came in at $61.03 on 790 conversions, and ROAS held at 4.1x across the campaigns we manage for the client.',
    'Click-through rate improved by +0.3 pp while conversion rate was broadly stable over the period.',
  ].join(' ');

  it('a shorter rewrite using only the original numbers passes and reports length', async () => {
    const text = 'Spend rose to $48.2k from $43,047. CPA was $61.03 on 790 conversions; ROAS 4.1x.';
    const r = await check({ text, mode: 'revise', original });
    expect(r.untraced).toEqual([]);
    expect(r.length).not.toBeNull();
    expect(r.length!.shorter).toBe(true);
    expect(r.length!.rewrite_words).toBeLessThan(r.length!.original_words);
    expect(r.pass).toBe(true);
  });

  it('a rewrite that is not shorter fails on length', async () => {
    const r = await check({ text: original, mode: 'revise' }); // original defaults to the text itself
    expect(r.untraced).toEqual([]);
    expect(r.length).toEqual({ original_words: r.length!.original_words, rewrite_words: r.length!.original_words, shorter: false });
    expect(r.pass).toBe(false);
  });

  it('a number the original does not have is untraced', async () => {
    const r = await check({ text: 'Spend rose 12% to $48,213; CPA $61.03.', mode: 'revise', original });
    expect(r.untraced.map((u) => u.raw)).toEqual(['12%']);
    expect(r.pass).toBe(false);
  });

  it('with facts, computed fact displays trace too', async () => {
    const extra = d('spend:account:period=current');
    const r = await check({ text: `Spend was ${extra}; CPA $61.03.`, mode: 'revise', original, facts });
    expect(r.untraced).toEqual([]);
    expect(r.pass).toBe(true);
  });
});

describe('grade', () => {
  it('returns the engine grade JSON', async () => {
    const g = (await grade('It could potentially indicate efficiency may have been impacted. Overall, a mixed picture.')) as any;
    expect(typeof g.score).toBe('number');
    expect(['ship', 'tighten', 'rewrite']).toContain(g.verdict);
    expect(g.findings.length).toBeGreaterThan(0);
    const w = (await grade('This was our best week ever.', { watchouts: true })) as any;
    expect(w.watchouts.some((f: any) => f.rule === 'W-best-period-only')).toBe(true);
  });

  it('an engine usage error (exit 1) throws EngineError with the message', async () => {
    const err = await grade('Spend was flat.', { rulesPath: '/nonexistent/rules.json' }).catch((e: unknown) => e) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/rules file not found/);
  });

  it('a missing python throws EngineError', async () => {
    const err = await grade('x', { python: '/nonexistent/python3' }).catch((e: unknown) => e) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
  });
});
