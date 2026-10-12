// Deliver: show the flags, the user keeps, cuts or rewords each one, and code
// produces the final version with a trace for every number in it.
//
// Flags come from three places (buildFlags):
//   check     engine findings on the final draft (tells, numbers, shape...) and untraced numbers
//   panel     reviewer notes the reviser did not apply, and notes "for the writer"
//   watchout  watchout findings from the engine, and cited facts that classify
//             labeled luck_risk or tagged with watchouts
// A flag's text never contains a number that isn't a fact display: engine
// messages and rule fixes are scrubbed (stray numbers become "N"), and
// reviewer notes have their {{fN}} references rendered.
//
// Decisions: keep (leave the text), cut (remove the sentence(s) holding the
// flag's quote), reword (replace the quote with the user's words). A reword
// is held to the same digit rule as a model's template (validateTemplate):
// it may cite {{fN}} or type a figure exactly as the report shows it, and
// any other number — digits, other numerals ("½", "⁴¹"), numbers in words
// ("doubled", "a third"), references run into other text — is refused and
// the flag is asked again (three tries, then RawNumberError).

import { RawNumberError, maskIdentifiers, allowedIdentifiers, renderFragment, segments, stripInvisible, traceNumbers, validateTemplate } from '../draft/template.js';
import type { CheckReport, Classification, Decision, Draft, FactsTable, Flag, PanelNote, Report } from '../schema.js';

const NUMBER_TOKEN = /[$€£¥+\-]?\p{N}[\p{N},]*(?:\.\p{N}+)?(?:\s?(?:%|pp\b|x\b|k\b|K\b|M\b|bn\b))?/gu;
const REF = /\{\{\s*(f\d+)\s*\}\}/g;

/** Replace numbers that aren't a fact display (or an allowed identifier) with "N". */
export function scrubForUser(text: string, facts?: FactsTable, allow: string[] = []): string {
  const displays = new Set((facts?.facts ?? []).filter((f) => f.value !== null).map((f) => f.display));
  const masked = facts ? maskIdentifiers(text, allowedIdentifiers(facts, allow)) : text;
  let out = '';
  let at = 0;
  for (const m of masked.matchAll(NUMBER_TOKEN)) {
    const raw = text.slice(m.index!, m.index! + m[0].length);
    out += text.slice(at, m.index!);
    out += displays.has(raw.trim()) ? raw : raw.endsWith(' ') ? 'N ' : 'N';
    at = m.index! + m[0].length;
  }
  return out + text.slice(at);
}

/** Render {{fN}} references in a fragment as displays (unknown ids stay as written). */
function renderRefs(text: string, facts?: FactsTable): string {
  if (!facts) return text;
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  return text.replace(REF, (m, id: string) => byId.get(id)?.display ?? m);
}

/** Render a reviewer's quote or note the way the draft rendered (a change after "rose" may lose its sign). */
function renderLikeDraft(text: string, facts?: FactsTable): string {
  return facts ? renderFragment(text, facts) : text;
}

/** The sentence of `text` that contains [s, e), widened to whole sentences. */
export function sentenceSpan(text: string, s: number, e: number): [number, number] {
  let start = s;
  while (start > 0) {
    const prev = text.slice(Math.max(0, start - 2), start);
    if (text[start - 1] === '\n' || /[.!?]\s$/.test(prev)) break;
    start--;
  }
  const end = text.slice(e).search(/[.!?](?=\s|$)|\n/);
  const stop = end < 0 ? text.length : e + end + (text[e + end] === '\n' ? 0 : 1);
  return [start, stop];
}

function sentenceWith(text: string, needle: string): string | undefined {
  const at = text.indexOf(needle);
  if (at < 0) return undefined;
  const [s, e] = sentenceSpan(text, at, at + needle.length);
  return text.slice(s, e).trim();
}

/** The sentence of the rendered draft where a fact is first cited (its display may render without a sign). */
function citedSentence(draft: Draft, facts: FactsTable, factId: string): string | undefined {
  if (!draft.template.includes('{{')) return undefined;
  const seg = segments(draft.template, facts).find((x) => x.kind === 'ref' && x.id === factId);
  const shown = seg ? draft.rendered.slice(seg.r[0], seg.r[1]) : '';
  const display = facts.facts.find((f) => f.id === factId)?.display ?? '';
  if (!seg || !shown || (shown !== display && shown !== display.slice(1))) return undefined;
  const [s, e] = sentenceSpan(draft.rendered, seg.r[0], seg.r[1]);
  return draft.rendered.slice(s, e).trim();
}

const WATCHOUT_WORDS: Record<string, string> = {
  'W-small-sample-size': 'rests on a small sample, so the change may be luck',
  'W-metric-without-baseline': 'has no baseline to compare against',
  'W-platform-roas-as-cause': 'is platform-reported attribution, not proven revenue',
  'W-volatile-rate-claim': 'is a volatile rate that often reverses next window',
};

export interface FlagContext {
  facts?: FactsTable;
  /** The draft the flags are about (for quotes of cited facts). */
  draft?: Draft;
  /** Revision mode identifiers. */
  allow?: string[];
}

export function buildFlags(check: CheckReport, notes: PanelNote[], labels?: Classification[], ctx: FlagContext = {}): Flag[] {
  const { facts, draft, allow = [] } = ctx;
  const flags: Omit<Flag, 'id'>[] = [];
  const rendered = draft?.rendered;

  for (const u of check.untraced) {
    flags.push({
      source: 'check',
      text: "A number here doesn't trace to the facts table. Cut it or cite the fact it should be.",
      ...(rendered ? { quote: sentenceWith(rendered, u.raw) ?? u.raw } : { quote: u.raw }),
    });
  }
  for (const f of check.findings) {
    const fix = f.fix ? ` Fix: ${f.fix}` : '';
    flags.push({
      source: f.category === 'watchout' ? 'watchout' : 'check',
      text: scrubForUser(`${f.name} (${f.rule}, ${f.severity}): ${f.message}${fix}`, facts, allow),
      ...(f.match ? { quote: f.match } : {}),
    });
  }
  for (const n of notes) {
    flags.push({
      source: 'panel',
      text: scrubForUser(`${n.persona} (${n.severity}): ${renderLikeDraft(n.note, facts)}`, facts, allow),
      ...(n.quote ? { quote: renderLikeDraft(n.quote, facts) } : {}),
    });
  }
  if (labels && facts && draft) {
    const cited = new Set(draft.factIds);
    const byId = new Map(facts.facts.map((f) => [f.id, f]));
    for (const c of labels) {
      if (!cited.has(c.factId)) continue;
      const fact = byId.get(c.factId);
      if (!fact) continue;
      const reasons = c.watchouts.map((w) => WATCHOUT_WORDS[w] ?? `matches watchout ${w}`);
      if (c.label !== 'luck_risk' && reasons.length === 0) continue;
      const head = c.label === 'luck_risk' ? 'Classified as a luck risk' : 'Watchout';
      const tail = reasons.length ? `: it ${reasons.join('; it ')}` : '';
      const quote = citedSentence(draft, facts, c.factId) ?? (draft.rendered.includes(fact.display) ? sentenceWith(draft.rendered, fact.display) : undefined);
      flags.push({
        source: 'watchout',
        text: scrubForUser(`${head} — "${fact.label}" ${fact.display}${tail}${c.watchouts.length ? ` (${c.watchouts.join(', ')})` : ''}.`, facts, allow),
        ...(quote ? { quote } : {}),
      });
    }
  }
  // Same text and quote once.
  const seen = new Set<string>();
  return flags
    .filter((f) => {
      const k = `${f.source}|${f.text}|${f.quote ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((f, i) => ({ id: `F${i + 1}`, ...f }));
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}

/** Why a reword broke the digit rule, in words with no number of the user's echoed back. */
function rewordWhy(err: RawNumberError): string {
  switch (err.kind) {
    case 'spelled_number':
      return `numbers in words ("${err.offending.join('", "')}"). Cite {{fN}} instead`;
    case 'unknown_fact':
    case 'null_fact':
      return `unknown fact ${err.offending.join(', ')}`;
    case 'bad_reference':
      return 'a reference run into other text or malformed. Write a reference as {{f12}} on its own';
    default:
      return `numbers that aren't in the facts table: ${err.offending.map(() => 'N').join(', ') || 'N'}. Cite {{fN}} or type a figure exactly as the report shows it`;
  }
}

/** Check a reword with validateTemplate (exact displays allowed), then render it and trace every number. */
function acceptReword(raw: string, facts: FactsTable | undefined, allow: string[]): { ok: true; text: string } | { ok: false; why: string } {
  const text = stripInvisible(raw);
  try {
    validateTemplate(text, facts, { allow, displays: true });
  } catch (err) {
    if (err instanceof RawNumberError) return { ok: false, why: rewordWhy(err) };
    throw err;
  }
  if (!facts) return { ok: true, text };
  // References render as the full display, exactly as cited.
  const out = renderRefs(text, facts);
  const { untraced } = traceNumbers(out, facts, { allow });
  if (untraced.length) return { ok: false, why: `numbers that aren't in the facts table: ${untraced.map(() => 'N').join(', ')}. Cite {{fN}} or type a figure exactly as the report shows it` };
  return { ok: true, text: out };
}

export interface DeliverInput {
  text: string;
  facts?: FactsTable;
  flags: Flag[];
  decide: (f: Flag) => Promise<Decision>;
  /** Revision mode identifiers. */
  allow?: string[];
  /** Fact ids the draft cited, preferred when two facts share a display. */
  prefer?: string[];
}

export async function deliver(input: DeliverInput): Promise<Report> {
  const allow = input.allow ?? [];
  let text = input.text;
  const decisions: Decision[] = [];
  for (const flag of input.flags) {
    let asked = flag;
    let decision: Decision | undefined;
    let lastWhy = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const d = await input.decide(asked);
      if (d.action !== 'reword') {
        decision = d;
        break;
      }
      const ok = acceptReword(d.text, input.facts, allow);
      if (ok.ok) {
        decision = { flagId: flag.id, action: 'reword', text: ok.text };
        break;
      }
      lastWhy = ok.why;
      asked = { ...flag, text: `${flag.text} (Your reword was refused: ${ok.why}.)` };
    }
    if (!decision) throw new RawNumberError(`Reword for flag ${flag.id} kept adding numbers that aren't in the facts table (last refusal: ${lastWhy}).`, 'raw_number', []);
    decisions.push({ ...decision, flagId: flag.id } as Decision);

    if (decision.action === 'keep' || !flag.quote) continue;
    const at = text.indexOf(flag.quote);
    if (at < 0) continue;
    if (decision.action === 'cut') {
      const [s, e] = sentenceSpan(text, at, at + flag.quote.length);
      text = text.slice(0, s) + text.slice(e);
    } else {
      text = text.slice(0, at) + decision.text + text.slice(at + flag.quote.length);
    }
    text = tidy(text);
  }
  text = tidy(text);

  let traces: Report['traces'] = [];
  if (input.facts) {
    const t = traceNumbers(text, input.facts, { allow, prefer: input.prefer });
    if (t.untraced.length) {
      throw new RawNumberError(`The final text has numbers that don't trace to the facts table (${t.untraced.length}).`, 'raw_number', t.untraced);
    }
    traces = t.traces.map(({ raw, factId }) => ({ raw, factId }));
  }
  return { text, traces, flags: input.flags, decisions };
}
