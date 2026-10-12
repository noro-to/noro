// `noro init [--global]`: the setup wizard.
//
// 1. Detect, all free: keys in the environment and in both .env files, claude
//    and codex on PATH, Ollama on :11434, LM Studio on :1234, AWS and Google
//    Cloud credentials.
// 2. Offer presets. The owner's setup (jev through OpenRouter for classify,
//    your own Claude Code login for writing) is always first, then the
//    detected ones, then the rest. The subscription presets show the
//    personal-use terms and need an explicit y.
// 3. Ask for missing keys with hidden input. Keys are never printed (only a
//    fingerprint of a key already set).
// 4. Write ./.env (or ~/.config/noro/.env with --global): update lines in
//    place, keep comments, save the old file as .env.bak, mode 600. Warn when
//    .gitignore doesn't list .env.
// 5. Run `noro doctor` (free checks only).

import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { formatDoctor, runDoctor } from '../doctor/index.js';
import type { DoctorResult } from '../doctor/index.js';
import { fingerprint, gitignoreListsEnv, loadEnvFiles, readEnvFile, userEnvPath, writeEnvFile } from '../env.js';
import type { EnvLoad } from '../env.js';
import { PROVIDERS } from '../providers/index.js';

// ------------------------------------------------------------------ prompting

export interface Prompter {
  /** Ask for one line of input. Resolves undefined when input has ended. */
  line(question: string): Promise<string | undefined>;
  /** Same, with the typed characters hidden (on a terminal). The answer is never echoed. */
  secret(question: string): Promise<string | undefined>;
  close(): void;
}

/** A prompter on stdin, writing questions to stderr. Lines piped in are buffered, so scripted input works. */
export function terminalPrompter(input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, output: NodeJS.WritableStream = process.stderr): Prompter {
  let rl: Interface | undefined;
  let it: AsyncIterator<string> | undefined;
  let muted = false;
  const open = () => {
    if (!rl) {
      rl = createInterface({ input, output, terminal: input.isTTY === true });
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput?.bind(rl);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (muted) {
          if (s.includes('\n') || s.includes('\r')) output.write('\n');
          return;
        }
        write?.(s);
      };
      it = rl[Symbol.asyncIterator]();
    }
    return it!;
  };
  const read = async (q: string, hide: boolean) => {
    const iter = open();
    output.write(q);
    muted = hide;
    try {
      const r = await iter.next();
      if (hide && input.isTTY !== true) output.write('\n');
      return r.done ? undefined : r.value.trim();
    } finally {
      muted = false;
    }
  };
  return {
    line: (q) => read(q, false),
    secret: (q) => read(q, true),
    close: () => rl?.close(),
  };
}

// ------------------------------------------------------------------ detection

export interface Detection {
  /** Env var name → where it is set ("environment", ".env", "~/.config/noro/.env"). */
  keys: Record<string, string>;
  claude: boolean;
  codex: boolean;
  /** Model names when the server answered, undefined when nothing answered. */
  ollama?: string[];
  lmstudio?: string[];
  aws: boolean;
  gcloud: boolean;
}

/** True when `bin` is an executable file on PATH (or an existing path). No process is started. */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return isFile(bin);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (isFile(join(dir, bin + ext))) return true;
  }
  return false;
}

async function modelsAt(f: typeof fetch, url: string, pick: (json: any) => string[]): Promise<string[] | undefined> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return [];
    return pick(await res.json().catch(() => ({})));
  } catch {
    return undefined;
  }
}

export async function detect(opts: { env: NodeJS.ProcessEnv; envLoad?: EnvLoad; home: string; fetch?: typeof fetch; platform?: NodeJS.Platform }): Promise<Detection> {
  const { env, home } = opts;
  const f = opts.fetch ?? fetch;
  const keys: Record<string, string> = {};
  const names = new Set<string>(['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'NORO_API_KEY', ...PROVIDERS.flatMap((p) => p.envKeys)]);
  for (const k of names) if (env[k]) keys[k] = opts.envLoad?.origin[k] ?? 'environment';
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const [ollama, lmstudio] = await Promise.all([
    modelsAt(f, 'http://localhost:11434/api/tags', (j) => (j?.models ?? []).map((m: { name?: string }) => String(m.name))),
    modelsAt(f, 'http://localhost:1234/v1/models', (j) => (j?.data ?? []).map((m: { id?: string }) => String(m.id))),
  ]);
  return {
    keys,
    claude: onPath(env.NORO_CLAUDE_BIN || 'claude', env, opts.platform),
    codex: onPath(env.NORO_CODEX_BIN || 'codex', env, opts.platform),
    ...(ollama ? { ollama } : {}),
    ...(lmstudio ? { lmstudio } : {}),
    aws: Boolean(env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID || env.AWS_BEARER_TOKEN_BEDROCK) || existsSync(join(home, '.aws', 'credentials')) || existsSync(join(home, '.aws', 'config')),
    gcloud:
      Boolean(env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_CLOUD_API_KEY) ||
      existsSync(join(home, '.config', 'gcloud', 'application_default_credentials.json')) ||
      existsSync(join(appData, 'gcloud', 'application_default_credentials.json')),
  };
}

// ------------------------------------------------------------------ presets

export const PERSONAL_USE_TERMS: Record<'claude-cli' | 'codex-cli', string> = {
  'claude-cli':
    'claude-cli runs the writing steps through your own logged-in Claude Code, on your Claude Pro or Max plan.\n' +
    '  - Personal use only: your own account, on your own machine, for your own reports. Not as a service\n' +
    '    for other people, and not in a shared container or CI runner.\n' +
    '  - You log in with Claude Code yourself. noro never sees, stores or passes your login.\n' +
    '  - noro starts the unmodified claude binary with no tools and removes API-key variables from it.\n' +
    '  - Calls count against your plan\'s usage limits.\n' +
    '  Anthropic\'s terms: https://code.claude.com/docs/en/legal-and-compliance',
  'codex-cli':
    'codex-cli runs the writing steps through your own logged-in Codex CLI, on your ChatGPT plan.\n' +
    '  - Personal use only: your own account, on your own machine, for your own reports. Not as a service\n' +
    '    for other people, and not in a shared container or CI runner.\n' +
    '  - You log in with `codex login` ("Sign in with ChatGPT"). noro never sees, stores or passes your login.\n' +
    '  - noro starts the unmodified codex binary in a read-only sandbox and removes API-key variables from it.\n' +
    '  - Calls count against your plan\'s usage limits.\n' +
    '  OpenAI\'s terms: https://developers.openai.com/siwc',
};

type Updates = Record<string, string | null>;

interface Ctx {
  p: Prompter;
  say: (s: string) => void;
  d: Detection;
  env: NodeJS.ProcessEnv;
  /** Keys the target file already holds. */
  target: Record<string, string>;
}

export class InitAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitAbort';
  }
}

const defaultModel = (provider: string, fallback: string) => PROVIDERS.find((p) => p.id === provider)?.defaultModel || fallback;

async function need(ctx: Ctx, q: string, secret = false): Promise<string> {
  const a = secret ? await ctx.p.secret(q) : await ctx.p.line(q);
  if (a === undefined) throw new InitAbort('input ended before setup was finished; nothing was written');
  return a;
}

/** Ask for a key with hidden input. Enter keeps one already set. Returns the update ({} when nothing changes). */
async function askKey(ctx: Ctx, name: string, what: string, opts: { optional?: string } = {}): Promise<Updates> {
  const have = ctx.env[name];
  if (have) {
    const where = ctx.d.keys[name] ?? 'environment';
    const a = await need(ctx, `${name} is already set (${fingerprint(have)}, in ${where}). Press Enter to keep it, or paste a new one (input hidden): `, true);
    if (!a) return where === 'environment' || name in ctx.target ? {} : { [name]: have };
    return { [name]: a };
  }
  for (let tries = 0; tries < 3; tries++) {
    const a = await need(ctx, `Paste your ${what} for ${name}${opts.optional ? ` (Enter to skip: ${opts.optional})` : ''} (input hidden): `, true);
    if (a) return { [name]: a };
    if (opts.optional) return {};
    ctx.say(`  ${name} is needed for this setup.`);
  }
  ctx.say(`  Skipped ${name}. \`noro doctor\` will flag it until it is set.`);
  return {};
}

async function askValue(ctx: Ctx, name: string, question: string, fallback?: string): Promise<Updates> {
  const have = ctx.env[name] || fallback;
  const a = await need(ctx, `${question}${have ? ` [${have}]` : ''}: `);
  const v = a || have;
  if (!v || v === ctx.target[name]) return {};
  return { [name]: v };
}

async function choose<T extends { label: string }>(ctx: Ctx, question: string, options: T[]): Promise<T> {
  for (;;) {
    ctx.say(question);
    options.forEach((o, i) => ctx.say(`  ${i + 1}. ${o.label}`));
    const a = await need(ctx, `Choose 1-${options.length} [1]: `);
    const n = a === '' ? 1 : Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
    ctx.say(`  "${a}" is not one of 1-${options.length}.`);
  }
}

async function consent(ctx: Ctx, which: 'claude-cli' | 'codex-cli'): Promise<boolean> {
  ctx.say('');
  ctx.say(PERSONAL_USE_TERMS[which]);
  const a = (await need(ctx, 'Use it on these terms? Type y to agree [y/N]: ')).toLowerCase();
  return a === 'y' || a === 'yes';
}

/** Classify for presets that don't already set an OpenRouter key: jev with a key, or rules. */
async function classifyKey(ctx: Ctx): Promise<Updates> {
  if (ctx.env.OPENROUTER_API_KEY || ctx.env.TYPESAFE_API_KEY || ctx.env.NORO_CLASSIFY || ctx.env.NORO_CLASSIFY_BASE_URL) return {};
  ctx.say('Classify: jev through OpenRouter needs an OpenRouter key. Without one, noro classifies with deterministic rules.');
  return askKey(ctx, 'OPENROUTER_API_KEY', 'OpenRouter key', { optional: 'use rules' });
}

interface Preset {
  id: string;
  label: string;
  detected: boolean;
  run(ctx: Ctx): Promise<Updates | null>;
}

function presets(d: Detection): Preset[] {
  const or = Boolean(d.keys.OPENROUTER_API_KEY);
  const local = d.ollama !== undefined || d.lmstudio !== undefined;
  const direct = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].filter((k) => d.keys[k]);
  const cloud = d.aws || d.gcloud || Boolean(d.keys.AZURE_OPENAI_API_KEY);
  const tag = (on: boolean, what: string) => (on ? `  (found: ${what})` : '');
  const list: Preset[] = [
    {
      id: 'owner',
      label: `jev through OpenRouter for classify, your own Claude Code login for writing (claude-cli)${tag(d.claude || or, [d.claude && 'claude', or && 'OpenRouter key'].filter(Boolean).join(', '))}`,
      detected: d.claude,
      async run(ctx) {
        if (!(await consent(ctx, 'claude-cli'))) return null;
        if (!ctx.d.claude) ctx.say('  claude is not on your PATH yet. Install Claude Code and run `claude` once to log in (or set NORO_CLAUDE_BIN).');
        return { NORO_MODEL: `claude-cli:${defaultModel('claude-cli', 'claude-opus-5-5')}`, ...(await askKey(ctx, 'OPENROUTER_API_KEY', 'OpenRouter key')) };
      },
    },
    {
      id: 'openrouter',
      label: `OpenRouter for everything${tag(or, 'OpenRouter key')}`,
      detected: or,
      async run(ctx) {
        return { NORO_MODEL: `openrouter:${defaultModel('openrouter', 'anthropic/claude-opus-5.5')}`, ...(await askKey(ctx, 'OPENROUTER_API_KEY', 'OpenRouter key')) };
      },
    },
    {
      id: 'direct',
      label: `A direct API: Anthropic, OpenAI or Google${tag(direct.length > 0, direct.join(', '))}`,
      detected: direct.length > 0,
      async run(ctx) {
        const opts = [
          { label: 'Anthropic', provider: 'anthropic', key: 'ANTHROPIC_API_KEY', what: 'Anthropic API key', model: 'claude-opus-5-5' },
          { label: 'OpenAI', provider: 'openai', key: 'OPENAI_API_KEY', what: 'OpenAI API key', model: 'gpt-6.1-sol' },
          { label: 'Google (Gemini API)', provider: 'google', key: 'GEMINI_API_KEY', what: 'Gemini API key', model: 'gemini-3.1-pro-preview' },
        ].sort((a, b) => Number(Boolean(ctx.d.keys[b.key])) - Number(Boolean(ctx.d.keys[a.key])));
        const o = await choose(ctx, 'Which API?', opts);
        return { NORO_MODEL: `${o.provider}:${defaultModel(o.provider, o.model)}`, ...(await askKey(ctx, o.key, o.what)), ...(await classifyKey(ctx)) };
      },
    },
    {
      id: 'cloud',
      label: `A cloud account: Bedrock, Vertex or Azure${tag(cloud, [d.aws && 'AWS', d.gcloud && 'Google Cloud', d.keys.AZURE_OPENAI_API_KEY && 'Azure key'].filter(Boolean).join(', '))}`,
      detected: cloud,
      async run(ctx) {
        const opts = [
          { label: 'Amazon Bedrock (Claude)', id: 'bedrock', found: ctx.d.aws },
          { label: 'Google Vertex AI (Gemini)', id: 'vertex', found: ctx.d.gcloud },
          { label: 'Azure OpenAI', id: 'azure', found: Boolean(ctx.d.keys.AZURE_OPENAI_API_KEY) },
        ].sort((a, b) => Number(b.found) - Number(a.found));
        const o = await choose(ctx, 'Which cloud?', opts);
        let u: Updates = {};
        if (o.id === 'bedrock') {
          if (!ctx.d.aws) ctx.say('  No AWS credentials found. noro uses the standard AWS chain: AWS_PROFILE, AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY, or an instance role.');
          u = { NORO_MODEL: `bedrock:${defaultModel('bedrock', 'global.anthropic.claude-opus-5-5')}`, ...(await askValue(ctx, 'AWS_REGION', 'AWS region', 'us-east-1')) };
        } else if (o.id === 'vertex') {
          u = {
            NORO_MODEL: `vertex:${defaultModel('vertex', 'gemini-3.1-pro-preview')}`,
            ...(await askValue(ctx, 'GOOGLE_CLOUD_PROJECT', 'Google Cloud project id')),
            ...(await askValue(ctx, 'GOOGLE_CLOUD_LOCATION', 'Google Cloud location', 'global')),
          };
          if (!ctx.d.gcloud) u = { ...u, ...(await askKey(ctx, 'GOOGLE_CLOUD_API_KEY', 'Google Cloud API key', { optional: 'use `gcloud auth application-default login` instead' })) };
        } else {
          u = {
            NORO_MODEL: `azure:${defaultModel('azure', 'gpt-6.1-sol')}`,
            ...(await askKey(ctx, 'AZURE_OPENAI_API_KEY', 'Azure OpenAI key')),
            ...(await askValue(ctx, 'AZURE_OPENAI_RESOURCE_NAME', 'Azure OpenAI resource name')),
          };
        }
        return { ...u, ...(await classifyKey(ctx)) };
      },
    },
    {
      id: 'local',
      label: `A local server: Ollama or LM Studio${tag(local, [d.ollama && 'Ollama', d.lmstudio && 'LM Studio'].filter(Boolean).join(', '))}`,
      detected: local,
      async run(ctx) {
        const opts = [
          { label: `Ollama${ctx.d.ollama ? ' (running)' : ''}`, id: 'ollama', models: ctx.d.ollama },
          { label: `LM Studio${ctx.d.lmstudio ? ' (running)' : ''}`, id: 'lmstudio', models: ctx.d.lmstudio },
        ].sort((a, b) => Number(b.models !== undefined) - Number(a.models !== undefined));
        const o = await choose(ctx, 'Which server?', opts);
        if (o.models?.length) ctx.say(`  Models on the server: ${o.models.slice(0, 10).join(', ')}`);
        let model = '';
        while (!model) {
          model = (await need(ctx, `Model id${o.models?.[0] ? ` [${o.models[0]}]` : ''}: `)) || o.models?.[0] || '';
        }
        if (o.id === 'ollama') ctx.say('  Start Ollama with OLLAMA_CONTEXT_LENGTH=16384 or more; it cuts longer prompts without an error.');
        return { NORO_MODEL: `${o.id}:${model}`, ...(await classifyKey(ctx)) };
      },
    },
    {
      id: 'codex',
      label: `Your ChatGPT plan through Codex (codex-cli)${tag(d.codex, 'codex')}`,
      detected: d.codex,
      async run(ctx) {
        if (!(await consent(ctx, 'codex-cli'))) return null;
        if (!ctx.d.codex) ctx.say('  codex is not on your PATH yet. Install the Codex CLI and run `codex login` (or set NORO_CODEX_BIN).');
        return { NORO_MODEL: 'codex-cli:default', ...(await classifyKey(ctx)) };
      },
    },
  ];
  // The owner's setup stays first; the rest go detected first (stable).
  const [first, ...rest] = list;
  return [first, ...rest.filter((p) => p.detected), ...rest.filter((p) => !p.detected)];
}

// ------------------------------------------------------------------ the wizard

export interface InitOptions {
  cwd?: string;
  home: string;
  /** The process environment before any .env file was merged in. */
  baseEnv: NodeJS.ProcessEnv;
  global?: boolean;
  prompter: Prompter;
  /** Where messages go (stderr). */
  say?: (s: string) => void;
  /** Where the doctor report goes (stdout). */
  print?: (s: string) => void;
  fetch?: typeof fetch;
}

export interface InitResult {
  exitCode: number;
  path?: string;
  doctor?: DoctorResult;
}

/** Variables that would override NORO_MODEL for a step, so a new preset must not leave them behind. */
const OVERRIDES = ['NORO_WRITER', 'NORO_DRAFT_MODEL', 'NORO_PANEL_MODEL'];

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const say = opts.say ?? ((s: string) => process.stderr.write(`${s}\n`));
  const print = opts.print ?? ((s: string) => process.stdout.write(`${s}\n`));
  const env = { ...opts.baseEnv };
  const envLoad = loadEnvFiles(cwd, opts.home, env);
  const file = opts.global ? userEnvPath(opts.home) : join(cwd, '.env');
  const shown = opts.global ? '~/.config/noro/.env' : '.env';

  say('noro init: checking what you already have (free, no model calls)...');
  const d = await detect({ env, envLoad, home: opts.home, fetch: opts.fetch });
  const found = [
    ...Object.entries(d.keys).map(([k, where]) => `${k} (${where})`),
    d.claude && 'claude on PATH',
    d.codex && 'codex on PATH',
    d.ollama && `Ollama on :11434 (${d.ollama.length} models)`,
    d.lmstudio && `LM Studio on :1234 (${d.lmstudio.length} models)`,
    d.aws && 'AWS credentials',
    d.gcloud && 'Google Cloud credentials',
  ].filter(Boolean);
  say(found.length ? `Found: ${found.join(', ')}.` : 'Found nothing set up yet.');
  say('');

  const ctx: Ctx = { p: opts.prompter, say, d, env, target: readEnvFile(file) };
  let updates: Updates | null = null;
  try {
    while (!updates) {
      const preset = await choose(ctx, 'Pick a setup:', presets(d));
      updates = await preset.run(ctx);
      if (!updates) say('  Not agreed. Pick another setup.\n');
    }
  } catch (err) {
    if (err instanceof InitAbort) {
      say(`noro init: ${err.message}.`);
      return { exitCode: 1 };
    }
    throw err;
  } finally {
    opts.prompter.close();
  }

  // A preset sets NORO_MODEL; per-step overrides left in the same file would quietly win over it.
  for (const k of OVERRIDES) if (k in ctx.target) updates[k] = null;
  const res = writeEnvFile(file, updates);
  say('');
  say(`Wrote ${shown}: ${res.changed.length ? res.changed.join(', ') : 'no changes'}${res.backup ? `; the old file is ${shown}.bak` : ''}. Mode 600.`);
  const cleared = OVERRIDES.filter((k) => updates![k] === null);
  if (cleared.length) say(`Commented out ${cleared.join(', ')} in ${shown}, so NORO_MODEL applies to every writing step.`);
  const elsewhere = OVERRIDES.filter((k) => !(k in ctx.target) && opts.baseEnv[k] !== undefined);
  if (elsewhere.length) say(`Note: ${elsewhere.join(', ')} ${elsewhere.length === 1 ? 'is' : 'are'} set in your environment and override${elsewhere.length === 1 ? 's' : ''} NORO_MODEL.`);
  if (!opts.global && !gitignoreListsEnv(cwd)) say('Warning: .gitignore here does not list .env. Add it so your keys are never committed.');
  say('');

  // Doctor with what is now on disk (the environment as it was, plus the files).
  const after = { ...opts.baseEnv };
  const afterLoad = loadEnvFiles(cwd, opts.home, after);
  const doctor = await runDoctor({ env: after, cwd, envLoad: afterLoad, fetch: opts.fetch });
  print(formatDoctor(doctor));
  return { exitCode: doctor.exitCode, path: file, doctor };
}
