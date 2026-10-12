// Runtime config from the environment. The writing steps (draft, panel,
// revise) use NORO_MODEL=<provider>:<model-id>; classify is configured
// separately (NORO_CLASSIFY*, see docs/install/classify.md).
//
// Writing model, first wins:
//   1. overrides.model (the --model flag): replaces all three below for the run
//   2. NORO_DRAFT_MODEL (draft + revise) / NORO_PANEL_MODEL (panel)
//   3. NORO_MODEL
//   4. NORO_WRITER=claude-cli, kept as an alias for NORO_MODEL=claude-cli:claude-opus-5-5
//   5. openrouter:anthropic/claude-opus-5.5
// A value with no provider prefix is an OpenRouter id, except when the base
// writer is claude-cli (NORO_WRITER=claude-cli or NORO_MODEL=claude-cli:...),
// where a bare NORO_DRAFT_MODEL / NORO_PANEL_MODEL keeps its v0.1 meaning (that
// model, through Claude Code).

import { DEFAULT_MODEL_REF, getProvider, parseModelRef, unknownProvider } from './providers/registry.js';

export const DEFAULT_WRITING_MODEL = 'anthropic/claude-opus-5.5';
export const DEFAULT_CLASSIFY_MODEL = 'typesafe/jev-1.13';
export { DEFAULT_MODEL_REF };

/** The provider of the draft model. Kept for v0.1 callers ("openrouter" | "claude-cli" | any provider id). */
export type Writer = string;

export interface Config {
  /** OPENROUTER_API_KEY: the openrouter writer, and jev on OpenRouter. */
  apiKey: string | undefined;
  /** The draft model's provider (derived; v0.1 back-compat). */
  writer: Writer;
  /** `claude` binary for claude-cli (NORO_CLAUDE_BIN). */
  claudeBin: string;
  /** `codex` binary for codex-cli (NORO_CODEX_BIN). */
  codexBin: string;
  /** OpenRouter base URL (OPENROUTER_BASE_URL). */
  baseUrl: string;
  /** NORO_BASE_URL: openai-compatible's server; overrides the ollama / lmstudio defaults. */
  noroBaseUrl: string | undefined;
  /** NORO_API_KEY: optional key for that server. */
  noroApiKey: string | undefined;
  /** `<provider>:<model-id>` for draft and revise. */
  draftModel: string;
  /** `<provider>:<model-id>` for the panel. */
  panelModel: string;
  /** NORO_CLASSIFY_MODEL; undefined when unset (the classify host picks its default). */
  classifyModel: string | undefined;
  /** NORO_CLASSIFY: jev | rules | writer; undefined = pick from what's configured. */
  classify: string | undefined;
  /** NORO_CLASSIFY_BASE_URL. */
  classifyBaseUrl: string | undefined;
  /** TYPESAFE_API_KEY. */
  typesafeKey: string | undefined;
  python: string;
  stateDir: string;
}

const nonEmpty = (v: string | undefined) => (v !== undefined && v.trim() !== '' ? v.trim() : undefined);

/** "provider:id" for a setting, with bare ids read as `bareProvider`. */
function refFrom(value: string, setting: string, bareProvider?: string): string {
  if (bareProvider && !value.includes(':')) return `${bareProvider}:${value}`;
  const r = parseModelRef(value, setting);
  return `${r.provider}:${r.id}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: { model?: string } = {}): Config {
  let base = DEFAULT_MODEL_REF;
  const writerAlias = nonEmpty(env.NORO_WRITER);
  if (writerAlias) {
    const info = getProvider(writerAlias.toLowerCase());
    if (!info) throw unknownProvider(writerAlias, 'NORO_WRITER');
    base = `${info.id}:${info.defaultModel}`;
  }
  const model = nonEmpty(env.NORO_MODEL);
  if (model) base = refFrom(model, 'NORO_MODEL');
  base = refFrom(base, 'NORO_MODEL');
  // A v0.1 .env may still carry NORO_DRAFT_MODEL=anthropic/claude-opus-5.5 next to a claude-cli
  // writer: that bare id kept meaning "through Claude Code", so it still does.
  const bareProvider = parseModelRef(base).provider === 'claude-cli' ? 'claude-cli' : undefined;

  const flag = nonEmpty(overrides.model);
  let draftModel: string;
  let panelModel: string;
  if (flag) {
    draftModel = panelModel = refFrom(flag, '--model');
  } else {
    const d = nonEmpty(env.NORO_DRAFT_MODEL);
    const p = nonEmpty(env.NORO_PANEL_MODEL);
    draftModel = d ? refFrom(d, 'NORO_DRAFT_MODEL', bareProvider) : base;
    panelModel = p ? refFrom(p, 'NORO_PANEL_MODEL', bareProvider) : base;
  }

  return {
    apiKey: nonEmpty(env.OPENROUTER_API_KEY),
    writer: parseModelRef(draftModel).provider,
    claudeBin: nonEmpty(env.NORO_CLAUDE_BIN) ?? 'claude',
    codexBin: nonEmpty(env.NORO_CODEX_BIN) ?? 'codex',
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api',
    noroBaseUrl: nonEmpty(env.NORO_BASE_URL),
    noroApiKey: nonEmpty(env.NORO_API_KEY),
    draftModel,
    panelModel,
    classifyModel: nonEmpty(env.NORO_CLASSIFY_MODEL),
    classify: nonEmpty(env.NORO_CLASSIFY)?.toLowerCase(),
    classifyBaseUrl: nonEmpty(env.NORO_CLASSIFY_BASE_URL),
    typesafeKey: nonEmpty(env.TYPESAFE_API_KEY),
    python: nonEmpty(env.NORO_PYTHON) ?? 'python3',
    stateDir: nonEmpty(env.NORO_STATE_DIR) ?? '.noro',
  };
}
