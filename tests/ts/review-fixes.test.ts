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

describe('D8a/b: secrets and run state are private from the first byte', () => {
  it.skipIf(process.platform === 'win32')('writePrivate replaces a world-readable .env with a new mode-600 file (never rewritten in place)', async () => {
    const { writeEnvFile } = await import('../../src/env.js');
    const { readdirSync, statSync, chmodSync } = await import('node:fs');
    const dir = tmp();
    const file = join(dir, '.env');
    writeFileSync(file, 'OPENROUTER_API_KEY=old\n');
    chmodSync(file, 0o644);
    const before = statSync(file).ino;
    const r = writeEnvFile(file, { OPENROUTER_API_KEY: 'sk-or-v1-new' });
    expect(statSync(file).ino).not.toBe(before); // a fresh file, created 600, renamed into place
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('sk-or-v1-new');
    expect(readdirSync(dir).sort()).toEqual(['.env', '.env.bak']); // no temp file left
  });

  it.skipIf(process.platform === 'win32')('a run creates .noro and .noro/runs as 700 and its checkpoint file as 600', async () => {
    const { statSync, readdirSync } = await import('node:fs');
    const { runNoro } = await import('../../src/harness/index.js');
    const { createMockChat, createMockJev } = await import('../../src/harness/mock.js');
    const { loadConfig } = await import('../../src/config.js');
    const cwd = tmp();
    const stateDir = join(cwd, '.noro');
    const old = process.umask(0o022);
    try {
      await runNoro({ file: FIXTURE, cwd, stateDir, config: { ...loadConfig({}), apiKey: undefined }, clients: { chat: createMockChat(), jev: createMockJev() }, decide: async (f) => ({ flagId: f.id, action: 'keep' }) });
    } finally {
      process.umask(old);
    }
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, 'runs')).mode & 0o777).toBe(0o700);
    const dbs = readdirSync(join(stateDir, 'runs'));
    expect(dbs.some((f) => f.endsWith('.sqlite'))).toBe(true);
    for (const f of dbs) expect(statSync(join(stateDir, 'runs', f)).mode & 0o777, f).toBe(0o600);
  });

  it('the weekly workflow template caches .noro/runs and uploads only the report', () => {
    for (const f of ['examples/noro-weekly.yml', 'docs/install/scheduled.md']) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      const upload = text.slice(text.indexOf('actions/upload-artifact'));
      expect(upload, f).toMatch(/path: report\.md\n/);
      expect(upload.slice(0, upload.indexOf('report.md') + 10), f).not.toContain('.noro');
      expect(text, f).toMatch(/actions\/cache@v\d+\n\s+with:\n\s+path: \.noro\/runs/);
    }
  });
});

describe('D8c/d/e: preflight says what will run, and fails before any paid call', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [...CLI, ...args], { cwd: ROOT, env: cleanEnv(env), encoding: 'utf8', input: '', timeout: 60_000 });

  it('a broken NORO_PYTHON fails with a clear error instead of falling back to python3; doctor shows it', () => {
    const r = cli(['this', FIXTURE, '--yes'], { NORO_MOCK_MODELS: '1', NORO_PYTHON: 'definitely-not-python' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NORO_PYTHON="definitely-not-python" doesn't run Python 3\.9\+ \(not found\)\. Point NORO_PYTHON at a Python 3\.9\+ command, or unset it/);
    expect(r.stderr).not.toMatch(/noro: ingest/);
    const d = cli(['doctor'], { NORO_PYTHON: 'definitely-not-python', NORO_CLASSIFY: 'rules', NORO_MODEL: 'ollama:qwen3.8:27b', NORO_BASE_URL: 'http://127.0.0.1:9' });
    expect(d.stdout).toMatch(/FAIL {2}NORO_PYTHON="definitely-not-python" doesn't run Python 3\.9\+/);
  });

  it('with NORO_MOCK_MODELS=1 the classify line and the footer name the canned classifier that ran', () => {
    const r = cli(['this', FIXTURE, '--yes'], { NORO_MOCK_MODELS: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('noro: classify with canned test classifier (NORO_MOCK_MODELS=1)');
    expect(r.stdout).toContain('Classify: canned test classifier (NORO_MOCK_MODELS=1).');
    expect(r.stdout).not.toMatch(/Classify: jev/);
    const j = cli(['this', FIXTURE, '--yes', '--json'], { NORO_MOCK_MODELS: '1' });
    expect(JSON.parse(j.stdout).classifier).toBe('canned test classifier (NORO_MOCK_MODELS=1)');
  });

  it.skipIf(process.platform === 'win32')('a logged-out claude-cli writer fails in preflight, before ingest and the paid classify call', () => {
    const log = join(tmp(), 'calls.jsonl');
    const r = cli(['this', FIXTURE, '--yes'], {
      NORO_MODEL: 'claude-cli:claude-opus-5-5',
      NORO_CLAUDE_BIN: join(ROOT, 'tests/ts/fixtures/fake-claude.mjs'),
      FAKE_CLAUDE_AUTH: 'none',
      FAKE_CLAUDE_LOG: log,
      OPENROUTER_API_KEY: 'sk-or-v1-not-a-real-key-but-not-a-placeholder', // jev on OpenRouter would be a paid call
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Claude Code is not logged in/);
    expect(r.stderr).not.toMatch(/noro: (ingest|classify)/);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args[0]);
    expect(calls).toEqual(['auth']);
  });
});

describe('D8f: errors about an unreadable export show short header names only, never data', () => {
  const long = 'Secret Revenue Figure For Acme Corp Q3 Internal Only Do Not Share';
  const headers = ['Client Name', long, ...'cdefghijklm'.split('')];
  const file = () => {
    const f = join(tmp(), 'odd.csv');
    writeFileSync(f, `${headers.join(',')}\nAcme Corp TOPSECRET,123456,${'x,'.repeat(10)}x\nGlobex SECRET2,654321,${'y,'.repeat(10)}y\n`);
    return f;
  };
  const check = (message: string) => {
    expect(message).toMatch(/Unknown export/);
    expect(message).not.toMatch(/TOPSECRET|SECRET2|123456|654321/);
    expect(message).not.toContain(long);
    expect(message).toContain(`${long.slice(0, 39)}…`);
    const unmapped = message.match(/Unmapped headers: (.*)/)![1];
    expect(unmapped).toMatch(/, and 3 more$/);
    expect(unmapped.replace(/, and 3 more$/, '').split(', ')).toHaveLength(10);
    for (const h of unmapped.split(', ')) expect(h.length).toBeLessThanOrEqual(40);
  };

  it('noro facts (CLI)', () => {
    const r = spawnSync(process.execPath, [...CLI, 'facts', file()], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', input: '', timeout: 60_000 });
    expect(r.status).toBe(1);
    check(r.stderr);
  });

  it('noro_facts (MCP)', async () => {
    const { createNoroMcpServer } = await import('../../src/mcp/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/server');
    const server = createNoroMcpServer({ cwd: tmp() });
    const [client, side] = InMemoryTransport.createLinkedPair();
    const replies = new Map<number, any>();
    client.onmessage = (m: any) => m.id !== undefined && replies.set(m.id, m);
    await server.connect(side);
    await client.start();
    const send = async (id: number, method: string, params: unknown) => {
      await client.send({ jsonrpc: '2.0', id, method, params } as never);
      for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 10));
      return replies.get(id);
    };
    await send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const r = await send(2, 'tools/call', { name: 'noro_facts', arguments: { path: file() } });
    await server.close();
    expect(r.result.isError).toBe(true);
    check(r.result.content[0].text);
  });

  it('a CSV parse error says where, not what', async () => {
    const { factsFor } = await import('../../src/facts.js');
    const f = join(tmp(), 'bad.csv');
    writeFileSync(f, 'Campaign,Cost,Clicks\nAcme,10,5\n"unterminated TOPSECRET,1,2\n');
    await expect(factsFor(f)).rejects.toThrow(/can't read it as CSV \(CSV_QUOTE_NOT_CLOSED at line \d+\)\.$/);
    await expect(factsFor(f)).rejects.not.toThrow(/TOPSECRET/);
  });
});
