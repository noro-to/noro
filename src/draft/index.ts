// Draft: the writing model turns fact ids + labels + classification into a
// template that cites {{fN}}; renderTemplate() puts code's numbers in.
// Revise: the writing model applies notes to a template (or cuts a pasted
// report down, revision mode); its output goes back through renderTemplate().
// A template that breaks the digit rule gets one retry with the error, then
// the step fails with RawNumberError.

import type { Classification, ChatClient, Draft, Fact, FactKind, FactsTable, PanelNote } from '../schema.js';
import { parseJsonObject, stripFence } from './chat.js';
import { DEFAULT_FORMAT, FORMATS, buildDraftPrompt, buildRetryNote, buildRevisePrompt, noteKey } from './prompts.js';
import { RawNumberError, renderTemplate, scrubNumbers } from './template.js';
import type { TemplateOptions } from './template.js';

export { createChatClient, parseJsonObject, stripFence } from './chat.js';
export { createClaudeCliClient, checkClaudeAuth, ClaudeCliError } from './claude-cli.js';
export {
  RawNumberError,
  allowedIdentifiers,
  maskIdentifiers,
  renderTemplate,
  scrubNumbers,
  segments,
  templateQuote,
  templateSpan,
  traceNumbers,
  validateTemplate,
} from './template.js';
export type { NumberTrace, TemplateErrorKind, TemplateOptions } from './template.js';
export { DEFAULT_FORMAT, FORMATS, HOUSE_RULES, NUMBER_RULES, buildDraftPrompt, buildPanelPrompt, buildRevisePrompt, factCard } from './prompts.js';

/** What the retry is told: the error, with any raw number the model wrote scrubbed out. */
function retryMessage(err: RawNumberError, facts: FactsTable, opts: TemplateOptions): string {
  const what =
    err.kind === 'raw_number'
      ? 'it contains numbers written as digits instead of fact references'
      : err.kind === 'spelled_number'
        ? `it compares numbers in words ("${scrubNumbers(err.offending.join('", "'), facts, opts)}")`
        : err.kind === 'unknown_fact'
          ? `it cites ids that are not in the list (${err.offending.map((x) => `{{${x}}}`).join(', ')})`
          : err.kind === 'null_fact'
            ? `it cites facts with no value (${err.offending.map((x) => `{{${x}}}`).join(', ')})`
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
  /** Digit-bearing tokens left in the template (identifiers the extractor ignored). */
  allow: string[];
}

export interface FoundNumber {
  raw: string;
  span: [number, number];
  value?: number;
  kind?: string;
  unit?: string;
}

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

/**
 * Replace each found number with {{fN}} and build a facts table whose displays are the raws as
 * written. Labels carry the templated sentence around the number, so they hold no numbers.
 */
export function templatize(text: string, numbers: FoundNumber[]): Templatized {
  const sorted = [...numbers].sort((a, b) => a.span[0] - b.span[0]);
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
  // Identifiers the extractor left in place. A token with a letter ("Q4", "PR-03") stands alone; a
  // digits-only token keeps the word before it ("Oct 6", "Oct 5–11"), so a bare small integer is never
  // allowed on its own. A standalone four-digit year is allowed as is.
  const tokens = template
    .replace(/\{\{\s*f\d+\s*\}\}/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{Nd}]+|[^\p{L}\p{Nd}]+$/gu, ''));
  const allowSet = new Set<string>();
  tokens.forEach((t, i) => {
    if (!/\p{Nd}/u.test(t)) return;
    if (/\p{L}/u.test(t) || /^(19|20)\d\d$/.test(t)) allowSet.add(t);
    else if (i > 0 && /^\p{L}+$/u.test(tokens[i - 1])) allowSet.add(`${tokens[i - 1]} ${t}`);
  });
  const allow = [...allowSet];
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
