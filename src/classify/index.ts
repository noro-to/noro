// Classify: label each fact signal | noise | luck_risk, give it a priority and
// attach the watchouts that apply. jev (typesafe/jev-1.13) makes the judgment
// calls through OpenRouter's Decisions API; code makes the deterministic ones.
//
// What jev sees, per fact (state.facts.<id>): the fact's label (compute's
// labels hold no numbers except campaign codes) and the coarse descriptors
// from describe.ts: metric, scope, period, change kind, direction, magnitude
// bucket, sample (small/adequate), flags. Never value, display, formula or
// sampleSize. jev returns probabilities over the labels we offer; it never
// returns a number that reaches the report.
//
// Questions per fact (jev guide: one state, many independent typed questions):
//   <id>__label     choice  signal | noise | luck_risk
//   <id>__priority  score   lead with it / supporting / background → 1 | 2 | 3
//   <id>__volatile  noul    rate-metric change facts only → W-volatile-rate-claim when p >= 0.5
// Watchouts code attaches without asking:
//   small_sample flag → W-small-sample-size;  no_baseline flag → W-metric-without-baseline;
//   ROAS / conversion value → W-platform-roas-as-cause (platform-reported attribution).
// Code may move a label toward caution, never away from it: a 'signal' on a
// small sample or a missing baseline becomes 'luck_risk'. Facts with no value
// are 'noise', priority 3, without a call.
//
// Batching: jev has a 32k-token context covering state + questions, so facts
// go in batches of at most MAX_FACTS_PER_CALL and an estimated
// TOKEN_BUDGET tokens (chars / 3.5, a deliberate overestimate).

import type { Config } from '../config.js';
import type { Classification, Fact, FactLabel, FactsTable, JevClient } from '../schema.js';
import { describeFact } from './describe.js';

export { describeFact } from './describe.js';
export type { FactDescriptor } from './describe.js';

export const MAX_FACTS_PER_CALL = 40;
export const TOKEN_BUDGET = 24_000;

export class MissingApiKeyError extends Error {
  constructor() {
    super('OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your OpenRouter key.');
    this.name = 'MissingApiKeyError';
  }
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** One jev question. The client sends `questions` as the object keyed by `id` that the Decisions API expects. */
export type JevQuestion =
  | { id: string; type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { id: string; type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { id: string; type: 'score'; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number> };

/** The Decisions API response, as far as noro reads it. */
export interface JevResponse {
  answers: Record<string, JevAnswer>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

async function postJson(url: string, apiKey: string, body: unknown, what: string): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/noro-to/noro',
          'X-Title': 'noro',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      last = new ModelError(`${what}: request failed: ${(err as Error).message}`);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new ModelError(`${what}: response was not JSON`);
      }
    }
    let msg = text.slice(0, 300);
    try {
      msg = JSON.parse(text)?.error?.message ?? msg;
    } catch {
      /* keep raw */
    }
    last = new ModelError(`${what}: HTTP ${res.status}: ${msg}`, res.status);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw last;
}

export { postJson as _postJson };

/** jev over OpenRouter: POST {baseUrl}/alpha/decisions (default https://openrouter.ai/api/alpha/decisions). */
export function createJevClient(cfg: Config): JevClient {
  return {
    async decide(req) {
      if (!cfg.apiKey) throw new MissingApiKeyError();
      const questions: Record<string, unknown> = {};
      for (const q of req.questions as JevQuestion[]) {
        const { id, ...rest } = q;
        questions[id] = rest;
      }
      const base = cfg.baseUrl.replace(/\/+$/, '');
      return postJson(`${base}/alpha/decisions`, cfg.apiKey, { model: req.model, state: req.state, questions }, 'jev');
    },
  };
}

const LABEL_CRITERIA: Record<FactLabel, string> = {
  signal:
    'A real change a media buyer should act on or report: a moderate or large move, on an adequate sample, in a metric that bears on cost or results.',
  noise:
    'Not worth the reader’s attention: a small move, a level with nothing to compare, or a metric that does not change the decision.',
  luck_risk:
    'A move that could be chance: it rests on a small sample, a volatile rate, a single window, or a missing baseline, so reading it as real is risky.',
};

const PRIORITY_CRITERIA = [
  'Lead with it: the headline or the cause behind it.',
  'Supporting: worth one line under the headline.',
  'Background: leave it out unless the reader asks.',
];

const RATE_METRICS = new Set(['ctr', 'cvr', 'cpa', 'cpc', 'roas']);

function questionsFor(f: Fact): JevQuestion[] {
  const path = `\`facts.${f.id}\``;
  const qs: JevQuestion[] = [
    { id: `${f.id}__label`, type: 'choice', instructions: `Classify the fact at ${path} for a weekly paid-media report.`, criteria: LABEL_CRITERIA },
    { id: `${f.id}__priority`, type: 'score', instructions: `How prominent should the fact at ${path} be in a short report?`, criteria: PRIORITY_CRITERIA },
  ];
  const d = describeFact(f);
  if (RATE_METRICS.has(d.metric) && (d.change === 'percent change' || d.change === 'percentage-point change')) {
    qs.push({
      id: `${f.id}__volatile`,
      type: 'noul',
      instructions: `Is the change at ${path} a volatile rate that often reverses the next window, so calling it a win or a loss is premature?`,
      criteria: { true: 'Likely to bounce back; a one-window move.', false: 'Stable enough to report as a change.' },
    });
  }
  return qs;
}

function stateFor(batch: Fact[], facts: FactsTable): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of batch) {
    const { flags, ...d } = describeFact(f);
    out[f.id] = { label: f.label, ...d, ...(flags.length ? { flags } : {}) };
  }
  return { task: 'Classify facts for a paid-media performance report. Each fact is described in words; values are withheld.', currency: facts.currency, facts: out };
}

const estimateTokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 3.5);

/** Split facts into jev calls that fit the context budget. Exported for tests. */
export function batchFacts(facts: FactsTable, maxFacts = MAX_FACTS_PER_CALL, budget = TOKEN_BUDGET): Fact[][] {
  const askable = facts.facts.filter((f) => f.value !== null);
  const batches: Fact[][] = [];
  let cur: Fact[] = [];
  let tokens = estimateTokens(stateFor([], facts));
  for (const f of askable) {
    const cost = estimateTokens({ [f.id]: stateFor([f], facts).facts }) + estimateTokens(questionsFor(f));
    if (cur.length && (cur.length >= maxFacts || tokens + cost > budget)) {
      batches.push(cur);
      cur = [];
      tokens = estimateTokens(stateFor([], facts));
    }
    cur.push(f);
    tokens += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** The exact requests classify() sends, for tests and audits. */
export function buildJevRequests(facts: FactsTable, model: string): { model: string; state: Record<string, unknown>; questions: JevQuestion[] }[] {
  return batchFacts(facts).map((batch) => ({ model, state: stateFor(batch, facts), questions: batch.flatMap(questionsFor) }));
}

const LABELS: FactLabel[] = ['signal', 'noise', 'luck_risk'];

function readAnswers(raw: unknown): Record<string, JevAnswer> {
  const answers = (raw as JevResponse | undefined)?.answers;
  if (!answers || typeof answers !== 'object') throw new ModelError('jev: response has no answers');
  return answers;
}

export async function classify(facts: FactsTable, jev: JevClient, opts: { model: string }): Promise<Classification[]> {
  const out = new Map<string, Classification>();
  for (const req of buildJevRequests(facts, opts.model)) {
    const answers = readAnswers(await jev.decide(req));
    const ids = Object.keys(req.state.facts as object);
    for (const id of ids) {
      const f = facts.facts.find((x) => x.id === id)!;
      const la = answers[`${id}__label`];
      const pa = answers[`${id}__priority`];
      const va = answers[`${id}__volatile`];
      let label: FactLabel = la?.type === 'choice' && (LABELS as string[]).includes(la.choice) ? (la.choice as FactLabel) : 'noise';
      const score = pa?.type === 'score' && Number.isFinite(pa.score) ? pa.score : 2;
      const priority = (Math.min(3, Math.max(1, Math.round(score) + 1)) as 1 | 2 | 3);
      const watchouts = codeWatchouts(f);
      if (va?.type === 'noul' && va.noul >= 0.5) watchouts.push('W-volatile-rate-claim');
      if (label === 'signal' && (f.flags.includes('small_sample') || f.flags.includes('no_baseline'))) label = 'luck_risk';
      out.set(id, { factId: id, label, priority, watchouts: [...new Set(watchouts)] });
    }
  }
  return facts.facts.map(
    (f) => out.get(f.id) ?? { factId: f.id, label: 'noise' as const, priority: 3 as const, watchouts: codeWatchouts(f) },
  );
}

function codeWatchouts(f: Fact): string[] {
  const w: string[] = [];
  if (f.flags.includes('small_sample')) w.push('W-small-sample-size');
  if (f.flags.includes('no_baseline')) w.push('W-metric-without-baseline');
  if (f.scope.metric === 'roas' || f.scope.metric === 'conversion_value') w.push('W-platform-roas-as-cause');
  return w;
}
