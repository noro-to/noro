// Prompts for every writing step. The agent-facing parts of the old Claude
// skill (reference/contract.md, voice.md, formats.md, panel.md) are folded in
// here so the CLI works from dist/ without reading reference files.
//
// What a writing model sees about a fact is factCard(): its id, its label
// (compute's labels hold no numbers except campaign codes and end with the
// direction in words), the classification (signal / noise / luck_risk,
// priority, watchout ids) and its flags. Never value, display, formula or
// sampleSize. Period labels ("Oct 6–12") and the currency code are also
// shown; they are identifiers, not metric values.

import type { Classification, Fact, FactsTable, PanelNote } from '../schema.js';
import { allowedIdentifiers } from './template.js';

export interface FormatSpec {
  name: string;
  /** In words: prompts carry no digits of their own. */
  ceiling: string;
  skeleton: string;
}

export const FORMATS: Record<string, FormatSpec> = {
  slack: {
    name: 'Slack / Teams message',
    ceiling: 'sixty',
    skeleton: '<The point, with its number.>\nWhy: <the cause, with its numbers>.\nNext: <the action: who, what, by when>.',
  },
  email: {
    name: 'Email',
    ceiling: 'one hundred twenty',
    skeleton: 'Subject: <the point, with its number>\n\n<Why, one or two sentences.>\n\n<Next, one sentence.>',
  },
  'one-page': {
    name: 'One-page doc',
    ceiling: 'two hundred fifty',
    skeleton:
      '<The point, with its number.>\n\nWhat happened: <two to four numbers that bear on the point, each with its change.>\nWhy: <cause and its numbers>.\nNext: <action>.\nBasis: <source and windows compared>.',
  },
  'slide-notes': {
    name: 'Slide notes',
    ceiling: 'eighty',
    skeleton: 'Title: <the point as a sentence, with its number>\n- <supporting number>\n- <supporting number>\nNote: <Why in one sentence.> <Next in one sentence.>',
  },
};
export const DEFAULT_FORMAT = 'one-page';

/** The arithmetic rule, as every writing model is told it. */
export const NUMBER_RULES = `NUMBERS — the one rule you can't break:
- You never see metric values, and you never write a number. Code computed every number; you cite them.
- Cite a fact as {{f12}}: double braces around one fact id from the list. Code replaces it with the exact figure, already formatted (currency sign, %, "pp", "x", and a "+" or "-" sign on changes).
- Write no digits at all: no figures, no percentages, no counts, no "last week" spelled with a number, no years or dates of your own. The only digits allowed are inside campaign or ad group names and the period labels, copied exactly as given.
- Don't write numbers in words either: no "one", "three", "a dozen", "one in five", "first", "second", "half", "a third", "double", "doubled", "twice", "two-fold", "forty percent". If a number or a change matters, cite the fact that holds it. ("No one", "one of the" and "third-party" are fine.)
- Put a reference on its own: nothing directly against it ("{{f1}}{{f2}}", "{{f1}}k", "{{f1}}%", "-{{f1}}" are refused).
- Each fact's label says what it measures. A change fact's label ends with its direction: (up), (down) or (no change). Use "rose", "fell" or "held" to match; the cited figure already carries its sign (code drops it right after "rose" or "fell").
- Cite only ids from the list. Never cite a fact for something its label doesn't say.`;

/** The house voice and contract (reference/voice.md, contract.md), for writing models. */
export const HOUSE_RULES = `You are a senior media buyer writing a short paid-media report for someone busy. You report what the facts say. You do no analysis of your own beyond choosing which facts matter.

CONTRACT
- Never add a claim the facts don't support. A cause you can't see in the facts stays a hypothesis: say "likely" and who confirms it, or leave it out.
- Facts labeled luck_risk (small sample, volatile rate, missing baseline) are never a headline on their own, never called a win or a loss, and never "significant", "a clear trend" or "drove". If you use one, say it is an early read.
- Never put the word "noro" in the report.

VOICE (standard detail, tight, professional)
- Lead with what moved and where it landed: "Spend rose {{f3}} to {{f1}}."
- Name things: campaign names, not "certain campaigns".
- Active verbs, short sentences, sentence case. Fragments and labels like "Why:" and "Next:" are fine.
- No bold mid-sentence, emoji, exclamation marks or rhetorical questions. At most one em dash.
- No throat-clearing or recaps: "It's worth noting", "Overall", "In summary", "Moving forward".
- "Likely", "strong" or "weak" only beside the number behind them.
- A contrast only when it rules out a real alternative.
- The headline (the point, with its number) appears once, first.
- "Why" gives the cause the facts show, with their numbers. "Next" gives one concrete action: who, what, by when. Don't invent targets or budgets.
- Bullets only for parallel items, three at most. No headings in a short report.
- Quiet week (nothing moved enough to matter): three lines — where the key metric landed, "Nothing needs changing.", and the next check.`;

export interface FactCardOptions {
  labels?: Classification[];
}

/** One line per fact: what a writing model knows about it. No value, display, formula or sample size. */
export function factCard(f: Fact, cls?: Classification): string {
  const parts = [`{{${f.id}}}`, f.label];
  if (cls) parts.push(`${cls.label}, priority ${['', 'one', 'two', 'three'][cls.priority]}${cls.watchouts.length ? `, watchouts: ${cls.watchouts.join(' ')}` : ''}`);
  if (f.flags.length) parts.push(`flags: ${f.flags.join(' ')}`);
  return parts.join(' | ');
}

const PRIORITY_CAP = 150;

/** Facts offered to the draft: non-null, priority order, capped. */
export function draftFacts(facts: FactsTable, labels: Classification[]): Fact[] {
  const cls = new Map(labels.map((c) => [c.factId, c]));
  const order = (f: Fact) => {
    const c = cls.get(f.id);
    const p = c?.priority ?? 3;
    const l = c?.label === 'signal' ? 0 : c?.label === 'luck_risk' ? 1 : 2;
    return p * 3 + l;
  };
  const ranked = facts.facts
    .filter((f) => f.value !== null)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => order(a.f) - order(b.f) || a.i - b.i)
    .map((x) => x.f);
  const picked = ranked.slice(0, PRIORITY_CAP);
  // A change is easier to say with the levels it compares ("rose {{f12}} to {{f7}}"): add the inputs of
  // every picked priority-one or priority-two fact, even past the cap.
  const have = new Set(picked.map((f) => f.id));
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  for (const f of [...picked]) {
    if ((cls.get(f.id)?.priority ?? 3) > 2) continue;
    for (const inp of f.inputs) {
      const g = byId.get(inp);
      if (g && g.value !== null && !have.has(g.id)) {
        have.add(g.id);
        picked.push(g);
      }
    }
  }
  return picked;
}

function context(facts: FactsTable, allow: string[] = []): string {
  const lines: string[] = [];
  if (facts.currency) lines.push(`Currency: ${facts.currency}.`);
  if (facts.periods.current) lines.push(`Current window: ${facts.periods.current}.`);
  if (facts.periods.previous) lines.push(`Previous window: ${facts.periods.previous}.`);
  const ids = allowedIdentifiers(facts, allow);
  if (ids.length) lines.push(`Names you may copy exactly (they contain digits but are not numbers): ${ids.map((x) => `"${x}"`).join(', ')}.`);
  return lines.join('\n');
}

export interface Prompt {
  system: string;
  user: string;
}

export function buildDraftPrompt(input: { facts: FactsTable; labels: Classification[]; format?: string }): Prompt {
  const fmt = FORMATS[input.format ?? DEFAULT_FORMAT] ?? FORMATS[DEFAULT_FORMAT];
  const cls = new Map(input.labels.map((c) => [c.factId, c]));
  const offered = draftFacts(input.facts, input.labels);
  const system = `${HOUSE_RULES}

${NUMBER_RULES}

FORMAT: ${fmt.name}. Stay under ${fmt.ceiling} words. Shape:
${fmt.skeleton}

Answer with the report only: no preamble, no code fence, no notes to me.`;
  const user = `${context(input.facts)}

Facts (id | label | classification | flags), most important first:
${offered.map((f) => factCard(f, cls.get(f.id))).join('\n')}

Write the report. Lead with the signal facts of priority one. Cite every number as {{fN}}.`;
  return { system, user };
}

export function buildRetryNote(error: string): string {
  return `Your previous answer was rejected by the number check: ${error}
Rewrite it. Cite every number as {{fN}} from the list and write no digits yourself.`;
}

/** Notes are keyed by letter (A, B, ... Z, AA, ...) so prompts carry no digits of their own. */
export function noteKey(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function notesBlock(notes: PanelNote[]): string {
  return notes
    .map((n, i) => `Note ${noteKey(i)} [${n.persona}, ${n.severity}]${n.quote ? ` Quote: "${n.quote}"` : ''} ${n.note}`)
    .join('\n');
}

export function buildRevisePrompt(input: {
  template: string;
  notes: PanelNote[];
  facts: FactsTable;
  labels?: Classification[];
  allow?: string[];
  /** 'apply': fix a draft from notes. 'rewrite': revision mode, cut a pasted report down. */
  task: 'apply' | 'rewrite';
}): Prompt {
  const cls = new Map((input.labels ?? []).map((c) => [c.factId, c]));
  const cards = input.facts.facts.filter((f) => f.value !== null).map((f) => factCard(f, cls.get(f.id)));
  const job =
    input.task === 'rewrite'
      ? `You are editing a paid-media report someone else wrote. Every number in it has been replaced by a fact reference like {{f3}}, and the facts list says what each one is. Cut the report to its one point: the headline once, then Why and Next if the original gives them. Keep the original's claims and order of importance; drop side data, history, asides, throat-clearing and empty placeholders. A hypothesis stays a hypothesis. Never add a claim the original doesn't make. The rewrite must be clearly shorter than the original. Apply each note below that keeps this contract.`
      : `You are revising a draft report after review. Apply each note below that keeps the contract: no new claim, no number that isn't a fact reference from the list, and the draft gets no longer. Reject a note that would break it, and say why in a few words.`;
  const system = `${HOUSE_RULES}

${NUMBER_RULES}

${job}

Answer with one JSON object and nothing else:
{"template": "<the full revised report, numbers only as {{fN}}>", "applied": ["<letter of each note you applied>"], "rejected": [{"note": "<letter>", "reason": "<a few words>"}]}`;
  const user = `${context(input.facts, input.allow)}

Facts (id | label | classification | flags):
${cards.join('\n')}

${input.task === 'rewrite' ? 'Original report' : 'Draft'}:
"""
${input.template}
"""

Notes:
${input.notes.length ? notesBlock(input.notes) : '(none)'}`;
  return { system, user };
}

/** reference/panel.md's brief, adapted to templates. */
export const PANEL_BRIEF = `You are the reviewer in the persona below. Read the draft as its reader would.
Numbers in the draft appear as fact references like {{f12}}; the facts list says what each one measures. You never see the values, and you never need them.
Return at most three notes. A note may cut, reorder or reword. It may not add a claim, and it may not add a number: refer to numbers only as {{fN}} references from the list, and write no digits yourself.
If the reader needs something the facts don't hold, write one note with "for_writer": true.
If nothing needs changing, return {"notes": []}. Don't invent notes to look thorough.
Answer with one JSON object and nothing else:
{"notes": [{"quote": "<exact words from the draft, references included>", "problem": "<one line>", "fix": "<replacement words, or \\"cut\\">", "severity": "must" | "should" | "consider", "for_writer": false}]}`;

export function buildPanelPrompt(input: { persona: string; personaText: string; template: string; facts?: FactsTable; labels?: Classification[]; allow?: string[] }): Prompt {
  const cls = new Map((input.labels ?? []).map((c) => [c.factId, c]));
  const cited = new Set([...input.template.matchAll(/\{\{\s*(f\d+)\s*\}\}/g)].map((m) => m[1]));
  const cards = (input.facts?.facts ?? []).filter((f) => cited.has(f.id)).map((f) => factCard(f, cls.get(f.id)));
  const system = `${PANEL_BRIEF}

Persona (${input.persona}):
${input.personaText.trim()}`;
  const user = `${input.facts ? `${context(input.facts, input.allow)}\n\nFacts cited in the draft (id | label | classification | flags):\n${cards.join('\n') || '(none)'}\n\n` : ''}Draft:
"""
${input.template}
"""`;
  return { system, user };
}
