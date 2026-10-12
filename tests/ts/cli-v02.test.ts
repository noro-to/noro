// v0.2 CLI: subcommands, --model, --decisions, noro facts, settings from the env files,
// Python preflight. Offline: NORO_MOCK_MODELS=1 for runs, fake HOME folders for settings.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fingerprint, gitignoreListsEnv, loadEnvFiles, mergeEnv, parseEnv, userEnvPath, writeEnvFile } from '../../src/env.js';
import { factsFor, formatFacts } from '../../src/facts.js';
import { DecisionsError, decideFrom, findPython, missingForRun, nodeOk, parseDecisionsArg, preflight, pythonCandidates, validateDecisions } from '../../src/preflight.js';
import { loadConfig } from '../../src/config.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');
const tmp = (p = 'noro-cli-') => mkdtempSync(join(tmpdir(), p));

/** Run the CLI with a clean environment: no real keys, a fake HOME, mock models unless overridden. */
function cli(args: string[], env: Record<string, string> = {}, opts: { cwd?: string; input?: string } = {}) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^NORO_|^AWS_|^GOOGLE_|^AZURE_/.test(k)) clean[k] = v;
  return spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts'), ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    input: opts.input ?? '',
    env: { ...clean, HOME: tmp('noro-home-'), USERPROFILE: '', NORO_STATE_DIR: tmp(), ...env },
    timeout: 120_000,
  });
}

describe('env files', () => {
  it('process env wins, then ./.env, then ~/.config/noro/.env', () => {
    const cwd = tmp();
    const home = tmp();
    writeFileSync(join(cwd, '.env'), 'A=from-dotenv\nB=from-dotenv\n# C=commented\n');
    mkdirSync(join(home, '.config', 'noro'), { recursive: true });
    writeFileSync(userEnvPath(home), 'B=from-user\nC=from-user\nexport D="quoted # not a comment"\n');
    const env: NodeJS.ProcessEnv = { A: 'from-process' };
    const load = loadEnvFiles(cwd, home, env);
    expect(env).toMatchObject({ A: 'from-process', B: 'from-dotenv', C: 'from-user', D: 'quoted # not a comment' });
    expect(load.origin).toEqual({ B: '.env', C: '~/.config/noro/.env', D: '~/.config/noro/.env' });
    expect(load.sources.map((s) => [s.label, s.keys.length])).toEqual([
      ['.env', 2],
      ['~/.config/noro/.env', 3],
    ]);
  });

  it('mergeEnv updates in place, keeps comments, comments out cleared keys, appends new ones', () => {
    const before = '# my keys\nOPENROUTER_API_KEY=old # inline\n\nNORO_DRAFT_MODEL=anthropic/claude-opus-5.5\nOTHER=1\n';
    const after = mergeEnv(before, { OPENROUTER_API_KEY: 'new', NORO_DRAFT_MODEL: null, NORO_MODEL: 'claude-cli:claude-opus-5-5' });
    expect(after).toBe('# my keys\nOPENROUTER_API_KEY=new\n\n# NORO_DRAFT_MODEL=anthropic/claude-opus-5.5\nOTHER=1\n\n# Added by noro init\nNORO_MODEL=claude-cli:claude-opus-5-5\n');
    expect(parseEnv(after)).toEqual({ OPENROUTER_API_KEY: 'new', OTHER: '1', NORO_MODEL: 'claude-cli:claude-opus-5-5' });
    expect(parseEnv(mergeEnv('', { K: 'has space' }))).toEqual({ K: 'has space' });
  });

  it('writeEnvFile backs up to .env.bak and writes mode 600', () => {
    const dir = tmp();
    const file = join(dir, '.env');
    writeFileSync(file, 'X=1\n', { mode: 0o644 });
    const r = writeEnvFile(file, { X: '2' });
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('X=1\n');
    expect(readFileSync(file, 'utf8')).toBe('X=2\n');
    expect(r.changed).toEqual(['X']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('fingerprints never show the whole key', () => {
    expect(fingerprint('sk-or-v1-0000000000000000')).toBe('sk-or...0000');
    expect(fingerprint('short')).not.toContain('short');
    expect(fingerprint(undefined)).toBe('(empty)');
  });

  it('gitignoreListsEnv', () => {
    const d = tmp();
    expect(gitignoreListsEnv(d)).toBe(false);
    writeFileSync(join(d, '.gitignore'), 'node_modules/\n.env\n');
    expect(gitignoreListsEnv(d)).toBe(true);
  });
});

describe('preflight', () => {
  it('Node 22.19 or newer', () => {
    expect(nodeOk('22.19.0')).toBe(true);
    expect(nodeOk('24.1.0')).toBe(true);
    expect(nodeOk('22.18.9')).toBe(false);
    expect(nodeOk('20.11.0')).toBe(false);
  });

  it('Python lookup order: NORO_PYTHON alone when set (split on spaces); else python3, python, py -3 on Windows', () => {
    expect(pythonCandidates({ NORO_PYTHON: 'py -3' }, 'win32')).toEqual([['py', '-3']]);
    expect(pythonCandidates({}, 'linux')).toEqual([['python3'], ['python']]);
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args.slice(0, args.length - 2)].join(' '));
      if (cmd === 'python3') return { status: 9009, stdout: '' }; // the Windows Store stub
      if (cmd === 'python') return { status: 0, stdout: '3.8.10\n' };
      return { status: 0, stdout: '3.12.4\n' };
    };
    const r = findPython({}, 'win32', run);
    expect(calls).toEqual(['python3', 'python', 'py -3']);
    expect(r.found).toEqual({ cmd: ['py', '-3'], version: '3.12.4' });
    expect(r.tried.map((t) => t.result)).toEqual(['not found', 'Python 3.8.10 is older than 3.9']);
  });

  it('fails with install advice when no Python 3.9+ is found', () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    expect(() => preflight({}, { platform: 'linux', run: () => ({ status: null, stdout: '', error: enoent }) })).toThrow(/needs Python 3\.9\+.*NORO_PYTHON/s);
    expect(() => preflight({}, { nodeVersion: '20.0.0' })).toThrow(/Node 22\.19/);
  });

  it('missingForRun names each writer key and the classifier key', () => {
    const cfg = loadConfig({ NORO_MODEL: 'anthropic:claude-opus-5-5' });
    expect(missingForRun(cfg, {}, {}).join('\n')).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(missingForRun(cfg, { missingKey: 'OPENROUTER_API_KEY' }, { ANTHROPIC_API_KEY: 'x' }).join('\n')).toMatch(/OPENROUTER_API_KEY is not set.*NORO_CLASSIFY=rules/);
    expect(missingForRun(loadConfig({ NORO_MODEL: 'claude-cli:claude-opus-5-5' }), {}, {})).toEqual([]);
  });
});

describe('--decisions', () => {
  it('takes a JSON array or a file', () => {
    const d = [{ flagId: 'F1', action: 'cut' }, { flagId: 'F2', action: 'reword', text: 'Spend held.' }];
    expect(parseDecisionsArg(JSON.stringify(d))).toEqual(d);
    const dir = tmp();
    writeFileSync(join(dir, 'd.json'), JSON.stringify(d));
    expect(parseDecisionsArg('d.json', dir)).toEqual(d);
  });

  it('refuses malformed entries', () => {
    expect(() => validateDecisions({})).toThrow(DecisionsError);
    expect(() => validateDecisions([{ flagId: 'F1', action: 'drop' }])).toThrow(/keep, cut or reword/);
    expect(() => validateDecisions([{ flagId: 'F1', action: 'reword' }])).toThrow(/needs "text"/);
    expect(() => validateDecisions([{ flagId: 'F1', action: 'keep' }, { flagId: 'F1', action: 'cut' }])).toThrow(/twice/);
    expect(() => parseDecisionsArg('[{"flagId":')).toThrow(/not valid JSON/);
    expect(() => parseDecisionsArg('no-such-file.json')).toThrow(/neither a JSON array nor a file/);
  });

  it('flags left out are kept', async () => {
    const decide = decideFrom([{ flagId: 'F2', action: 'cut' }]);
    expect(await decide({ id: 'F1' })).toEqual({ flagId: 'F1', action: 'keep' });
    expect(await decide({ id: 'F2' })).toEqual({ flagId: 'F2', action: 'cut' });
  });
});

describe('noro facts', () => {
  it('factsFor runs ingest and compute only', async () => {
    const r = await factsFor(FIXTURE);
    expect(r.facts.length).toBeGreaterThan(10);
    expect(r.platform).toBe('Google Ads');
    expect(formatFacts(r)).toMatch(/^id\s+label\s+value\s+formula$/m);
    await expect(factsFor(join(ROOT, 'bench/corpus/01-weekly-email-hedges/original.md'))).rejects.toThrow(/reads exports/);
  });

  it('CLI: text table, --json full table, no key needed', () => {
    const t = cli(['facts', FIXTURE]);
    expect(t.status, t.stderr).toBe(0);
    expect(t.stdout).toMatch(/^f1\s+Spend, account, current week\s+\$/m);
    const j = cli(['facts', FIXTURE, '--json']);
    expect(j.status, j.stderr).toBe(0);
    const table = JSON.parse(j.stdout);
    expect(table.facts[0]).toMatchObject({ id: 'f1', label: expect.any(String), display: expect.any(String), formula: expect.any(String) });
    expect(table.warnings.length).toBeGreaterThan(0);
  });
});

describe('noro this (v0.2 flags)', () => {
  it('help lists the subcommands; unknown command and wrong flags exit 1', () => {
    const h = cli(['--help']);
    expect(h.status).toBe(0);
    for (const c of ['noro facts', 'noro init', 'noro doctor', 'noro mcp', '--model', '--decisions']) expect(h.stdout).toContain(c);
    expect(cli(['that', 'x.csv']).status).toBe(1);
    const wrong = cli(['facts', FIXTURE, '--live']);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain(`--live doesn't apply to "noro facts"`);
  });

  it('--model with an unknown provider exits 1 before any work', () => {
    const r = cli(['this', FIXTURE, '--yes', '--model', 'antropic:claude-opus-5-5'], { NORO_MOCK_MODELS: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/antropic/);
    expect(r.stderr).not.toMatch(/noro: ingest/);
  });

  it('a missing writer key is named, with no network call; claude-cli needs no OpenRouter key', () => {
    const r = cli(['this', FIXTURE, '--yes', '--model', 'anthropic:claude-opus-5-5']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY is not set');
    expect(r.stderr).toContain('noro init');
  });

  it('without a key, classify falls back to rules and says so (mock writer)', () => {
    const r = cli(['this', FIXTURE, '--yes', '--json'], { NORO_MOCK_MODELS: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/noro: classify with /);
    const report = JSON.parse(r.stdout);
    expect(report.classifier).toEqual(expect.any(String));
  });

  it('--decisions applies keep/cut without asking and reports them', () => {
    const state = tmp();
    const first = cli(['this', FIXTURE, '--yes', '--json'], { NORO_MOCK_MODELS: '1', NORO_STATE_DIR: state });
    expect(first.status, first.stderr).toBe(0);
    const flags = JSON.parse(first.stdout).flags as { id: string; quote?: string }[];
    expect(flags.length).toBeGreaterThan(0);
    const target = flags.find((f) => f.quote) ?? flags[0];
    const second = cli(['this', FIXTURE, '--json', '--decisions', JSON.stringify([{ flagId: target.id, action: 'cut' }])], { NORO_MOCK_MODELS: '1', NORO_STATE_DIR: state });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toContain('no terminal to ask in');
    const report = JSON.parse(second.stdout);
    expect(report.decisions.find((d: { flagId: string }) => d.flagId === target.id)).toEqual({ flagId: target.id, action: 'cut' });
    for (const d of report.decisions) if (d.flagId !== target.id) expect(d.action).toBe('keep');
  });

  it('a bad --decisions value exits 1 before the run', () => {
    const r = cli(['this', FIXTURE, '--decisions', '[{"flagId":"F1","action":"maybe"}]'], { NORO_MOCK_MODELS: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/keep, cut or reword/);
    expect(r.stderr).not.toMatch(/noro: ingest/);
  });

  it('a key in ~/.config/noro/.env reaches a run started from another folder', () => {
    const home = tmp('noro-home-');
    mkdirSync(join(home, '.config', 'noro'), { recursive: true });
    writeFileSync(join(home, '.config', 'noro', '.env'), 'NORO_MODEL=anthropic:claude-opus-5-5\n');
    const r = cli(['this', FIXTURE, '--yes'], { HOME: home }, { cwd: tmp() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY is not set'); // the user file's NORO_MODEL applied
  });

  it('no Python 3.9+: exit 1 with install advice, before any model call', () => {
    const r = cli(['this', FIXTURE, '--yes'], { NORO_MOCK_MODELS: '1', PATH: '/nonexistent' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/needs Python 3\.9\+/);
    expect(r.stderr).not.toMatch(/noro: ingest/);
  });
});
