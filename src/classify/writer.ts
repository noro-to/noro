// Opt-in classify with the writing model (NORO_CLASSIFY=writer). The chat model
// answers the same three questions jev gets, as JSON. Its prompt is built from
// the same state jev sees (fact ids, labels, coarse descriptors, currency) and
// static text without a single digit, so it never sees a value, display,
// formula or sample size. Prominence comes back as a word (lead | supporting |
// background), not a number. Code then applies the same caution rules as for jev.

import type { ChatClient, ChatRequest, Classification, Fact, FactLabel, FactsTable } from '../schema.js';
import { LABEL_CRITERIA, LABELS, ModelError, fallback, finalize, isRateChange, stateFor } from './shared.js';

export const WRITER_FACTS_PER_CALL = 60;

const PROMINENCE: Record<string, 1 | 2 | 3> = { lead: 1, supporting: 2, background: 3 };

const SYSTEM = [
  'You label facts for a weekly paid-media performance report. Each fact is described in words; its value is withheld on purpose.',
  'For every fact id in the state, give:',
  '- label: one of signal, noise, luck_risk.',
  ...LABELS.map((l) => `  ${l}: ${LABEL_CRITERIA[l]}`),
  '- prominence: lead (the headline or the cause behind it), supporting (worth one line under the headline) or background (leave it out unless the reader asks).',
  '- volatile: true when the fact is a change in a rate metric that often reverses the next window, so calling it a win or a loss is premature; otherwise false.',
  'Answer with JSON only, no prose and no code fence, in this shape:',
  '{"facts": {"<fact id>": {"label": "signal", "prominence": "supporting", "volatile": false}}}',
].join('\n');

/** The exact chat requests writer-mode classify sends, for tests and audits. */
export function buildWriterRequests(facts: FactsTable, model: string): { req: ChatRequest; batch: Fact[] }[] {
  const askable = facts.facts.filter((f) => f.value !== null);
  const out: { req: ChatRequest; batch: Fact[] }[] = [];
  for (let i = 0; i < askable.length; i += WRITER_FACTS_PER_CALL) {
    const batch = askable.slice(i, i + WRITER_FACTS_PER_CALL);
    const user = `State:\n${JSON.stringify(stateFor(batch, facts), null, 1)}`;
    out.push({ req: { model, system: SYSTEM, user, json: true }, batch });
  }
  return out;
}

function parseAnswer(text: string): Record<string, any> {
  const s = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new ModelError('writer classify: answer was not JSON');
  let parsed: any;
  try {
    parsed = JSON.parse(s.slice(a, b + 1));
  } catch {
    throw new ModelError('writer classify: answer was not JSON');
  }
  const byId = parsed?.facts ?? parsed;
  if (!byId || typeof byId !== 'object' || Array.isArray(byId)) throw new ModelError('writer classify: answer has no facts object');
  return byId;
}

export async function classifyWithWriter(facts: FactsTable, chat: ChatClient, opts: { model: string }): Promise<Classification[]> {
  const out = new Map<string, Classification>();
  for (const { req, batch } of buildWriterRequests(facts, opts.model)) {
    let byId: Record<string, any> | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2 && !byId; attempt++) {
      try {
        byId = parseAnswer(await chat.complete(req));
      } catch (err) {
        if (!(err instanceof ModelError) || !/writer classify/.test(err.message)) throw err;
        lastErr = err;
      }
    }
    if (!byId) throw lastErr;
    for (const f of batch) {
      const a = byId[f.id];
      if (!a || typeof a !== 'object') continue;
      const label: FactLabel = (LABELS as string[]).includes(a.label) ? a.label : 'noise';
      const priority = PROMINENCE[String(a.prominence)] ?? 3;
      out.set(f.id, finalize(f, label, priority, a.volatile === true && isRateChange(f)));
    }
  }
  return facts.facts.map((f) => out.get(f.id) ?? fallback(f));
}
