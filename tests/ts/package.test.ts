// Regressions for the v0.2 hardening review of packaging: Node engines, the prepare script and
// type-checking the tests in lint.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

describe('defects 8 and 9: engines and prepare', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  it('requires Node 22.19+ and builds on install', () => {
    expect(pkg.engines.node).toBe('>=22.19.0');
    expect(pkg.scripts.prepare).toBe('npm run build');
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain('Node 22.19+ (Node 24 recommended)');
  });
  it('lint type-checks the tests and the fixture generator', () => {
    expect(pkg.scripts.lint).toContain('tsconfig.test.json');
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.test.json'), 'utf8'));
    expect(tsconfig.include).toEqual(expect.arrayContaining(['tests/ts/**/*.ts', 'fixtures/generate.ts']));
  });
});


describe('v0.2 distribution: the npm package', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  it('is published as @noro-to/noro with the noro command', () => {
    expect(pkg.name).toBe('@noro-to/noro');
    expect(pkg.bin).toEqual({ noro: 'dist/cli.js' });
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(pkg.scripts.prepack).toContain('npm run build');
    expect(pkg.repository.url).toContain('github.com/noro-to/noro');
  });
  it('ships the runtime files and no source maps', () => {
    for (const f of ['dist', '!dist/**/*.map', 'engine/noro.py', 'engine/rules.json', 'personas', '.env.example']) expect(pkg.files).toContain(f);
    expect(pkg.files).not.toContain('engine');
    expect(pkg.files).not.toContain('src');
    for (const f of ['engine/noro.py', 'engine/rules.json', 'personas', '.env.example']) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });
  it('the lockfile carries the same name', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    expect(lock.name).toBe('@noro-to/noro');
    expect(lock.packages[''].name).toBe('@noro-to/noro');
  });
});
