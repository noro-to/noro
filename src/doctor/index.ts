// `noro doctor [--live] [--yes] [--json]`: check the setup.
//
// Every check without --live is free: keys are checked against each provider's
// key or model-list endpoint (no tokens), CLIs with their own login-status
// command, local servers with their model list. Keys show only as a short
// fingerprint. Bedrock, Vertex and Azure credentials show as "found (not
// verified)", since verifying them takes a paid call.
//
// --live makes one 16-token call per writing model and one single-fact
// classify call, after showing the estimated cost and asking (--yes skips the
// question).
//
// Exit codes: 0 all checks pass, 1 a check failed, 3 some items could not be verified.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyHost, classifyKeyEnv, classifySettings, OPENROUTER_CLASSIFY_BASE, resolveClassifier, TYPESAFE_CLASSIFY_BASE } from '../classify/index.js';
import { loadConfig } from '../config.js';
import type { Config } from '../config.js';
import { checkClaudeAuth, childEnv } from '../draft/claude-cli.js';
import { checkCodexAuth, codexChildEnv } from '../draft/codex-cli.js';
import type { EnvLoad } from '../env.js';
import { fingerprint } from '../env.js';
import { findPython, MIN_NODE, nodeOk, PYTHON_HELP } from '../preflight.js';
import { createChatClientFor, missingCredentials, nativeModelId, parseModelRef, PROVIDERS } from '../providers/index.js';
import type { ModelRef, ProviderInfo } from '../providers/index.js';
import type { ChatClient, FactsTable, JevClient } from '../schema.js';

export type Status = 'ok' | 'fail' | 'unverified' | 'warn' | 'info';

export interface DoctorLine {
  status: Status;
  text: string;
}

export interface DoctorSection {
  name: 'config' | 'writer' | 'classify' | 'engine' | 'state' | 'live';
  /** The first line: what is configured. */
  head: string;
  lines: DoctorLine[];
}

export interface DoctorResult {
  sections: DoctorSection[];
  exitCode: 0 | 1 | 3;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** What loadEnvFiles found, for the config line. */
  envLoad?: EnvLoad;
  live?: boolean;
  yes?: boolean;
  /** Ask a yes/no question (for --live). Absent: no terminal, so --live needs --yes. */
  ask?: (question: string) => Promise<boolean>;
  fetch?: typeof fetch;
  /** Clients for --live (tests, NORO_MOCK_MODELS). */
  clients?: { chat?: ChatClient; jev?: JevClient };
  /** Progress for --live, on stderr. */
  progress?: (line: string) => void;
}

const TIMEOUT_MS = 5000;

/** Free key checks: an endpoint that answers 200 for a valid key and costs nothing. */
const KEY_CHECKS: Record<string, { url: (env: NodeJS.ProcessEnv, cfg: Config) => string; headers: (key: string) => Record<string, string> }> = {
  openrouter: { url: (_e, cfg) => `${cfg.baseUrl.replace(/\/+$/, '')}/v1/key`, headers: (k) => ({ authorization: `Bearer ${k}` }) },
  anthropic: { url: () => 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  openai: { url: () => 'https://api.openai.com/v1/models', headers: (k) => ({ authorization: `Bearer ${k}` }) },
  google: { url: () => 'https://generativelanguage.googleapis.com/v1beta/models', headers: (k) => ({ 'x-goog-api-key': k }) },
  mistral: { url: () => 'https://api.mistral.ai/v1/models', headers: (k) => ({ authorization: `Bearer ${k}` }) },
  deepseek: { url: () => 'https://api.deepseek.com/models', headers: (k) => ({ authorization: `Bearer ${k}` }) },
  groq: { url: () => 'https://api.groq.com/openai/v1/models', headers: (k) => ({ authorization: `Bearer ${k}` }) },
};

const LOCAL_DEFAULTS: Record<string, string> = { ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' };
const CLOUD = new Set(['bedrock', 'vertex', 'azure']);
export const OLLAMA_MIN_CONTEXT = 16384;

function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** The env var holding a provider's API key (the first of its envKeys that looks like a key). */
function keyEnvFor(p: ProviderInfo | undefined): string | undefined {
  return p?.envKeys.find((k) => /_API_KEY$/.test(k));
}

async function getJson(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<{ status: number; json?: any } | { error: string }> {
  try {
    const res = await f(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let json: any;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return { error: e.cause?.code ?? e.name ?? 'network error' };
  }
}

/** Run a command, capture its output. Never throws: a missing binary is code -1 with error ENOENT. */
function runCmd(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string; error?: string }> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      done({ code: -1, stdout, stderr, error: (err as NodeJS.ErrnoException).code ?? 'spawn failed' });
      return;
    }
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr, error: err.code ?? err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

class Checker {
  private cache = new Map<string, Promise<DoctorLine[]>>();
  constructor(
    private env: NodeJS.ProcessEnv,
    private config: Config,
    private f: typeof fetch,
  ) {}

  /** A key check against a free endpoint, once per URL and key. */
  keyCheck(provider: string, keyEnv: string): Promise<DoctorLine[]> {
    const spec = KEY_CHECKS[provider];
    const key = this.env[keyEnv] ?? '';
    const url = spec.url(this.env, this.config);
    const k = `${url}|${key}`;
    let p = this.cache.get(k);
    if (!p) {
      p = (async () => {
        const set = `${keyEnv} set (${fingerprint(key)})`;
        const r = await getJson(this.f, url, spec.headers(key));
        if ('error' in r) return [{ status: 'unverified' as Status, text: `${set}, but ${new URL(url).host} could not be reached (${r.error})` }];
        if (r.status >= 200 && r.status < 300) return [{ status: 'ok' as Status, text: `${set}, key valid` }];
        if (r.status === 401 || r.status === 403) return [{ status: 'fail' as Status, text: `${set}, but ${new URL(url).host} rejected it (HTTP ${r.status})` }];
        return [{ status: 'unverified' as Status, text: `${set}, but ${new URL(url).host} answered HTTP ${r.status}` }];
      })();
      this.cache.set(k, p);
    }
    return p;
  }

  /** A server with an OpenAI-style /v1/models list (openai-compatible, LM Studio, Ollama). */
  async localServer(provider: string, model: string): Promise<DoctorLine[]> {
    const base = (this.env.NORO_BASE_URL || LOCAL_DEFAULTS[provider] || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    if (!base) return [{ status: 'fail', text: 'NORO_BASE_URL not set' }];
    const key = this.env.NORO_API_KEY;
    const r = await getJson(this.f, `${base}/v1/models`, key ? { authorization: `Bearer ${key}` } : {});
    if ('error' in r) return [{ status: 'fail', text: `nothing answers at ${base} (${r.error}). Is the server running?` }];
    if (r.status === 401 || r.status === 403) return [{ status: 'fail', text: `${base} refused the request (HTTP ${r.status})${key ? `; NORO_API_KEY (${fingerprint(key)})` : '; set NORO_API_KEY'}` }];
    if (r.status < 200 || r.status >= 300) return [{ status: 'unverified', text: `${base}/v1/models answered HTTP ${r.status}` }];
    const ids: string[] = Array.isArray(r.json?.data) ? r.json.data.map((m: { id?: string }) => String(m.id)) : [];
    const lines: DoctorLine[] = [{ status: 'ok', text: `server at ${base}${key ? `, NORO_API_KEY set (${fingerprint(key)})` : ''}` }];
    if (ids.length && !ids.includes(model) && !ids.some((i) => i.split(':')[0] === model)) {
      lines.push({ status: 'fail', text: `model "${model}" is not on the server. It has: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', ...' : ''}` });
    } else if (ids.length) {
      lines.push({ status: 'ok', text: `model ${model} available` });
    }
    if (provider === 'ollama') lines.push(...(await this.ollamaContext(base, model)));
    return lines;
  }

  /** Ollama cuts long prompts silently below about 16k context. /api/ps shows a loaded model's context length. */
  private async ollamaContext(base: string, model: string): Promise<DoctorLine[]> {
    const r = await getJson(this.f, `${base}/api/ps`);
    if ('error' in r || r.status !== 200) return [];
    const loaded = (r.json?.models ?? []).find((m: { name?: string; model?: string }) => m.name === model || m.model === model || m.name?.split(':')[0] === model);
    const ctx = Number(loaded?.context_length);
    if (!loaded || !Number.isFinite(ctx) || ctx <= 0) {
      return [{ status: 'info', text: `context length unknown until the model is loaded; start Ollama with OLLAMA_CONTEXT_LENGTH=${OLLAMA_MIN_CONTEXT} or more` }];
    }
    if (ctx < OLLAMA_MIN_CONTEXT) {
      return [{ status: 'warn', text: `context length ${ctx} is below ${OLLAMA_MIN_CONTEXT}; Ollama cuts long prompts without an error. Restart it with OLLAMA_CONTEXT_LENGTH=${OLLAMA_MIN_CONTEXT}` }];
    }
    return [{ status: 'ok', text: `context length ${ctx}` }];
  }

  async claudeCli(): Promise<DoctorLine[]> {
    const bin = this.config.claudeBin;
    const env = childEnv(this.env);
    const v = await runCmd(bin, ['--version'], env);
    if (v.error === 'ENOENT') return [{ status: 'fail', text: `${bin} not found on PATH. Install Claude Code, or set NORO_CLAUDE_BIN` }];
    const lines: DoctorLine[] = [{ status: 'ok', text: `${bin} found${v.stdout.trim() ? ` (${v.stdout.trim().split('\n')[0].slice(0, 40)})` : ''}` }];
    try {
      await checkClaudeAuth({ claudeBin: bin }, env);
      lines.push({ status: 'ok', text: 'logged in with a Claude subscription' });
    } catch (err) {
      lines.push({ status: 'fail', text: (err as Error).message });
    }
    return lines;
  }

  async codexCli(): Promise<DoctorLine[]> {
    const bin = this.config.codexBin;
    const env = codexChildEnv(this.env);
    const v = await runCmd(bin, ['--version'], env);
    if (v.error === 'ENOENT') return [{ status: 'fail', text: `${bin} not found on PATH. Install the Codex CLI, or set NORO_CODEX_BIN` }];
    const lines: DoctorLine[] = [{ status: 'ok', text: `${bin} found${v.stdout.trim() ? ` (${v.stdout.trim().split('\n')[0].slice(0, 40)})` : ''}` }];
    try {
      await checkCodexAuth({ codexBin: bin }, env);
      lines.push({ status: 'ok', text: 'logged in with ChatGPT' });
    } catch (err) {
      lines.push({ status: 'fail', text: (err as Error).message });
    }
    return lines;
  }

  async writer(ref: ModelRef): Promise<DoctorLine[]> {
    const info = providerInfo(ref.provider);
    const missing = missingCredentials(ref, this.env);
    if (missing.length) return [{ status: 'fail', text: `${missing.join(', ')} not set. Run \`noro init\`, or see docs/install/providers.md` }];
    if (ref.provider === 'claude-cli') return this.claudeCli();
    if (ref.provider === 'codex-cli') return this.codexCli();
    if (ref.provider === 'openai-compatible' || ref.provider in LOCAL_DEFAULTS) return this.localServer(ref.provider, ref.id);
    if (CLOUD.has(ref.provider)) {
      const found = (info?.envKeys ?? []).filter((k) => this.env[k]);
      return [{ status: 'unverified', text: `credentials found (not verified)${found.length ? `: ${found.join(', ')}` : ''}. Checking them takes a paid call; try \`noro doctor --live\`` }];
    }
    const keyEnv = keyEnvFor(info);
    if (keyEnv && KEY_CHECKS[ref.provider]) return this.keyCheck(ref.provider, keyEnv);
    return [{ status: 'unverified', text: 'credentials found (not verified)' }];
  }
}

function countRuns(stateDir: string): number {
  const dir = join(stateDir, 'runs');
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.sqlite')).length;
  } catch {
    return 0;
  }
}

function exitFor(sections: DoctorSection[]): 0 | 1 | 3 {
  const all = sections.flatMap((s) => s.lines.map((l) => l.status));
  if (all.includes('fail')) return 1;
  if (all.includes('unverified')) return 3;
  return 0;
}

/** A one-fact table for the live classify call. Its label and value are made up; no user data. */
function liveFacts(): FactsTable {
  return {
    currency: 'USD',
    periods: { current: 'this week' },
    facts: [
      {
        id: 'f1',
        key: 'spend:period=current',
        label: 'Spend, account, current week',
        value: 100,
        kind: 'currency',
        unit: 'USD',
        display: '$100',
        formula: 'sum of spend',
        inputs: ['row:spend'],
        scope: { metric: 'spend', period: 'current' },
        flags: [],
      },
    ],
  };
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const f = opts.fetch ?? fetch;
  const sections: DoctorSection[] = [];

  // config
  const sources = opts.envLoad?.sources ?? [];
  sections.push({
    name: 'config',
    head: sources.length ? sources.map((s) => `${s.label} (${plural(s.keys.length, 'key')})`).join(', ') : 'no .env files; using the environment only',
    lines: (opts.envLoad?.placeholders ?? []).map(({ key, label }) => ({
      status: 'warn' as Status,
      text: `${key} in ${label} is a placeholder, not a key, so noro ignores it${env[key] ? ` and uses the one from ${opts.envLoad?.origin[key] ?? 'the environment'} (${fingerprint(env[key])})` : ''}. Put your real key there, or delete the line`,
    })),
  });

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    sections.push({ name: 'writer', head: 'config error', lines: [{ status: 'fail', text: (err as Error).message }] });
    return { sections, exitCode: 1 };
  }
  const checker = new Checker(env, config, f);

  // writer: one block per distinct model (draft and panel are usually the same)
  const refs = new Map<string, { ref: ModelRef; steps: string[] }>();
  for (const [step, raw] of [
    ['draft', config.draftModel],
    ['panel', config.panelModel],
  ] as const) {
    let ref: ModelRef;
    try {
      ref = parseModelRef(raw);
    } catch (err) {
      sections.push({ name: 'writer', head: raw, lines: [{ status: 'fail', text: (err as Error).message }] });
      continue;
    }
    const k = `${ref.provider}:${ref.id}`;
    const e = refs.get(k);
    if (e) e.steps.push(step);
    else refs.set(k, { ref, steps: [step] });
  }
  for (const { ref, steps } of refs.values()) {
    const info = providerInfo(ref.provider);
    const personal = info?.kind === 'subscription' ? '   [personal use only]' : '';
    const which = refs.size > 1 ? `${steps.join('/')}: ` : '';
    sections.push({ name: 'writer', head: `${which}${ref.provider}  ${ref.id}${personal}`, lines: await checker.writer(ref) });
  }

  // classify
  try {
    const c = resolveClassifier(config, { env });
    const lines: DoctorLine[] = [];
    if (c.mode === 'rules') {
      lines.push({ status: 'ok', text: 'deterministic rules from the compute flags; no key, no model' });
    } else if (c.mode === 'writer') {
      lines.push({ status: 'info', text: 'the writing model answers the classify questions (NORO_CLASSIFY=writer)' });
    } else {
      const s = classifySettings(config, env);
      const base = s.baseUrl ?? (!s.openrouterKey && s.typesafeKey ? TYPESAFE_CLASSIFY_BASE : OPENROUTER_CLASSIFY_BASE);
      const keyEnv = classifyKeyEnv(base);
      const host = classifyHost(base);
      if (c.missingKey) lines.push({ status: 'fail', text: `${c.missingKey} not set` });
      else if (host === 'openrouter' && keyEnv) lines.push(...(await checker.keyCheck('openrouter', keyEnv)));
      else if (keyEnv) lines.push({ status: 'unverified', text: `${keyEnv} set (${fingerprint(env[keyEnv])}), not verified` });
      else {
        const r = await getJson(f, `${base.replace(/\/+$/, '').replace(/\/v1(\/systemone)?$/i, '')}/v1/models`);
        lines.push('error' in r ? { status: 'fail', text: `nothing answers at ${base} (${r.error})` } : { status: 'ok', text: `server at ${base} answers` });
      }
    }
    sections.push({ name: 'classify', head: c.describe, lines });
  } catch (err) {
    sections.push({ name: 'classify', head: 'config error', lines: [{ status: 'fail', text: (err as Error).message }] });
  }

  // engine
  const engine: DoctorLine[] = [];
  engine.push(nodeOk() ? { status: 'ok', text: `node ${process.versions.node}` } : { status: 'fail', text: `node ${process.versions.node} is older than ${MIN_NODE.join('.')}` });
  const py = findPython(env);
  engine.push(py.found ? { status: 'ok', text: `${py.found.cmd.join(' ')} ${py.found.version}` } : { status: 'fail', text: PYTHON_HELP });
  sections.push({ name: 'engine', head: '', lines: engine });

  // state
  const stateDir = resolve(cwd, config.stateDir);
  const runs = countRuns(stateDir);
  sections.push({ name: 'state', head: `${config.stateDir}: ${runs ? `${plural(runs, 'saved run')} (an unfinished run resumes when you rerun its input)` : 'no runs in progress'}`, lines: [] });

  // live
  sections.push(await live(opts, config, [...refs.values()].map((r) => r.ref), env));

  return { sections, exitCode: exitFor(sections) };
}

async function live(opts: DoctorOptions, config: Config, refs: ModelRef[], env: NodeJS.ProcessEnv): Promise<DoctorSection> {
  if (!opts.live) return { name: 'live', head: 'skipped. Run `noro doctor --live` for a paid test call.', lines: [] };
  const what = `${plural(refs.length, '16-token call')} to ${refs.map((r) => `${r.provider}:${r.id}`).join(', ')} and one single-fact classify call`;
  const cost = 'estimated cost under $0.01 in total (subscription and local models: no charge)';
  if (!opts.yes) {
    if (!opts.ask) return { name: 'live', head: `skipped: no terminal to ask in. Rerun with --yes to make ${what}.`, lines: [] };
    if (!(await opts.ask(`noro doctor --live makes ${what}, ${cost}. Go ahead? [y/N] `))) {
      return { name: 'live', head: 'skipped: not confirmed.', lines: [] };
    }
  }
  const lines: DoctorLine[] = [];
  for (const ref of refs) {
    opts.progress?.(`live: ${ref.provider}:${ref.id}`);
    try {
      const chat = opts.clients?.chat ?? createChatClientFor(ref, config);
      const out = await chat.complete({ model: nativeModelId(ref), system: 'Reply with the single word OK.', user: 'OK', maxTokens: 16 });
      lines.push({ status: 'ok', text: `${ref.provider}:${ref.id} answered (${out.trim().slice(0, 20) || 'empty reply'})` });
    } catch (err) {
      lines.push({ status: 'fail', text: `${ref.provider}:${ref.id}: ${(err as Error).message.slice(0, 300)}` });
    }
  }
  try {
    opts.progress?.('live: classify');
    const c = resolveClassifier(config, { env, ...(opts.clients?.jev ? { jev: opts.clients.jev } : {}), ...(opts.clients?.chat ? { chat: opts.clients.chat } : {}) });
    const labels = await c.run(liveFacts());
    lines.push({ status: 'ok', text: `classify (${c.describe}) answered: ${labels[0]?.label ?? 'no label'}` });
  } catch (err) {
    lines.push({ status: 'fail', text: `classify: ${(err as Error).message.slice(0, 300)}` });
  }
  return { name: 'live', head: cost, lines };
}

/** The result as the text block the docs show. */
export function formatDoctor(r: DoctorResult): string {
  const out: string[] = [];
  const mark: Record<Status, string> = { ok: 'ok', fail: 'FAIL', unverified: '??', warn: 'warn', info: '--' };
  for (const s of r.sections) {
    const first = s.head ? `${s.name.padEnd(10)}${s.head}` : '';
    const lines = s.lines.map((l) => `${mark[l.status]}  ${l.text}`);
    if (first) out.push(first, ...lines.map((l) => `${' '.repeat(10)}${l}`));
    else if (lines.length) out.push(`${s.name.padEnd(10)}${lines[0]}`, ...lines.slice(1).map((l) => `${' '.repeat(10)}${l}`));
  }
  return out.join('\n');
}
