// Regressions for the v0.2 hardening review of packaging: Node engines, the prepare script and
// type-checking the tests in lint.

import { readFileSync } from 'node:fs';
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

