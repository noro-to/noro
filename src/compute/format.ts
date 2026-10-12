// Display formatting for facts. A fact's `display` is the exact text code puts
// in the report, so it must be text the engine's `extract` reads back as one
// number of the same kind and unit, within half a unit of its last shown digit
// of fact.value (docs/engine.md tracing rule). tests/ts/compute.test.ts round-trips
// every display through the real engine.
//
// The rule (signed = a change fact: pct change, diff, pp change):
//   currency    |v| < 1,000 → 2 decimals ("$61.03"); otherwise whole units with
//               thousands separators ("$48,213"). USD $, EUR €, GBP £ as symbols;
//               CAD and AUD as a code prefix ("CAD 1,204"); any other currency
//               as a code suffix ("1,204 JPY"), which the engine reads as a count.
//   percent     |v| < 1 → 2 decimals, < 10 → 1 decimal, else whole ("38%", "3.2%", "0.45%")
//   pp          |v| < 0.1 → 2 decimals, else 1 decimal, always signed ("+0.3 pp")
//   multiplier  |v| < 1 → 2 decimals, else 1 decimal ("4.1x", "0.85x")
//   count       thousands separators, 1 decimal only when the value isn't whole
//               at 1 decimal ("1,284", "790.5")
//   Signed displays put "+" on positive values ("+12%", "+$1,234", "+0.3x");
//   negatives always show "-" ("-12%", "-$61.03"). A value that rounds to zero
//   shows no sign. null → "n/a" (no digits, so the engine sees nothing).

import type { FactKind } from '../schema.js';

/** Currencies the engine's number parser recognises (noro.py CURRENCY_SYMBOLS and codes). */
export const ENGINE_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

function digits(abs: number, kind: FactKind): number {
  switch (kind) {
    case 'currency':
      return abs < 1000 ? 2 : 0;
    case 'percent':
      return abs < 1 ? 2 : abs < 10 ? 1 : 0;
    case 'pp':
      return abs < 0.1 ? 2 : 1;
    case 'multiplier':
    case 'ratio':
      return abs < 1 ? 2 : 1;
    case 'count':
      return Number.isInteger(Number(abs.toFixed(1))) ? 0 : 1;
  }
}

function group(abs: number, fractionDigits: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: true,
  }).format(abs);
}

/** Format a fact value for the report. `signed` adds "+" to positive values (change facts). */
export function formatDisplay(value: number | null, kind: FactKind, unit: string, signed = false): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  const body = group(abs, digits(abs, kind));
  const isZero = !/[1-9]/.test(body);
  const sign = isZero ? '' : value < 0 ? '-' : signed ? '+' : '';
  switch (kind) {
    case 'currency': {
      const code = (unit || 'USD').toUpperCase();
      const sym = SYMBOLS[code];
      if (sym) return `${sign}${sym}${body}`;
      if (ENGINE_CURRENCIES.has(code)) return `${sign}${code} ${body}`;
      return `${sign}${body} ${code}`;
    }
    case 'percent':
      return `${sign}${body}%`;
    case 'pp':
      return `${sign}${body} pp`;
    case 'multiplier':
    case 'ratio':
      return `${sign}${body}x`;
    case 'count':
      return `${sign}${body}`;
  }
}

/** Plain number for formulas: up to 6 decimals, no grouping, trailing zeros trimmed. */
export function plain(v: number | null): string {
  if (v === null) return 'null';
  return String(round6(v));
}

/** Round to 6 decimals and normalise -0 to 0. Fact values are stored this way. */
export function round6(v: number): number {
  const r = Number(v.toFixed(6));
  return Object.is(r, -0) ? 0 : r;
}
