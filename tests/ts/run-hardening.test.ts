// Regressions for the v0.2 hardening review of the run and the CLI: ingest warnings, the micros
// stop, --format, exit codes, the run key, the footer and <cwd>/.noro/adapters. No network, no
// API key: models are mocked, the check is the real engine.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { RawNumberError } from '../../src/draft/index.js';
import { CheckFailedError, UsageError, exitCodeFor, runKeyFor, runNoro } from '../../src/harness/index.js';
import type { NoroReport } from '../../src/harness/index.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import { IngestWarningError, ingest } from '../../src/ingest/index.js';
import type { CheckReport } from '../../src/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');
const config = { ...loadConfig({}), apiKey: undefined };
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-run-'));

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('npx', ['tsx', 'src/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OPENROUTER_API_KEY: '', NORO_STATE_DIR: tmp(), NORO_MOCK_MODELS: '1', ...env },
    timeout: 120_000,
  });

describe('defect 5: ingest warnings reach the report; a micros-looking cost stops the run', () => {
  const MICROS = join(ROOT, 'tests/ts/fixtures/ga-micros-as-cost.csv');

  it('runNoro returns the ingest warnings', async () => {
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() } });
    expect(report.warnings.some((w) => /Header row found on line 3/.test(w))).toBe(true);
  });

  it('stops before any model call unless accepted', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const clients = { chat: createMockChat({ log }), jev: createMockJev(log) };
    await expect(runNoro({ file: MICROS, cwd: ROOT, config, stateDir: tmp(), clients })).rejects.toBeInstanceOf(IngestWarningError);
    expect(log.chat).toHaveLength(0);
    expect(log.jev).toHaveLength(0);
    // Declined interactively: same.
    await expect(runNoro({ file: MICROS, cwd: ROOT, config, stateDir: tmp(), clients, confirmWarnings: async () => false })).rejects.toBeInstanceOf(IngestWarningError);
    expect(log.jev).toHaveLength(0);
    // Confirmed, or accepted up front: the run goes on and the warning is in the report.
    const asked: string[][] = [];
    const a = await runNoro({ file: MICROS, cwd: ROOT, config, stateDir: tmp(), clients, confirmWarnings: async (w) => (asked.push(w), true) });
    expect(asked[0].join()).toMatch(/looks like micros/);
    const b = await runNoro({ file: MICROS, cwd: ROOT, config, stateDir: tmp(), clients, acceptWarnings: true });
    for (const r of [a, b]) expect(r.warnings.some((w) => /looks like micros/.test(w))).toBe(true);
  });

  it('CLI: exit 1 with a clear error, or --accept-warnings with warnings on stderr and in --json', () => {
    const stopped = cli(['this', MICROS, '--yes']);
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toMatch(/looks like micros/);
    expect(stopped.stderr).toContain('--accept-warnings');
    expect(stopped.stderr).not.toContain('noro: classify');
    const ok = cli(['this', MICROS, '--yes', '--json', '--accept-warnings']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stderr).toMatch(/noro: warning: .*looks like micros/);
    expect((JSON.parse(ok.stdout) as NoroReport).warnings.some((w) => /looks like micros/.test(w))).toBe(true);
  });
});

describe('defect 10: unknown --format is a usage error', () => {
  it('CLI exits 1 and lists the valid formats', () => {
    for (const args of [['--format', 'bogus'], ['--format=bogus'], ['--format']]) {
      const r = cli(['this', 'fixtures/exports/google-ads.csv', '--yes', ...args]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('slack, email, one-page, slide-notes');
      expect(r.stderr).not.toContain('noro: ingest');
    }
  });
  it('runNoro throws UsageError', async () => {
    await expect(runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), format: 'bogus', clients: { chat: createMockChat(), jev: createMockJev() } })).rejects.toBeInstanceOf(UsageError);
  });
});

describe("defect 11: a RawNumberError after retries exits 2 (the report can't pass the check)", () => {
  it('maps errors to exit codes', () => {
    expect(exitCodeFor(new RawNumberError('x', 'raw_number', []))).toBe(2);
    expect(exitCodeFor(new CheckFailedError('x', { pass: false } as CheckReport))).toBe(2);
    expect(exitCodeFor(new IngestWarningError(['w']))).toBe(1);
    expect(exitCodeFor(new Error('x'))).toBe(1);
  });
  it('CLI: a rewrite that keeps a number word exits 2', () => {
    const dir = tmp();
    const file = join(dir, 'update.md');
    // The canned reviser keeps the first half of the sentences, so "doubled" stays in its rewrite.
    writeFileSync(file, 'Brand spend doubled this week. CPA held at $30. Next we review bids. Then we report back.\n');
    const r = cli(['this', file, '--yes']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("can't pass the check");
  });
});

describe('defect 12: mock mode is part of the run key', () => {
  it('real, injected and NORO_MOCK_MODELS runs never share a key', () => {
    const keys = new Set([
      runKeyFor(FIXTURE, 'generate', 'one-page', config),
      runKeyFor(FIXTURE, 'generate', 'one-page', config, { mock: true }),
      runKeyFor(FIXTURE, 'generate', 'one-page', config, { injected: { chat: true, jev: true } }),
      runKeyFor(FIXTURE, 'generate', 'one-page', config, { injected: { chat: true, jev: true }, mock: true }),
    ]);
    expect(keys.size).toBe(4);
    expect(runKeyFor(FIXTURE, 'generate', 'one-page', config, { mock: true })).toBe(runKeyFor(FIXTURE, 'generate', 'one-page', config, { mock: true }));
  });
});

describe('nits: CLI footer and adapters', () => {
  it('the footer says "1 note", not "1 notes"', () => {
    const r = cli(['this', 'fixtures/exports/google-ads.csv', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Panel: 1 note, \d+ applied\./);
  });

  it('<cwd>/.noro/adapters loads when cwd is not process.cwd()', async () => {
    const cwd = tmp();
    const unknown = join(ROOT, 'fixtures/exports/unknown-platform.csv');
    mkdirSync(join(cwd, '.noro', 'adapters'), { recursive: true });
    await ingest(unknown, { confirmMapping: async (g) => g.mapping, saveAdapterAs: join(cwd, '.noro', 'adapters', 'tiktok.yaml') });
    expect(resolve(cwd)).not.toBe(process.cwd());
    const report = await runNoro({ file: unknown, cwd, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() } });
    expect(report.traces.length).toBeGreaterThan(0);
  });
});
