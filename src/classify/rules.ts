// Deterministic classify: labels from what compute already decided (flags) and
// the coarse buckets in describe.ts. Free, offline, the same answer every run.
// It can't judge which metric matters for a given account, so it leans on a
// fixed list of primary metrics.
//
//   no value                                   → noise, priority 3
//   small_sample | no_baseline | divide_by_zero → luck_risk
//   change, magnitude small (or no bucket)     → noise
//   change, magnitude moderate | large         → signal
//   rate change at campaign / ad-group scope   → + W-volatile-rate-claim
//   combined runs: a channel's share-of-spend or share-of-conversions change
//               of moderate or large magnitude is a headline candidate too, ranked
//               ahead of account changes of the same size (the cross-channel story),
//               the biggest share move first
//   level / share                              → noise, except current-window
//                                                account totals of primary metrics: signal, priority 2
//   priority 1: at most two account-scope signal changes in primary metrics
//               (large before moderate, then fact order); other signals 2; the rest 3
//   watchouts: codeWatchouts, as for jev

import type { Classification, Fact, FactLabel, FactsTable } from '../schema.js';
import { describeFact } from './describe.js';
import { finalize, fallback, isRateChange } from './shared.js';

export const PRIMARY_METRICS = new Set(['spend', 'conversions', 'cpa', 'roas', 'conversion_value']);
export const MAX_RULES_HEADLINES = 2;

const LUCK_FLAGS = ['small_sample', 'no_baseline', 'divide_by_zero'];

function isCurrentWindow(f: Fact): boolean {
  return f.scope.period === undefined || f.scope.period === 'current';
}

export function classifyByRules(facts: FactsTable): Classification[] {
  const judged = new Map<string, { label: FactLabel; priority: 1 | 2 | 3; volatile: boolean; headline: boolean; large: boolean; channel: boolean }>();
  for (const f of facts.facts) {
    if (f.value === null) continue;
    const d = describeFact(f);
    const isChange = d.change !== 'level' && d.change !== 'share';
    let label: FactLabel;
    let priority: 1 | 2 | 3 = 3;
    let headline = false;
    let channel = false;
    if (f.flags.some((x) => LUCK_FLAGS.includes(x))) {
      label = 'luck_risk';
    } else if (isChange) {
      label = d.magnitude === 'moderate' || d.magnitude === 'large' ? 'signal' : 'noise';
      if (label === 'signal') {
        priority = 2;
        channel = d.scope === 'channel' && d.change === 'share change';
        headline = (d.scope === 'account' && PRIMARY_METRICS.has(d.metric)) || channel;
      }
    } else if (d.change === 'level' && d.scope === 'account' && isCurrentWindow(f) && PRIMARY_METRICS.has(d.metric)) {
      label = 'signal';
      priority = 2;
    } else {
      label = 'noise';
    }
    const volatile = isChange && (d.scope === 'campaign' || d.scope === 'ad group') && isRateChange(f);
    judged.set(f.id, { label, priority, volatile, headline, large: d.magnitude === 'large', channel });
  }
  const size = new Map(facts.facts.map((f) => [f.id, Math.abs(f.value ?? 0)]));
  const headlines = [...judged.entries()]
    .filter(([, j]) => j.headline)
    .map(([id, j], i) => ({ id, tier: (j.large ? 0 : 2) + (j.channel ? 0 : 1), share: j.channel ? size.get(id)! : 0, i }))
    // Among channel share changes, the biggest move first (code compares the values; no model does).
    .sort((a, b) => a.tier - b.tier || b.share - a.share || a.i - b.i)
    .slice(0, MAX_RULES_HEADLINES);
  for (const h of headlines) judged.get(h.id)!.priority = 1;
  return facts.facts.map((f) => {
    const j = judged.get(f.id);
    return j ? finalize(f, j.label, j.priority, j.volatile) : fallback(f);
  });
}
