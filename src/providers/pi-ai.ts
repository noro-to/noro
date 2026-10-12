// Writers on @earendil-works/pi-ai: anthropic, openai, google, bedrock,
// vertex (Gemini), azure (OpenAI), mistral, deepseek, groq.
//
// pi-ai always streams, reports failures as stopReason 'error' (it does not
// throw), and defaults to max_tokens 128000 with thinking on. So every call
// sets maxTokens, asks for the lowest reasoning level the model allows (off
// where it can be turned off; Claude Opus 5.5 can't, so its lowest effort),
// never sends temperature, drops thinking blocks, and turns 'error' /
// 'aborted' / 'length' into a ModelError. Rate and plan limits become
// UsageLimitError ("usage limit reached; rerun later").

import type { Api, AssistantMessage, Model, MutableModels, Provider } from '@earendil-works/pi-ai';
import { clampThinkingLevel, createModels } from '@earendil-works/pi-ai/models';
import { ModelError } from '../classify/index.js';
import type { ChatClient } from '../schema.js';
import { UsageLimitError, looksLikeUsageLimit } from './errors.js';
import { JSON_SUFFIX } from './openai-chat.js';
import { getProvider, redact } from './registry.js';

export type PiProviderId = 'anthropic' | 'openai' | 'google' | 'google-vertex' | 'amazon-bedrock' | 'azure' | 'mistral' | 'deepseek' | 'groq';

/** noro provider id → pi-ai provider id. */
export const PI_PROVIDER: Record<string, PiProviderId> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  vertex: 'google-vertex',
  bedrock: 'amazon-bedrock',
  azure: 'azure',
  mistral: 'mistral',
  deepseek: 'deepseek',
  groq: 'groq',
};

/** Load one provider factory on demand (each pulls in its SDK lazily). */
const LOADERS: Record<PiProviderId, () => Promise<Provider>> = {
  anthropic: async () => (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider() as unknown as Provider,
  openai: async () => (await import('@earendil-works/pi-ai/providers/openai')).openaiProvider() as unknown as Provider,
  google: async () => (await import('@earendil-works/pi-ai/providers/google')).googleProvider() as unknown as Provider,
  'google-vertex': async () => (await import('@earendil-works/pi-ai/providers/google-vertex')).googleVertexProvider() as unknown as Provider,
  'amazon-bedrock': async () => (await import('@earendil-works/pi-ai/providers/amazon-bedrock')).amazonBedrockProvider() as unknown as Provider,
  azure: async () => (await import('@earendil-works/pi-ai/providers/azure')).azureProvider() as unknown as Provider,
  mistral: async () => (await import('@earendil-works/pi-ai/providers/mistral')).mistralProvider() as unknown as Provider,
  deepseek: async () => (await import('@earendil-works/pi-ai/providers/deepseek')).deepseekProvider() as unknown as Provider,
  groq: async () => (await import('@earendil-works/pi-ai/providers/groq')).groqProvider() as unknown as Provider,
};

/** The env var that holds the API key, passed explicitly so pi-ai never picks up another source. */
const API_KEY_ENV: Partial<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
};

/** Output cap per call. noro's longest answer (a revise JSON) is far below it; thinking, where it can't be off, fits too. */
export const MAX_TOKENS = 16_384;

export interface PiAiDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Tests: a Models collection with a faux provider registered under the pi-ai id. */
  models?: MutableModels;
  maxRetries?: number;
  timeoutMs?: number;
}

/** The lowest reasoning level the model accepts: undefined (off) where it can be turned off. */
export function lowestReasoning(model: Model<Api>): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!model.reasoning) return undefined;
  const level = clampThinkingLevel(model, 'off');
  return level === 'off' ? undefined : level;
}

function findModel(models: MutableModels, piId: string, id: string): Model<Api> | undefined {
  const exact = models.getModel(piId, id);
  if (exact) return exact;
  // pi-ai's catalog is pinned; a newer id gets a sibling's API settings with the id swapped.
  const sibling = models.getModels(piId)[0];
  return sibling ? { ...sibling, id, name: id } : undefined;
}

function envRecord(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = env[n];
    if (typeof v === 'string' && v !== '') out[n] = v;
  }
  return out;
}

/** Rewrite a top-level Anthropic `output_config.effort` to the requested level; other payloads unchanged. */
export function effortPayload(payload: unknown, level: string | undefined): unknown {
  const p = payload as { output_config?: { effort?: unknown } } | null;
  if (!level || !p || typeof p !== 'object' || !p.output_config || typeof p.output_config.effort !== 'string') return undefined;
  return { ...p, output_config: { ...p.output_config, effort: level === 'minimal' ? 'low' : level } };
}

export function textOf(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function createPiAiClient(provider: string, modelId: string, deps: PiAiDeps = {}): ChatClient {
  const piId = PI_PROVIDER[provider];
  if (!piId) throw new Error(`no pi-ai provider for ${provider}`);
  const info = getProvider(provider)!;
  let ready: Promise<MutableModels> | undefined;
  const load = () =>
    (ready ??= (async () => {
      if (deps.models) return deps.models;
      const models = createModels();
      models.setProvider(await LOADERS[piId]());
      return models;
    })());

  return {
    async complete(req) {
      const env = deps.env ?? process.env;
      const what = `${provider} (${modelId})`;
      const keyEnv = API_KEY_ENV[provider];
      const apiKey = keyEnv ? env[keyEnv] : undefined;
      if (keyEnv && !apiKey) throw new ModelError(`NORO_MODEL uses ${info.label}; set ${keyEnv}. See ${info.docs}.`);
      const models = await load();
      const model = findModel(models, piId, modelId);
      if (!model) throw new ModelError(`${what}: pi-ai has no ${piId} models`);
      const user = req.json ? `${req.user}${JSON_SUFFIX}` : req.user;
      const reasoning = lowestReasoning(model);
      const msg = await models.completeSimple(
        model,
        { systemPrompt: req.system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] },
        {
          maxTokens: Math.min(MAX_TOKENS, model.maxTokens || MAX_TOKENS),
          reasoning,
          // pi-ai sends a top-level effort of "high" on Claude models whose thinking can't be turned
          // off, whatever the reasoning option says. Keep it at the level asked for.
          onPayload: (payload: unknown) => effortPayload(payload, reasoning),
          timeoutMs: deps.timeoutMs ?? 300_000,
          maxRetries: deps.maxRetries ?? 2,
          ...(apiKey ? { apiKey } : {}),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          env: envRecord(env, info.envKeys.concat(provider === 'bedrock' ? ['AWS_DEFAULT_REGION'] : [], provider === 'vertex' ? ['GCLOUD_PROJECT'] : [])),
        },
      );
      const secrets = info.secretEnv ?? [];
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
        const why = redact(msg.errorMessage ?? msg.stopReason, env, secrets);
        if (looksLikeUsageLimit(why)) throw new UsageLimitError(provider, why);
        throw new ModelError(`${what}: ${why.slice(0, 400)}`);
      }
      if (msg.stopReason === 'length') throw new ModelError(`${what}: the answer was cut off at ${MAX_TOKENS} tokens`);
      const text = textOf(msg);
      if (!text.trim()) throw new ModelError(`${what}: the answer had no text`);
      return text;
    },
  };
}
