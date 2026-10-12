// `noro init --workspace [dir]`: a folder to open in Claude Code, with an inbox.
//
// 1. Copy the template that ships in the package (examples/workspace/) into
//    dir (default ./noro-reports). A file that is already there is never
//    overwritten; it is listed as skipped. npm drops files named .gitignore,
//    so the template stores it as `gitignore` and it is written as .gitignore.
// 2. Copy the skill from skills/noro/SKILL.md (the one the plugin ships) to
//    dir/.claude/skills/noro/SKILL.md. The template's own copy is ignored, so
//    the workspace always gets the skill of the installed noro.
// 3. With --update: refresh CLAUDE.md and the skill from the installed
//    version. A copy that differs is saved first as <file>.bak. Every other
//    file still only gets added when missing.
// 4. Keys: when ~/.config/noro/.env doesn't exist (and not --update), run the
//    normal `noro init` setup with --global on a terminal, or print the next step.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userEnvPath } from '../env.js';
import { runInit } from './index.js';
import type { InitResult, Prompter } from './index.js';

/** The template and the skill, resolved from the installed package (dist/init/ or src/init/ → package root). */
export const WORKSPACE_TEMPLATE_DIR = fileURLToPath(new URL('../../examples/workspace/', import.meta.url));
export const SKILL_SOURCE = fileURLToPath(new URL('../../skills/noro/SKILL.md', import.meta.url));
export const DEFAULT_WORKSPACE = 'noro-reports';

const SKILL_DEST = '.claude/skills/noro/SKILL.md';
/** Workspace files `--update` refreshes from the installed version. */
export const REFRESHED = ['CLAUDE.md', SKILL_DEST];

/** Template path → workspace path (both relative, with forward slashes). */
const destName = (rel: string) => (rel === 'gitignore' ? '.gitignore' : rel);

/** Every file the workspace gets: workspace path (relative, forward slashes) → source file. */
export function workspaceFiles(templateDir = WORKSPACE_TEMPLATE_DIR, skillPath = SKILL_SOURCE): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = destName(relative(templateDir, full).split(/[\\/]/).join('/'));
        if (rel !== SKILL_DEST) out.set(rel, full);
      }
    }
  };
  walk(templateDir);
  out.set(SKILL_DEST, skillPath);
  return out;
}

export interface ScaffoldResult {
  dir: string;
  created: string[];
  /** Already there and left alone. */
  skipped: string[];
  /** Refreshed by --update; `backups` holds the old copies. */
  updated: string[];
  backups: string[];
  /** --update found them identical to the installed version. */
  current: string[];
}

/** The first free name of <file>.bak, <file>.bak2, ... */
function backupName(file: string): string {
  for (let n = 1; ; n++) {
    const b = `${file}.bak${n === 1 ? '' : n}`;
    if (!existsSync(b)) return b;
  }
}

/** Copy the template into dir. Never overwrites, except CLAUDE.md and the skill with `update` (after a .bak). */
export function scaffoldWorkspace(dir: string, opts: { update?: boolean; templateDir?: string; skillPath?: string } = {}): ScaffoldResult {
  const r: ScaffoldResult = { dir, created: [], skipped: [], updated: [], backups: [], current: [] };
  for (const [rel, src] of workspaceFiles(opts.templateDir, opts.skillPath)) {
    const dest = join(dir, ...rel.split('/'));
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      r.created.push(rel);
    } else if (opts.update && REFRESHED.includes(rel) && statSync(dest).isFile()) {
      if (readFileSync(dest).equals(readFileSync(src))) {
        r.current.push(rel);
        continue;
      }
      const bak = backupName(dest);
      copyFileSync(dest, bak);
      copyFileSync(src, dest);
      r.updated.push(rel);
      r.backups.push(relative(dir, bak).split(/[\\/]/).join('/'));
    } else r.skipped.push(rel);
  }
  return r;
}

export interface WorkspaceOptions {
  cwd?: string;
  home: string;
  baseEnv: NodeJS.ProcessEnv;
  /** The workspace folder, relative to cwd. Default ./noro-reports. */
  dir?: string;
  update?: boolean;
  /** True on a terminal: run the key setup when ~/.config/noro/.env is missing. */
  interactive: boolean;
  prompter: Prompter;
  say?: (s: string) => void;
  print?: (s: string) => void;
  fetch?: typeof fetch;
  templateDir?: string;
  skillPath?: string;
}

export interface WorkspaceResult extends InitResult {
  workspace?: ScaffoldResult;
}

export async function runWorkspace(opts: WorkspaceOptions): Promise<WorkspaceResult> {
  const say = opts.say ?? ((s: string) => process.stderr.write(`${s}\n`));
  const cwd = resolve(opts.cwd ?? process.cwd());
  const dir = resolve(cwd, opts.dir ?? DEFAULT_WORKSPACE);
  const templateDir = opts.templateDir ?? WORKSPACE_TEMPLATE_DIR;
  const skillPath = opts.skillPath ?? SKILL_SOURCE;
  const fail = (msg: string): WorkspaceResult => {
    opts.prompter.close();
    say(`noro init: ${msg}`);
    return { exitCode: 1 };
  };
  if (!existsSync(templateDir) || !existsSync(skillPath)) return fail(`this noro install has no workspace template (${existsSync(templateDir) ? skillPath : templateDir}). Reinstall @noro-to/noro.`);
  if (existsSync(dir) && !statSync(dir).isDirectory()) return fail(`${dir} is a file, not a folder.`);
  if (opts.update && !existsSync(dir)) return fail(`${dir} doesn't exist yet. Run \`noro init --workspace${opts.dir ? ` ${opts.dir}` : ''}\` first.`);

  const ws = scaffoldWorkspace(dir, { update: opts.update, templateDir, skillPath });
  say(`noro init: workspace ${dir}`);
  const list = (label: string, files: string[]) => {
    if (files.length) say(`${label}:\n${files.map((f) => `  ${f}`).join('\n')}`);
  };
  list('Created', ws.created);
  ws.updated.forEach((f, i) => say(`Updated ${f} from the installed noro; your old copy is ${ws.backups[i]}`));
  list('Already up to date', ws.current);
  list(opts.update ? 'Left alone' : 'Skipped (already there, not overwritten)', ws.skipped);
  if (!opts.update && ws.skipped.some((f) => REFRESHED.includes(f))) say('To refresh CLAUDE.md and the skill from this noro version, run `noro init --workspace --update`.');
  say('');

  const next = [
    'Next:',
    `  1. Open ${dir} in Claude Code (desktop app: open the folder as a new session; terminal: cd into it and run \`claude\`).`,
    '  2. Drop exports (.csv, .tsv, .xlsx) or reports (.md, .txt) into inbox/.',
    '  3. Type: noro the inbox',
  ].join('\n');
  const hasKeys = existsSync(userEnvPath(opts.home));
  if (hasKeys || opts.update) {
    opts.prompter.close();
    if (!hasKeys) say('No ~/.config/noro/.env yet. Run `noro init --global` to pick a writing model and save your keys.');
    say(next);
    return { exitCode: 0, workspace: ws };
  }
  if (!opts.interactive) {
    opts.prompter.close();
    say('No ~/.config/noro/.env yet. Run `noro init --global` in a terminal to pick a writing model and save your keys, then `noro doctor`.');
    say(next);
    return { exitCode: 0, workspace: ws };
  }
  say('No ~/.config/noro/.env yet, so setting up your writing model and keys now (saved there, so noro finds them from any folder).');
  say('');
  const init = await runInit({ cwd: dir, home: opts.home, baseEnv: opts.baseEnv, global: true, prompter: opts.prompter, say, print: opts.print, fetch: opts.fetch });
  say('');
  say(next);
  return { ...init, workspace: ws };
}
