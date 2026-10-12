// What a model may know about a fact, besides its id and label.
//
// Code turns each value into coarse words. No model sees fact.value,
// fact.display, fact.formula or fact.sampleSize: those are numbers it could
// combine. What it gets instead:
//   direction  up | down | no change | n/a     (sign of a change fact; compute's labels already end with it)
//   magnitude  small | moderate | large | n/a  (change facts only; thresholds below, applied by code)
//   sample     small | adequate | n/a          (from the small_sample flag, or n/a when no sample applies)
//   change     level | percent change | absolute change | percentage-point change | share
//   flags      divide_by_zero, small_sample, no_baseline
// None of these contain a digit, and none can be combined into a number.

import type { Fact } from '../schema.js';

export type Direction = 'up' | 'down' | 'no change' | 'n/a';
export type Magnitude = 'small' | 'moderate' | 'large' | 'n/a';

export interface FactDescriptor {
  metric: string;
  scope: 'account' | 'campaign' | 'ad group';
  campaign?: string;
  period: string;
  change: 'level' | 'percent change' | 'absolute change' | 'percentage-point change' | 'share' | 'share change';
  direction: Direction;
  magnitude: Magnitude;
  sample: 'small' | 'adequate' | 'n/a';
  flags: string[];
}

/** Percent-change magnitude buckets (absolute value): < 5 small, < 20 moderate, otherwise large. */
const PCT_BUCKETS: [number, number] = [5, 20];
/** Percentage-point change buckets: < 0.5 small, < 2 moderate, otherwise large. */
const PP_BUCKETS: [number, number] = [0.5, 2];

function bucket(abs: number, [a, b]: [number, number]): Magnitude {
  return abs < a ? 'small' : abs < b ? 'moderate' : 'large';
}

function changeKind(f: Fact): FactDescriptor['change'] {
  const d = f.scope.dimension;
  if (d === 'pct_change') return 'percent change';
  if (d === 'pp_change') return 'percentage-point change';
  if (d === 'diff') return 'absolute change';
  if (d === 'share') return 'share';
  if (d === 'share_pp_change') return 'share change';
  return 'level';
}

export function describeFact(f: Fact): FactDescriptor {
  const change = changeKind(f);
  const isChange = change !== 'level' && change !== 'share';
  let direction: Direction = 'n/a';
  let magnitude: Magnitude = 'n/a';
  if (isChange && f.value !== null) {
    direction = f.value > 0 ? 'up' : f.value < 0 ? 'down' : 'no change';
    const abs = Math.abs(f.value);
    if (change === 'percent change') magnitude = bucket(abs, PCT_BUCKETS);
    else if (change === 'percentage-point change' || change === 'share change') magnitude = bucket(abs, PP_BUCKETS);
  }
  const scope: FactDescriptor['scope'] = f.scope.adGroup ? 'ad group' : f.scope.campaign !== undefined ? 'campaign' : 'account';
  return {
    metric: f.scope.metric,
    scope,
    ...(f.scope.campaign !== undefined ? { campaign: f.scope.campaign } : {}),
    period: f.scope.period === 'previous_to_current' ? 'change between windows' : `${f.scope.period ?? 'whole export'} window`,
    change,
    direction,
    magnitude,
    sample: f.flags.includes('small_sample') ? 'small' : f.sampleSize !== undefined ? 'adequate' : 'n/a',
    flags: [...f.flags],
  };
}
