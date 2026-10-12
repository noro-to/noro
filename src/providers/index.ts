// Writing providers: one ChatClient per `<provider>:<model-id>`.
//
//   openrouter, openai-compatible, ollama, lmstudio → noro's own fetch client (openai-chat.ts)
//   anthropic, openai, google, bedrock, vertex, azure, mistral, deepseek, groq → pi-ai (pi-ai.ts)
//   claude-cli, codex-cli → the user's own logged-in vendor CLI (src/draft/*-cli.ts)
//
// Clients only forward ChatRequest.system and .user; they add no content, and
// never send temperature or other sampling parameters. Creating a client never
// fails for a missing credential: that surfaces on the first call, so a rerun
// that needs no model call (resume past the writing steps, --decisions) works
// without one.

import type { Config } from '../config.js';
import { MissingApiKeyError } from '../classify/index.js';
import { createClaudeCliClient } from '../draft/claude-cli.js';
import { createCodexCliClient } from '../draft/codex-cli.js';
import type { ChatClient } from '../schema.js';
import { createOpenAIChatClient } from './openai-chat.js';
import { PI_PROVIDER, createPiAiClient } from './pi-ai.js';
import type { PiAiDeps } from './pi-ai.js';
import { ConfigError, resolveModelRef } from './registry.js';
import type { ModelRef } from './registry.js';

export {
  ALL_SECRET_ENV,
  ConfigError,
  DEFAULT_MODEL_REF,
  PROVIDERS,
  claudeModelId,
  didYouMean,
  formatModelRef,
  getProvider,
  missingCredentials,
  normalizeModelId,
  parseModelRef,
  redact,
  resolveModelRef,
} from './registry.js';
export type { ModelRef, ProviderInfo, ProviderKind } from './registry.js';
export { USAGE_LIMIT_MESSAGE, UsageLimitError } from './errors.js';

export const OLLAMA_BASE_URL = 'http://localhost:11434';
export const LMSTUDIO_BASE_URL = 'http://localhost:1234';

/** Everything a test may swap. Production passes nothing. */
export type ProviderDeps = PiAiDeps;

const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/noro-to/noro', 'X-Title': 'noro' };

/** The OpenRouter writer (the v0.1 client): POST {baseUrl}/v1/chat/completions with OPENROUTER_API_KEY. */
export function createOpenRouterClient(cfg: Pick<Config, 'apiKey' | 'baseUrl'>, model?: string, deps: ProviderDeps = {}): ChatClient {
  return createOpenAIChatClient({
    provider: 'openrouter',
    baseUrl: cfg.baseUrl,
    apiKey: () => cfg.apiKey,
    missingKey: () => new MissingApiKeyError(),
    model,
    jsonMode: 'response_format',
    headers: OPENROUTER_HEADERS,
    fetch: deps.fetch,
  });
}

/** The native id a client for this ref sends (what the harness puts in ChatRequest.model). */
export function nativeModelId(ref: string | ModelRef): string {
  return resolveModelRef(ref).id;
}

/**
 * A ChatClient for one `<provider>:<model-id>` (or a parsed ref). Throws
 * ConfigError only for a ref it can't parse or a model the provider can't run.
 */
export function createChatClientFor(ref: string | ModelRef, config: Config, deps: ProviderDeps = {}): ChatClient {
  const { provider, id } = resolveModelRef(ref);
  const env = deps.env ?? process.env;
  switch (provider) {
    case 'openrouter':
      return createOpenRouterClient(config, id, deps);
    case 'openai-compatible':
      if (!config.noroBaseUrl) {
        return {
          async complete() {
            throw new ConfigError('NORO_MODEL uses openai-compatible; set NORO_BASE_URL to your server (with or without /v1). See docs/install/providers.md#openai-compatible.');
          },
        };
      }
      return createOpenAIChatClient({
        provider,
        baseUrl: config.noroBaseUrl,
        apiKey: () => config.noroApiKey,
        model: id,
        jsonMode: 'prompt',
        timeoutMs: 600_000,
        fetch: deps.fetch,
      });
    case 'ollama':
      return createOpenAIChatClient({
        provider,
        baseUrl: config.noroBaseUrl ?? OLLAMA_BASE_URL,
        apiKey: () => config.noroApiKey,
        model: id,
        jsonMode: 'response_format',
        // Thinking models would put their reasoning in the answer: ask Ollama to turn it off.
        extraBody: { reasoning_effort: 'none' },
        timeoutMs: 600_000,
        fetch: deps.fetch,
      });
    case 'lmstudio':
      return createOpenAIChatClient({
        provider,
        baseUrl: config.noroBaseUrl ?? LMSTUDIO_BASE_URL,
        apiKey: () => config.noroApiKey,
        model: id,
        jsonMode: 'prompt', // LM Studio documents json_schema only; json_object is reportedly rejected
        extraBody: { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } },
        timeoutMs: 600_000,
        fetch: deps.fetch,
      });
    case 'claude-cli':
      return createClaudeCliClient(config, id);
    case 'codex-cli':
      return createCodexCliClient(config, id);
    default:
      if (PI_PROVIDER[provider]) return createPiAiClient(provider, id, { ...deps, env });
      throw new ConfigError(`No writer for provider "${provider}".`);
  }
}
