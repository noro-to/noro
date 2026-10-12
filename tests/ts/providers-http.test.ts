// Writer wire tests, offline. noro's own fetch client (openrouter,
// openai-compatible, ollama, lmstudio) against a mocked fetch; pi-ai writers
// against mocked SSE streams (pi-ai always streams), and bedrock / vertex
// through pi-ai's faux provider (their SDKs don't take a custom fetch).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from '@earendil-works/pi-ai';
import { loadConfig } from '../../src/config.js';
import { createChatClient } from '../../src/draft/chat.js';
import { ModelError } from '../../src/classify/index.js';
import { USAGE_LIMIT_MESSAGE, UsageLimitError, createChatClientFor } from '../../src/providers/index.js';
import { MAX_TOKENS } from '../../src/providers/pi-ai.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function jsonFetch(calls: Call[], reply: (c: Call) => Response) {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const c = { url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    return reply(c);
  }) as unknown as typeof fetch;
}

const chatReply = (content: string) => () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
const sse = (events: (string | object)[]) =>
  new Response(events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const REQ = { model: 'ignored', system: 'SYS', user: 'Write {{f1}}.' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('noro fetch client', () => {
  it('openrouter: the v0.1 wire format, no temperature, JSON via response_format', async () => {
    const calls: Call[] = [];
    const cfg = { ...loadConfig({}), apiKey: 'sk-or-test' };
    const chat = createChatClientFor('openrouter:anthropic/claude-opus-5.5', cfg, { fetch: jsonFetch(calls, chatReply('ok')) });
    expect(await chat.complete({ ...REQ, json: true })).toBe('ok');
    const [c] = calls;
    expect(c.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(c.headers.authorization).toBe('Bearer sk-or-test');
    expect(c.headers['x-title']).toBe('noro');
    expect(c.body).toEqual({
      model: 'anthropic/claude-opus-5.5',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Write {{f1}}.' },
      ],
      response_format: { type: 'json_object' },
    });
  });

  it('openrouter: the v0.1 createChatClient still sends req.model', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', jsonFetch(calls, chatReply('ok')));
    await createChatClient({ ...loadConfig({}), apiKey: 'k' }).complete({ ...REQ, model: 'openai/gpt-6.1-sol' });
    expect(calls[0].body.model).toBe('openai/gpt-6.1-sol');
    expect(calls[0].body).not.toHaveProperty('temperature');
  });

  it('openrouter: a missing key fails the call, not the client', async () => {
    const chat = createChatClientFor('openrouter:x/y', { ...loadConfig({}), apiKey: undefined });
    await expect(chat.complete(REQ)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it('openrouter: a 429 after retries is "usage limit reached; rerun later"', async () => {
    const calls: Call[] = [];
    const fetch = jsonFetch(calls, () => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429 }));
    vi.useFakeTimers();
    try {
      const p = createChatClientFor('openrouter:x/y', { ...loadConfig({}), apiKey: 'k' }, { fetch }).complete(REQ);
      const done = expect(p).rejects.toThrow(UsageLimitError);
      await vi.runAllTimersAsync();
      await done;
      await expect(p).rejects.toThrow(USAGE_LIMIT_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toHaveLength(2);
  });

  it('ollama: default base URL, no key, thinking off, JSON mode', async () => {
    const calls: Call[] = [];
    const chat = createChatClientFor('ollama:qwen3.8:27b', loadConfig({}), { fetch: jsonFetch(calls, chatReply('<think>hmm 42</think>{"a":1}')) });
    expect(await chat.complete({ ...REQ, json: true })).toBe('{"a":1}');
    const [c] = calls;
    expect(c.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(c.headers.authorization).toBeUndefined();
    expect(c.body).toMatchObject({ model: 'qwen3.8:27b', reasoning_effort: 'none', response_format: { type: 'json_object' } });
    expect(c.body).not.toHaveProperty('temperature');
  });

  it('lmstudio: default base URL, thinking off, JSON asked in the prompt', async () => {
    const calls: Call[] = [];
    const chat = createChatClientFor('lmstudio:qwen3.8-27b', loadConfig({}), { fetch: jsonFetch(calls, chatReply('{}')) });
    await chat.complete({ ...REQ, json: true });
    const [c] = calls;
    expect(c.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(c.body).toMatchObject({ reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
    expect(c.body).not.toHaveProperty('response_format');
    expect(c.body.messages[1].content).toMatch(/Reply with only the JSON object/);
  });

  it('openai-compatible: NORO_BASE_URL with or without /v1, NORO_API_KEY optional', async () => {
    for (const base of ['https://llm.example.internal', 'https://llm.example.internal/v1/']) {
      const calls: Call[] = [];
      const cfg = loadConfig({ NORO_BASE_URL: base, NORO_API_KEY: 'gw-key' });
      await createChatClientFor('openai-compatible:acme-writer-70b', cfg, { fetch: jsonFetch(calls, chatReply('ok')) }).complete(REQ);
      expect(calls[0].url).toBe('https://llm.example.internal/v1/chat/completions');
      expect(calls[0].headers.authorization).toBe('Bearer gw-key');
      expect(calls[0].body.model).toBe('acme-writer-70b');
    }
    const calls: Call[] = [];
    await createChatClientFor('ollama:m', loadConfig({ NORO_BASE_URL: 'http://gpu-box:11434/v1' }), { fetch: jsonFetch(calls, chatReply('ok')) }).complete(REQ);
    expect(calls[0].url).toBe('http://gpu-box:11434/v1/chat/completions');
  });

  it('openai-compatible: no NORO_BASE_URL fails the call with the fix', async () => {
    await expect(createChatClientFor('openai-compatible:m', loadConfig({})).complete(REQ)).rejects.toThrow(/NORO_BASE_URL/);
  });
});

// ---------------------------------------------------------------- pi-ai over SSE

const anthropicStream = (text: string) =>
  sse([
    'event: message_start\n',
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    'event: content_block_start\n',
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    'event: content_block_delta\n',
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the CPA is 61.03' } },
    'event: content_block_stop\n',
    { type: 'content_block_stop', index: 0 },
    'event: content_block_start\n',
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    'event: content_block_delta\n',
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    'event: content_block_stop\n',
    { type: 'content_block_stop', index: 1 },
    'event: message_delta\n',
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    'event: message_stop\n',
    { type: 'message_stop' },
  ]);

const completionsStream = (text: string) =>
  sse([
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    'data: [DONE]\n\n',
  ]);

describe('pi-ai writers', () => {
  it('anthropic: the native id, noro\'s maxTokens, no temperature, thinking dropped', async () => {
    const calls: Call[] = [];
    const chat = createChatClientFor('anthropic:anthropic/claude-opus-5.5', loadConfig({}), {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-123456' },
      fetch: jsonFetch(calls, () => anthropicStream('Spend held at {{f1}}.')),
      maxRetries: 0,
    });
    expect(await chat.complete(REQ)).toBe('Spend held at {{f1}}.');
    const [c] = calls;
    expect(c.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages(\?|$)/);
    expect(c.headers['x-api-key']).toBe('sk-ant-test-123456');
    expect(c.body.model).toBe('claude-opus-5-5');
    expect(c.body.max_tokens).toBe(MAX_TOKENS);
    expect(c.body).not.toHaveProperty('temperature');
    expect(JSON.stringify(c.body.system)).toContain('SYS');
    // Opus 5.5 can't turn thinking off: noro asks for the lowest effort, never the default "high".
    expect(JSON.stringify(c.body)).not.toContain('"effort":"high"');
    expect(c.body.output_config).toEqual({ effort: 'low' });
  });

  it('anthropic: an API error is a ModelError with the key redacted', async () => {
    const key = 'sk-ant-secret-abcdef';
    const chat = createChatClientFor('anthropic:claude-opus-5-5', loadConfig({}), {
      env: { ANTHROPIC_API_KEY: key },
      fetch: jsonFetch([], () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `bad key ${key}` } }), { status: 400 })),
      maxRetries: 0,
    });
    const err = await chat.complete(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).not.toBeInstanceOf(UsageLimitError);
    expect(err.message).not.toContain(key);
  });

  it('anthropic: a rate limit is "usage limit reached; rerun later"', async () => {
    const chat = createChatClientFor('anthropic:claude-opus-5-5', loadConfig({}), {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-123456' },
      fetch: jsonFetch([], () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }), { status: 429 })),
      maxRetries: 0,
    });
    const err = await chat.complete(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(UsageLimitError);
    expect(err.message).toBe('usage limit reached; rerun later');
  });

  it('anthropic: no key fails the call with the env var to set', async () => {
    const chat = createChatClientFor('anthropic:claude-opus-5-5', loadConfig({}), { env: {} });
    await expect(chat.complete(REQ)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it.each([
    ['deepseek:deepseek-v4-pro', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com', 'deepseek-v4-pro'],
    ['groq:openai/gpt-oss-120b', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b'],
  ])('%s: chat completions with maxTokens and no temperature', async (ref, keyEnv, base, model) => {
    const calls: Call[] = [];
    const chat = createChatClientFor(ref, loadConfig({}), { env: { [keyEnv]: 'key-test-123456' }, fetch: jsonFetch(calls, () => completionsStream('ok')), maxRetries: 0 });
    expect(await chat.complete({ ...REQ, json: true })).toBe('ok');
    const [c] = calls;
    expect(c.url).toBe(`${base}/chat/completions`);
    expect(c.headers.authorization).toBe('Bearer key-test-123456');
    expect(c.body.model).toBe(model);
    expect(c.body).not.toHaveProperty('temperature');
    expect(c.body.max_tokens ?? c.body.max_completion_tokens).toBe(MAX_TOKENS);
    expect(c.body.messages.at(-1).content).toMatch(/Reply with only the JSON object/);
  });

  it('openai: the Responses API with maxTokens and no temperature', async () => {
    const calls: Call[] = [];
    const chat = createChatClientFor('openai:gpt-6.1-sol', loadConfig({}), {
      env: { OPENAI_API_KEY: 'sk-proj-test-123456' },
      fetch: jsonFetch(calls, () => new Response('', { status: 500 })),
      maxRetries: 0,
    });
    await expect(chat.complete(REQ)).rejects.toThrow(ModelError);
    const [c] = calls;
    expect(c.url).toBe('https://api.openai.com/v1/responses');
    expect(c.body.model).toBe('gpt-6.1-sol');
    expect(c.body.max_output_tokens).toBe(MAX_TOKENS);
    expect(c.body).not.toHaveProperty('temperature');
  });

  it('google: the Gemini API with the key from GEMINI_API_KEY', async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      jsonFetch(calls, () => sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }])),
    );
    const chat = createChatClientFor('google:gemini-3.1-pro-preview', loadConfig({}), { env: { GEMINI_API_KEY: 'AIza-test-123456' }, maxRetries: 0 });
    expect(await chat.complete(REQ)).toBe('ok');
    const [c] = calls;
    expect(c.url).toContain('generativelanguage.googleapis.com');
    expect(c.url).toContain('gemini-3.1-pro-preview');
    expect(JSON.stringify(c.body)).not.toContain('temperature');
    expect(c.body.generationConfig?.maxOutputTokens).toBe(MAX_TOKENS);
  });
});

describe('pi-ai writers through the faux provider', () => {
  function faux(provider: string, id: string, reply: ReturnType<typeof fauxAssistantMessage>) {
    const f = fauxProvider({ provider, models: [{ id, reasoning: true, maxTokens: 128_000 }] });
    const models = createModels();
    models.setProvider(f.provider);
    const seen: { maxTokens?: number; reasoning?: unknown; temperature?: unknown }[] = [];
    f.setResponses([
      (_ctx, options) => {
        seen.push({ maxTokens: options?.maxTokens, reasoning: options?.reasoning, temperature: options?.temperature });
        return reply;
      },
    ]);
    return { models, seen };
  }

  it('bedrock: global.anthropic id, thinking blocks dropped, maxTokens set, no temperature', async () => {
    const { models, seen } = faux('amazon-bedrock', 'global.anthropic.claude-opus-5-5', fauxAssistantMessage([fauxThinking('the CPA is 61.03'), fauxText('Spend held at {{f1}}.')]));
    const chat = createChatClientFor('bedrock:anthropic/claude-opus-5.5', loadConfig({}), { models, env: { AWS_PROFILE: 'reports', AWS_REGION: 'us-east-1' } });
    expect(await chat.complete(REQ)).toBe('Spend held at {{f1}}.');
    expect(seen).toEqual([{ maxTokens: MAX_TOKENS, reasoning: undefined, temperature: undefined }]);
  });

  it('vertex: a throttling error is the usage-limit message; a cut-off answer is an error', async () => {
    const limited = faux('google-vertex', 'gemini-3.1-pro-preview', fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 RESOURCE_EXHAUSTED: Quota exceeded' }));
    const chat = createChatClientFor('vertex:gemini-3.1-pro-preview', loadConfig({}), { models: limited.models, env: {} });
    await expect(chat.complete(REQ)).rejects.toThrow('usage limit reached; rerun later');
    const cut = faux('google-vertex', 'gemini-3.1-pro-preview', fauxAssistantMessage('half a', { stopReason: 'length' }));
    await expect(createChatClientFor('vertex:gemini-3.1-pro-preview', loadConfig({}), { models: cut.models, env: {} }).complete(REQ)).rejects.toThrow(/cut off/);
  });

  it('azure: a model id newer than the catalog still runs', async () => {
    const { models } = faux('azure', 'gpt-6.1-sol', fauxAssistantMessage('ok'));
    const chat = createChatClientFor('azure:gpt-7-preview', loadConfig({}), { models, env: { AZURE_OPENAI_API_KEY: 'k-123456' } });
    expect(await chat.complete(REQ)).toBe('ok');
  });
});
