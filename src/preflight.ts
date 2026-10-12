// Preflight: Node and Python checks that run before any paid model call.
//
// Node 22.19+ (the package's engines field). Python 3.9+ for the rules engine,
// standard library only. Python is looked up in this order, first 3.9+ wins:
//   1. NORO_PYTHON, split on spaces (so `NORO_PYTHON=py -3` works)
//   2. python3
//   3. python
//   4. py -3 (Windows only)
// Each candidate is probed with a one-line script; "not found" (ENOENT, or the
// Windows 9009 of the Microsoft Store stub) moves on to the next.

import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { readFileSync, existsSync as fileExists } from 'node:fs';
import type { Config } from './config.js';
import { resolveClassifier } from './classify/index.js';
import type { ResolvedClassifier } from './classify/index.js';
import { getProvider, missingCredentials, parseModelRef } from './providers/index.js';
import type { ChatClient, Decision, JevClient } from './schema.js';

export const MIN_NODE: [number, number] = [22, 19];
export const MIN_PYTHON: [number, number] = [3, 9];

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export const PYTHON_HELP =
  'noro needs Python 3.9+ for its rules engine (standard library only). Install it ' +
  '(macOS: brew install python; Debian/Ubuntu: sudo apt install python3; Windows: winget install Python.Python.3.13) ' +
  'or set NORO_PYTHON. Or run the Docker image.';

/** True when `version` ("22.19.0") is at least `min`. */
export function nodeOk(version: string = process.versions.node, min: [number, number] = MIN_NODE): boolean {
  const [maj, minor] = version.replace(/^v/, '').split('.').map(Number);
  return maj > min[0] || (maj === min[0] && minor >= min[1]);
}

export function checkNode(version: string = process.versions.node): void {
  if (!nodeOk(version)) {
    throw new PreflightError(`noro needs Node ${MIN_NODE.join('.')} or newer (Node 24 recommended); this is Node ${version}. See https://nodejs.org or use nvm.`);
  }
}

export interface PythonFound {
  /** The command and its leading arguments, e.g. ["py", "-3"]. */
  cmd: string[];
  /** "3.12.4" */
  version: string;
}

export interface PythonLookup {
  found?: PythonFound;
  /** Every candidate tried, with why it was skipped. */
  tried: { cmd: string[]; result: string }[];
}

type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; error?: NodeJS.ErrnoException };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout ?? '', error: r.error as NodeJS.ErrnoException | undefined };
};

const PROBE = 'import sys;v=sys.version_info;print("%d.%d.%d" % (v[0], v[1], v[2]))';

/** The Python candidates in lookup order. */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[][] {
  const out: string[][] = [];
  const custom = env.NORO_PYTHON?.trim();
  if (custom) out.push(custom.split(/\s+/));
  out.push(['python3'], ['python']);
  if (platform === 'win32') out.push(['py', '-3']);
  return out;
}

/** Find the first Python 3.9+. Never throws. */
export function findPython(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, run: Runner = defaultRunner): PythonLookup {
  const tried: PythonLookup['tried'] = [];
  for (const cmd of pythonCandidates(env, platform)) {
    const r = run(cmd[0], [...cmd.slice(1), '-c', PROBE]);
    if (r.error || r.status === 9009) {
      tried.push({ cmd, result: r.error?.code === 'ENOENT' || r.status === 9009 ? 'not found' : (r.error?.message ?? 'failed') });
      continue;
    }
    const version = r.stdout.trim();
    if (r.status !== 0 || !/^\d+\.\d+/.test(version)) {
      tried.push({ cmd, result: `exit ${r.status}` });
      continue;
    }
    const [maj, min] = version.split('.').map(Number);
    if (maj > MIN_PYTHON[0] || (maj === MIN_PYTHON[0] && min >= MIN_PYTHON[1])) return { found: { cmd, version }, tried };
    tried.push({ cmd, result: `Python ${version} is older than 3.9` });
  }
  return { tried };
}

/**
 * Check Node and Python. Returns the Python command as one string for Config.python
 * (the command and its arguments joined by spaces). Throws PreflightError.
 */
export function preflight(env: NodeJS.ProcessEnv = process.env, opts: { nodeVersion?: string; platform?: NodeJS.Platform; run?: Runner } = {}): { python: string; pythonVersion: string } {
  checkNode(opts.nodeVersion);
  const r = findPython(env, opts.platform, opts.run);
  if (!r.found) {
    const tried = r.tried.map((t) => `${t.cmd.join(' ')}: ${t.result}`).join('; ');
    throw new PreflightError(`${PYTHON_HELP}${tried ? `\n  tried: ${tried}` : ''}`);
  }
  return { python: r.found.cmd.join(' '), pythonVersion: r.found.version };
}

// ------------------------------------------------------------ ready to run
// Everything `noro this` and the MCP noro_this tool check before the first
// paid call: credentials for each writing model, the classifier's key, Python.

/** What is missing before a run, as one actionable message per problem. Empty when ready. */
export function missingForRun(config: Config, classifier: Pick<ResolvedClassifier, 'missingKey'>, env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [step, raw] of [
    ['writing', config.draftModel],
    ['panel', config.panelModel],
  ] as const) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const ref = parseModelRef(raw);
    const missing = missingCredentials(ref, env);
    if (!missing.length) continue;
    const label = getProvider(ref.provider)?.label ?? ref.provider;
    problems.push(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. The ${step === 'panel' && config.panelModel !== config.draftModel ? 'panel step' : 'writing steps'} use ${raw} (${label}).`,
    );
  }
  if (classifier.missingKey && !problems.some((p) => p.startsWith(`${classifier.missingKey} `))) {
    problems.push(`${classifier.missingKey} is not set. Classify uses jev on ${classifier.missingKey === 'OPENROUTER_API_KEY' ? 'OpenRouter' : 'TypeSafe'}; set the key, or NORO_CLASSIFY=rules.`);
  }
  return problems;
}

export const SETUP_HINT =
  '  Run `noro init` to set up (or `noro init --global` for ~/.config/noro/.env), then `noro doctor` to check.\n' +
  '  Keys are read from the environment, ./.env, then ~/.config/noro/.env. See docs/install/providers.md.';

/** The classifier a run will use (for the "classify with" line and the footer). */
export function classifierFor(config: Config, env: NodeJS.ProcessEnv, clients?: { chat?: ChatClient; jev?: JevClient }): ResolvedClassifier {
  return resolveClassifier(config, { env, ...(clients?.jev ? { jev: clients.jev } : {}), ...(clients?.chat ? { chat: clients.chat } : {}) });
}

// ------------------------------------------------------------ --decisions

export class DecisionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionsError';
  }
}

/** Validate a decisions array: [{flagId, action: keep|cut|reword, text (reword only)}]. */
export function validateDecisions(value: unknown): Decision[] {
  if (!Array.isArray(value)) throw new DecisionsError('--decisions must be a JSON array like [{"flagId":"F1","action":"keep"}].');
  const out: Decision[] = [];
  const seen = new Set<string>();
  value.forEach((d, i) => {
    const at = `--decisions entry ${i + 1}`;
    if (!d || typeof d !== 'object') throw new DecisionsError(`${at} is not an object.`);
    const { flagId, action, text } = d as Record<string, unknown>;
    if (typeof flagId !== 'string' || !flagId) throw new DecisionsError(`${at} needs a "flagId" from the first run's flags (e.g. "F1").`);
    if (seen.has(flagId)) throw new DecisionsError(`${at}: flag ${flagId} appears twice.`);
    seen.add(flagId);
    if (action === 'keep' || action === 'cut') out.push({ flagId, action });
    else if (action === 'reword') {
      if (typeof text !== 'string' || !text.trim()) throw new DecisionsError(`${at}: a reword needs "text".`);
      out.push({ flagId, action, text });
    } else throw new DecisionsError(`${at}: "action" must be keep, cut or reword.`);
  });
  return out;
}

/** --decisions takes a JSON array or the path of a file holding one. */
export function parseDecisionsArg(arg: string, cwd: string = process.cwd()): Decision[] {
  const trimmed = arg.trim();
  let text = trimmed;
  if (!trimmed.startsWith('[')) {
    const path = resolvePath(cwd, trimmed);
    if (!fileExists(path)) throw new DecisionsError(`--decisions: "${arg}" is neither a JSON array nor a file.`);
    text = readFileSync(path, 'utf8');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new DecisionsError(`--decisions is not valid JSON: ${(err as Error).message}`);
  }
  return validateDecisions(json);
}

/** A decide() for runNoro that answers from the decisions; flags left out are kept. */
export function decideFrom(decisions: Decision[]): (f: { id: string }) => Promise<Decision> {
  const byId = new Map(decisions.map((d) => [d.flagId, d]));
  return async (f) => byId.get(f.id) ?? { flagId: f.id, action: 'keep' };
}
