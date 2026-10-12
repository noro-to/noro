// Pure arithmetic for the facts table. Every number a report can show is
// computed here (or summed off the rows in compute/index.ts), never by a model.
//
// Every op takes numbers or null (a missing input) and returns
// { value, flags }. Dividing by zero gives value null and the
// 'divide_by_zero' flag; a null input gives value null with no new flag (the
// caller carries the input's flags forward).

import type { FactFlag } from '../schema.js';

export interface OpResult {
  value: number | null;
  flags: FactFlag[];
}

type N = number | null | undefined;

const ok = (value: number): OpResult => ({ value, flags: [] });
const missing = (): OpResult => ({ value: null, flags: [] });
const divByZero = (): OpResult => ({ value: null, flags: ['divide_by_zero'] });

function isNum(x: N): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** a / b * scale, with divide-by-zero and missing-input handling. */
function divide(a: N, b: N, scale = 1): OpResult {
  if (!isNum(a) || !isNum(b)) return missing();
  if (b === 0) return divByZero();
  return ok((a / b) * scale);
}

/** Percent change from `from` to `to`: (to - from) / from * 100. */
export function pctChange(from: N, to: N): OpResult {
  if (!isNum(from) || !isNum(to)) return missing();
  if (from === 0) return divByZero();
  return ok(((to - from) / from) * 100);
}

/** Difference from `from` to `to`: to - from. For two percents this is in percentage points. */
export function diff(from: N, to: N): OpResult {
  if (!isNum(from) || !isNum(to)) return missing();
  return ok(to - from);
}

/** a / b. */
export function ratio(a: N, b: N): OpResult {
  return divide(a, b);
}

/** part / whole * 100. */
export function share(part: N, whole: N): OpResult {
  return divide(part, whole, 100);
}

/** Click-through rate in percent: clicks / impressions * 100. */
export function ctr(clicks: N, impressions: N): OpResult {
  return divide(clicks, impressions, 100);
}

/** Cost per click: spend / clicks. */
export function cpc(spend: N, clicks: N): OpResult {
  return divide(spend, clicks);
}

/** Cost per acquisition: spend / conversions. */
export function cpa(spend: N, conversions: N): OpResult {
  return divide(spend, conversions);
}

/** Conversion rate in percent: conversions / clicks * 100. */
export function cvr(conversions: N, clicks: N): OpResult {
  return divide(conversions, clicks, 100);
}

/** Return on ad spend as a multiplier: conversion value / spend. */
export function roas(conversionValue: N, spend: N): OpResult {
  return divide(conversionValue, spend);
}
