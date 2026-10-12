// noro's own client for OpenAI-style chat completions:
// POST {base}/v1/chat/completions. Used for openrouter (byte-for-byte the v0.1
// wire format, so cost and behavior don't drift), openai-compatible, ollama and
// lmstudio. No temperature or other sampling parameter is ever sent.

import { ModelError } from '../classify/index.js';
import type { ChatClient } from '../schema.js';
import { UsageLimitError } from './errors.js';

export const JSON_SUFFIX = '\n\nReply with only the JSON object, no other text.';

export interface OpenAIChatOptions {
  /** For messages: "openrouter", "ollama", ... */
  provider: string;
  /** Server root, with or without a trailing /v1. */
  baseUrl: string;
  /** Bearer token; resolved per call so a missing key fails the call, not client creation. */
  apiKey?: () => string | undefined;
  /** Thrown from complete() when the key is required and missing. */
  missingKey?: () => Error;
  /** The model to send; req.model is used when unset. */
  model?: string;
  /** How to ask for JSON: the API's response_format, or a line in the prompt. */
  jsonMode: 'response_format' | 'prompt';
  /** Extra body fields (e.g. asking a local server to turn thinking off). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Attempts on 429 / 5xx / network errors. Default 2. */
  attempts?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

/** "http://localhost:11434/v1/" → "http://localhost:11434". */
export function stripV1(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Drop a leading <think>…</think> block some local models put in the answer. */
export function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
}

export function createOpenAIChatClient(o: OpenAIChatOptions): ChatClient {
  const base = stripV1(o.baseUrl);
  const attempts = o.attempts ?? 2;
  return {
    async complete(req) {
      const key = o.apiKey?.();
      if (!key && o.missingKey) throw o.missingKey();
      const model = o.model ?? req.model;
      const what = `chat (${model})`;
      const user = req.json && o.jsonMode === 'prompt' ? `${req.user}${JSON_SUFFIX}` : req.user;
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: user },
        ],
      };
      if (req.json && o.jsonMode === 'response_format') body.response_format = { type: 'json_object' };
      Object.assign(body, o.extraBody);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...o.headers };
      if (key) headers.Authorization = `Bearer ${key}`;
      const doFetch = o.fetch ?? fetch;

      let last: Error | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        let res: Response;
        try {
          res = await doFetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(o.timeoutMs ?? 180_000),
          });
        } catch (err) {
          last = new ModelError(`${what}: request to ${new URL(base).host} failed: ${(err as Error).message}`);
          continue;
        }
        const text = await res.text();
        if (res.ok) {
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            throw new ModelError(`${what}: response was not JSON`);
          }
          const content = json?.choices?.[0]?.message?.content;
          if (typeof content === 'string') return stripThinking(content);
          if (Array.isArray(content)) return stripThinking(content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(''));
          throw new ModelError(`${what}: response has no message content`);
        }
        let msg = text.slice(0, 300);
        try {
          msg = JSON.parse(text)?.error?.message ?? msg;
        } catch {
          /* keep raw */
        }
        last = res.status === 429 ? new UsageLimitError(o.provider, msg) : new ModelError(`${what}: HTTP ${res.status}: ${msg}`, res.status);
        if (res.status !== 429 && res.status < 500) break;
        if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, (o.retryDelayMs ?? 1500) * (attempt + 1)));
      }
      throw last ?? new ModelError(`${what}: no request was made`);
    },
  };
}
