// Templates: the only way a number gets into a report.
//
// A model writes prose with {{f12}} references. renderTemplate() checks the
// template and replaces each reference with that fact's `display`, which code
// computed. The model never writes a digit of its own.
//
// The digit rule (what renderTemplate rejects with RawNumberError)
//   1. Strip every {{fN}} reference. Each must name a fact in the table that
//      has a value (a null fact renders "n/a", which no report should say).
//   2. Mask allowed identifiers: names that carry digits but are not numbers.
//      They are exactly
//        - campaign and ad group names from the facts table's scopes (these
//          appear verbatim in fact labels, e.g. "PR-03" in
//          "CPA, campaign PR-03, current week"),
//        - the period labels of the facts table ("Oct 6–12"),
//        - in revision mode, the digit-bearing tokens the engine's `extract`
//          left in the pasted report because it reads them as identifiers
//          ("Q4", "W45", dates), passed as `opts.allow`.
//      A campaign or ad group name only counts when it contains a letter, so
//      a campaign called "41" can't smuggle in a number. A match must sit on
//      word boundaries and must not touch a unit or currency sign ("PR-03%"
//      or "$PR-03" stay raw).
//   3. Any digit left over (any Unicode decimal digit) is a raw number.
//   4. Spelled-out arithmetic is rejected too: "doubled", "halved",
//      "threefold", "twice as", "forty percent", "three times".
// Everything the model wrote is held to this, including reviser output.

import type { Draft, Fact, FactsTable } from '../schema.js';

export type TemplateErrorKind = 'raw_number' | 'spelled_number' | 'unknown_fact' | 'null_fact' | 'bad_reference';

/** The template breaks the arithmetic rule: a digit outside {{fN}}, spelled arithmetic, or a bad reference. */
export class RawNumberError extends Error {
  constructor(
    message: string,
    readonly kind: TemplateErrorKind,
    /** The offending text: raw numbers, unknown ids, or bad references. */
    readonly offending: string[],
  ) {
    super(message);
    this.name = 'RawNumberError';
  }
}

export interface TemplateOptions {
  /** Extra identifiers that may contain digits (revision mode: what the engine ignored in the original). */
  allow?: string[];
}

const REF = /\{\{\s*(f\d+)\s*\}\}/g;
const DIGIT = /\p{Nd}/u;
const LETTER = /\p{L}/u;

const NUMBER_WORDS =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|a quarter|a third';
const SPELLED: RegExp[] = [
  /\b(doubl(?:ed|es|ing)|tripl(?:ed|es|ing)|quadrupl(?:ed|es|ing)|halv(?:ed|es|ing)|twice as|thrice)\b/i,
  /\b[a-z]+fold\b/i,
  new RegExp(`\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}))*[\\s-]+(?:percent|per cent|percentage points?|times|x)\\b`, 'i'),
];

/** Names that may carry digits without being numbers. See the rule above. */
export function allowedIdentifiers(facts: FactsTable, extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const f of facts.facts) {
    for (const name of [f.scope.campaign, f.scope.adGroup]) {
      if (name && DIGIT.test(name) && LETTER.test(name)) out.add(name);
    }
  }
  for (const p of [facts.periods.current, facts.periods.previous]) {
    if (p && DIGIT.test(p)) out.add(p);
  }
  for (const x of extra) if (x && DIGIT.test(x)) out.add(x);
  // Longest first, so "PR-03 Brand" masks before "PR-03".
  return [...out].sort((a, b) => b.length - a.length);
}

const BEFORE_BAD = /[\p{L}\p{Nd}$€£¥+\-.,]/u;
const AFTER_BAD = /[\p{L}\p{Nd}%]/u;

/** Where allowed identifiers occur in text on clean boundaries, longest first, non-overlapping. */
export function identifierRanges(text: string, identifiers: string[]): [number, number][] {
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const id of identifiers) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(id, from);
      if (at < 0) break;
      const end = at + id.length;
      const before = at > 0 ? text[at - 1] : '';
      const after = text.slice(end, end + 2);
      const okBefore = before === '' || !BEFORE_BAD.test(before);
      const okAfter = after === '' || (!AFTER_BAD.test(after[0]) && !/^[.,]\p{Nd}/u.test(after));
      if (okBefore && okAfter && !overlaps(at, end)) taken.push([at, end]);
      from = at + 1;
    }
  }
  return taken.sort((a, b) => a[0] - b[0]);
}

/** Replace allowed identifiers (on clean boundaries) with spaces of the same length. */
export function maskIdentifiers(text: string, identifiers: string[]): string {
  let out = text;
  for (const [s, e] of identifierRanges(text, identifiers)) out = out.slice(0, s) + ' '.repeat(e - s) + out.slice(e);
  return out;
}

/** Number-like tokens around each stray digit, for error messages. */
function rawTokens(masked: string): string[] {
  const out: string[] = [];
  const re = /[$€£¥+\-]?\p{Nd}[\p{Nd},.]*\s?(?:%|pp\b|x\b|k\b|K\b|M\b|bn\b)?/gu;
  for (const m of masked.matchAll(re)) out.push(m[0].trim());
  return [...new Set(out)];
}

/** Text with every {{fN}} reference removed (replaced by spaces), plus the ids in order of first use. */
function stripRefs(template: string): { stripped: string; ids: string[]; all: string[] } {
  const ids: string[] = [];
  const all: string[] = [];
  const stripped = template.replace(REF, (m, id: string) => {
    all.push(id);
    if (!ids.includes(id)) ids.push(id);
    return ' '.repeat(m.length);
  });
  return { stripped, ids, all };
}

export interface ValidateResult {
  factIds: string[];
}

/**
 * Check text against the digit rule without rendering it. `facts` may be undefined only for
 * text that must not contain any reference (then every digit outside `allow` is raw).
 */
export function validateTemplate(template: string, facts: FactsTable | undefined, opts: TemplateOptions = {}): ValidateResult {
  const { stripped, ids } = stripRefs(template);
  const byId = new Map<string, Fact>((facts?.facts ?? []).map((f) => [f.id, f]));

  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) {
    throw new RawNumberError(
      `The template cites ${unknown.map((u) => `{{${u}}}`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in the facts table. Cite only the fact ids you were given.`,
      'unknown_fact',
      unknown,
    );
  }
  const nulls = ids.filter((id) => byId.get(id)!.value === null);
  if (nulls.length) {
    throw new RawNumberError(
      `The template cites ${nulls.map((u) => `{{${u}}}`).join(', ')}, which has no value (it could not be computed). Don't cite it.`,
      'null_fact',
      nulls,
    );
  }
  const bad = stripped.match(/\{\{[^}]*\}\}|\{\{|\}\}/g);
  if (bad) {
    throw new RawNumberError(
      `Malformed reference ${bad.map((b) => `"${b}"`).join(', ')}. A reference is exactly {{f12}}: double braces around one fact id.`,
      'bad_reference',
      bad,
    );
  }

  const identifiers = facts ? allowedIdentifiers(facts, opts.allow) : allowedIdentifiers({ currency: '', periods: { current: '' }, facts: [] }, opts.allow);
  const masked = maskIdentifiers(stripped, identifiers);
  if (DIGIT.test(masked)) {
    const raws = rawTokens(masked);
    throw new RawNumberError(
      `Raw number${raws.length === 1 ? '' : 's'} in the template: ${raws.map((r) => `"${r}"`).join(', ')}. Every number must be a fact reference like {{f12}}; write no digits yourself (campaign names and period labels excepted).`,
      'raw_number',
      raws,
    );
  }
  for (const re of SPELLED) {
    const m = masked.match(re);
    if (m) {
      throw new RawNumberError(
        `Spelled-out arithmetic in the template: "${m[0]}". Don't compare numbers in words; cite the fact that holds the change, like {{f12}}.`,
        'spelled_number',
        [m[0]],
      );
    }
  }
  return { factIds: ids };
}

/** Check a template against the digit rule and render each {{fN}} as the fact's display. */
export function renderTemplate(template: string, facts: FactsTable, opts: TemplateOptions = {}): Draft {
  const { factIds } = validateTemplate(template, facts, opts);
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const rendered = template.replace(REF, (_m, id: string) => byId.get(id)!.display);
  return { template, rendered, factIds };
}

/** One piece of a template: literal text or a reference, with its spans in template and rendered text. */
export interface Segment {
  kind: 'text' | 'ref';
  id?: string;
  t: [number, number];
  r: [number, number];
}

/** Map a template onto its rendering, piece by piece. Assumes the template already rendered cleanly. */
export function segments(template: string, facts: FactsTable): Segment[] {
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const out: Segment[] = [];
  let t = 0;
  let r = 0;
  for (const m of template.matchAll(REF)) {
    const at = m.index!;
    if (at > t) {
      out.push({ kind: 'text', t: [t, at], r: [r, r + (at - t)] });
      r += at - t;
    }
    const display = byId.get(m[1])?.display ?? '';
    out.push({ kind: 'ref', id: m[1], t: [at, at + m[0].length], r: [r, r + display.length] });
    r += display.length;
    t = at + m[0].length;
  }
  if (t < template.length) out.push({ kind: 'text', t: [t, template.length], r: [r, r + (template.length - t)] });
  return out;
}

/**
 * The template text behind a span of the rendered text. A span that touches a rendered number is
 * widened to the whole reference, so the result never contains a fact's display.
 */
export function templateSpan(template: string, facts: FactsTable, span: [number, number]): string {
  const [s, e] = span;
  let ts = -1;
  let te = -1;
  for (const seg of segments(template, facts)) {
    const [rs, re] = seg.r;
    if (re <= s || rs >= e) {
      // A zero-width ref (empty display) never overlaps; skip.
      continue;
    }
    if (seg.kind === 'ref') {
      if (ts < 0) ts = seg.t[0];
      te = seg.t[1];
    } else {
      const a = Math.max(s, rs) - rs + seg.t[0];
      const b = Math.min(e, re) - rs + seg.t[0];
      if (ts < 0) ts = a;
      te = b;
    }
  }
  return ts < 0 ? '' : template.slice(ts, te);
}

/** The template form of a quote taken from the rendered text, or undefined when it isn't found. */
export function templateQuote(draft: Draft, facts: FactsTable, quote: string): string | undefined {
  const at = draft.rendered.indexOf(quote);
  if (at < 0) return undefined;
  return templateSpan(draft.template, facts, [at, at + quote.length]);
}

/**
 * Make free text safe to show a model: references and allowed identifiers stay, every other
 * number-like token becomes "N". Used on engine messages and rule fixes, which can quote numbers.
 */
export function scrubNumbers(text: string, facts?: FactsTable, opts: TemplateOptions = {}): string {
  const identifiers = facts ? allowedIdentifiers(facts, opts.allow) : allowedIdentifiers({ currency: '', periods: { current: '' }, facts: [] }, opts.allow);
  // Protect refs and identifiers with placeholders, scrub, then restore.
  const kept: string[] = [];
  // Placeholder keys are letters, so the scrub below can't touch them.
  const keep = (x: string) => {
    kept.push(x);
    let n = kept.length - 1;
    let key = '';
    do {
      key = String.fromCharCode(65 + (n % 26)) + key;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `\u0000${key}\u0000`;
  };
  let out = text.replace(REF, (m) => keep(m));
  let rebuilt = '';
  let i = 0;
  for (const [s, e] of identifierRanges(out, identifiers)) {
    rebuilt += out.slice(i, s) + keep(out.slice(s, e));
    i = e;
  }
  out = rebuilt + out.slice(i);
  out = out.replace(/[$€£¥+\-]?\p{Nd}[\p{Nd},.]*(?:\s?(?:%|pp\b|x\b|k\b|K\b|M\b|bn\b))?/gu, (m) => (m.endsWith('.') ? 'N.' : 'N'));
  return out.replace(/\u0000([A-Z]+)\u0000/g, (_m, key: string) => {
    let n = 0;
    for (const ch of key) n = n * 26 + (ch.charCodeAt(0) - 64);
    return kept[n - 1];
  });
}

/** One number found in final text and the fact it traces to. */
export interface NumberTrace {
  raw: string;
  factId: string;
  span: [number, number];
}

/**
 * Find every number in rendered text and trace it to a fact by its exact display. Displays shared
 * by several facts trace to the first one in `prefer` (the ids the draft cited), then table order.
 * Returns the traces and any digits left that match no display.
 */
export function traceNumbers(
  text: string,
  facts: FactsTable,
  opts: TemplateOptions & { prefer?: string[] } = {},
): { traces: NumberTrace[]; untraced: string[] } {
  const prefer = opts.prefer ?? [];
  const rank = (f: Fact) => {
    const i = prefer.indexOf(f.id);
    return i < 0 ? prefer.length + Number(f.id.replace(/\D/g, '')) : i;
  };
  const byDisplay = new Map<string, Fact>();
  for (const f of facts.facts) {
    if (f.value === null || !DIGIT.test(f.display)) continue;
    const cur = byDisplay.get(f.display);
    if (!cur || rank(f) < rank(cur)) byDisplay.set(f.display, f);
  }
  const displays = [...byDisplay.keys()].sort((a, b) => b.length - a.length);
  let work = maskIdentifiers(text, allowedIdentifiers(facts, opts.allow));
  const traces: NumberTrace[] = [];
  for (const d of displays) {
    let from = 0;
    for (;;) {
      const at = work.indexOf(d, from);
      if (at < 0) break;
      const before = at > 0 ? work[at - 1] : '';
      const after = work.slice(at + d.length, at + d.length + 2);
      const okBefore = before === '' || !/[\p{L}\p{Nd}$€£¥+\-.,]/u.test(before);
      const okAfter = after === '' || (!/[\p{L}\p{Nd}%]/u.test(after[0]) && !/^[.,]\p{Nd}/u.test(after));
      if (okBefore && okAfter) {
        traces.push({ raw: d, factId: byDisplay.get(d)!.id, span: [at, at + d.length] });
        work = work.slice(0, at) + ' '.repeat(d.length) + work.slice(at + d.length);
      }
      from = at + d.length;
    }
  }
  traces.sort((a, b) => a.span[0] - b.span[0]);
  return { traces, untraced: DIGIT.test(work) ? rawTokens(work) : [] };
}
