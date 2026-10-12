// noro doctor: free checks, fingerprints only, exit 0/1/3, --live asks first. Offline: an
// injected fetch, a localhost stand-in for OpenRouter, and the fake claude binary.

import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDoctor, runDoctor } from '../../src/doctor/index.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import type { ChatClient, ChatRequest } from '../../src/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FAKE_CLAUDE = join(ROOT, 'tests/ts/fixtures/fake-claude.mjs');
const KEY = 'sk-or-v1-SECRETSECRETSECRET1234';
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-doctor-'));
const base = () => ({ PATH: process.env.PATH, NORO_STATE_DIR: '.noro' }) as NodeJS.ProcessEnv;

/** A fetch that answers by URL and counts calls. */
function fakeFetch(routes: Record<string, number | { status: number; json: unknown }>) {
  const calls: string[] = [];
  const f = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const hit = Object.entries(routes).find(([k]) => u.startsWith(k));
    if (!hit) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const r = typeof hit[1] === 'number' ? { status: hit[1], json: {} } : hit[1];
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

const statusOf = (r: Awaited<ReturnType<typeof runDoctor>>, name: string) => r.sections.filter((s) => s.name === name).flatMap((s) => s.lines.map((l) => l.status));

describe('noro doctor (free checks)', () => {
  it("the owner's setup: claude-cli logged in + jev on OpenRouter with a valid key → exit 0, key as a fingerprint", async () => {
    const { f, calls } = fakeFetch({ 'https://openrouter.ai/api/v1/key': 200 });
    const env = { ...base(), NORO_MODEL: 'claude-cli:claude-opus-5-5', NORO_CLAUDE_BIN: FAKE_CLAUDE, OPENROUTER_API_KEY: KEY };
    const r = await runDoctor({ env, cwd: tmp(), fetch: f });
    const text = formatDoctor(r);
    expect(r.exitCode, text).toBe(0);
    expect(text).toMatch(/^writer\s+claude-cli\s+claude-opus-5-5\s+\[personal use only\]/m);
    expect(text).toContain('ok  logged in with a Claude subscription');
    expect(text).toMatch(/^classify\s+jev \(typesafe\/jev-1\.13 on openrouter\.ai\)/m);
    expect(text).toContain('OPENROUTER_API_KEY set (sk-or...1234), key valid');
    expect(text).toMatch(/^live\s+skipped\. Run `noro doctor --live`/m);
    expect(text).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(calls).toEqual(['https://openrouter.ai/api/v1/key']); // one free key check, shared by writer-less classify
  });

  it('--model openrouter on the same setup checks the key once', async () => {
    const { f, calls } = fakeFetch({ 'https://openrouter.ai/api/v1/key': 200 });
    const r = await runDoctor({ env: { ...base(), OPENROUTER_API_KEY: KEY }, cwd: tmp(), fetch: f });
    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('a rejected key fails (exit 1); claude-cli on an API-key login fails', async () => {
    const { f } = fakeFetch({ 'https://openrouter.ai/api/v1/key': 401 });
    const r = await runDoctor({ env: { ...base(), OPENROUTER_API_KEY: KEY }, cwd: tmp(), fetch: f });
    expect(r.exitCode).toBe(1);
    expect(formatDoctor(r)).toMatch(/rejected it \(HTTP 401\)/);
    const c = await runDoctor({ env: { ...base(), NORO_MODEL: 'claude-cli:claude-opus-5-5', NORO_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_AUTH: 'apiKey', NORO_CLASSIFY: 'rules' }, cwd: tmp(), fetch: f });
    expect(c.exitCode).toBe(1);
    expect(statusOf(c, 'writer')).toContain('fail');
  });

  it('nothing set: no network call at all, the missing key is named, classify is rules', async () => {
    const { f, calls } = fakeFetch({});
    const r = await runDoctor({ env: base(), cwd: tmp(), fetch: f });
    expect(calls).toEqual([]);
    expect(r.exitCode).toBe(1);
    expect(formatDoctor(r)).toMatch(/OPENROUTER_API_KEY not set/);
    expect(formatDoctor(r)).toMatch(/^classify\s+rules$/m);
  });

  it('Bedrock credentials are "found (not verified)": exit 3', async () => {
    const { f, calls } = fakeFetch({});
    const env = { ...base(), NORO_MODEL: 'bedrock:global.anthropic.claude-opus-5-5', AWS_PROFILE: 'work', AWS_REGION: 'us-east-1', NORO_CLASSIFY: 'rules' };
    const r = await runDoctor({ env, cwd: tmp(), fetch: f });
    expect(r.exitCode).toBe(3);
    expect(formatDoctor(r)).toContain('credentials found (not verified)');
    expect(calls).toEqual([]);
  });

  it('Ollama: model listed, warns when the context length is below 16384', async () => {
    const { f } = fakeFetch({
      'http://localhost:11434/v1/models': { status: 200, json: { data: [{ id: 'qwen3.8:27b' }] } },
      'http://localhost:11434/api/ps': { status: 200, json: { models: [{ name: 'qwen3.8:27b', context_length: 4096 }] } },
    });
    const r = await runDoctor({ env: { ...base(), NORO_MODEL: 'ollama:qwen3.8:27b', NORO_CLASSIFY: 'rules' }, cwd: tmp(), fetch: f });
    const text = formatDoctor(r);
    expect(text).toContain('model qwen3.8:27b available');
    expect(text).toMatch(/warn  context length 4096 is below 16384/);
    expect(r.exitCode).toBe(0);
  });

  it('an unreachable local server fails', async () => {
    const { f } = fakeFetch({});
    const r = await runDoctor({ env: { ...base(), NORO_MODEL: 'lmstudio:qwen3.8-27b', NORO_CLASSIFY: 'rules' }, cwd: tmp(), fetch: f });
    expect(r.exitCode).toBe(1);
    expect(formatDoctor(r)).toMatch(/nothing answers at http:\/\/localhost:1234/);
  });
});

describe('noro doctor --live', () => {
  const env = () => ({ ...base(), NORO_CLASSIFY: 'jev', OPENROUTER_API_KEY: KEY });
  const okFetch = () => fakeFetch({ 'https://openrouter.ai/api/v1/key': 200 }).f;

  it('asks before spending; no answer, no call', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const clients = { chat: createMockChat({ log }), jev: createMockJev(log) };
    const asked: string[] = [];
    const r = await runDoctor({ env: env(), cwd: tmp(), fetch: okFetch(), live: true, clients, ask: async (q) => (asked.push(q), false) });
    expect(asked[0]).toMatch(/16-token call.*estimated cost/);
    expect(log.chat).toHaveLength(0);
    expect(log.jev).toHaveLength(0);
    expect(formatDoctor(r)).toMatch(/^live\s+skipped: not confirmed/m);
  });

  it('without a terminal it needs --yes', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const r = await runDoctor({ env: env(), cwd: tmp(), fetch: okFetch(), live: true, clients: { chat: createMockChat({ log }), jev: createMockJev(log) } });
    expect(log.chat).toHaveLength(0);
    expect(formatDoctor(r)).toMatch(/Rerun with --yes/);
  });

  it('--yes: one call per writing model plus one single-fact classify call', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const r = await runDoctor({ env: env(), cwd: tmp(), fetch: okFetch(), live: true, yes: true, clients: { chat: createMockChat({ log }), jev: createMockJev(log) } });
    expect(log.chat).toHaveLength(1);
    expect(log.jev).toHaveLength(1);
    expect(statusOf(r, 'live')).toEqual(['ok', 'ok']);
  });

  it('--yes: the writing call is capped at 16 output tokens', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const reqs: ChatRequest[] = [];
    const chat: ChatClient = { complete: async (req) => (reqs.push(req), 'OK') };
    await runDoctor({ env: env(), cwd: tmp(), fetch: okFetch(), live: true, yes: true, clients: { chat, jev: createMockJev(log) } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].maxTokens).toBe(16);
  });
});

describe('noro doctor (CLI)', () => {
  it('reads both .env files, prints fingerprints only, --json, exit codes', async () => {
    // A stand-in for OpenRouter's key endpoint on localhost.
    const server = createServer((req, res) => {
      res.statusCode = req.headers.authorization === `Bearer ${KEY}` ? 200 : 401;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const home = tmp();
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(home, '.config', 'noro'), { recursive: true });
      writeFileSync(join(home, '.config', 'noro', '.env'), `OPENROUTER_API_KEY=${KEY}\n`);
      const cwd = tmp();
      writeFileSync(join(cwd, '.env'), `OPENROUTER_BASE_URL=http://127.0.0.1:${port}/api\nNORO_MODEL=claude-cli:claude-opus-5-5\nNORO_CLAUDE_BIN=${FAKE_CLAUDE}\n`);
      const run = (args: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
          const child = spawn(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts'), 'doctor', ...args], {
            cwd,
            env: { PATH: process.env.PATH, HOME: home },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => (stdout += d));
          child.stderr.on('data', (d) => (stderr += d));
          child.on('close', (code) => done({ code, stdout, stderr }));
        });
      const r = await run([]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^config\s+\.env \(3 keys\), ~\/\.config\/noro\/\.env \(1 key\)/m);
      expect(r.stdout).toContain('OPENROUTER_API_KEY set (sk-or...1234), key valid');
      expect(r.stdout + r.stderr).not.toContain(KEY);
      const j = await run(['--json']);
      expect(JSON.parse(j.stdout).exitCode).toBe(0);
    } finally {
      server.close();
    }
  });

  it('--live --yes with the mock models', () => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts'), 'doctor', '--live', '--yes', '--json'], {
      cwd: tmp(),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: tmp(), NORO_MOCK_MODELS: '1', NORO_CLASSIFY: 'rules', NORO_MODEL: 'ollama:qwen3.8:27b', NORO_BASE_URL: 'http://127.0.0.1:9' },
    });
    const res = JSON.parse(r.stdout);
    const live = res.sections.find((s: { name: string }) => s.name === 'live');
    expect(live.lines.map((l: { status: string }) => l.status)).toEqual(['ok', 'ok']);
    expect(r.status).toBe(1); // the local server isn't there
  });
});
