// Regressions from the final v0.2 review: each test pins one defect that shipped once.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildFlags, deliver } from '../../src/deliver/index.js';
import { isPlaceholderSecret, loadEnvFiles, userEnvPath } from '../../src/env.js';
import { formatDoctor, runDoctor } from '../../src/doctor/index.js';
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

describe('D4: placeholder keys count as unset', () => {
  it('recognizes the shipped placeholder and other obvious ones, not real-looking keys', () => {
    for (const p of ['sk-or-v1-0000000000000000', '0000', 'sk-or-...', 'sk-or-v1-…', 'sk-xxxxxxxx', '<your key>', 'your-api-key-here', 'changeme']) expect(isPlaceholderSecret(p), p).toBe(true);
    for (const k of ['sk-or-v1-3f9a0c1d2e4b5a6978', 'sk-ant-api03-AbCdEf0123456789', 'gsk_0aB1cD2eF3gH4iJ5', 'mykeyABC123def456', '']) expect(isPlaceholderSecret(k), k).toBe(false);
  });

  it('a placeholder in ./.env does not shadow the real key in ~/.config/noro/.env, and doctor warns', async () => {
    const cwd = tmp();
    const home = tmp();
    writeFileSync(join(cwd, '.env'), 'NORO_MODEL=openrouter:anthropic/claude-opus-5.5\nOPENROUTER_API_KEY=sk-or-v1-0000000000000000\n');
    mkdirSync(join(home, '.config', 'noro'), { recursive: true });
    writeFileSync(userEnvPath(home), 'OPENROUTER_API_KEY=sk-or-v1-realrealreal123456789\n');
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant-...' };
    const load = loadEnvFiles(cwd, home, env);
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-realrealreal123456789');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(load.placeholders).toEqual([
      { key: 'ANTHROPIC_API_KEY', label: 'the environment' },
      { key: 'OPENROUTER_API_KEY', label: '.env' },
    ]);
    const fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch;
    const r = await runDoctor({ env, cwd, envLoad: load, fetch });
    const text = formatDoctor(r);
    expect(text).toMatch(/warn {2}OPENROUTER_API_KEY in \.env is a placeholder, not a key, so noro ignores it and uses the one from ~\/\.config\/noro\/\.env \(sk-or\.\.\.6789\)/);
    expect(text).not.toContain('0000');
  });

  it('.env.example ships no uncommented key', async () => {
    const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n');
    expect(lines.filter((l) => /^\s*[A-Z_]*(?:_API_KEY|_TOKEN)\s*=/.test(l))).toEqual([]);
  });
});

describe('D6: contact placeholders in shipped files say they are placeholders', () => {
  it('PRIVACY.md and SECURITY.md mark [... EMAIL] as a placeholder and point to a private GitHub advisory', () => {
    for (const f of ['PRIVACY.md', 'SECURITY.md']) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const m of text.matchAll(/\[[A-Z ]*EMAIL\]/g)) expect(text.slice(m.index! + m[0].length, m.index! + m[0].length + 16), f).toBe(' (a placeholder:');
    }
    expect(readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8')).toMatch(/Until then, open a private security advisory on GitHub/);
  });
});

describe('D7: --model values', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [...CLI, ...args], { cwd: ROOT, env: cleanEnv(env), encoding: 'utf8', input: '', timeout: 60_000 });

  it('an empty --model is a usage error, not the default model', () => {
    for (const args of [['--model', ''], ['--model='], ['--model', '  ']]) {
      const r = cli(['this', FIXTURE, '--yes', ...args], { NORO_MOCK_MODELS: '1' });
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/--model needs a value/);
      expect(r.stderr).toMatch(/Usage:/);
    }
  });

  it('a bare provider name means that provider with its default model', async () => {
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig({}, { model: 'claude-cli' }).draftModel).toBe('claude-cli:claude-opus-5-5');
    expect(loadConfig({}, { model: 'codex-cli' }).draftModel).toBe('codex-cli:default');
    expect(loadConfig({}, { model: 'Anthropic' }).draftModel).toBe('anthropic:claude-opus-5-5');
    expect(loadConfig({ NORO_MODEL: 'claude-cli' }).draftModel).toBe('claude-cli:claude-opus-5-5');
    expect(loadConfig({ NORO_MODEL: 'claude-cli', NORO_PANEL_MODEL: 'codex-cli' }).panelModel).toBe('codex-cli:default');
    expect(loadConfig({}, { model: 'openrouter:' }).draftModel).toBe('openrouter:anthropic/claude-opus-5.5');
    // A bare OpenRouter id is still an OpenRouter id.
    expect(loadConfig({}, { model: 'deepseek/deepseek-v4-pro' }).draftModel).toBe('openrouter:deepseek/deepseek-v4-pro');
    expect(() => loadConfig({}, { model: 'openai-compatible' })).toThrow(/needs a model id/);
  });

  it('the CLI says which writing model it uses', () => {
    const r = cli(['this', FIXTURE, '--yes'], { NORO_MOCK_MODELS: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('noro: write with canned test models (NORO_MOCK_MODELS=1)');
  });
});
