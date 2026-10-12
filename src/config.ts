// Runtime config from the environment. Every step that writes uses the writing
// model; classify uses jev. All three are overridable in .env.
export const DEFAULT_WRITING_MODEL = 'anthropic/claude-opus-5.5';
export const DEFAULT_CLASSIFY_MODEL = 'typesafe/jev-1.13';

export interface Config {
  apiKey: string | undefined;
  baseUrl: string;
  draftModel: string;
  panelModel: string;
  classifyModel: string;
  python: string;
  stateDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api',
    draftModel: env.NORO_DRAFT_MODEL || DEFAULT_WRITING_MODEL,
    panelModel: env.NORO_PANEL_MODEL || DEFAULT_WRITING_MODEL,
    classifyModel: env.NORO_CLASSIFY_MODEL || DEFAULT_CLASSIFY_MODEL,
    python: env.NORO_PYTHON || 'python3',
    stateDir: env.NORO_STATE_DIR || '.noro',
  };
}
