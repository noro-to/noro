// Draft: the writing model turns fact ids + labels + classification into a
// template that cites {{fN}}; renderTemplate() puts code's numbers in.
// Revise: the writing model applies notes to a template (or cuts a pasted
// report down, revision mode); its output goes back through renderTemplate().
// A template that breaks the digit rule gets one retry with the error, then
// the step fails with RawNumberError.

import type { Classification, ChatClient, Draft, Fact, FactKind, FactsTable, PanelNote } from '../schema.js';
import { parseJsonObject, stripFence } from './chat.js';
import { DEFAULT_FORMAT, FORMATS, buildDraftPrompt, buildRetryNote, buildRevisePrompt, noteKey } from './prompts.js';
import { DATE_LABEL, NUMERAL, RawNumberError, isIdentifierShape, numberWordSpans, numberWordsIn, renderTemplate, scrubNumbers } from './template.js';
import type { TemplateOptions } from './template.js';

export { createChatClient, parseJsonObject, stripFence } from './chat.js';
export { createClaudeCliClient, checkClaudeAuth, ClaudeCliError } from './claude-cli.js';
export {
  DATE_LABEL,
  NUMERAL,
  RawNumberError,
  allowedIdentifiers,
  allowedNumberWords,
  findNumberWords,
  isIdentifierShape,
  maskIdentifiers,
  numberWordSpans,
  numberWordsIn,
  renderFragment,
  renderTemplate,
  scrubNumbers,
  segments,
  stripInvisible,
  templateQuote,
  templateSpan,
  traceNumbers,
  validateTemplate,
} from './template.js';
export type { NumberTrace, TemplateErrorKind, TemplateOptions, ValidateOptions } from './template.js';
export { CROSS_CHANNEL_RULES, DEFAULT_FORMAT, FORMATS, HOUSE_RULES, NUMBER_RULES, buildDraftPrompt, buildPanelPrompt, buildRevisePrompt, factCard } from './prompts.js';

/** What the retry is told: the error, with any raw number the model wrote scrubbed out. */
function retryMessage(err: RawNumberError, facts: FactsTable, opts: TemplateOptions): string {
  const what =
    err.kind === 'raw_number'
      ? 'it contains numbers written as digits instead of fact references'
      : err.kind === 'spelled_number'
        ? `it writes numbers in words ("${scrubNumbers(err.offending.join('", "'), facts, opts)}"); write none, not even "one", "first", "half" or "double"`
        : err.kind === 'unknown_fact'
          ? `it cites ids that are not in the list (${err.offending.map((x) => `{{${x}}}`).join(', ')})`
          : err.kind === 'null_fact'
            ? `it cites facts with no value (${err.offending.map((x) => `{{${x}}}`).join(', ')})`
            : err.offending.some((x) => !/^\{\{[^}]*\}\}$|^\{\{$|^\}\}$/.test(x))
              ? 'it runs references into other text; put each {{fN}} on its own, with no digit, unit, sign or other reference against it'
              : 'it has malformed references';
  return buildRetryNote(what + '.');
}

async function writeOnce<T>(
  ask: (retry?: string) => Promise<string>,
  parse: (answer: string) => T,
  facts: FactsTable,
  opts: TemplateOptions,
): Promise<T> {
  const first = await ask();
  try {
    return parse(first);
  } catch (err) {
    if (!(err instanceof RawNumberError)) throw err;
    const second = await ask(`${retryMessage(err, facts, opts)}\n\nYour previous answer, numbers removed:\n"""\n${scrubNumbers(first, facts, opts)}\n"""`);
    return parse(second);
  }
}

export async function draft(input: {
  facts: FactsTable;
  labels: Classification[];
  chat: ChatClient;
  model: string;
  format?: string;
}): Promise<Draft> {
  const format = input.format && FORMATS[input.format] ? input.format : DEFAULT_FORMAT;
  const prompt = buildDraftPrompt({ facts: input.facts, labels: input.labels, format });
  return writeOnce(
    (retry) =>
      input.chat.complete({ model: input.model, system: prompt.system, user: retry ? `${prompt.user}\n\n${retry}` : prompt.user }),
    (answer) => renderTemplate(stripFence(answer), input.facts),
    input.facts,
    {},
  );
}

export interface ReviseResult {
  draft: Draft;
  /** Indexes into the notes passed in. */
  applied: number[];
  rejected: { note: number; reason: string }[];
}

const fromKey = (k: unknown, n: number): number | undefined => {
  if (typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < n) return k;
  if (typeof k !== 'string') return undefined;
  for (let i = 0; i < n; i++) if (noteKey(i) === k.trim().toUpperCase()) return i;
  return undefined;
};

/** Notes as a model may see them: quotes and note text with stray numbers scrubbed. */
export function safeNotes(notes: PanelNote[], facts: FactsTable, opts: TemplateOptions = {}): PanelNote[] {
  return notes.map((n) => ({
    ...n,
    note: scrubNumbers(n.note, facts, opts),
    ...(n.quote !== undefined ? { quote: scrubNumbers(n.quote, facts, opts) } : {}),
  }));
}

/**
 * Revise a template with notes. `task: 'apply'` fixes a draft (generate mode); `'rewrite'` cuts a
 * pasted report down (revision mode, where `template` is the report with its numbers templated).
 */
export async function reviseDetailed(input: {
  template: string;
  notes: PanelNote[];
  facts: FactsTable;
  chat: ChatClient;
  model: string;
  labels?: Classification[];
  allow?: string[];
  task?: 'apply' | 'rewrite';
}): Promise<ReviseResult> {
  const opts: TemplateOptions = { allow: input.allow };
  const notes = safeNotes(input.notes, input.facts, opts);
  const prompt = buildRevisePrompt({
    template: input.template,
    notes,
    facts: input.facts,
    labels: input.labels,
    allow: input.allow,
    task: input.task ?? 'apply',
  });
  return writeOnce(
    (retry) =>
      input.chat.complete({ model: input.model, system: prompt.system, user: retry ? `${prompt.user}\n\n${retry}` : prompt.user, json: true }),
    (answer) => {
      const obj = parseJsonObject(answer);
      if (typeof obj?.template !== 'string') throw new Error('revise: model answer has no "template"');
      const d = renderTemplate(stripFence(obj.template), input.facts, opts);
      const applied = [...new Set(((obj.applied ?? []) as unknown[]).map((k) => fromKey(k, notes.length)).filter((x): x is number => x !== undefined))];
      const rejected = ((obj.rejected ?? []) as any[])
        .map((r) => ({ note: fromKey(r?.note, notes.length), reason: scrubNumbers(String(r?.reason ?? ''), input.facts, opts) }))
        .filter((r): r is { note: number; reason: string } => r.note !== undefined);
      return { draft: d, applied, rejected };
    },
    input.facts,
    opts,
  );
}

/** A pasted report turned into a template: every number replaced by a fact reference. */
export interface Templatized {
  template: string;
  facts: FactsTable;
  /**
   * What the rewrite may repeat from the original: digit-bearing tokens left in the template
   * (strict identifiers and dates only), plus the number-word phrases the original used verbatim
   * ("two", "six", "nine"), which no code computed. The template itself carries none of those
   * words: they are facts "as written" like the digits, so no model sees them.
   */
  allow: string[];
}

export interface FoundNumber {
  raw: string;
  span: [number, number];
  value?: number;
  kind?: string;
  unit?: string;
}

/** A bare scale word belongs to the number beside it; it stays in the template, as before. */
const BARE_SCALE_WORD = /^(?:hundreds?|thousands?|millions?|billions?|trillions?)$/iu;

const KINDS = new Set<FactKind>(['currency', 'percent', 'pp', 'multiplier', 'count', 'ratio']);

/** Numbers in text by a plain regex (used only when the engine's extractor isn't available). */
export function findNumbers(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  const re = /(?<![\p{L}\p{Nd}\-])[$€£]?\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?(?:\s?(?:%|pp\b|x\b|k\b|K\b|M\b))?/gu;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    const after = text[m.index! + m[0].length] ?? '';
    if (/[\p{L}\-]/u.test(after)) continue; // part of an identifier like Q4X or 2026-10
    out.push({ raw, span: [m.index!, m.index! + raw.length] });
  }
  return out;
}

const WRAP_START = /[("'“‘«\[*_]/u;
const WRAP_END = /[.,;:!?)"'”’»\]*_]/u;

/**
 * Every number in a pasted report, so none reaches a model: the extractor's numbers, plus every
 * other run of digits it ignored. A whitespace-delimited token whose digits the extractor left
 * alone is kept only when it is a strict identifier ("Q4", "H2", "FY26", "PR-07", a year) or part
 * of a date ("2025-10-06", "Oct 6–12"); anything else ("week 41", "Top 5", "1e3", "x2", "a 2:1",
 * "50/50", "#1", "3rd") becomes a number too, written exactly as in the report. Numbers joined
 * with no space ("$95-109", "3-for-1") become one.
 */
export function coverNumbers(text: string, numbers: FoundNumber[]): { numbers: FoundNumber[]; allow: string[] } {
  let kept = [...numbers].sort((a, b) => a.span[0] - b.span[0]);
  const allow = new Set<string>();
  const overlaps = (s: number, e: number, spans: [number, number][]) => spans.some(([a, b]) => s < b && e > a);

  // Dates and period labels the extractor left alone stay as they are.
  const dates: [number, number][] = [];
  for (const m of text.matchAll(DATE_LABEL)) {
    const span: [number, number] = [m.index!, m.index! + m[0].length];
    if (overlaps(span[0], span[1], kept.map((n) => n.span))) continue;
    dates.push(span);
    allow.add(m[0]);
  }
  const covered = (i: number) => kept.some((n) => i >= n.span[0] && i < n.span[1]) || dates.some(([a, b]) => i >= a && i < b);

  const extra: FoundNumber[] = [];
  for (const m of text.matchAll(/\S+/gu)) {
    let s = m.index!;
    let e = s + m[0].length;
    while (s < e && WRAP_START.test(text[s])) s++;
    while (e > s && WRAP_END.test(text[e - 1])) e--;
    let leftover = false;
    for (let i = s; i < e; i++) {
      if (NUMERAL.test(text[i]) && !covered(i)) {
        leftover = true;
        break;
      }
    }
    if (!leftover) continue;
    const core = text.slice(s, e);
    const inside = kept.filter((n) => n.span[0] < e && n.span[1] > s);
    if (!inside.length && !overlaps(s, e, dates) && isIdentifierShape(core)) {
      allow.add(core);
      continue;
    }
    // One number for the whole token, absorbing any extractor numbers inside it.
    for (const n of inside) {
      s = Math.min(s, n.span[0]);
      e = Math.max(e, n.span[1]);
    }
    kept = kept.filter((n) => !inside.includes(n));
    const raw = text.slice(s, e);
    extra.push({ raw, span: [s, e], value: Number(raw.replace(/[^\d.\-]/g, '')) || 0, kind: 'count' });
  }

  // Numbers that touch ("$95-109", "1.2/3") are one number as written.
  const all = [...kept, ...extra].sort((a, b) => a.span[0] - b.span[0]);
  const merged: FoundNumber[] = [];
  for (const n of all) {
    const prev = merged[merged.length - 1];
    if (prev && n.span[0] - prev.span[1] <= 1 && /^[-–/:.,x×]?$/u.test(text.slice(prev.span[1], n.span[0]))) {
      const span: [number, number] = [prev.span[0], n.span[1]];
      merged[merged.length - 1] = { raw: text.slice(span[0], span[1]), span, value: prev.value, kind: prev.kind, unit: prev.unit };
    } else {
      merged.push(n);
    }
  }
  return { numbers: merged, allow: [...allow].filter((x) => NUMERAL.test(x)) };
}

/**
 * Replace each found number with {{fN}} and build a facts table whose displays are the raws as
 * written. Labels carry the templated sentence around the number, so they hold no numbers.
 * Digits the extractor ignored are covered too (coverNumbers): only strict identifiers and dates
 * are left in the template, and they are the `allow` list, with the original's number words.
 * Number words ("five times", "Half", "twenty more leads") become facts as written too, so the
 * template a model sees carries no number in any form; they stay on the allow list, so a rewrite
 * may still repeat one of them verbatim.
 */
export function templatize(text: string, found: FoundNumber[]): Templatized {
  const covered = coverNumbers(text, found);
  const allow = covered.allow;
  // Number words outside the numbers found (a word inside "$2 million" belongs to that number).
  let blanked = text;
  for (const n of covered.numbers) blanked = blanked.slice(0, n.span[0]) + ' '.repeat(n.span[1] - n.span[0]) + blanked.slice(n.span[1]);
  const words: FoundNumber[] = numberWordSpans(blanked)
    .filter((w) => !BARE_SCALE_WORD.test(w.raw.trim()))
    .map((w) => ({ raw: text.slice(w.span[0], w.span[1]), span: w.span, value: 0, kind: 'count' }));
  for (const w of words) if (!allow.includes(w.raw)) allow.push(w.raw);
  const sorted = [...covered.numbers, ...words].sort((a, b) => a.span[0] - b.span[0]);
  let template = '';
  let at = 0;
  const refAt: { id: string; start: number; end: number }[] = [];
  sorted.forEach((n, i) => {
    const id = `f${i + 1}`;
    template += text.slice(at, n.span[0]);
    const start = template.length;
    template += `{{${id}}}`;
    refAt.push({ id, start, end: template.length });
    at = n.span[1];
  });
  template += text.slice(at);
  // Any number word left in the template (a bare scale word next to a number) stays allowed as before.
  for (const w of numberWordsIn(template)) if (!allow.includes(w)) allow.push(w);

  const facts: Fact[] = sorted.map((n, i) => {
    const { start, end } = refAt[i];
    let s = Math.max(0, start - 60);
    let e = Math.min(template.length, end + 60);
    while (s > 0 && !/\s/.test(template[s - 1])) s--;
    while (e < template.length && !/\s/.test(template[e])) e++;
    // Don't cut a reference in half.
    const window = template.slice(s, e).replace(/^[^{]*?\}\}/, '').replace(/\{\{[^}]*$/, '');
    const kind = (n.kind && KINDS.has(n.kind as FactKind) ? n.kind : 'count') as FactKind;
    return {
      id: `f${i + 1}`,
      key: `original:n${i + 1}`,
      label: `${kind} as written in the report, in: "${window.replace(/\s+/g, ' ').trim()}"`,
      value: n.value ?? (Number(n.raw.replace(/[^\d.\-]/g, '')) || 0),
      kind,
      unit: n.unit ?? '',
      display: n.raw,
      formula: 'as written in the original report',
      inputs: [],
      scope: { metric: 'as_written' },
      flags: [],
    };
  });
  return { template, facts: { currency: '', periods: { current: '' }, facts }, allow };
}

/**
 * Revise text with notes. With a facts table, `text` is a template and the result is a Draft.
 * Without one, the text is templatized first (numbers found by regex), so the model still sees no
 * numbers, and the rendered string comes back.
 */
export async function revise(input: { text: string; notes: PanelNote[]; facts?: FactsTable; chat: ChatClient; model: string }): Promise<Draft | string> {
  if (input.facts) {
    return (await reviseDetailed({ template: input.text, notes: input.notes, facts: input.facts, chat: input.chat, model: input.model })).draft;
  }
  const t = templatize(input.text, findNumbers(input.text));
  const r = await reviseDetailed({ template: t.template, notes: input.notes, facts: t.facts, chat: input.chat, model: input.model, allow: t.allow, task: 'rewrite' });
  return r.draft.rendered;
}
