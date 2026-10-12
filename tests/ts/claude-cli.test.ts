// The claude-cli writer, against a fake `claude` binary: the right flags, no API
// key or cloud provider leaks into the child, and it refuses anything but a
// Claude subscription login.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { claudeModelId, createClaudeCliClient } from '../../src/draft/claude-cli.js';

const FAKE = resolve('tests/ts/fixtures/fake-claude.mjs');
let log: string;
const saved = { ...process.env };

beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), 'noro-claude-')), 'calls.jsonl');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
});

afterEach(() => {
  process.env = { ...saved };
});

function calls() {
  return readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

const config = () => loadConfig({ NORO_WRITER: 'claude-cli', NORO_CLAUDE_BIN: FAKE });

describe('claude-cli writer', () => {
  it('reads NORO_WRITER and keeps openrouter as the default', () => {
    expect(loadConfig({}).writer).toBe('openrouter');
    expect(config().writer).toBe('claude-cli');
    expect(() => loadConfig({ NORO_WRITER: 'nope' })).toThrow(/NORO_WRITER/);
  });

  it('maps OpenRouter model ids to Claude Code ids', () => {
    expect(claudeModelId('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(claudeModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('runs one tool-less completion on the subscription, with no API key in the env', async () => {
    const chat = createClaudeCliClient(config());
    const out = await chat.complete({ model: config().draftModel, system: 'SYS', user: 'Write {{f1}}.' });
    expect(out).toBe('echo: Write {{f1}}.');
    const [auth, call] = calls();
    expect(auth.args.slice(0, 2)).toEqual(['auth', 'status']);
    expect(call.args).toEqual(['-p', '--model', 'claude-opus-5-5', '--output-format', 'json', '--system-prompt', 'SYS', '--tools', '', '--safe-mode', '--no-session-persistence']);
    for (const c of [auth, call]) {
      expect(c.apiKey).toBeNull();
      expect(c.bedrock).toBeNull();
    }
  });

  it('checks auth once per client', async () => {
    const chat = createClaudeCliClient(config());
    await chat.complete({ model: 'claude-opus-5-5', system: 's', user: 'a' });
    await chat.complete({ model: 'claude-opus-5-5', system: 's', user: 'b' });
    expect(calls().filter((c) => c.args[0] === 'auth')).toHaveLength(1);
  });

  it('refuses an API-key login', async () => {
    process.env.FAKE_CLAUDE_AUTH = 'api_key';
    const chat = createClaudeCliClient(config());
    await expect(chat.complete({ model: 'claude-opus-5-5', system: 's', user: 'x' })).rejects.toThrow(/not a Claude subscription/);
    expect(calls().some((c) => c.args[0] === '-p')).toBe(false);
  });

  it('refuses when logged out', async () => {
    process.env.FAKE_CLAUDE_AUTH = 'none';
    await expect(createClaudeCliClient(config()).complete({ model: 'claude-opus-5-5', system: 's', user: 'x' })).rejects.toThrow(/not logged in/);
  });

  it('surfaces a failed run', async () => {
    process.env.FAKE_CLAUDE_FAIL = '1';
    await expect(createClaudeCliClient(config()).complete({ model: 'claude-opus-5-5', system: 's', user: 'x' })).rejects.toThrow(/failed: Not logged in/);
  });

  it('explains a missing binary', async () => {
    const cfg = loadConfig({ NORO_WRITER: 'claude-cli', NORO_CLAUDE_BIN: '/nonexistent/claude' });
    await expect(createClaudeCliClient(cfg).complete({ model: 'claude-opus-5-5', system: 's', user: 'x' })).rejects.toThrow(/wasn't found/);
  });
});
