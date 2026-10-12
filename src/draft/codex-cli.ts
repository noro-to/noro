// The "codex-cli" writer: runs the writing steps through the user's own
// installed, logged-in OpenAI Codex CLI (`codex exec`), on their own ChatGPT
// plan. noro never reads, stores or passes a Codex or ChatGPT credential: it
// only starts the unmodified `codex` binary. Personal use on your own machine;
// see docs/install/subscriptions.md.
//
// Each call is one completion: `codex exec` in a read-only sandbox, in an empty
// temporary folder, with the shell tool and web search off, the user's Codex
// config and rules ignored and no session files saved. The system prompt
// replaces Codex's built-in instructions (model_instructions_file); the user
// prompt goes on stdin; the final message is read from -o <file>.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelError } from '../classify/index.js';
import type { Config } from '../config.js';
import { UsageLimitError, looksLikeUsageLimit } from '../providers/errors.js';
import type { ChatClient } from '../schema.js';

/** Variables that would make `codex` bill an API account instead of the user's ChatGPT plan. */
export const CODEX_STRIPPED_ENV = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'AZURE_OPENAI_API_KEY',
];

export class CodexCliError extends ModelError {}

export function codexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of CODEX_STRIPPED_ENV) delete out[k];
  return out;
}

/** "codex-cli:default" (or an empty id) means Codex's own default model: no --model flag. */
export function codexModelArg(model: string): string[] {
  const id = model.replace(/^codex-cli:/, '').replace(/^openai\//, '').trim();
  return id === '' || id === 'default' ? [] : ['--model', id];
}

function run(bin: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'ENOENT'
          ? new CodexCliError(
              `NORO_MODEL=codex-cli needs the Codex CLI installed and logged in, but "${bin}" wasn't found. Install it (https://learn.chatgpt.com/docs/cli/reference), run \`codex login\` and choose "Sign in with ChatGPT", or set NORO_CODEX_BIN.`,
            )
          : err,
      ),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {}); // the child may exit before reading stdin
    child.stdin.end(stdin);
  });
}

/** Refuse to run unless `codex login status` exits 0 with a ChatGPT login (not an API key). */
export async function checkCodexAuth(cfg: Pick<Config, 'codexBin'>, env = codexChildEnv()): Promise<void> {
  const r = await run(cfg.codexBin, ['login', 'status'], '', env);
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    throw new CodexCliError('The Codex CLI is not logged in. Run `codex login` and choose "Sign in with ChatGPT", then try again.');
  }
  if (/api[ _-]?key/i.test(out)) {
    throw new CodexCliError('The Codex CLI is logged in with an API key, not a ChatGPT plan. Run `codex login` and choose "Sign in with ChatGPT", or use NORO_MODEL=openai:<model> for API billing.');
  }
  if (!/chatgpt/i.test(out)) {
    throw new CodexCliError(`\`${cfg.codexBin} login status\` didn't name a ChatGPT login. Run \`codex login\` and choose "Sign in with ChatGPT".`);
  }
}

/** The `codex exec` argv for one completion (exported for tests). */
export function codexExecArgs(model: string, workDir: string, systemFile: string, outFile: string): string[] {
  return [
    'exec',
    ...codexModelArg(model),
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--color', 'never',
    '-C', workDir,
    '-c', `model_instructions_file=${JSON.stringify(systemFile)}`,
    '-c', 'features.shell_tool=false',
    '-c', 'web_search="disabled"',
    '-o', outFile,
    '-',
  ];
}

/** req.maxTokens is ignored: `codex exec` has no output-token flag, and the plan, not a key, pays. */
export function createCodexCliClient(cfg: Config, model?: string): ChatClient {
  const env = codexChildEnv();
  let checked: Promise<void> | undefined;
  return {
    async complete(req) {
      checked ??= checkCodexAuth(cfg, env);
      await checked;
      const id = model ?? req.model;
      const work = mkdtempSync(join(tmpdir(), 'noro-codex-work-')); // stays empty: Codex runs here
      const io = mkdtempSync(join(tmpdir(), 'noro-codex-io-'));
      try {
        const systemFile = join(io, 'system.md');
        const outFile = join(io, 'out.txt');
        writeFileSync(systemFile, req.system);
        const user = req.json ? `${req.user}\n\nReply with only the JSON object, no other text.` : req.user;
        const r = await run(cfg.codexBin, codexExecArgs(id, work, systemFile, outFile), user, env, work);
        let text = '';
        try {
          text = readFileSync(outFile, 'utf8');
        } catch {
          /* no output file */
        }
        if (r.code !== 0 || !text.trim()) {
          const why = (r.stderr || r.stdout).trim();
          if (looksLikeUsageLimit(why)) throw new UsageLimitError('codex-cli', why.slice(0, 300));
          throw new CodexCliError(`codex exec (${id}) ${r.code !== 0 ? `exited ${r.code}` : 'gave no answer'}: ${why.slice(-300)}`);
        }
        return text.trim();
      } finally {
        rmSync(work, { recursive: true, force: true });
        rmSync(io, { recursive: true, force: true });
      }
    },
  };
}
