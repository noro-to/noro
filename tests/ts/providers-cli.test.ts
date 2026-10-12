// The codex-cli writer against a fake `codex` binary: the right flags, an empty
// working folder, no API key in the child, ChatGPT login only, and the plan
// limit message. Plus claude-cli through createChatClientFor.
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { CodexCliError, codexModelArg } from '../../src/draft/codex-cli.js';
import { UsageLimitError, createChatClientFor } from '../../src/providers/index.js';

const FAKE_CODEX = resolve('tests/ts/fixtures/fake-codex.mjs');
const FAKE_CLAUDE = resolve('tests/ts/fixtures/fake-claude.mjs');
chmodSync(FAKE_CODEX, 0o755);
let log: string;
const saved = { ...process.env };

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'noro-codex-test-'));
  log = join(dir, 'calls.jsonl');
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CLAUDE_LOG = join(dir, 'claude.jsonl');
  process.env.OPENAI_API_KEY = 'sk-proj-should-not-leak';
  process.env.CODEX_API_KEY = 'should-not-leak';
  process.env.OPENAI_BASE_URL = 'https://elsewhere.example';
});

afterEach(() => {
  process.env = { ...saved };
});

const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cfg = () => loadConfig({ NORO_MODEL: 'codex-cli:default', NORO_CODEX_BIN: FAKE_CODEX, NORO_CLAUDE_BIN: FAKE_CLAUDE });
const REQ = { model: 'x', system: 'SYS PROMPT', user: 'Write {{f1}}.' };

describe('codex-cli writer', () => {
  it('codex-cli:default passes no --model; another id is passed as --model', () => {
    expect(codexModelArg('default')).toEqual([]);
    expect(codexModelArg('')).toEqual([]);
    expect(codexModelArg('gpt-6.1-sol')).toEqual(['--model', 'gpt-6.1-sol']);
    expect(loadConfig({ NORO_MODEL: 'codex-cli:' }).draftModel).toBe('codex-cli:default');
  });

  it('runs one locked-down codex exec on the ChatGPT plan, with no API key in the env', async () => {
    const chat = createChatClientFor('codex-cli:default', cfg());
    expect(await chat.complete({ ...REQ, json: true })).toBe('echo: Write {{f1}}.\n\nReply with only the JSON object, no other text.');
    const [status, exec] = calls();
    expect(status.args).toEqual(['login', 'status']);
    const a: string[] = exec.args;
    expect(a[0]).toBe('exec');
    expect(a).not.toContain('--model');
    for (const flag of ['--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) expect(a).toContain(flag);
    expect(a.slice(a.indexOf('--sandbox'), a.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    expect(a).toContain('features.shell_tool=false');
    expect(a).toContain('web_search="disabled"');
    expect(a.at(-1)).toBe('-');
    expect(exec.system).toBe('SYS PROMPT');
    expect(exec.stdin).toContain('Write {{f1}}.');
    // Codex runs in an empty temp folder: no prompt files, no repo.
    expect(exec.cwdFiles).toEqual([]);
    expect(a[a.indexOf('-C') + 1]).toBe(exec.cwd);
    for (const c of [status, exec]) for (const v of Object.values(c.leaked)) expect(v).toBeNull();
  });

  it('passes a named model and checks auth once per client', async () => {
    const chat = createChatClientFor('codex-cli:gpt-6.1-sol', cfg());
    await chat.complete(REQ);
    await chat.complete(REQ);
    const all = calls();
    expect(all.filter((c) => c.args[0] === 'login')).toHaveLength(1);
    const exec = all.find((c) => c.args[0] === 'exec');
    expect(exec.args.slice(1, 3)).toEqual(['--model', 'gpt-6.1-sol']);
  });

  it('stops on an API-key login or no login', async () => {
    process.env.FAKE_CODEX_AUTH = 'apikey';
    await expect(createChatClientFor('codex-cli:default', cfg()).complete(REQ)).rejects.toThrow(/API key, not a ChatGPT plan/);
    process.env.FAKE_CODEX_AUTH = 'none';
    await expect(createChatClientFor('codex-cli:default', cfg()).complete(REQ)).rejects.toThrow(CodexCliError);
    expect(calls().every((c) => c.args[0] === 'login')).toBe(true);
  });

  it('a plan limit is "usage limit reached; rerun later"', async () => {
    process.env.FAKE_CODEX_LIMIT = '1';
    const err = await createChatClientFor('codex-cli:default', cfg()).complete(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(UsageLimitError);
    expect(err.message).toBe('usage limit reached; rerun later');
  });

  it('says how to install when the binary is missing', async () => {
    const c = { ...cfg(), codexBin: '/nonexistent/codex' };
    await expect(createChatClientFor('codex-cli:default', c).complete(REQ)).rejects.toThrow(/NORO_CODEX_BIN/);
  });
});

describe('claude-cli through the registry', () => {
  it('normalizes the model id and runs claude -p', async () => {
    const chat = createChatClientFor('claude-cli:anthropic/claude-opus-5.5', cfg());
    expect(await chat.complete(REQ)).toBe('echo: Write {{f1}}.');
    const lines = readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const call = lines.find((l) => l.args[0] === '-p');
    expect(call.args.slice(0, 3)).toEqual(['-p', '--model', 'claude-opus-5-5']);
  });
});
