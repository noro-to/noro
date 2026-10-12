// Pieces every classifier shares (jev, rules, writer): the errors, the HTTP
// helper, what a model may see about a fact, the watchouts code attaches on its
// own, and the one place where code moves a label toward caution.

import type { Classification, Fact, FactLabel, FactsTable } from '../schema.js';
import { describeFact } from './describe.js';

export class MissingApiKeyError extends Error {
  constructor(message = 'OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your OpenRouter key.') {
    super(message);
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

/** A classify setting that can't work (unknown NORO_CLASSIFY, bad base URL, no model for a host without a default). */
export class ClassifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifyConfigError';
  }
}

/** POST JSON with one retry on network errors, 429 and 5xx. No Authorization header when apiKey is empty. */
export async function postJson(
  url: string,
  apiKey: string | undefined,
  body: unknown,
  what: string,
  extraHeaders: Record<string, string> = {
    'HTTP-Referer': 'https://github.com/noro-to/noro',
    'X-Title': 'noro',
  },
): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...extraHeaders,
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

export const LABELS: FactLabel[] = ['signal', 'noise', 'luck_risk'];

export const LABEL_CRITERIA: Record<FactLabel, string> = {
  signal:
    'A real change a media buyer should act on or report: a moderate or large move, on an adequate sample, in a metric that bears on cost or results.',
  noise:
    'Not worth the reader’s attention: a small move, a level with nothing to compare, or a metric that does not change the decision.',
  luck_risk:
    'A move that could be chance: it rests on a small sample, a volatile rate, a single window, or a missing baseline, so reading it as real is risky.',
};

export const PRIORITY_CRITERIA = [
  'Lead with it: the headline or the cause behind it.',
  'Supporting: worth one line under the headline.',
  'Background: leave it out unless the reader asks.',
];

export const RATE_METRICS = new Set(['ctr', 'cvr', 'cpa', 'cpc', 'roas']);

/** A percent or percentage-point change in a rate metric: the facts that can get W-volatile-rate-claim. */
export function isRateChange(f: Fact): boolean {
  const d = describeFact(f);
  return RATE_METRICS.has(d.metric) && (d.change === 'percent change' || d.change === 'percentage-point change');
}

/** What a model may know about a batch of facts: labels and coarse descriptors, never values. */
export function stateFor(batch: Fact[], facts: FactsTable): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of batch) {
    const { flags, ...d } = describeFact(f);
    out[f.id] = { label: f.label, ...d, ...(flags.length ? { flags } : {}) };
  }
  return { task: 'Classify facts for a paid-media performance report. Each fact is described in words; values are withheld.', currency: facts.currency, facts: out };
}

export function codeWatchouts(f: Fact): string[] {
  const w: string[] = [];
  if (f.flags.includes('small_sample')) w.push('W-small-sample-size');
  if (f.flags.includes('no_baseline')) w.push('W-metric-without-baseline');
  if (f.scope.metric === 'roas' || f.scope.metric === 'conversion_value') w.push('W-platform-roas-as-cause');
  return w;
}

/**
 * Turn a classifier's judgment into a Classification. Code only moves toward
 * caution: a 'signal' on a small sample or a missing baseline becomes
 * 'luck_risk', and the volatile watchout only lands on rate changes.
 */
export function finalize(f: Fact, label: FactLabel, priority: 1 | 2 | 3, volatile: boolean): Classification {
  const watchouts = codeWatchouts(f);
  if (volatile && isRateChange(f)) watchouts.push('W-volatile-rate-claim');
  if (label === 'signal' && (f.flags.includes('small_sample') || f.flags.includes('no_baseline'))) label = 'luck_risk';
  return { factId: f.id, label, priority, watchouts: [...new Set(watchouts)] };
}

/** A fact nobody judged (no value, or missing from an answer): noise, background. */
export function fallback(f: Fact): Classification {
  return { factId: f.id, label: 'noise', priority: 3, watchouts: codeWatchouts(f) };
}
