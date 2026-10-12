// Provider config: model refs, precedence, the NORO_WRITER alias, model-id
// normalization, missing credentials, and the owner's run key pinned to v0.1.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveClassifier } from '../../src/classify/index.js';
import { loadConfig } from '../../src/config.js';
import { classifierSource, runKeyFor } from '../../src/harness/index.js';
import {
  ConfigError,
  PROVIDERS,
  createChatClientFor,
  formatModelRef,
  missingCredentials,
  nativeModelId,
  normalizeModelId,
  parseModelRef,
} from '../../src/providers/index.js';

const FIXTURE = resolve('fixtures/exports/google-ads.csv');

describe('model refs', () => {
  it('splits on the first colon; a bare id is openrouter', () => {
    expect(parseModelRef('anthropic:claude-opus-5-5')).toEqual({ provider: 'anthropic', id: 'claude-opus-5-5' });
    expect(parseModelRef('bedrock:anthropic.claude-x-v1:0')).toEqual({ provider: 'bedrock', id: 'anthropic.claude-x-v1:0' });
    expect(parseModelRef('ollama:qwen3.8:27b')).toEqual({ provider: 'ollama', id: 'qwen3.8:27b' });
    expect(parseModelRef('anthropic/claude-opus-5.5')).toEqual({ provider: 'openrouter', id: 'anthropic/claude-opus-5.5' });
    expect(parseModelRef('deepseek/deepseek-r1:free')).toEqual({ provider: 'openrouter', id: 'deepseek/deepseek-r1:free' });
    expect(formatModelRef({ provider: 'groq', id: 'openai/gpt-oss-120b' })).toBe('groq:openai/gpt-oss-120b');
  });

  it('an empty id means the provider default; codex-cli: means Codex default', () => {
    expect(parseModelRef('anthropic:')).toEqual({ provider: 'anthropic', id: 'claude-opus-5-5' });
    expect(parseModelRef('codex-cli:')).toEqual({ provider: 'codex-cli', id: 'default' });
    expect(() => parseModelRef('openai-compatible:')).toThrow(ConfigError);
  });

  it('refuses an unknown provider with a did-you-mean', () => {
    expect(() => parseModelRef('antropic:claude-opus-5-5')).toThrow(/not a provider\. Did you mean "anthropic"/);
  });

  it('lists every provider in the docs', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      'openrouter', 'anthropic', 'openai', 'google', 'bedrock', 'vertex', 'azure', 'mistral', 'deepseek', 'groq',
      'openai-compatible', 'ollama', 'lmstudio', 'claude-cli', 'codex-cli',
    ]);
  });
});

describe('model id normalization', () => {
  it.each([
    ['openrouter', 'anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5'],
    ['anthropic', 'anthropic/claude-opus-5.5', 'claude-opus-5-5'],
    ['anthropic', 'claude-opus-5-5', 'claude-opus-5-5'],
    ['claude-cli', 'anthropic/claude-opus-5.5', 'claude-opus-5-5'],
    ['bedrock', 'anthropic/claude-opus-5.5', 'global.anthropic.claude-opus-5-5'],
    ['bedrock', 'us.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5'],
    ['openai', 'openai/gpt-6.1-sol', 'gpt-6.1-sol'],
    ['azure', 'gpt-6.1-sol', 'gpt-6.1-sol'],
    ['google', 'google/gemini-3.1-pro-preview', 'gemini-3.1-pro-preview'],
    ['vertex', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview'],
    ['mistral', 'mistralai/mistral-large-4', 'mistral-large-4'],
    ['groq', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b'],
    ['ollama', 'qwen3.8:27b', 'qwen3.8:27b'],
    ['codex-cli', 'default', 'default'],
  ])('%s: %s → %s', (provider, id, out) => {
    expect(normalizeModelId(provider, id)).toBe(out);
  });

  it('refuses a model the provider cannot run', () => {
    expect(() => normalizeModelId('openai', 'anthropic/claude-opus-5.5')).toThrow(/can't run/);
    expect(() => normalizeModelId('vertex', 'claude-opus-5-5')).toThrow(/Gemini models only/);
    expect(() => createChatClientFor('vertex:anthropic/claude-opus-5.5', loadConfig({}))).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  it('defaults to OpenRouter with Claude Opus 5.5', () => {
    const c = loadConfig({});
    expect(c.draftModel).toBe('openrouter:anthropic/claude-opus-5.5');
    expect(c.panelModel).toBe('openrouter:anthropic/claude-opus-5.5');
    expect(c.writer).toBe('openrouter');
    expect(c.classifyModel).toBeUndefined();
    expect(c.codexBin).toBe('codex');
  });

  it('NORO_MODEL sets both steps; per-step overrides win; --model beats all three', () => {
    const env = { NORO_MODEL: 'anthropic:claude-opus-5-5', NORO_PANEL_MODEL: 'openrouter:deepseek/deepseek-v4-pro' };
    const c = loadConfig(env);
    expect(c.draftModel).toBe('anthropic:claude-opus-5-5');
    expect(c.panelModel).toBe('openrouter:deepseek/deepseek-v4-pro');
    expect(c.writer).toBe('anthropic');
    const f = loadConfig({ ...env, NORO_DRAFT_MODEL: 'openai:gpt-6.1-sol' }, { model: 'openrouter:anthropic/claude-opus-5.5' });
    expect([f.draftModel, f.panelModel]).toEqual(['openrouter:anthropic/claude-opus-5.5', 'openrouter:anthropic/claude-opus-5.5']);
  });

  it('a bare NORO_DRAFT_MODEL is openrouter, as in v0.1', () => {
    expect(loadConfig({ NORO_DRAFT_MODEL: 'openai/gpt-6.1-sol' }).draftModel).toBe('openrouter:openai/gpt-6.1-sol');
  });

  it('NORO_WRITER=claude-cli is an alias for claude-cli:claude-opus-5-5, and keeps bare per-step ids on claude-cli', () => {
    const c = loadConfig({ NORO_WRITER: 'claude-cli' });
    expect(c.draftModel).toBe('claude-cli:claude-opus-5-5');
    expect(c.writer).toBe('claude-cli');
    expect(loadConfig({ NORO_WRITER: 'claude-cli', NORO_DRAFT_MODEL: 'anthropic/claude-sonnet-5.5' }).draftModel).toBe('claude-cli:anthropic/claude-sonnet-5.5');
    expect(loadConfig({ NORO_WRITER: 'claude-cli', NORO_MODEL: 'openai:gpt-6.1-sol' }).draftModel).toBe('openai:gpt-6.1-sol');
    // A leftover v0.1 NORO_DRAFT_MODEL next to NORO_MODEL=claude-cli:... stays on Claude Code.
    expect(loadConfig({ NORO_MODEL: 'claude-cli:claude-opus-5-5', NORO_DRAFT_MODEL: 'anthropic/claude-opus-5.5' }).draftModel).toBe('claude-cli:anthropic/claude-opus-5.5');
    expect(() => loadConfig({ NORO_WRITER: 'nope' })).toThrow(/NORO_WRITER/);
  });

  it('reads the endpoint, classify and binary settings', () => {
    const c = loadConfig({
      NORO_BASE_URL: 'http://localhost:8000/v1',
      NORO_API_KEY: 'k',
      NORO_CLASSIFY: 'Rules',
      NORO_CLASSIFY_BASE_URL: 'http://localhost:11434',
      NORO_CLASSIFY_MODEL: 'nimble',
      TYPESAFE_API_KEY: 'ts',
      NORO_CODEX_BIN: '/opt/codex',
    });
    expect(c).toMatchObject({ noroBaseUrl: 'http://localhost:8000/v1', noroApiKey: 'k', classify: 'rules', classifyBaseUrl: 'http://localhost:11434', classifyModel: 'nimble', typesafeKey: 'ts', codexBin: '/opt/codex' });
  });

  it('the native id the harness sends', () => {
    expect(nativeModelId('claude-cli:anthropic/claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(nativeModelId('openrouter:anthropic/claude-opus-5.5')).toBe('anthropic/claude-opus-5.5');
  });
});

describe('missingCredentials', () => {
  it('names the env vars each provider still needs', () => {
    expect(missingCredentials('openrouter:x/y', {})).toEqual(['OPENROUTER_API_KEY']);
    expect(missingCredentials('anthropic:claude-opus-5-5', { ANTHROPIC_API_KEY: 'k' })).toEqual([]);
    expect(missingCredentials('google:gemini-3.1-pro-preview', {})).toEqual(['GEMINI_API_KEY']);
    expect(missingCredentials('bedrock:global.anthropic.claude-opus-5-5', { AWS_PROFILE: 'reports' })).toEqual(['AWS_REGION']);
    expect(missingCredentials('bedrock:x', {})).toHaveLength(2);
    expect(missingCredentials('vertex:gemini-3.1-pro-preview', { GOOGLE_CLOUD_API_KEY: 'k' })).toEqual([]);
    expect(missingCredentials('vertex:gemini-3.1-pro-preview', { GOOGLE_CLOUD_PROJECT: 'p' })).toEqual(['GOOGLE_CLOUD_LOCATION']);
    expect(missingCredentials('azure:gpt-6.1-sol', { AZURE_OPENAI_API_KEY: 'k' })).toEqual(['AZURE_OPENAI_RESOURCE_NAME or AZURE_OPENAI_BASE_URL']);
    expect(missingCredentials('openai-compatible:m', {})).toEqual(['NORO_BASE_URL']);
    for (const r of ['ollama:m', 'lmstudio:m', 'claude-cli:claude-opus-5-5', 'codex-cli:default']) expect(missingCredentials(r, {})).toEqual([]);
  });
});

describe('run keys', () => {
  /** The v0.1 run key, byte for byte (harness at 918c323). */
  function v01Key(writer: string, models: string[]): string {
    const h = createHash('sha256');
    h.update(JSON.stringify({ v: 2, mode: 'generate', format: 'one-page', writer, models, origin: { injected: { chat: false, jev: false }, mock: false } }));
    h.update(readFileSync(FIXTURE));
    return h.digest('hex').slice(0, 32);
  }
  const DEFAULTS = ['anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5', 'typesafe/jev-1.13'];
  const keyOf = (env: NodeJS.ProcessEnv, overrides?: { model?: string }) => {
    const cfg = loadConfig(env, overrides);
    const c = resolveClassifier(cfg, { env });
    return runKeyFor(FIXTURE, 'generate', 'one-page', cfg, { classifier: classifierSource(c) });
  };

  it("keeps the owner's v0.1 key: claude-cli writing, jev on OpenRouter", () => {
    expect(v01Key('claude-cli', DEFAULTS)).toBe('fcb96dff9d6e017b37654f79be63ff56');
    const key = 'fcb96dff9d6e017b37654f79be63ff56';
    expect(keyOf({ NORO_WRITER: 'claude-cli', OPENROUTER_API_KEY: 'sk-or-test' })).toBe(key);
    expect(keyOf({ NORO_MODEL: 'claude-cli:claude-opus-5-5', OPENROUTER_API_KEY: 'sk-or-test' })).toBe(key);
    expect(runKeyFor(FIXTURE, 'generate', 'one-page', loadConfig({ NORO_WRITER: 'claude-cli' }))).toBe(key);
  });

  it('keeps the default OpenRouter key, and --model openrouter gives it too', () => {
    const key = v01Key('openrouter', DEFAULTS);
    expect(key).toBe('b2ec199c532c2272de9abe0b356bb53a');
    expect(keyOf({ OPENROUTER_API_KEY: 'sk-or-test' })).toBe(key);
    expect(keyOf({ NORO_MODEL: 'claude-cli:claude-opus-5-5', OPENROUTER_API_KEY: 'sk-or-test' }, { model: 'openrouter:anthropic/claude-opus-5.5' })).toBe(key);
  });

  it('separates runs by model, classifier and endpoint', () => {
    const keys = [
      keyOf({ OPENROUTER_API_KEY: 'k' }),
      keyOf({ NORO_WRITER: 'claude-cli', OPENROUTER_API_KEY: 'k' }),
      keyOf({ NORO_MODEL: 'anthropic:claude-opus-5-5', OPENROUTER_API_KEY: 'k' }),
      keyOf({ NORO_MODEL: 'anthropic:claude-opus-5-5', NORO_PANEL_MODEL: 'groq:openai/gpt-oss-120b', OPENROUTER_API_KEY: 'k' }),
      keyOf({ OPENROUTER_API_KEY: 'k', NORO_CLASSIFY: 'rules' }),
      keyOf({ NORO_CLASSIFY_BASE_URL: 'http://localhost:11434', NORO_CLASSIFY_MODEL: 'nimble', OPENROUTER_API_KEY: 'k' }),
      keyOf({ NORO_MODEL: 'openai-compatible:m', NORO_BASE_URL: 'http://a.internal', OPENROUTER_API_KEY: 'k' }),
      keyOf({ NORO_MODEL: 'openai-compatible:m', NORO_BASE_URL: 'http://b.internal', OPENROUTER_API_KEY: 'k' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
