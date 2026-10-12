// Where noro finds its settings, and how `noro init` writes them.
//
// Each variable comes from the first place that has it:
//   1. the process environment
//   2. .env in the current folder
//   3. ~/.config/noro/.env (on Windows, %USERPROFILE%\.config\noro\.env)
// AI tools often start noro from a folder of their own choosing, which is why
// the user-level file exists: keys stored once reach noro from anywhere.
//
// Secrets never leave this module in clear: callers that show a key show its
// fingerprint() only.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** ~/.config/noro/.env under the given home. */
export function userEnvPath(home: string = homeDir()): string {
  return join(home, '.config', 'noro', '.env');
}

/** The user's home: HOME (or USERPROFILE on Windows), so tests can point it at a temp folder. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, '');
}

/** KEY=value pairs of a .env text, in order. Comments and blank lines are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const m = raw.match(LINE);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** The pairs in a .env file, or {} when it doesn't exist or can't be read. */
export function readEnvFile(file: string): Record<string, string> {
  try {
    return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

export interface EnvSource {
  /** The file, as found. */
  path: string;
  /** Short name for messages: ".env" or "~/.config/noro/.env". */
  label: string;
  /** Every key the file holds (whether or not the environment already had it). */
  keys: string[];
  /** Keys this file supplied (absent from the environment and from earlier files). */
  applied: string[];
}

export interface EnvLoad {
  sources: EnvSource[];
  /** Where each supplied key came from (keys already in the environment are absent). */
  origin: Record<string, string>;
}

/**
 * Merge ./.env, then ~/.config/noro/.env, into `env` without overriding anything already set.
 * Mutates `env` (process.env by default) and reports which file supplied what.
 */
export function loadEnvFiles(cwd: string = process.cwd(), home: string = homeDir(), env: NodeJS.ProcessEnv = process.env): EnvLoad {
  const files: [string, string][] = [
    [join(cwd, '.env'), '.env'],
    [userEnvPath(home), '~/.config/noro/.env'],
  ];
  const sources: EnvSource[] = [];
  const origin: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [path, label] of files) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    const pairs = readEnvFile(path);
    const applied: string[] = [];
    for (const [k, v] of Object.entries(pairs)) {
      if (env[k] !== undefined) continue;
      env[k] = v;
      applied.push(k);
      origin[k] = label;
    }
    sources.push({ path, label, keys: Object.keys(pairs), applied });
  }
  return { sources, origin };
}

/** A key as a short fingerprint: its first five and last four characters ("sk-or...0000"), never the whole value. */
export function fingerprint(value: string | undefined): string {
  if (!value) return '(empty)';
  if (value.length < 16) return `${'*'.repeat(3)}${value.length >= 10 ? value.slice(-2) : ''}`;
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

/** Quote a value for a .env line when it needs it. */
function formatValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Apply `updates` to a .env text: update existing KEY= lines in place (the first one; later
 * duplicates are commented out so they can't win), keep comments and blank lines, append new keys.
 * An update of `null` comments the key out.
 */
export function mergeEnv(text: string, updates: Record<string, string | null>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*#/.test(line) ? null : line.match(LINE);
    if (!m || !(m[1] in updates)) return line;
    const key = m[1];
    const value = updates[key];
    if (done.has(key) || value === null) return `# ${line}`;
    done.add(key);
    const exported = /^\s*export\s+/.test(line) ? 'export ' : '';
    return `${exported}${key}=${formatValue(value)}`;
  });
  const added = Object.entries(updates).filter(([k, v]) => !done.has(k) && v !== null) as [string, string][];
  if (added.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('# Added by noro init');
    for (const [k, v] of added) out.push(`${k}=${formatValue(v)}`);
  }
  return out.length ? out.join(eol) + eol : '';
}

export interface WriteEnvResult {
  path: string;
  /** Set when an older file was saved first. */
  backup?: string;
  /** Keys that changed or were added. */
  changed: string[];
}

/** Merge `updates` into a .env file: back the old one up to <file>.bak, write with mode 600. */
export function writeEnvFile(file: string, updates: Record<string, string | null>): WriteEnvResult {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const old = parseEnv(before);
  const changed = Object.entries(updates)
    .filter(([k, v]) => (v === null ? k in old : old[k] !== v))
    .map(([k]) => k);
  let backup: string | undefined;
  if (existsSync(file)) {
    backup = `${file}.bak`;
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
  }
  writeFileSync(file, mergeEnv(before, updates), { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync keeps the mode of an existing file
  return { path: file, ...(backup ? { backup } : {}), changed };
}

/** True when <dir>/.gitignore has a line that ignores .env. */
export function gitignoreListsEnv(dir: string): boolean {
  const file = join(dir, '.gitignore');
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => ['.env', '/.env', '.env*', '/.env*', '*.env', '**/.env'].includes(l));
}
