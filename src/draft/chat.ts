// Chat helpers. createChatClient is the v0.1 OpenRouter client (POST
// {baseUrl}/v1/chat/completions with OPENROUTER_API_KEY); the harness picks a
// client per step with createChatClientFor (src/providers).

import { ModelError } from '../classify/index.js';
import type { Config } from '../config.js';
import { createOpenRouterClient } from '../providers/index.js';
import type { ChatClient } from '../schema.js';

/** The OpenRouter client, sending req.model as is. Other providers: createChatClientFor in src/providers. */
export function createChatClient(cfg: Config): ChatClient {
  return createOpenRouterClient(cfg);
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
