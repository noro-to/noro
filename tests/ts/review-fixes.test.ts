// Regressions from the final v0.2 review: each test pins one defect that shipped once.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');
const tmp = (p = 'noro-review-') => mkdtempSync(join(tmpdir(), p));

/** A clean environment for a CLI child: no real keys, a fake HOME. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^NORO_|^AWS_|^GOOGLE_|^AZURE_/.test(k)) clean[k] = v;
  return { ...clean, HOME: tmp('noro-home-'), USERPROFILE: '', NORO_STATE_DIR: tmp(), ...extra };
}

const CLI = ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts')];

describe('D1: piped stdout is never cut short', () => {
  // A shell pipe whose reader sleeps before reading: the child fills the 64 KiB pipe buffer and
  // must wait. (A Node parent can't stand in: its stream reads the pipe into memory at once.)
  it.skipIf(process.platform === 'win32')('noro facts --json through a slow-reading pipe prints the whole JSON (> 64 KiB) and exits 0', () => {
    const dir = tmp();
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    const cmd = `(${[process.execPath, ...CLI, 'facts', FIXTURE, '--json'].map(q).join(' ')} 2>/dev/null; echo $? > ${q(join(dir, 'code'))}) | (sleep 2; cat)`;
    const r = spawnSync('sh', ['-c', cmd], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    expect(readFileSync(join(dir, 'code'), 'utf8').trim()).toBe('0');
    expect(r.stdout.length).toBeGreaterThan(64 * 1024);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.facts.length).toBeGreaterThan(100);
  }, 60_000);
});
