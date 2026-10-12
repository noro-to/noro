// noro init --workspace: the Claude Code folder with an inbox. Copies the template from the
// package, never overwrites, copies the skill from skills/noro/SKILL.md, --update refreshes
// CLAUDE.md and the skill with a .bak, settings.json allows only the narrow noro commands, and
// the key setup runs only when ~/.config/noro/.env is missing. Offline: temp folders, no models.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/env.js';
import type { Prompter } from '../../src/init/index.js';
import { DEFAULT_WORKSPACE, runWorkspace, SKILL_SOURCE, WORKSPACE_TEMPLATE_DIR, workspaceFiles } from '../../src/init/workspace.js';

const ROOT = resolve(import.meta.dirname, '../..');
const TEMPLATE = join(ROOT, 'examples', 'workspace');
const SKILL = join(ROOT, 'skills', 'noro', 'SKILL.md');
const KEY = 'sk-or-v1-TOPSECRETTOPSECRET9876';
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-ws-'));
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');
const offline = (async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}) as unknown as typeof fetch;

const TREE = ['CLAUDE.md', 'README.md', '.gitignore', '.claude/settings.json', '.claude/skills/noro/SKILL.md', 'inbox/.gitkeep', 'inbox/done/.gitkeep', 'reports/.gitkeep'];

function scripted(answers: string[] = []) {
  const asked: string[] = [];
  const next = async (q: string) => {
    asked.push(q);
    return answers.shift();
  };
  const p: Prompter = { line: next, secret: next, close() {} };
  return { p, asked };
}

function ws(opts: { cwd?: string; home?: string; dir?: string; update?: boolean; interactive?: boolean; answers?: string[] } = {}) {
  const said: string[] = [];
  const out: string[] = [];
  const s = scripted(opts.answers);
  const cwd = opts.cwd ?? tmp();
  const home = opts.home ?? tmp();
  const promise = runWorkspace({
    cwd,
    home,
    baseEnv: { PATH: '', NORO_STATE_DIR: '.noro' },
    dir: opts.dir,
    update: opts.update,
    interactive: opts.interactive ?? false,
    prompter: s.p,
    say: (x) => said.push(x),
    print: (x) => out.push(x),
    fetch: offline,
  });
  return { promise, cwd, home, said, out, asked: s.asked };
}

/** A home that already has ~/.config/noro/.env. */
function homeWithKeys(): string {
  const home = tmp();
  mkdirSync(join(home, '.config', 'noro'), { recursive: true });
  writeFileSync(join(home, '.config', 'noro', '.env'), `OPENROUTER_API_KEY=${KEY}\n`);
  return home;
}

describe('the template', () => {
  it('resolves from the package and holds the workspace tree', () => {
    expect(resolve(WORKSPACE_TEMPLATE_DIR)).toBe(TEMPLATE);
    expect(resolve(SKILL_SOURCE)).toBe(SKILL);
    expect([...workspaceFiles().keys()].sort()).toEqual([...TREE].sort());
  });

  it("the template's skill copy is the same skill as skills/noro/SKILL.md", () => {
    expect(read(TEMPLATE, '.claude', 'skills', 'noro', 'SKILL.md')).toBe(read(SKILL));
  });

  it('settings.json is valid JSON that allows only the narrow noro commands', () => {
    const settings = JSON.parse(read(TEMPLATE, '.claude', 'settings.json'));
    expect(Object.keys(settings).sort()).toEqual(['$schema', 'permissions']);
    expect(Object.keys(settings.permissions)).toEqual(['allow']);
    const cmds = ['this', 'facts', 'doctor'];
    expect(settings.permissions.allow.sort()).toEqual([...cmds.map((c) => `Bash(noro ${c}:*)`), ...cmds.map((c) => `Bash(npx -y @noro-to/noro ${c}:*)`)].sort());
    for (const rule of settings.permissions.allow) {
      expect(rule).toMatch(/^Bash\((?:noro|npx -y @noro-to\/noro) (?:this|facts|doctor):\*\)$/);
      expect(rule).not.toMatch(/Bash\(\*?\)|Bash\(npx[ :]\*|Bash\(noro[ :]\*/);
    }
  });

  it('.gitignore (stored as gitignore, since npm drops .gitignore) keeps exports, reports, state and keys out', () => {
    const lines = read(TEMPLATE, 'gitignore').split('\n');
    for (const l of ['inbox/', 'reports/', '.noro/', '.env']) expect(lines).toContain(l);
  });

  it('CLAUDE.md documents the inbox workflow, the cap of 3, resuming, inbox/done and the combined report', () => {
    const md = read(TEMPLATE, 'CLAUDE.md');
    for (const s of [
      'noro the inbox',
      'Parallel runs: 3',
      'noro this "inbox/<file>" --json --yes',
      '--decisions',
      'reports/<name>.md',
      'usage limit reached; rerun later',
      'mv "inbox/<file>" "inbox/done/"',
      'reports/combined-<YYYY-MM-DD>.md',
      'noro this "inbox/<file1>" "inbox/<file2>" --json --yes',
    ]) {
      expect(md, s).toContain(s);
    }
    // The one mention is the warning against it (the unscoped package is someone else's).
    expect(md.replace('Never `npx noro`', '')).not.toMatch(/npx (?:-y )?noro\b/);
  });

  it('the package ships the template', () => {
    expect(JSON.parse(read(ROOT, 'package.json')).files).toContain('examples/workspace');
  });
});

describe('noro init --workspace', () => {
  it('creates ./noro-reports with the tree, the skill from skills/noro and .gitignore; prints the next step', async () => {
    const r = ws({ home: homeWithKeys() });
    const res = await r.promise;
    expect(res.exitCode).toBe(0);
    const dir = join(r.cwd, DEFAULT_WORKSPACE);
    for (const f of TREE) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, 'gitignore'))).toBe(false);
    expect(read(dir, '.claude', 'skills', 'noro', 'SKILL.md')).toBe(read(SKILL));
    expect(read(dir, 'CLAUDE.md')).toBe(read(TEMPLATE, 'CLAUDE.md'));
    expect(read(dir, '.gitignore')).toBe(read(TEMPLATE, 'gitignore'));
    expect(res.workspace?.created.sort()).toEqual([...TREE].sort());
    const text = r.said.join('\n');
    expect(text).toMatch(/noro the inbox/);
    expect(text).not.toMatch(/noro init --global/);
    expect(r.asked).toEqual([]);
  });

  it('never overwrites a file that is already there and reports it as skipped', async () => {
    const cwd = tmp();
    const dir = join(cwd, 'reports-folder');
    mkdirSync(join(dir, 'inbox'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), 'my own instructions\n');
    writeFileSync(join(dir, '.gitignore'), 'secret/\n');
    writeFileSync(join(dir, 'inbox', 'google-ads.csv'), 'Day,Cost\n');
    const r = ws({ cwd, dir: 'reports-folder', home: homeWithKeys() });
    const res = await r.promise;
    expect(read(dir, 'CLAUDE.md')).toBe('my own instructions\n');
    expect(read(dir, '.gitignore')).toBe('secret/\n');
    expect(read(dir, 'inbox', 'google-ads.csv')).toBe('Day,Cost\n');
    expect(res.workspace?.skipped.sort()).toEqual(['.gitignore', 'CLAUDE.md']);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md.bak'))).toBe(false);
    const text = r.said.join('\n');
    expect(text).toMatch(/Skipped \(already there, not overwritten\):\n {2}CLAUDE\.md\n {2}\.gitignore/);
    expect(text).toMatch(/noro init --workspace --update/);

    // A second run creates nothing and skips everything.
    const again = await ws({ cwd, dir: 'reports-folder', home: homeWithKeys() }).promise;
    expect(again.workspace?.created).toEqual([]);
    expect(again.workspace?.skipped.length).toBe(TREE.length);
  });

  it('--update refreshes CLAUDE.md and the skill, backs up edited copies as .bak, leaves the rest alone', async () => {
    const cwd = tmp();
    const home = homeWithKeys();
    await ws({ cwd, home }).promise;
    const dir = join(cwd, DEFAULT_WORKSPACE);
    const skill = join(dir, '.claude', 'skills', 'noro', 'SKILL.md');
    writeFileSync(join(dir, 'CLAUDE.md'), 'edited by hand\n');
    writeFileSync(skill, 'an old skill\n');
    writeFileSync(join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(noro this:*)","Read"]}}\n');
    writeFileSync(join(dir, 'README.md'), 'my notes\n');
    writeFileSync(join(dir, 'inbox', 'meta.csv'), 'x\n');

    const r = ws({ cwd, home, update: true });
    const res = await r.promise;
    expect(res.exitCode).toBe(0);
    expect(read(dir, 'CLAUDE.md')).toBe(read(TEMPLATE, 'CLAUDE.md'));
    expect(read(dir, 'CLAUDE.md.bak')).toBe('edited by hand\n');
    expect(read(skill)).toBe(read(SKILL));
    expect(read(`${skill}.bak`)).toBe('an old skill\n');
    expect(res.workspace?.updated.sort()).toEqual(['.claude/skills/noro/SKILL.md', 'CLAUDE.md']);
    expect(res.workspace?.backups.sort()).toEqual(['.claude/skills/noro/SKILL.md.bak', 'CLAUDE.md.bak']);
    // Everything else stays as the user left it.
    expect(read(dir, 'README.md')).toBe('my notes\n');
    expect(read(dir, '.claude', 'settings.json')).toContain('"Read"');
    expect(read(dir, 'inbox', 'meta.csv')).toBe('x\n');
    expect(r.said.join('\n')).toMatch(/Updated CLAUDE\.md from the installed noro; your old copy is CLAUDE\.md\.bak/);

    // Up to date now: no new backup. An older .bak is never overwritten.
    const same = await ws({ cwd, home, update: true }).promise;
    expect(same.workspace?.updated).toEqual([]);
    expect(same.workspace?.current.sort()).toEqual(['.claude/skills/noro/SKILL.md', 'CLAUDE.md']);
    writeFileSync(join(dir, 'CLAUDE.md'), 'edited again\n');
    await ws({ cwd, home, update: true }).promise;
    expect(read(dir, 'CLAUDE.md.bak')).toBe('edited by hand\n');
    expect(read(dir, 'CLAUDE.md.bak2')).toBe('edited again\n');
  });

  it('--update restores a deleted file and refuses a folder that does not exist', async () => {
    const cwd = tmp();
    const home = homeWithKeys();
    const missing = await ws({ cwd, home, update: true }).promise;
    expect(missing.exitCode).toBe(1);
    expect(existsSync(join(cwd, DEFAULT_WORKSPACE))).toBe(false);
    await ws({ cwd, home }).promise;
    const res = await ws({ cwd, home, update: true, dir: DEFAULT_WORKSPACE }).promise;
    expect(res.workspace?.current.length).toBe(2);
  });

  it('without ~/.config/noro/.env and no terminal, prints the next step instead of asking', async () => {
    const r = ws();
    const res = await r.promise;
    expect(res.exitCode).toBe(0);
    expect(r.asked).toEqual([]);
    expect(r.said.join('\n')).toMatch(/Run `noro init --global` in a terminal/);
    expect(existsSync(join(r.home, '.config', 'noro', '.env'))).toBe(false);
  });

  it('without ~/.config/noro/.env on a terminal, runs the normal setup and saves keys globally', async () => {
    const r = ws({ interactive: true, answers: ['2', KEY] });
    const res = await r.promise;
    expect(r.asked[0]).toMatch(/Choose 1-/);
    expect(parseEnv(read(r.home, '.config', 'noro', '.env'))).toEqual({ NORO_MODEL: 'openrouter:anthropic/claude-opus-5.5', OPENROUTER_API_KEY: KEY });
    expect(existsSync(join(r.cwd, DEFAULT_WORKSPACE, '.env'))).toBe(false);
    expect([...r.said, ...r.out].join('\n')).not.toContain(KEY);
    expect(res.doctor).toBeDefined();
    expect(r.said.at(-1)).toMatch(/noro the inbox/);
  });

  it('with ~/.config/noro/.env already there, never asks for keys even on a terminal', async () => {
    const r = ws({ interactive: true, home: homeWithKeys() });
    await r.promise;
    expect(r.asked).toEqual([]);
  });

  it('refuses a path that is a file', async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, 'noro-reports'), 'x');
    const res = await ws({ cwd }).promise;
    expect(res.exitCode).toBe(1);
  });
});

describe('CLI flags', () => {
  const cli = (args: string[], cwd: string, home = tmp()) =>
    spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts'), ...args], {
      cwd,
      encoding: 'utf8',
      input: '',
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      timeout: 60_000,
    });

  it('noro init --workspace <dir> creates the folder; piped stdin prints the next step', () => {
    const cwd = tmp();
    const r = cli(['init', '--workspace', 'my-reports'], cwd);
    expect(r.status).toBe(0);
    expect(existsSync(join(cwd, 'my-reports', '.claude', 'skills', 'noro', 'SKILL.md'))).toBe(true);
    expect(r.stderr).toMatch(/noro init --global/);
    const up = cli(['init', '--workspace', 'my-reports', '--update'], cwd);
    expect(up.status).toBe(0);
    expect(up.stderr).toMatch(/Already up to date/);
  });

  it('rejects --update without --workspace, --global with --workspace, and a second folder', () => {
    const cwd = tmp();
    expect(cli(['init', '--update'], cwd).stderr).toMatch(/--update goes with --workspace/);
    expect(cli(['init', '--workspace', '--global'], cwd).status).toBe(1);
    expect(cli(['init', '--workspace', 'a', 'b'], cwd).stderr).toMatch(/Unexpected argument "b"/);
    expect(cli(['this', 'x.csv', '--workspace'], cwd).stderr).toMatch(/--workspace doesn't apply to "noro this"/);
    expect(existsSync(join(cwd, 'noro-reports'))).toBe(false);
  });
});
