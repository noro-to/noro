// Classify: label each fact signal | noise | luck_risk, give it a priority and
// attach the watchouts that apply. Three classifiers, picked by resolveClassifier:
//
//   jev     a System One decision model (jev on OpenRouter or TypeSafe, or a
//           local decision model) makes the judgment calls; see systemone.ts.
//   rules   deterministic labels from compute flags and describe.ts buckets; rules.ts.
//   writer  opt-in: the writing model answers the same questions as JSON; writer.ts.
//
// What a model sees, per fact (state.facts.<id>): the fact's label (compute's
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
// Batching: jev has a 32k-token context covering state + questions, and Ollama
// takes at most 64 questions per request, so facts go in batches of at most
// MAX_FACTS_PER_CALL facts, MAX_QUESTIONS_PER_CALL questions and an estimated
// TOKEN_BUDGET tokens (chars / 3.5, a deliberate overestimate).

import type { Config } from '../config.js';
import type { ChatClient, Classification, Fact, FactLabel, FactsTable, JevClient } from '../schema.js';
import { classifyByRules } from './rules.js';
import {
  ClassifyConfigError,
  LABEL_CRITERIA,
  LABELS,
  ModelError,
  PRIORITY_CRITERIA,
  fallback,
  finalize,
  isRateChange,
  postJson,
  stateFor,
} from './shared.js';
import {
  OPENROUTER_CLASSIFY_BASE,
  OPENROUTER_JEV_MODEL,
  TYPESAFE_CLASSIFY_BASE,
  classifyKeyEnv,
  classifySettings,
  createSystemOneClient,
  defaultClassifyModel,
  displayHost,
} from './systemone.js';
import { classifyWithWriter } from './writer.js';

export { describeFact } from './describe.js';
export type { FactDescriptor } from './describe.js';
export { ClassifyConfigError, MissingApiKeyError, ModelError, codeWatchouts } from './shared.js';
export { PRIMARY_METRICS, classifyByRules } from './rules.js';
export { buildWriterRequests, classifyWithWriter } from './writer.js';
export {
  OPENROUTER_CLASSIFY_BASE,
  OPENROUTER_JEV_MODEL,
  TYPESAFE_CLASSIFY_BASE,
  TYPESAFE_JEV_MODEL,
  classifyHost,
  classifyKeyEnv,
  classifySettings,
  createSystemOneClient,
  defaultClassifyModel,
  systemOneUrl,
} from './systemone.js';
export type { ClassifySettings } from './systemone.js';

export const MAX_FACTS_PER_CALL = 40;
/** Ollama's System One limit; the lowest of the servers noro supports. */
export const MAX_QUESTIONS_PER_CALL = 64;
export const TOKEN_BUDGET = 24_000;

/** One jev question. The client sends `questions` as the object keyed by `id` that System One expects. */
export type JevQuestion =
  | { id: string; type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { id: string; type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { id: string; type: 'score'; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number> };

/** The System One response, as far as noro reads it. */
export interface JevResponse {
  answers: Record<string, JevAnswer>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

export { postJson as _postJson };

/**
 * A System One client for this config: the classify base URL (NORO_CLASSIFY_BASE_URL,
 * else OpenRouter, else TypeSafe when only TYPESAFE_API_KEY is set) with the key its host takes.
 */
export function createJevClient(cfg: Config, env: NodeJS.ProcessEnv = process.env): JevClient {
  const s = classifySettings(cfg, env);
  const base = jevBase(s);
  return createSystemOneClient({ baseUrl: base, apiKey: keyFor(base, s) });
}

function jevBase(s: { baseUrl?: string; openrouterKey?: string; typesafeKey?: string }): string {
  if (s.baseUrl) return s.baseUrl;
  if (!s.openrouterKey && s.typesafeKey) return TYPESAFE_CLASSIFY_BASE;
  return OPENROUTER_CLASSIFY_BASE;
}

function keyFor(base: string, s: { openrouterKey?: string; typesafeKey?: string }): string | undefined {
  const env = classifyKeyEnv(base);
  return env === 'OPENROUTER_API_KEY' ? s.openrouterKey : env === 'TYPESAFE_API_KEY' ? s.typesafeKey : undefined;
}

function questionsFor(f: Fact): JevQuestion[] {
  const path = `\`facts.${f.id}\``;
  const qs: JevQuestion[] = [
    { id: `${f.id}__label`, type: 'choice', instructions: `Classify the fact at ${path} for a weekly paid-media report.`, criteria: LABEL_CRITERIA },
    { id: `${f.id}__priority`, type: 'score', instructions: `How prominent should the fact at ${path} be in a short report?`, criteria: PRIORITY_CRITERIA },
  ];
  if (isRateChange(f)) {
    qs.push({
      id: `${f.id}__volatile`,
      type: 'noul',
      instructions: `Is the change at ${path} a volatile rate that often reverses the next window, so calling it a win or a loss is premature?`,
      criteria: { true: 'Likely to bounce back; a one-window move.', false: 'Stable enough to report as a change.' },
    });
  }
  return qs;
}

const estimateTokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 3.5);

/** Split facts into jev calls that fit the context budget and the question cap. Exported for tests. */
export function batchFacts(facts: FactsTable, maxFacts = MAX_FACTS_PER_CALL, budget = TOKEN_BUDGET, maxQuestions = MAX_QUESTIONS_PER_CALL): Fact[][] {
  const askable = facts.facts.filter((f) => f.value !== null);
  const batches: Fact[][] = [];
  let cur: Fact[] = [];
  let tokens = estimateTokens(stateFor([], facts));
  let questions = 0;
  for (const f of askable) {
    const qs = questionsFor(f);
    const cost = estimateTokens({ [f.id]: stateFor([f], facts).facts }) + estimateTokens(qs);
    if (cur.length && (cur.length >= maxFacts || tokens + cost > budget || questions + qs.length > maxQuestions)) {
      batches.push(cur);
      cur = [];
      tokens = estimateTokens(stateFor([], facts));
      questions = 0;
    }
    cur.push(f);
    tokens += cost;
    questions += qs.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** The exact requests classify() sends, for tests and audits. */
export function buildJevRequests(facts: FactsTable, model: string): { model: string; state: Record<string, unknown>; questions: JevQuestion[] }[] {
  return batchFacts(facts).map((batch) => ({ model, state: stateFor(batch, facts), questions: batch.flatMap(questionsFor) }));
}

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
      const label: FactLabel = la?.type === 'choice' && (LABELS as string[]).includes(la.choice) ? (la.choice as FactLabel) : 'noise';
      const score = pa?.type === 'score' && Number.isFinite(pa.score) ? pa.score : 2;
      const priority = Math.min(3, Math.max(1, Math.round(score) + 1)) as 1 | 2 | 3;
      out.set(id, finalize(f, label, priority, va?.type === 'noul' && va.noul >= 0.5));
    }
  }
  return facts.facts.map((f) => out.get(f.id) ?? fallback(f));
}

// ---------------------------------------------------------------- picking a classifier

export interface ResolvedClassifier {
  mode: 'jev' | 'rules' | 'writer';
  /** For the CLI line and the report footer, e.g. "jev (typesafe/jev-1.13 on openrouter.ai)", "rules". */
  describe: string;
  /**
   * jev only: the env var this host needs that isn't set (the run would throw
   * MissingApiKeyError), so the CLI and doctor can say so before any work.
   */
  missingKey?: 'OPENROUTER_API_KEY' | 'TYPESAFE_API_KEY';
  run(facts: FactsTable): Promise<Classification[]>;
}

export interface ClassifierDeps {
  /** Overrides the System One client (tests, mocks). Also selects jev when nothing else would. */
  jev?: JevClient;
  /** The writing model's client, needed for NORO_CLASSIFY=writer. */
  chat?: ChatClient;
  /** The model id writer mode sends; defaults to config.draftModel. */
  writerModel?: string;
  /** Where to read settings a Config doesn't carry yet (NORO_CLASSIFY, NORO_CLASSIFY_BASE_URL, TYPESAFE_API_KEY). */
  env?: NodeJS.ProcessEnv;
}

const MODES = ['jev', 'rules', 'writer'] as const;

/**
 * Pick the classifier. NORO_CLASSIFY (jev | rules | writer) wins when set. Unset:
 * NORO_CLASSIFY_BASE_URL → that System One endpoint; else OPENROUTER_API_KEY →
 * jev on OpenRouter; else TYPESAFE_API_KEY → jev on TypeSafe; else rules. An
 * injected deps.jev (tests) stands in for the endpoint when nothing explicit
 * says otherwise. Bad settings throw ClassifyConfigError now; a missing key or
 * model throws when run() is called, so a resumed run past classify needs neither.
 */
export function resolveClassifier(config: Config, deps: ClassifierDeps = {}): ResolvedClassifier {
  const s = classifySettings(config, deps.env ?? process.env);
  if (s.mode && !(MODES as readonly string[]).includes(s.mode)) {
    throw new ClassifyConfigError(`NORO_CLASSIFY must be jev, rules or writer, not "${s.mode}"`);
  }
  let mode = s.mode as (typeof MODES)[number] | undefined;
  if (!mode) mode = s.baseUrl || s.openrouterKey || s.typesafeKey || deps.jev ? 'jev' : 'rules';

  if (mode === 'rules') {
    return { mode, describe: 'rules', run: async (facts) => classifyByRules(facts) };
  }

  if (mode === 'writer') {
    const model = deps.writerModel ?? config.draftModel;
    return {
      mode,
      describe: `writer (${deps.chat?.describe ?? model})`,
      async run(facts) {
        if (!deps.chat) throw new ClassifyConfigError('NORO_CLASSIFY=writer needs the writing model client, and none was given');
        return classifyWithWriter(facts, deps.chat, { model });
      },
    };
  }

  const base = jevBase(s);
  const host = displayHost(base);
  const model = s.model ?? defaultClassifyModel(base) ?? (deps.jev ? config.classifyModel || OPENROUTER_JEV_MODEL : undefined);
  const key = keyFor(base, s);
  const keyEnv = classifyKeyEnv(base);
  const missingKey = !deps.jev && keyEnv && !key ? keyEnv : undefined;
  const client = deps.jev ?? createSystemOneClient({ baseUrl: base, apiKey: key });
  return {
    mode,
    describe: deps.jev?.describe ?? `jev (${model ?? 'no model set'} on ${host})`,
    ...(missingKey ? { missingKey } : {}),
    async run(facts) {
      if (!model) {
        throw new ClassifyConfigError(
          `NORO_CLASSIFY_MODEL is not set. ${host} has no default decision model (only openrouter.ai and api.typesafe.ai do). Set it, e.g. NORO_CLASSIFY_MODEL=nimble for Ollama.`,
        );
      }
      return classify(facts, client, { model });
    },
  };
}

