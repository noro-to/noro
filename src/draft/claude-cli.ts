// The "claude-cli" writer: runs the writing steps (draft, panel, revise) through
// the user's own locally installed, logged-in Claude Code (`claude -p`), on their
// own Claude subscription. noro never reads, stores or passes a Claude credential:
// it only starts the unmodified `claude` binary, which signs in through
// Anthropic's own flow. Meant for personal use on your own machine; see the README.
//
// Each call is one completion: no tools, no customizations (--safe-mode), no
// saved session.

import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type { ChatClient } from '../schema.js';
import { ModelError } from '../classify/index.js';
import { UsageLimitError, looksLikeUsageLimit } from '../providers/errors.js';
import { claudeModelId } from '../providers/registry.js';

export { claudeModelId } from '../providers/registry.js';

/**
 * Environment variables that would make `claude` bill something other than the
 * user's subscription (an API key, a cloud provider, another endpoint). They are
 * removed from the child's environment.
 */
export const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/** `claude auth status` methods that mean the user's own Claude subscription. */
const SUBSCRIPTION_METHODS = new Set(['claude.ai', 'oauth_token']);

export class ClaudeCliError extends ModelError {}

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of STRIPPED_ENV) delete out[k];
  return out;
}

function run(bin: string, args: string[], stdin: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'ENOENT'
          ? new ClaudeCliError(`NORO_MODEL=claude-cli needs Claude Code installed and logged in, but "${bin}" wasn't found. Install it from https://claude.com/claude-code, run \`claude\` once to log in, or set NORO_CLAUDE_BIN.`)
          : err,
      ),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** Refuse to run unless `claude` is logged in to a Claude subscription (not an API key). */
export async function checkClaudeAuth(cfg: Pick<Config, 'claudeBin'>, env = childEnv()): Promise<void> {
  const r = await run(cfg.claudeBin, ['auth', 'status', '--json'], '', env);
  let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string } = {};
  try {
    status = JSON.parse(r.stdout);
  } catch {
    throw new ClaudeCliError(`\`${cfg.claudeBin} auth status\` didn't return JSON (exit ${r.code}). Is Claude Code up to date?`);
  }
  if (!status.loggedIn) {
    throw new ClaudeCliError('Claude Code is not logged in. Run `claude` once and log in with your Claude account, then try again.');
  }
  if (!SUBSCRIPTION_METHODS.has(status.authMethod ?? '') || (status.apiProvider && status.apiProvider !== 'firstParty')) {
    throw new ClaudeCliError(
      `Claude Code is signed in with "${status.authMethod}" (${status.apiProvider ?? 'unknown provider'}), not a Claude subscription. ` +
        'Log in with your Claude account (`claude auth login`), or use an API provider (NORO_MODEL=openrouter:anthropic/claude-opus-5.5).',
    );
  }
}

/**
 * `model` (a Claude Code id) wins over req.model when given. req.maxTokens is
 * ignored: `claude -p` has no output-token flag, and the plan, not a key, pays.
 */
export function createClaudeCliClient(cfg: Config, model?: string): ChatClient {
  const env = childEnv();
  let checked: Promise<void> | undefined;
  return {
    async complete(req) {
      checked ??= checkClaudeAuth(cfg, env);
      await checked;
      const id = claudeModelId((model ?? req.model).replace(/^claude-cli:/, ''));
      const args = [
        '-p',
        '--model', id,
        '--output-format', 'json',
        '--system-prompt', req.system,
        '--tools', '',
        '--safe-mode',
        '--no-session-persistence',
      ];
      const user = req.json ? `${req.user}\n\nReply with only the JSON object, no other text.` : req.user;
      const r = await run(cfg.claudeBin, args, user, env);
      let out: { result?: unknown; is_error?: boolean; subtype?: string } | undefined;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        throw new ClaudeCliError(`claude -p (${id}) exited ${r.code} without JSON output: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      }
      if (r.code !== 0 || out?.is_error || typeof out?.result !== 'string') {
        const why = typeof out?.result === 'string' ? out.result : out?.subtype ?? r.stderr.trim();
        if (looksLikeUsageLimit(String(why))) throw new UsageLimitError('claude-cli', String(why).slice(0, 300));
        throw new ClaudeCliError(`claude -p (${id}) failed: ${String(why).slice(0, 300)}`);
      }
      return out.result;
    },
  };
}
