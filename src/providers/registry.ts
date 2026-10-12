// The provider registry: which writing providers exist, what they read from
// the environment, and how a `<provider>:<model-id>` string is parsed. Pure
// data and string handling, no clients, so config.ts can import it cheaply.
//
// Model refs: NORO_MODEL=<provider>:<model-id>, split on the FIRST colon, so
// ids with colons (Bedrock `...-v1:0`, Ollama `qwen3.8:27b`) work. A value with
// no known provider prefix is an OpenRouter id, so older .env files
// (NORO_DRAFT_MODEL=anthropic/claude-opus-5.5) keep working.

export type ProviderKind = 'api' | 'cloud' | 'local' | 'subscription' | 'compatible';

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Environment variables this provider reads (credentials and endpoint settings). */
  envKeys: string[];
  /** The model used for `<provider>:` with an empty id, and the docs example. Empty: the user must name one. */
  defaultModel: string;
  /** Where the docs cover it. */
  docs: string;
  /** The subset of envKeys that hold secrets: show as fingerprints only, redact from errors. */
  secretEnv?: string[];
}

const doc = (anchor: string, page = 'providers') => `docs/install/${page}.md#${anchor}`;

export const PROVIDERS: ProviderInfo[] = [
  { id: 'openrouter', label: 'OpenRouter', kind: 'api', envKeys: ['OPENROUTER_API_KEY'], secretEnv: ['OPENROUTER_API_KEY'], defaultModel: 'anthropic/claude-opus-5.5', docs: doc('openrouter') },
  { id: 'anthropic', label: 'Anthropic API', kind: 'api', envKeys: ['ANTHROPIC_API_KEY'], secretEnv: ['ANTHROPIC_API_KEY'], defaultModel: 'claude-opus-5-5', docs: doc('anthropic') },
  { id: 'openai', label: 'OpenAI API', kind: 'api', envKeys: ['OPENAI_API_KEY'], secretEnv: ['OPENAI_API_KEY'], defaultModel: 'gpt-6.1-sol', docs: doc('openai') },
  { id: 'google', label: 'Gemini API', kind: 'api', envKeys: ['GEMINI_API_KEY'], secretEnv: ['GEMINI_API_KEY'], defaultModel: 'gemini-3.1-pro-preview', docs: doc('google') },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    kind: 'cloud',
    envKeys: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
    secretEnv: ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'],
    defaultModel: 'global.anthropic.claude-opus-5-5',
    docs: doc('bedrock'),
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI (Gemini)',
    kind: 'cloud',
    envKeys: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    secretEnv: ['GOOGLE_CLOUD_API_KEY'],
    defaultModel: 'gemini-3.1-pro-preview',
    docs: doc('vertex'),
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    kind: 'cloud',
    envKeys: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP'],
    secretEnv: ['AZURE_OPENAI_API_KEY'],
    defaultModel: 'gpt-6.1-sol',
    docs: doc('azure'),
  },
  { id: 'mistral', label: 'Mistral API', kind: 'api', envKeys: ['MISTRAL_API_KEY'], secretEnv: ['MISTRAL_API_KEY'], defaultModel: 'mistral-large-4', docs: doc('mistral') },
  { id: 'deepseek', label: 'DeepSeek API', kind: 'api', envKeys: ['DEEPSEEK_API_KEY'], secretEnv: ['DEEPSEEK_API_KEY'], defaultModel: 'deepseek-v4-pro', docs: doc('deepseek') },
  { id: 'groq', label: 'Groq', kind: 'api', envKeys: ['GROQ_API_KEY'], secretEnv: ['GROQ_API_KEY'], defaultModel: 'openai/gpt-oss-120b', docs: doc('groq') },
  { id: 'openai-compatible', label: 'OpenAI-compatible server', kind: 'compatible', envKeys: ['NORO_BASE_URL', 'NORO_API_KEY'], secretEnv: ['NORO_API_KEY'], defaultModel: '', docs: doc('openai-compatible') },
  { id: 'ollama', label: 'Ollama', kind: 'local', envKeys: ['NORO_BASE_URL'], defaultModel: 'qwen3.8:27b', docs: doc('ollama', 'local') },
  { id: 'lmstudio', label: 'LM Studio', kind: 'local', envKeys: ['NORO_BASE_URL', 'NORO_API_KEY'], secretEnv: ['NORO_API_KEY'], defaultModel: 'qwen3.8-27b', docs: doc('lm-studio', 'local') },
  { id: 'claude-cli', label: 'Claude Code (your Claude plan)', kind: 'subscription', envKeys: ['NORO_CLAUDE_BIN'], defaultModel: 'claude-opus-5-5', docs: doc('claude-cli', 'subscriptions') },
  { id: 'codex-cli', label: 'Codex CLI (your ChatGPT plan)', kind: 'subscription', envKeys: ['NORO_CODEX_BIN'], defaultModel: 'default', docs: doc('codex-cli', 'subscriptions') },
];

export const DEFAULT_PROVIDER = 'openrouter';
/** NORO_MODEL's default. */
export const DEFAULT_MODEL_REF = 'openrouter:anthropic/claude-opus-5.5';

/** A setting noro can't use: an unknown provider, a model the provider can't run, a missing credential. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ModelRef {
  provider: string;
  id: string;
}

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** "anthropc" → ` Did you mean "anthropic"?`, or '' when nothing is close. */
export function didYouMean(name: string): string {
  let best: string | undefined;
  let score = Infinity;
  for (const p of PROVIDERS) {
    const s = editDistance(name.toLowerCase(), p.id);
    if (s < score) {
      score = s;
      best = p.id;
    }
  }
  return best && score <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean "${best}"?` : '';
}

export function unknownProvider(name: string, setting = 'NORO_MODEL'): ConfigError {
  return new ConfigError(`${setting}: "${name}" is not a provider.${didYouMean(name)} Providers: ${PROVIDERS.map((p) => p.id).join(', ')}.`);
}

/**
 * Split `<provider>:<model-id>` on the first colon. No colon, or a prefix that
 * looks like an OpenRouter vendor path (contains "/"), means openrouter. An
 * unknown provider prefix is a ConfigError. An empty id means the provider's
 * default model.
 */
export function parseModelRef(s: string, setting = 'NORO_MODEL'): ModelRef {
  const value = s.trim();
  if (!value) throw new ConfigError(`${setting} is empty. Use <provider>:<model-id>, e.g. ${DEFAULT_MODEL_REF}.`);
  const at = value.indexOf(':');
  if (at < 0) {
    // A bare provider name ("claude-cli", "codex-cli", "anthropic") means that provider's default model.
    const bare = getProvider(value.toLowerCase());
    if (bare) {
      if (!bare.defaultModel) throw new ConfigError(`${setting}=${value}: ${bare.label} needs a model id, e.g. ${bare.id}:my-model.`);
      return { provider: bare.id, id: bare.defaultModel };
    }
    return { provider: DEFAULT_PROVIDER, id: value };
  }
  const prefix = value.slice(0, at).trim();
  const rest = value.slice(at + 1).trim();
  const info = getProvider(prefix.toLowerCase());
  if (!info) {
    // "deepseek/deepseek-r1:free" is an OpenRouter id with a variant suffix, not a provider.
    if (prefix.includes('/')) return { provider: DEFAULT_PROVIDER, id: value };
    throw unknownProvider(prefix, setting);
  }
  const id = rest || info.defaultModel;
  if (!id) throw new ConfigError(`${setting}=${value}: ${info.label} needs a model id, e.g. ${info.id}:my-model.`);
  return { provider: info.id, id };
}

export function formatModelRef(r: ModelRef): string {
  return `${r.provider}:${r.id}`;
}

// ---------------------------------------------------------------- model ids

/** "anthropic/claude-opus-5.5" (OpenRouter style) → "claude-opus-5-5" (Anthropic API / Claude Code style). */
export function claudeModelId(model: string): string {
  return model.replace(/^anthropic\//, '').replace(/\./g, '-');
}

function stripVendor(provider: string, id: string, own: string[]): string {
  const slash = id.indexOf('/');
  if (slash < 0) return id;
  const vendor = id.slice(0, slash);
  if (own.includes(vendor)) return id.slice(slash + 1);
  throw new ConfigError(
    `${provider}:${id} names a ${vendor} model, which the ${getProvider(provider)?.label ?? provider} provider can't run. Use one of its own model ids (e.g. ${provider}:${getProvider(provider)?.defaultModel}), or openrouter:${id}.`,
  );
}

/**
 * The provider's native id for a model id the user wrote. OpenRouter-style
 * ids are accepted where the mapping is unambiguous ("anthropic/claude-opus-5.5"
 * on anthropic, claude-cli or bedrock); a bare id is passed through.
 */
export function normalizeModelId(provider: string, id: string): string {
  switch (provider) {
    case 'anthropic':
    case 'claude-cli': {
      const bare = stripVendor(provider, id, ['anthropic']);
      return /^claude-/.test(bare) ? claudeModelId(bare) : bare;
    }
    case 'bedrock':
      if (id.startsWith('anthropic/')) return `global.anthropic.${claudeModelId(id)}`;
      return id;
    case 'vertex':
      if (id.startsWith('anthropic/') || /^claude-/.test(id)) {
        throw new ConfigError(`vertex:${id}: the vertex provider runs Gemini models only in v0.2. For Claude on a cloud account, use bedrock:global.anthropic.claude-opus-5-5.`);
      }
      return stripVendor(provider, id, ['google']);
    case 'google':
      return stripVendor(provider, id, ['google']);
    case 'openai':
    case 'azure':
      return stripVendor(provider, id, ['openai']);
    case 'codex-cli':
      return id === '' ? 'default' : stripVendor(provider, id, ['openai']);
    case 'mistral':
      return stripVendor(provider, id, ['mistralai', 'mistral']);
    case 'deepseek':
      return stripVendor(provider, id, ['deepseek']);
    default:
      // openrouter, groq (its ids carry a vendor path), openai-compatible, ollama, lmstudio.
      return id;
  }
}

/** Parse and normalize in one step. */
export function resolveModelRef(ref: string | ModelRef, setting = 'NORO_MODEL'): ModelRef {
  const r = typeof ref === 'string' ? parseModelRef(ref, setting) : ref;
  if (!getProvider(r.provider)) throw unknownProvider(r.provider, setting);
  return { provider: r.provider, id: normalizeModelId(r.provider, r.id) };
}

// ---------------------------------------------------------------- credentials

const has = (env: NodeJS.ProcessEnv, k: string) => typeof env[k] === 'string' && env[k]!.trim() !== '';

/**
 * Env var names still needed before this provider can make a call. An entry
 * with " or " means any one of those. Ambient credentials noro can't see from
 * the environment (an AWS instance role, gcloud ADC files) are not reported,
 * so an empty list for bedrock/vertex means "found (not verified)". Local
 * servers and the subscription CLIs need no env.
 */
export function missingCredentials(ref: string | ModelRef, env: NodeJS.ProcessEnv): string[] {
  const { provider } = typeof ref === 'string' ? parseModelRef(ref) : ref;
  const missing: string[] = [];
  switch (provider) {
    case 'openrouter':
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'mistral':
    case 'deepseek':
    case 'groq': {
      const key = getProvider(provider)!.envKeys[0];
      if (!has(env, key)) missing.push(key);
      break;
    }
    case 'bedrock': {
      const creds =
        has(env, 'AWS_PROFILE') ||
        (has(env, 'AWS_ACCESS_KEY_ID') && has(env, 'AWS_SECRET_ACCESS_KEY')) ||
        has(env, 'AWS_BEARER_TOKEN_BEDROCK') ||
        has(env, 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI') ||
        has(env, 'AWS_CONTAINER_CREDENTIALS_FULL_URI') ||
        has(env, 'AWS_WEB_IDENTITY_TOKEN_FILE');
      if (!creds) missing.push('AWS_PROFILE or AWS_ACCESS_KEY_ID or AWS_BEARER_TOKEN_BEDROCK');
      if (!has(env, 'AWS_REGION') && !has(env, 'AWS_DEFAULT_REGION')) missing.push('AWS_REGION');
      break;
    }
    case 'vertex':
      if (has(env, 'GOOGLE_CLOUD_API_KEY')) break;
      if (!has(env, 'GOOGLE_CLOUD_PROJECT') && !has(env, 'GCLOUD_PROJECT')) missing.push('GOOGLE_CLOUD_PROJECT');
      if (!has(env, 'GOOGLE_CLOUD_LOCATION')) missing.push('GOOGLE_CLOUD_LOCATION');
      break;
    case 'azure':
      if (!has(env, 'AZURE_OPENAI_API_KEY')) missing.push('AZURE_OPENAI_API_KEY');
      if (!has(env, 'AZURE_OPENAI_RESOURCE_NAME') && !has(env, 'AZURE_OPENAI_BASE_URL')) missing.push('AZURE_OPENAI_RESOURCE_NAME or AZURE_OPENAI_BASE_URL');
      break;
    case 'openai-compatible':
      if (!has(env, 'NORO_BASE_URL')) missing.push('NORO_BASE_URL');
      break;
    default:
      break; // ollama, lmstudio, claude-cli, codex-cli
  }
  return missing;
}

/** Replace any secret value from these env vars in a message (errors may echo request details). */
export function redact(message: string, env: NodeJS.ProcessEnv, names: string[]): string {
  let out = message;
  for (const n of names) {
    const v = env[n];
    if (v && v.length >= 6) out = out.split(v).join('[redacted]');
  }
  return out;
}

/** Every secret env name any provider reads (for redaction). */
export const ALL_SECRET_ENV = [...new Set(PROVIDERS.flatMap((p) => p.secretEnv ?? []))];
