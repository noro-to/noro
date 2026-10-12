// Shared test helpers (not a test file). Independent of production code on purpose: what a model
// prompt may contain is decided here, not by the allow lists the code under test builds.

import { expect } from 'vitest';
import type { FactsTable } from '../../src/schema.js';

/**
 * Identifier shapes a prompt may carry digits in, written here independently of production
 * (allowedIdentifiers / isIdentifierShape), so a leaky allow list can't mask its own leak.
 */
const STRICT_ID =
  /^(?:[A-Z]{1,5}-?\d{1,4}(?:[-_][A-Z0-9]{1,8})*|(?:19|20)\d\d|\d{4}-\d{1,2}-\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:\s?[–-]\s?(?:[A-Z][a-z]{2,8}\.? )?\d{1,2})?(?:,? \d{4})?)$/;

/** Names that may carry digits: campaign and ad group names and period labels of the table, plus strict-shape allow entries. */
export function promptNames(table: FactsTable, allow: string[] = []): string[] {
  for (const a of allow) expect(STRICT_ID.test(a), `allow entry "${a}" is not a strict identifier`).toBe(true);
  const out = new Set<string>();
  for (const f of table.facts) for (const n of [f.scope.campaign, f.scope.adGroup]) if (n && /\p{L}/u.test(n)) out.add(n);
  for (const p of [table.periods.current, table.periods.previous]) if (p) out.add(p);
  for (const a of allow) out.add(a);
  return [...out].sort((a, b) => b.length - a.length);
}

/** Blank out the names on clean boundaries (not touching a unit, sign or another digit). */
export function maskNames(text: string, names: string[]): string {
  let out = text;
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}$€£¥+\\-.,])${esc}(?![\\p{L}\\p{N}%])`, 'gu'), (m) => ' '.repeat(m.length));
  }
  return out;
}

/**
 * What a prompt may contain: after removing {{fN}} references and the names above, there must be
 * no numeral at all (any Unicode number). Static prompt text has none.
 */
export function assertNoNumbers(text: string, table: FactsTable, allow: string[] = []) {
  const stripped = maskNames(text.replace(/\{\{\s*f\d+\s*\}\}/g, ' '), promptNames(table, allow));
  const digits = stripped.match(/.{0,30}\p{N}.{0,30}/u);
  expect(digits?.[0] ?? null, 'a digit reached a model prompt').toBeNull();
}

