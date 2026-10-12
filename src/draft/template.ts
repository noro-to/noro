// Templates: the only way a number gets into a report.
//
// A model writes prose with {{f12}} references. renderTemplate() checks the
// template and replaces each reference with that fact's `display`, which code
// computed. The model never writes a digit of its own.
//
// The digit rule (what renderTemplate rejects with RawNumberError)
//   0. Invisible format characters (Unicode category Cf: zero-width spaces,
//      soft hyphens, bidi marks) are removed first, so "dou\u200Bbled" is
//      "doubled". The stored template is the cleaned one.
//   1. Strip every {{fN}} reference. Each must name a fact in the table that
//      has a value (a null fact renders "n/a", which no report should say).
//      A reference must stand alone: no letter, digit, unit, sign or other
//      reference directly against it ("{{f1}}{{f2}}", "{{f1}}k", "{{f1}}%",
//      "{{f1}}x", "-{{f1}}", "PR{{f1}}", "{{f1}}.{{f2}}" are refused).
//   2. Mask allowed identifiers: names that carry digits but are not numbers.
//      They are exactly
//        - campaign and ad group names from the facts table's scopes (these
//          appear verbatim in fact labels, e.g. "PR-03" in
//          "CPA, campaign PR-03, current week"),
//        - the period labels of the facts table ("Oct 6–12"),
//        - in revision mode, identifiers left in the pasted report, passed as
//          `opts.allow`. Only strict identifier shapes count (see
//          isIdentifierShape): letter-led codes ("Q4", "H2", "FY26", "W45",
//          "PR-07"), four-digit years, ISO dates and month-name dates. Any
//          other entry is ignored, so "x2", "1e3" or "Top 5" can't be allowed.
//      A campaign or ad group name only counts when it contains a letter, so
//      a campaign called "41" can't smuggle in a number. A match must sit on
//      word boundaries and must not touch a unit or currency sign ("PR-03%"
//      or "$PR-03" stay raw).
//   3. Any numeral left over is a raw number: any Unicode number (\p{N}), so
//      superscripts, vulgar fractions, roman numerals and circled digits count
//      as well as decimal digits in any script.
//   4. Numbers in words are rejected too (checked on the NFKC form):
//        - cardinals and their multiples: "one" … "ninety", "hundred",
//          "thousand", "million", "billion", "dozen" ("forty-one dollars",
//          "only three conversions", "one in five clicks", "a dozen");
//        - ordinals and fractions: "first", "second", "third", "fifth" …,
//          "half", "halved", "two thirds", "a quarter of";
//        - multipliers: "double", "doubled", "triple", "quadruple", "twice",
//          "thrice", "two-fold", "threefold", "-fold".
//      Ordinary phrases that only look like numbers stay allowed: "no one",
//      "one another", "one-off", "one of the …" (a pronoun: "one of the main
//      contributors"; any number after it is still caught), "first-party",
//      "third-party", "first-click", "double-check", "double-click",
//      "double-count", "double down", and "quarter" as a period ("this
//      quarter", "next quarter"). Every other "one" is refused ("one
//      campaign", "only one", "one in five"), and "first" / "second" as
//      ordering words ("first week", "First, …") are refused too: they
//      assert a rank or a position. "Why:" / "Next:" labels are fine.
//      Revision mode only: a number-word phrase that appears verbatim in the
//      pasted original ("the two", "six months", "nine campaigns") may be
//      repeated, because the original said it and no code computed it. The
//      caller passes those phrases in `opts.allow` (templatize does). A phrase
//      must match whole ("two" doesn't allow "two times" or "twenty-two"), and
//      a bare scale word ("million") is never allowed. Generate mode passes no
//      such list, so every number word stays refused.
// Everything the model wrote is held to this, including reviser output and a
// user's rewords at deliver.
//
// One rendering nicety: a computed change fact ("+38%", "-12%") cited directly
// after a direction word of the same sign ("rose", "up", "fell", "down",
// "increased by" …) renders without the sign ("rose 38%", "fell 12%"). The
// tracer accepts that unsigned form only in the same position, and the engine
// traces an unsigned number by its absolute value. Facts "as written" in a
// pasted report always render exactly as written.

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
/** Any numeral: decimal digits in any script, superscripts, fractions, roman numerals, circled digits. */
export const NUMERAL = /\p{N}/u;
const LETTER = /\p{L}/u;
const INVISIBLE = /\p{Cf}/gu;

/** Remove invisible format characters (zero-width spaces and joiners, soft hyphens, bidi marks). */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/** The form number words are checked on: NFKC (fullwidth and styled letters fold to plain ones), no Cf. */
function wordForm(text: string): string {
  return stripInvisible(stripInvisible(text).normalize('NFKC'));
}

const CARDINAL =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|dozens?';
const ORDINAL =
  'first|second|thirds?|fourths?|fifths?|sixths?|sevenths?|eighths?|ninths?|tenths?|elevenths?|twelfths?|thirteenths?|fourteenths?|fifteenths?|sixteenths?|seventeenths?|eighteenths?|nineteenths?|twentieths?|thirtieths?|fortieths?|fiftieths?|sixtieths?|seventieths?|eightieths?|ninetieths?|hundredths?|thousandths?|millionths?';
const MULTIPLIER = 'doubl(?:e|ed|es|ing)|tripl(?:e|ed|es|ing)|quadrupl(?:e|ed|es|ing)|quintupl(?:e|ed|es|ing)|twice|thrice|halv(?:e|ed|es|ing)|half';

/** Phrases that only look like numbers. Blanked out before the number-word check. */
const HARMLESS: RegExp[] = [
  /\bno[\s-]+one\b/giu,
  /\bone[\s-]+another\b/giu,
  /\bone-off\b/giu,
  /\bone\s+of\s+(?:the|our|its|their|your|these|those|his|her|my|them|us)\b/giu,
  /\b(?:first|second|third)[\s-]+part(?:y|ies)\b/giu,
  /\bfirst[\s-]+(?:click|touch)\b/giu,
  /\bdouble[\s-]+(?:check(?:s|ed|ing)?|click(?:s|ed|ing)?|count(?:s|ed|ing)?|down)\b/giu,
];

const NUMBER_WORD_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:${CARDINAL})(?:fold)?\\b(?:[\\s-]+(?:${CARDINAL}|${ORDINAL}|percent|per cent|percentage points?|times|x|fold)\\b)*`, 'iu'),
  new RegExp(`\\b(?:${ORDINAL})\\b`, 'iu'),
  new RegExp(`\\b(?:${MULTIPLIER})\\b`, 'iu'),
  /-fold\b|\b(?:many|several|multi)fold\b/iu,
  /\ba\s+quarter\s+of\b|\bby\s+a\s+quarter\b|\bquarter(?:ed|ing)\b/iu,
];

/** The earliest number-word match in already-prepared text (wordForm, harmless phrases blanked). */
function firstNumberWord(t: string): { at: number; end: number; text: string } | undefined {
  let best: { at: number; end: number; text: string } | undefined;
  for (const re of NUMBER_WORD_PATTERNS) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { at: m.index, end: m.index + m[0].length, text: m[0].trim() };
  }
  return best;
}

function prepareWords(text: string): string {
  let t = wordForm(text);
  for (const re of HARMLESS) t = t.replace(re, (m) => ' '.repeat(m.length));
  return t;
}

/** Number words in text (already masked), or undefined. */
export function findNumberWords(text: string): string | undefined {
  return firstNumberWord(prepareWords(text))?.text;
}

/** Every number-word phrase in text, in order, as written ("two", "six", "forty-one", "doubled"). */
export function numberWordsIn(text: string): string[] {
  let t = prepareWords(text);
  const out: string[] = [];
  for (let m = firstNumberWord(t); m; m = firstNumberWord(t)) {
    out.push(m.text);
    t = t.slice(0, m.at) + ' '.repeat(m.end - m.at) + t.slice(m.end);
  }
  return out;
}

/**
 * Every number-word phrase in text with its span in `text` ("five times", "Half", "twenty").
 * Spans come from the prepared text when it keeps the length (the usual case); otherwise each
 * phrase is found again in order, on word boundaries.
 */
export function numberWordSpans(text: string): { raw: string; span: [number, number] }[] {
  let t = prepareWords(text);
  const same = t.length === text.length;
  const out: { raw: string; span: [number, number] }[] = [];
  let from = 0;
  for (let m = firstNumberWord(t); m; m = firstNumberWord(t)) {
    t = t.slice(0, m.at) + ' '.repeat(m.end - m.at) + t.slice(m.end);
    let at = -1;
    let end = -1;
    if (same) {
      const lead = text.slice(m.at, m.end).search(/\S/);
      at = m.at + Math.max(0, lead);
      end = at + m.text.length;
    } else {
      const esc = m.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu');
      re.lastIndex = from;
      const found = re.exec(text);
      if (found) (at = found.index), (end = found.index + found[0].length);
    }
    if (at < 0) continue;
    out.push({ raw: text.slice(at, end), span: [at, end] });
    from = end;
  }
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

/** How number-word phrases are compared: lowercase, hyphens and whitespace as one space. */
const wordKey = (phrase: string) => phrase.toLowerCase().replace(/[\s-]+/gu, ' ').trim();

/** A bare scale word ("million", "thousands") usually belongs to a number next to it, so it is never allowed on its own. */
const BARE_SCALE = /^(?:hundreds?|thousands?|millions?|billions?|trillions?)$/u;

/**
 * Revision mode: the number-word phrases of the pasted original that a rewrite may repeat. Each
 * `allow` entry with no numeral that is exactly one number-word phrase counts, except a bare scale
 * word. Generate mode passes no `allow`, so every number word stays refused there.
 */
export function allowedNumberWords(allow: string[] = []): Set<string> {
  const out = new Set<string>();
  for (const x of allow) {
    if (!x || NUMERAL.test(x)) continue;
    const found = numberWordsIn(x);
    if (found.length !== 1 || wordKey(found[0]) !== wordKey(x)) continue;
    const key = wordKey(x);
    if (!BARE_SCALE.test(key)) out.add(key);
  }
  return out;
}

/** The first number-word phrase in text that isn't in `allowed` (compared whole: "two" doesn't allow "two times"). */
function firstUnallowedNumberWord(text: string, allowed: Set<string>): string | undefined {
  return numberWordsIn(text).find((w) => !allowed.has(wordKey(w)));
}

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
const DATE_SOURCE =
  `\\d{4}-\\d{1,2}-\\d{1,2}|\\d{4}-\\d{2}(?![\\d-])` +
  `|${MONTH}\\.?\\s+${DAY}(?:\\s?[-–]\\s?(?:${MONTH}\\.?\\s+)?${DAY})?(?:,?\\s+\\d{4})?` +
  `|${DAY}(?:\\s?[-–]\\s?${DAY})?\\s+${MONTH}(?:,?\\s+\\d{4})?`;
/** Dates and period labels: ISO dates ("2025-10-06"), month-name dates and ranges ("Oct 6–12", "Sep 29–Oct 5", "6 Oct 2025"). */
export const DATE_LABEL = new RegExp(`(?<![\\p{L}\\p{N}])(?:${DATE_SOURCE})(?![\\p{L}\\p{N}])`, 'gu');
const DATE_EXACT = new RegExp(`^(?:${DATE_SOURCE})$`, 'u');
/** Letter-led codes: "Q4", "H2", "FY26", "W45", "PR-07", "NB-11", "PR-07-B". Not "x2" / "X2" (a multiplier). */
const CODE = /^(?!X\d)[A-Z]{1,5}-?\d{1,4}(?:[-_][A-Z0-9]{1,8})*$/;
const YEAR = /^(?:19|20)\d\d$/;

/**
 * Strict identifier shapes: the only digit-bearing tokens that may be allowed outside the facts
 * table's own names. Letter-led codes, four-digit years, ISO dates and month-name dates.
 */
export function isIdentifierShape(token: string): boolean {
  return CODE.test(token) || YEAR.test(token) || DATE_EXACT.test(token);
}

/** Names that may carry digits without being numbers. See the rule above. */
export function allowedIdentifiers(facts: FactsTable, extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const f of facts.facts) {
    for (const name of [f.scope.campaign, f.scope.adGroup]) {
      if (name && NUMERAL.test(name) && LETTER.test(name)) out.add(name);
    }
  }
  for (const p of [facts.periods.current, facts.periods.previous]) {
    if (p && NUMERAL.test(p)) out.add(p);
  }
  // Revision-mode extras: strict identifier shapes only, whatever the caller passed.
  for (const x of extra) if (x && NUMERAL.test(x) && isIdentifierShape(x)) out.add(x);
  // Longest first, so "PR-03 Brand" masks before "PR-03".
  return [...out].sort((a, b) => b.length - a.length);
}

const BEFORE_BAD = /[\p{L}\p{N}$€£¥+\-.,]/u;
const AFTER_BAD = /[\p{L}\p{N}%]/u;

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
      const okAfter = after === '' || (!AFTER_BAD.test(after[0]) && !/^[.,]\p{N}/u.test(after));
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
  const re = /[$€£¥+\-]?\p{N}[\p{N},.]*\s?(?:%|pp\b|x\b|k\b|K\b|M\b|bn\b)?/gu;
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

export interface ValidateOptions extends TemplateOptions {
  /**
   * Also accept a fact's display typed exactly as the report shows it (a user's reword at deliver).
   * Models never get this: they cite {{fN}}.
   */
  displays?: boolean;
}

/** References touching something that would change the number they render: "{{f1}}{{f2}}", "{{f1}}k", "-{{f1}}", "PR{{f1}}". */
function badAdjacency(template: string): string[] {
  const out: string[] = [];
  const nearBefore = /[\p{L}\p{N}}$€£¥+\-−–±~≈#@]/u;
  const nearAfter = /[\p{L}\p{N}{%‰×$€£¥]/u;
  const joiner = /[.,:/\-–]/u;
  for (const m of template.matchAll(REF)) {
    const s = m.index!;
    const e = s + m[0].length;
    const b1 = template[s - 1] ?? '';
    const b2 = template[s - 2] ?? '';
    const a1 = template[e] ?? '';
    const a2 = template[e + 1] ?? '';
    const before = (b1 !== '' && nearBefore.test(b1)) || (joiner.test(b1) && /[\p{N}}]/u.test(b2));
    const after = (a1 !== '' && nearAfter.test(a1)) || (joiner.test(a1) && /[\p{N}{]/u.test(a2));
    if (before || after) {
      const from = Math.max(0, s - (before ? (joiner.test(b1) ? 2 : 1) : 0));
      const to = Math.min(template.length, e + (after ? (joiner.test(a1) ? 2 : 1) : 0));
      out.push(template.slice(from, to));
    }
  }
  return [...new Set(out)];
}

/**
 * Check text against the digit rule without rendering it. `facts` may be undefined only for
 * text that must not contain any reference (then every digit outside `allow` is raw).
 */
export function validateTemplate(template: string, facts: FactsTable | undefined, opts: ValidateOptions = {}): ValidateResult {
  const clean = stripInvisible(template);
  const { stripped, ids } = stripRefs(clean);
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
  const touching = badAdjacency(clean);
  if (touching.length) {
    throw new RawNumberError(
      `Reference${touching.length === 1 ? '' : 's'} run into other text: ${touching.map((b) => `"${b}"`).join(', ')}. A reference stands alone: no letter, digit, unit, sign or other reference directly against it.`,
      'bad_reference',
      touching,
    );
  }

  const empty: FactsTable = { currency: '', periods: { current: '' }, facts: [] };
  const identifiers = allowedIdentifiers(facts ?? empty, opts.allow);
  let masked = maskIdentifiers(stripped, identifiers);
  if (opts.displays && facts) masked = traceIn(masked, facts, { prefer: [] }).work;
  if (NUMERAL.test(masked)) {
    const raws = rawTokens(masked);
    throw new RawNumberError(
      `Raw number${raws.length === 1 ? '' : 's'} in the template: ${raws.map((r) => `"${r}"`).join(', ')}. Every number must be a fact reference like {{f12}}; write no digits yourself (campaign names and period labels excepted).`,
      'raw_number',
      raws,
    );
  }
  // Campaign and ad group names are names even when they hold a number word ("Half Price Sale").
  const names = [...new Set((facts?.facts ?? []).flatMap((f) => [f.scope.campaign, f.scope.adGroup]).filter((n): n is string => !!n && LETTER.test(n)))];
  // Revision mode: number words the pasted original already used verbatim aren't computed numbers.
  const words = firstUnallowedNumberWord(maskIdentifiers(masked, names.sort((a, b) => b.length - a.length)), allowedNumberWords(opts.allow));
  if (words) {
    throw new RawNumberError(
      `Number written in words in the template: "${words}". Write no numbers in words (no "one", "first", "half", "double", "twice", "a dozen", "one in five"); cite the fact that holds the number, like {{f12}}.`,
      'spelled_number',
      [words],
    );
  }
  return { factIds: ids };
}

/** Change facts code formatted with a sign may drop it after a matching direction word. Facts as written never do. */
function signable(f: Fact): boolean {
  return !f.key.startsWith('original:') && /^[+\-−]/.test(f.display);
}

const UP_WORDS = 'rose|rises|rising|risen|up|increased|increases|increasing|grew|grows|growing|grown|climbed|climbs|climbing|jumped|jumps|jumping|gained|gains|gaining';
const DOWN_WORDS = 'fell|falls|falling|fallen|down|decreased|decreases|decreasing|dropped|drops|dropping|declined|declines|declining|slipped|slips|slipping|dipped|dips|dipping|shrank|shrinks|shrinking';
const DIRECTION_BEFORE = new RegExp(`(?<![\\p{L}\\p{N}])(?:(${UP_WORDS})|(${DOWN_WORDS}))(?:\\s+by)?\\s+$`, 'iu');

/** The direction word right before `at` in text ("rose ", "fell by "), if any. */
function directionBefore(text: string, at: number): 'up' | 'down' | undefined {
  const m = text.slice(Math.max(0, at - 24), at).match(DIRECTION_BEFORE);
  return m ? (m[1] ? 'up' : 'down') : undefined;
}

const signOf = (display: string): 'up' | 'down' => (display.startsWith('+') ? 'up' : 'down');

/** How the reference at `at` in `template` renders: the display, minus a sign its direction word already says. */
function renderAt(template: string, at: number, f: Fact): string {
  if (!signable(f)) return f.display;
  return directionBefore(template, at) === signOf(f.display) ? f.display.slice(1) : f.display;
}

/**
 * Render the references in a fragment of a template the way renderTemplate does, without checking
 * it (unknown ids stay as written). For quotes and notes about a draft, so they match its text.
 */
export function renderFragment(text: string, facts: FactsTable): string {
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  return text.replace(REF, (m, id: string, at: number) => {
    const f = byId.get(id);
    return f ? renderAt(text, at, f) : m;
  });
}

/** Check a template against the digit rule and render each {{fN}} as the fact's display. */
export function renderTemplate(template: string, facts: FactsTable, opts: ValidateOptions = {}): Draft {
  const clean = stripInvisible(template);
  const { factIds } = validateTemplate(clean, facts, opts);
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const rendered = clean.replace(REF, (_m, id: string, at: number) => renderAt(clean, at, byId.get(id)!));
  return { template: clean, rendered, factIds };
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
    const f = byId.get(m[1]);
    const display = f ? renderAt(template, at, f) : '';
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
  out = out.replace(/[$€£¥+\-]?\p{N}[\p{N},.]*(?:\s?(?:%|pp\b|x\b|k\b|K\b|M\b|bn\b))?/gu, (m) => (m.endsWith('.') ? 'N.' : 'N'));
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

/** Trace displays in text (identifiers already masked or not), masking each traced span in `work`. */
function traceIn(text: string, facts: FactsTable, opts: { prefer?: string[] }): { traces: NumberTrace[]; work: string } {
  const prefer = opts.prefer ?? [];
  const rank = (f: Fact) => {
    const i = prefer.indexOf(f.id);
    return i < 0 ? prefer.length + Number(f.id.replace(/\D/g, '')) : i;
  };
  const byDisplay = new Map<string, Fact>();
  const unsigned = new Map<string, Map<'up' | 'down', Fact>>();
  for (const f of facts.facts) {
    if (f.value === null || !NUMERAL.test(f.display)) continue;
    const cur = byDisplay.get(f.display);
    if (!cur || rank(f) < rank(cur)) byDisplay.set(f.display, f);
    if (signable(f)) {
      const u = f.display.slice(1);
      const m = unsigned.get(u) ?? new Map<'up' | 'down', Fact>();
      const dir = signOf(f.display);
      const prev = m.get(dir);
      if (!prev || rank(f) < rank(prev)) m.set(dir, f);
      unsigned.set(u, m);
    }
  }
  let work = text;
  const traces: NumberTrace[] = [];
  const clean = (at: number, len: number) => {
    const before = at > 0 ? work[at - 1] : '';
    const after = work.slice(at + len, at + len + 2);
    const okBefore = before === '' || !/[\p{L}\p{N}$€£¥+\-−.,]/u.test(before);
    const okAfter = after === '' || (!/[\p{L}\p{N}%]/u.test(after[0]) && !/^[.,]\p{N}/u.test(after));
    return okBefore && okAfter;
  };
  const scan = (needle: string, pick: (at: number) => Fact | undefined) => {
    let from = 0;
    for (;;) {
      const at = work.indexOf(needle, from);
      if (at < 0) break;
      const f = clean(at, needle.length) ? pick(at) : undefined;
      if (f) {
        traces.push({ raw: needle, factId: f.id, span: [at, at + needle.length] });
        work = work.slice(0, at) + ' '.repeat(needle.length) + work.slice(at + needle.length);
      }
      from = at + needle.length;
    }
  };
  // Exact displays first, longest first; then a signed change written without its sign ("rose 38%"
  // for +38%, "fell 12%" for -12%), as the engine also traces it, except right after a direction word
  // that contradicts the sign ("fell 38%" never traces to +38%).
  for (const d of [...byDisplay.keys()].sort((a, b) => b.length - a.length)) scan(d, () => byDisplay.get(d));
  for (const u of [...unsigned.keys()].sort((a, b) => b.length - a.length)) {
    scan(u, (at) => {
      const byDir = unsigned.get(u)!;
      const dir = directionBefore(work, at);
      if (dir) return byDir.get(dir);
      return byDir.size === 1 ? [...byDir.values()][0] : undefined;
    });
  }
  traces.sort((a, b) => a.span[0] - b.span[0]);
  return { traces, work };
}

/**
 * Find every number in rendered text and trace it to a fact by its exact display. Displays shared
 * by several facts trace to the first one in `prefer` (the ids the draft cited), then table order.
 * A signed change fact also traces in its unsigned form (how renderTemplate shows it after "rose" or
 * "fell"), unless a direction word right before it says the opposite. Returns the traces and any numerals left that match no display.
 */
export function traceNumbers(
  text: string,
  facts: FactsTable,
  opts: TemplateOptions & { prefer?: string[] } = {},
): { traces: NumberTrace[]; untraced: string[] } {
  // Invisible characters become spaces (spans stay aligned with `text`), so they can't hide a numeral.
  const masked = maskIdentifiers(text.replace(INVISIBLE, ' '), allowedIdentifiers(facts, opts.allow));
  const { traces, work } = traceIn(masked, facts, opts);
  return { traces, untraced: NUMERAL.test(work) ? rawTokens(work) : [] };
}
