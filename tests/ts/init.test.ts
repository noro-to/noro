// noro init: detection, presets (the owner's first), consent for subscription presets, hidden
// keys never printed, .env merged in place with .env.bak and mode 600, .gitignore warning,
// ends with doctor. Offline: fake HOME folders, a scripted prompter, no local servers.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/env.js';
import { detect, onPath, runInit } from '../../src/init/index.js';
import type { Prompter } from '../../src/init/index.js';

const ROOT = resolve(import.meta.dirname, '../..');
const KEY = 'sk-or-v1-TOPSECRETTOPSECRET9876';
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-init-'));
const offline = (async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}) as unknown as typeof fetch;

/** A prompter that answers from a script and records every question. */
function scripted(answers: string[]) {
  const asked: { q: string; secret: boolean }[] = [];
  const next = async (q: string, secret: boolean) => {
    asked.push({ q, secret });
    return answers.shift();
  };
  const p: Prompter = { line: (q) => next(q, false), secret: (q) => next(q, true), close() {} };
  return { p, asked, answers };
}

/** A folder on PATH with a fake `claude`. */
function fakeBin(name: string): string {
  const dir = tmp();
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return dir;
}

function run(answers: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; home?: string; global?: boolean } = {}) {
  const out: string[] = [];
  const said: string[] = [];
  const s = scripted(answers);
  const cwd = opts.cwd ?? tmp();
  const home = opts.home ?? tmp();
  const promise = runInit({
    cwd,
    home,
    baseEnv: { PATH: '', NORO_STATE_DIR: '.noro', ...opts.env },
    global: opts.global,
    prompter: s.p,
    say: (x) => said.push(x),
    print: (x) => out.push(x),
    fetch: offline,
  });
  return { promise, cwd, home, out, said, asked: s.asked };
}

describe('detection', () => {
  it('finds keys by source, binaries on PATH without running them, nothing on closed ports', async () => {
    const bin = fakeBin('claude');
    const home = tmp();
    mkdirSync(join(home, '.aws'));
    writeFileSync(join(home, '.aws', 'credentials'), '[default]\n');
    const d = await detect({ env: { PATH: bin, OPENROUTER_API_KEY: KEY }, envLoad: { sources: [], origin: { OPENROUTER_API_KEY: '.env' } }, home, fetch: offline });
    expect(d).toMatchObject({ claude: true, codex: false, aws: true, gcloud: false, keys: { OPENROUTER_API_KEY: '.env' } });
    expect(d.ollama).toBeUndefined();
    expect(onPath('claude', { PATH: '' })).toBe(false);
  });
});

describe('noro init', () => {
  it("offers the owner's setup first; the subscription preset needs an explicit y; the key is hidden and never printed", async () => {
    const r = run(['1', 'y', KEY], { env: { PATH: fakeBin('claude') } });
    const res = await r.promise;
    const text = [...r.said, ...r.out].join('\n');
    expect(r.said.join('\n')).toMatch(/1\. jev through OpenRouter for classify, your own Claude Code login for writing \(claude-cli\)/);
    expect(text).toMatch(/Personal use only/);
    expect(r.asked.find((a) => /OPENROUTER_API_KEY/.test(a.q))?.secret).toBe(true);
    expect(text).not.toContain(KEY);
    const written = parseEnv(readFileSync(join(r.cwd, '.env'), 'utf8'));
    expect(written).toEqual({ NORO_MODEL: 'claude-cli:claude-opus-5-5', OPENROUTER_API_KEY: KEY });
    if (process.platform !== 'win32') expect(statSync(join(r.cwd, '.env')).mode & 0o777).toBe(0o600);
    expect(text).toMatch(/\.gitignore here does not list \.env/);
    // Ends with doctor.
    expect(r.out.join('\n')).toMatch(/^writer\s+claude-cli\s+claude-opus-5-5\s+\[personal use only\]/m);
    expect(res.doctor).toBeDefined();
  });

  it('declining the terms goes back to the presets; OpenRouter for everything', async () => {
    const r = run(['1', 'n', '2', KEY]);
    await r.promise;
    expect(r.said.join('\n')).toMatch(/Not agreed/);
    expect(parseEnv(readFileSync(join(r.cwd, '.env'), 'utf8'))).toEqual({ NORO_MODEL: 'openrouter:anthropic/claude-opus-5.5', OPENROUTER_API_KEY: KEY });
  });

  it('merges into an existing .env: keeps comments, comments out per-step overrides, saves .env.bak', async () => {
    const cwd = tmp();
    const before = '# team settings\nNORO_STATE_DIR=.state\nNORO_DRAFT_MODEL=anthropic/claude-opus-5.5\nOPENROUTER_API_KEY=sk-or-v1-oldoldoldoldold0000\n';
    writeFileSync(join(cwd, '.env'), before);
    writeFileSync(join(cwd, '.gitignore'), '.env\n');
    const r = run(['2', KEY], { cwd });
    await r.promise;
    const after = readFileSync(join(cwd, '.env'), 'utf8');
    expect(readFileSync(join(cwd, '.env.bak'), 'utf8')).toBe(before);
    expect(after).toContain('# team settings\nNORO_STATE_DIR=.state\n# NORO_DRAFT_MODEL=anthropic/claude-opus-5.5\n');
    expect(parseEnv(after)).toMatchObject({ OPENROUTER_API_KEY: KEY, NORO_MODEL: 'openrouter:anthropic/claude-opus-5.5' });
    expect(r.said.join('\n')).not.toMatch(/\.gitignore/);
    expect(r.said.join('\n')).toMatch(/Commented out NORO_DRAFT_MODEL/);
  });

  it('Enter keeps a key already set and shows only its fingerprint', async () => {
    const r = run(['2', ''], { env: { OPENROUTER_API_KEY: KEY } });
    await r.promise;
    const q = r.asked.find((a) => /OPENROUTER_API_KEY is already set/.test(a.q))!;
    expect(q.q).toContain('sk-or...9876');
    expect(q.q).not.toContain(KEY);
    expect(parseEnv(readFileSync(join(r.cwd, '.env'), 'utf8'))).toEqual({ NORO_MODEL: 'openrouter:anthropic/claude-opus-5.5' });
  });

  it('--global writes ~/.config/noro/.env and leaves the folder alone', async () => {
    const r = run(['2', KEY], { global: true });
    await r.promise;
    expect(existsSync(join(r.cwd, '.env'))).toBe(false);
    expect(parseEnv(readFileSync(join(r.home, '.config', 'noro', '.env'), 'utf8')).OPENROUTER_API_KEY).toBe(KEY);
  });

  it('a direct API preset asks which API, its key, and an optional OpenRouter key for classify', async () => {
    const r = run(['3', '1', 'sk-ant-api03-abcdefghijklmnop', '']);
    await r.promise;
    const env = parseEnv(readFileSync(join(r.cwd, '.env'), 'utf8'));
    expect(env).toEqual({ NORO_MODEL: 'anthropic:claude-opus-5-5', ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop' });
    expect(r.out.join('\n')).toMatch(/^classify\s+rules/m);
  });

  it('codex-cli writes codex-cli:default after consent', async () => {
    const r = run(['6', 'y', '']);
    await r.promise;
    expect(parseEnv(readFileSync(join(r.cwd, '.env'), 'utf8')).NORO_MODEL).toBe('codex-cli:default');
  });

  it('input ending early writes nothing, exit 1', async () => {
    const r = run(['1']);
    expect((await r.promise).exitCode).toBe(1);
    expect(existsSync(join(r.cwd, '.env'))).toBe(false);
  });

  it('CLI: piped answers work and the key never reaches stdout or stderr', () => {
    const cwd = tmp();
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts'), 'init'], {
      cwd,
      encoding: 'utf8',
      input: `2\n${KEY}\n`,
      env: { PATH: process.env.PATH, HOME: tmp(), OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api' },
      timeout: 60_000,
    });
    expect(r.stdout + r.stderr).not.toContain(KEY);
    expect(parseEnv(readFileSync(join(cwd, '.env'), 'utf8')).OPENROUTER_API_KEY).toBe(KEY);
    expect(r.stdout).toMatch(/^writer\s+openrouter\s+anthropic\/claude-opus-5\.5/m);
    expect(r.status).toBe(3); // the key can't be verified: nothing listens on port 9
  });
});
