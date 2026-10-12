// Regressions from the final v0.2 review: each test pins one defect that shipped once.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildFlags, deliver } from '../../src/deliver/index.js';
import type { CheckReport, Draft, FactsTable } from '../../src/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');
const tmp = (p = 'noro-review-') => mkdtempSync(join(tmpdir(), p));

/** A clean environment for a CLI child: no real keys, a fake HOME. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^NORO_|^AWS_|^GOOGLE_|^AZURE_/.test(k)) clean[k] = v;
  return { ...clean, HOME: tmp('noro-home-'), USERPROFILE: '', NORO_STATE_DIR: tmp(), ...extra };
}

const CLI = ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts')];

describe('D1: piped stdout is never cut short', () => {
  // A shell pipe whose reader sleeps before reading: the child fills the 64 KiB pipe buffer and
  // must wait. (A Node parent can't stand in: its stream reads the pipe into memory at once.)
  it.skipIf(process.platform === 'win32')('noro facts --json through a slow-reading pipe prints the whole JSON (> 64 KiB) and exits 0', () => {
    const dir = tmp();
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    const cmd = `(${[process.execPath, ...CLI, 'facts', FIXTURE, '--json'].map(q).join(' ')} 2>/dev/null; echo $? > ${q(join(dir, 'code'))}) | (sleep 2; cat)`;
    const r = spawnSync('sh', ['-c', cmd], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    expect(readFileSync(join(dir, 'code'), 'utf8').trim()).toBe('0');
    expect(r.stdout.length).toBeGreaterThan(64 * 1024);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.facts.length).toBeGreaterThan(100);
  }, 60_000);
});

describe('D2: cut and reword act on the same whole sentence, and the flag says so', () => {
  const facts: FactsTable = {
    currency: 'USD',
    periods: { current: 'this week' },
    facts: [
      { id: 'f1', key: 'cpa', label: 'CPA, PR-07 Prospecting', value: 41.4, kind: 'currency', unit: 'USD', display: '$41.40', formula: 'spend / conversions', inputs: [], scope: { metric: 'cpa', campaign: 'PR-07 Prospecting' }, flags: [] },
      { id: 'f2', key: 'spend', label: 'Spend, account', value: 13678, kind: 'currency', unit: 'USD', display: '$13,678', formula: 'sum of spend', inputs: [], scope: { metric: 'spend' }, flags: [] },
    ],
  };
  const draft: Draft = {
    template: 'CPA for PR-07 Prospecting rose to {{f1}}. Account spend landed at {{f2}}.',
    rendered: 'CPA for PR-07 Prospecting rose to $41.40. Account spend landed at $13,678.',
    factIds: ['f1', 'f2'],
  };
  const jargon: CheckReport = {
    pass: true,
    mode: 'generate',
    untraced: [],
    length: null,
    findings: [{ rule: 'T-jargon', name: 'Jargon', category: 'tells', severity: 'advisory', match: 'CPA', span: [0, 3], message: 'Spell out CPA for a client.', fix: '' }],
    engine: null,
  };

  it('a one-word jargon flag names the whole headline sentence that cut would remove', () => {
    const [flag] = buildFlags(jargon, [], undefined, { facts, draft });
    expect(flag.quote).toBe('CPA');
    expect(flag.sentence).toBe('CPA for PR-07 Prospecting rose to $41.40.');
    expect(flag.text).toContain('Cut removes the sentence; reword replaces it: "CPA for PR-07 Prospecting rose to $41.40."');
  });

  it('reword replaces the whole sentence, the same span cut removes', async () => {
    const flags = buildFlags(jargon, [], undefined, { facts, draft });
    const reworded = await deliver({ text: draft.rendered, facts, flags, decide: async (f) => ({ flagId: f.id, action: 'reword', text: 'Cost per lead for PR-07 Prospecting rose to {{f1}}' }) });
    expect(reworded.text).toBe('Cost per lead for PR-07 Prospecting rose to $41.40. Account spend landed at $13,678.');
    const cut = await deliver({ text: draft.rendered, facts, flags, decide: async (f) => ({ flagId: f.id, action: 'cut' }) });
    expect(cut.text).toBe('Account spend landed at $13,678.');
  });
});
