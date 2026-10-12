// OpenRouter chat completions: POST {baseUrl}/v1/chat/completions with the
// key as a Bearer token. Every writing step (draft, panel, revise) goes
// through this client with the model from config (default
// anthropic/claude-opus-5.5).

import { MissingApiKeyError, ModelError, _postJson } from '../classify/index.js';
import type { Config } from '../config.js';
import type { ChatClient } from '../schema.js';

export function createChatClient(cfg: Config): ChatClient {
  return {
    async complete(req) {
      if (!cfg.apiKey) throw new MissingApiKeyError();
      const base = cfg.baseUrl.replace(/\/+$/, '');
      // No temperature: Claude Opus 5.5 rejects sampling parameters.
      const body: Record<string, unknown> = {
        model: req.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      };
      if (req.json) body.response_format = { type: 'json_object' };
      const res = await _postJson(`${base}/v1/chat/completions`, cfg.apiKey, body, `chat (${req.model})`);
      const content = res?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
      throw new ModelError(`chat (${req.model}): response has no message content`);
    },
  };
}

/** Strip a Markdown code fence a model may wrap its answer in. */
export function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

/** Parse a JSON object out of a model answer (tolerates fences and text around it). */
export function parseJsonObject(text: string): any {
  const t = stripFence(text);
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new ModelError('model answer was not JSON');
  }
}
