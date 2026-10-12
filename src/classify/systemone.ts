// The System One request format: POST {base}/v1/systemone with
// {model, state, questions} (questions keyed by id) → {model, answers, usage}.
// Served by OpenRouter, TypeSafe directly, Ollama ≥0.35, llama.cpp and LM Studio.
//
// The key depends on the host, never on which variable happens to be set:
//   openrouter.ai   → OPENROUTER_API_KEY   default model typesafe/jev-1.13
//   api.typesafe.ai → TYPESAFE_API_KEY     default model jev-latest
//   any other host  → no key               model required (NORO_CLASSIFY_MODEL)

import type { Config } from '../config.js';
import type { JevClient } from '../schema.js';
import { ClassifyConfigError, MissingApiKeyError, postJson } from './shared.js';

export const OPENROUTER_CLASSIFY_BASE = 'https://openrouter.ai/api';
export const TYPESAFE_CLASSIFY_BASE = 'https://api.typesafe.ai';
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';
export const TYPESAFE_JEV_MODEL = 'jev-latest';

export type ClassifyHost = 'openrouter' | 'typesafe' | 'other';

/** The classify-related settings, from the Config fields when present, else straight from the env. */
export interface ClassifySettings {
  /** NORO_CLASSIFY, lower-cased; undefined when unset. */
  mode?: string;
  /** NORO_CLASSIFY_BASE_URL as given; undefined when unset. */
  baseUrl?: string;
  /** NORO_CLASSIFY_MODEL when the user set one; undefined means "use the host's default". */
  model?: string;
  openrouterKey?: string;
  typesafeKey?: string;
}

const nonEmpty = (s: unknown): string | undefined => (typeof s === 'string' && s.trim() ? s.trim() : undefined);

/**
 * Read classify settings. B1's Config carries `classify`, `classifyBaseUrl`,
 * `typesafeKey`; when a Config predates those fields, the env fills in.
 * `classifyModel` used to default to typesafe/jev-1.13 inside loadConfig, so
 * that value alone doesn't count as an explicit choice (it is the OpenRouter
 * default anyway); NORO_CLASSIFY_MODEL in the env does.
 */
export function classifySettings(config: Config, env: NodeJS.ProcessEnv = process.env): ClassifySettings {
  const c = config as Config & { classify?: string; classifyBaseUrl?: string; typesafeKey?: string };
  const hasNew = 'classify' in c || 'classifyBaseUrl' in c || 'typesafeKey' in c;
  const pick = (field: 'classify' | 'classifyBaseUrl' | 'typesafeKey', envName: string) =>
    nonEmpty(field in c ? c[field] : hasNew ? undefined : env[envName]);
  const cfgModel = nonEmpty(config.classifyModel);
  return {
    mode: pick('classify', 'NORO_CLASSIFY')?.toLowerCase(),
    baseUrl: pick('classifyBaseUrl', 'NORO_CLASSIFY_BASE_URL'),
    model: (hasNew ? undefined : nonEmpty(env.NORO_CLASSIFY_MODEL)) ?? (cfgModel !== OPENROUTER_JEV_MODEL ? cfgModel : undefined),
    openrouterKey: nonEmpty(config.apiKey),
    typesafeKey: pick('typesafeKey', 'TYPESAFE_API_KEY'),
  };
}

function parseBase(base: string): URL {
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    return u;
  } catch {
    throw new ClassifyConfigError(`NORO_CLASSIFY_BASE_URL is not an http(s) URL: "${base}"`);
  }
}

export function classifyHost(base: string): ClassifyHost {
  const h = parseBase(base).hostname.toLowerCase();
  if (h === 'openrouter.ai' || h.endsWith('.openrouter.ai')) return 'openrouter';
  if (h === 'api.typesafe.ai') return 'typesafe';
  return 'other';
}

/** host[:port] for the CLI footer, e.g. "openrouter.ai", "localhost:11434". */
export function displayHost(base: string): string {
  return parseBase(base).host;
}

/** {base}/v1/systemone; the base may end in /, /v1 or even /v1/systemone. */
export function systemOneUrl(base: string): string {
  parseBase(base);
  const b = base
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/systemone$/i, '')
    .replace(/\/v1$/i, '');
  return `${b}/v1/systemone`;
}

/** The env var whose key goes to this host, or undefined (no key sent). */
export function classifyKeyEnv(base: string): 'OPENROUTER_API_KEY' | 'TYPESAFE_API_KEY' | undefined {
  const h = classifyHost(base);
  return h === 'openrouter' ? 'OPENROUTER_API_KEY' : h === 'typesafe' ? 'TYPESAFE_API_KEY' : undefined;
}

export function defaultClassifyModel(base: string): string | undefined {
  const h = classifyHost(base);
  return h === 'openrouter' ? OPENROUTER_JEV_MODEL : h === 'typesafe' ? TYPESAFE_JEV_MODEL : undefined;
}

/** A System One client. Throws MissingApiKeyError at call time when the host needs a key that isn't set. */
export function createSystemOneClient(opts: { baseUrl: string; apiKey?: string }): JevClient {
  const url = systemOneUrl(opts.baseUrl);
  const keyEnv = classifyKeyEnv(opts.baseUrl);
  const host = classifyHost(opts.baseUrl);
  return {
    async decide(req) {
      if (keyEnv && !opts.apiKey) {
        throw new MissingApiKeyError(`${keyEnv} is not set. Classify uses ${displayHost(opts.baseUrl)}, which needs it. Or set NORO_CLASSIFY=rules.`);
      }
      const questions: Record<string, unknown> = {};
      for (const q of req.questions as { id: string }[]) {
        const { id, ...rest } = q;
        questions[id] = rest;
      }
      const extra: Record<string, string> = host === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/noro-to/noro', 'X-Title': 'noro' } : {};
      return postJson(url, keyEnv ? opts.apiKey : undefined, { model: req.model, state: req.state, questions }, 'jev', extra);
    },
  };
}
