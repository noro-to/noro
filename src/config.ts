// Runtime config from the environment. Every step that writes uses the writing
// model; classify uses jev. All three are overridable in .env.
export const DEFAULT_WRITING_MODEL = 'anthropic/claude-opus-5.5';
export const DEFAULT_CLASSIFY_MODEL = 'typesafe/jev-1.13';

/**
 * Who runs the writing steps (draft, panel, revise).
 * - "openrouter" (default): pay per token through OpenRouter with OPENROUTER_API_KEY.
 * - "claude-cli": your own locally installed, logged-in `claude` (Claude Code) on your
 *   own Claude subscription, for your personal use. noro never sees your Claude login.
 * Classify (jev) always goes through OpenRouter.
 */
export type Writer = 'openrouter' | 'claude-cli';

export interface Config {
  apiKey: string | undefined;
  writer: Writer;
  /** The `claude` binary for writer "claude-cli". */
  claudeBin: string;
  baseUrl: string;
  draftModel: string;
  panelModel: string;
  classifyModel: string;
  python: string;
  stateDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const writer = env.NORO_WRITER || 'openrouter';
  if (writer !== 'openrouter' && writer !== 'claude-cli') {
    throw new Error(`NORO_WRITER must be "openrouter" or "claude-cli", not "${writer}"`);
  }
  return {
    apiKey: env.OPENROUTER_API_KEY,
    writer,
    claudeBin: env.NORO_CLAUDE_BIN || 'claude',
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api',
    draftModel: env.NORO_DRAFT_MODEL || DEFAULT_WRITING_MODEL,
    panelModel: env.NORO_PANEL_MODEL || DEFAULT_WRITING_MODEL,
    classifyModel: env.NORO_CLASSIFY_MODEL || DEFAULT_CLASSIFY_MODEL,
    python: env.NORO_PYTHON || 'python3',
    stateDir: env.NORO_STATE_DIR || '.noro',
  };
}
