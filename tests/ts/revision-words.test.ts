// Revision mode: number words the pasted original already used ("the two", "six months", "nine
// campaigns") may stay in the rewrite. They aren't computed numbers, so refusing them only made
// faithful rewrites fail. A number word the original didn't use is still refused, and generate
// mode stays strict.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEngine } from '../../src/check/index.js';
import { loadConfig } from '../../src/config.js';
import { RawNumberError, allowedNumberWords, numberWordsIn, renderTemplate, templatize, validateTemplate } from '../../src/draft/index.js';
import type { FoundNumber, Templatized } from '../../src/draft/index.js';
import { runNoro } from '../../src/harness/index.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import type { FactsTable } from '../../src/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORPUS = join(ROOT, 'bench/corpus');
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-words-'));
const corpus = (dir: string, file: 'original.md' | 'gold.md') => readFileSync(join(CORPUS, dir, file), 'utf8');

/** Templatize a report the way the harness does: the engine's extractor, then templatize. */
async function revision(text: string): Promise<Templatized> {
  const p = join(tmp(), 'original.md');
  writeFileSync(p, text);
  const numbers = (await runEngine(['extract', p])).json.numbers.map((n: FoundNumber) => ({ raw: n.raw, span: n.span, value: n.value, kind: n.kind, unit: n.unit }));
  return templatize(text, numbers);
}

/** The reference to the first fact of the original written exactly as `display`. */
function ref(t: Templatized, display: string): string {
  const f = t.facts.facts.find((x) => x.display === display);
  if (!f) throw new Error(`no fact displays "${display}": ${t.facts.facts.map((x) => x.display).join(' | ')}`);
  return `{{${f.id}}}`;
}

function verdict(template: string, facts: FactsTable, allow?: string[]): string {
  try {
    validateTemplate(template, facts, allow ? { allow } : {});
    return 'ok';
  } catch (err) {
    if (err instanceof RawNumberError) return err.kind;
    throw err;
  }
}

describe('revision mode: number words from the original', () => {
  it('templatize lists the number words the original used, and only those', async () => {
    const t = await revision(corpus('08-truncated-dual-axis', 'original.md'));
    expect(t.allow).toContain('six');
    expect(t.allow).not.toContain('seven');
    const t9 = await revision(corpus('09-pie-nine-slices', 'original.md'));
    expect(t9.allow).toContain('nine');
  });

  it('bench 08: the gold "highest in six months" passes when the original says "six months"', async () => {
    const original = corpus('08-truncated-dual-axis', 'original.md');
    expect(original).toContain('six months');
    expect(corpus('08-truncated-dual-axis', 'gold.md')).toContain('highest in six months');
    const t = await revision(original);
    const gold = `**September's ${ref(t, '433')} appointment requests were the highest in six months.**`;
    expect(verdict(gold, t.facts, t.allow)).toBe('ok');
    // Generate mode (no allow list) stays strict.
    expect(verdict(gold, t.facts)).toBe('spelled_number');
  });

  it('bench 09: "nine campaigns" passes when the original says "nine campaigns"', async () => {
    const original = corpus('09-pie-nine-slices', 'original.md');
    expect(original).toContain('nine campaigns');
    const t = await revision(original);
    expect(verdict(`PMax took ${ref(t, '31.2%')} of spend across nine campaigns.`, t.facts, t.allow)).toBe('ok');
    expect(verdict(`PMax took ${ref(t, '31.2%')} of spend across ten campaigns.`, t.facts, t.allow)).toBe('spelled_number');
  });

  it('bench 01: the gold "We haven\'t separated the two." passes only when the original says "two"', async () => {
    const original = corpus('01-weekly-email-hedges', 'original.md');
    const sentence = "We haven't separated the two.";
    expect(corpus('01-weekly-email-hedges', 'gold.md')).toContain(sentence);
    // The real original never says "two": a new number word is refused.
    expect(original).not.toMatch(/\btwo\b/i);
    const t = await revision(original);
    expect(verdict(sentence, t.facts, t.allow)).toBe('spelled_number');
    // With "the two" in the original, the same gold sentence passes.
    const withTwo = await revision(`${original}\nThe promotion and the ads overlap, and we can't split the two yet.\n`);
    expect(verdict(sentence, withTwo.facts, withTwo.allow)).toBe('ok');
  });

  it('a number word the original did not use is still refused', async () => {
    const t = await revision(corpus('08-truncated-dual-axis', 'original.md'));
    expect(verdict('The highest in seven months.', t.facts, t.allow)).toBe('spelled_number');
    expect(verdict('CPA doubled.', t.facts, t.allow)).toBe('spelled_number');
    expect(verdict('The highest in six months.', t.facts, t.allow)).toBe('ok');
  });

  it('a phrase matches whole: "two" does not allow "two times", "twenty-two" or "two thirds"', () => {
    const empty: FactsTable = { currency: '', periods: { current: '' }, facts: [] };
    const allow = ['two'];
    expect(verdict('We compared the two.', empty, allow)).toBe('ok');
    expect(verdict('The Two campaigns.', empty, allow)).toBe('ok'); // case doesn't change the number
    for (const s of ['CPA was two times higher.', 'Clicks hit twenty-two.', 'Spend fell two thirds.', 'A two-fold rise.', 'Two hundred clicks.']) {
      expect(verdict(s, empty, allow), s).toBe('spelled_number');
    }
  });

  it('a bare scale word is never allowed, and digit-bearing or non-phrase entries add no words', async () => {
    const t = await revision('Reach hit a million people at $30 each.\n');
    expect(verdict(`Reach hit a million people.`, t.facts, t.allow)).toBe('spelled_number');
    expect(verdict(`Cost was ${ref(t, '$30')} million.`, t.facts, t.allow)).toBe('spelled_number');
    expect([...allowedNumberWords(['Q4', 'two', 'the two', 'million', 'thousands', '6 months', 'forty-one', 'Forty one'])].sort()).toEqual(['forty one', 'two']);
  });

  it('words that were part of a templated number are not allowed', () => {
    // "$5 million" as one number: the word went into the fact, so the rewrite can't reuse it.
    const text = 'Spend was $5 million and the two campaigns split it.';
    const at = text.indexOf('$5 million');
    const t = templatize(text, [{ raw: '$5 million', span: [at, at + '$5 million'.length], value: 5_000_000, kind: 'currency', unit: '$' }]);
    expect(t.allow).toContain('two');
    expect(t.allow).not.toContain('million');
    // "two" is a fact as written; the template a model sees has no number word left.
    expect(numberWordsIn(t.template)).toEqual([]);
    expect(t.facts.facts.map((f) => f.display)).toEqual(['$5 million', 'two']);
  });

  it('a revision run keeps a number word from the original and delivers', async () => {
    const dir = tmp();
    const file = join(dir, 'update.md');
    // The canned reviser keeps the first half of the sentences, so "six months" stays in its rewrite.
    writeFileSync(file, 'Requests were the highest in six months. CPA held at $30. Next we review bids. Then we report back.\n');
    const log: MockLog = { chat: [], jev: [] };
    const config = { ...loadConfig({}), apiKey: undefined };
    const report = await runNoro({ file, cwd: dir, config, stateDir: tmp(), clients: { chat: createMockChat({ log }), jev: createMockJev(log) } });
    expect(report.text).toContain('six months');
    // No model saw the number word: every prompt had it as a fact reference.
    for (const c of log.chat) expect(`${c.system}\n${c.user}`).not.toMatch(/\bsix\b/i);
  });

  it('number words become facts as written, so no model sees "five times", "Half" or "twenty more leads"', () => {
    const text = 'Half the budget went to search. Leads rose five times, with twenty more leads from PR-07. No one expected it.';
    const t = templatize(text, []);
    expect(numberWordsIn(t.template)).toEqual([]);
    expect(t.template).not.toMatch(/\b(?:half|five|twenty)\b/i);
    expect(t.template).toContain('No one expected it.'); // a phrase that only looks like a number stays
    expect(t.facts.facts.map((f) => f.display)).toEqual(['Half', 'five times', 'twenty']);
    expect(t.facts.facts.every((f) => f.formula === 'as written in the original report')).toBe(true);
    // Rendering gives the original back, and a rewrite may still repeat the words verbatim.
    expect(renderTemplate(t.template, t.facts, { allow: t.allow }).rendered.replace(/\s+/g, ' ')).toBe(text);
    expect(verdict('Leads rose five times.', t.facts, t.allow)).toBe('ok');
  });
});
