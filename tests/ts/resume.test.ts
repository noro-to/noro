// Resume: each step is a checkpointed phase of a Pi Durable task in SQLite.
// Stop after classify (what a kill looks like to Pi Durable: the Harness
// closes with the checkpoint committed), rerun the same input, and ingest,
// compute and classify must not run again. No network, no key.

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { STEPS, StopAfterError, runNoro } from '../../src/harness/index.js';
import type { StepName } from '../../src/harness/index.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = 'fixtures/exports/google-ads.csv';
const config = { ...loadConfig({}), apiKey: undefined };

describe('resume', () => {
  it('stopAfter classify, rerun: ingest and compute are not re-executed, and the run completes', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'noro-resume-'));
    const log: MockLog = { chat: [], jev: [] };
    const clients = { chat: createMockChat({ log }), jev: createMockJev(log) };

    const first: StepName[] = [];
    await expect(
      runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients, stopAfter: 'classify', onStep: (s) => first.push(s) }),
    ).rejects.toBeInstanceOf(StopAfterError);
    expect(first).toEqual(['ingest', 'compute', 'classify']);
    expect(readdirSync(join(stateDir, 'runs')).filter((f) => f.endsWith('.sqlite'))).toHaveLength(1);
    const jevCalls = log.jev.length;
    expect(jevCalls).toBeGreaterThan(0);
    expect(log.chat).toHaveLength(0);

    const second: StepName[] = [];
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients, onStep: (s) => second.push(s) });
    expect(second).toEqual(['draft', 'check', 'panel', 'deliver']);
    expect(second).not.toContain('ingest');
    expect(second).not.toContain('compute');
    expect(log.jev.length).toBe(jevCalls); // classify's jev calls were not repeated
    expect(report.summary.resumed).toBe(true);
    expect(report.text.length).toBeGreaterThan(0);
    expect(report.traces.length).toBeGreaterThan(0);

    // A finished run is not reused: the same input runs fresh.
    const third: StepName[] = [];
    const again = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients, onStep: (s) => third.push(s) });
    expect(third).toEqual([...STEPS]);
    expect(again.summary.resumed).toBe(false);
    expect(again.text).toBe(report.text);
  });

  it('resumes from any step: stop after draft, rerun continues at check with the same draft', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'noro-resume-'));
    let drafts = 0;
    const chat = createMockChat({
      draft: (req) => {
        drafts++;
        return `CPA for PR-07 Prospecting rose {{${req.user.match(/\{\{(f\d+)\}\} \| CPA, campaign PR-07 Prospecting, percent change/)![1]}}}.\nNext: the media buyer reviews PR-07 Prospecting bids by Friday.`;
      },
    });
    const clients = { chat, jev: createMockJev() };
    await expect(runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients, stopAfter: 'draft' })).rejects.toBeInstanceOf(StopAfterError);
    expect(drafts).toBe(1);
    const steps: StepName[] = [];
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients, onStep: (s) => steps.push(s) });
    expect(steps).toEqual(['check', 'panel', 'deliver']);
    expect(drafts).toBe(1); // the checkpointed draft was used, not a new model call
    expect(report.text).toContain('PR-07 Prospecting rose +');
  });

  it('a different input is a different run', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'noro-resume-'));
    const clients = { chat: createMockChat(), jev: createMockJev() };
    await expect(runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients, stopAfter: 'compute' })).rejects.toBeInstanceOf(StopAfterError);
    const steps: StepName[] = [];
    await runNoro({ file: 'fixtures/exports/meta.csv', cwd: ROOT, config, stateDir, clients, onStep: (s) => steps.push(s) });
    expect(steps[0]).toBe('ingest');
    // The google-ads run is still waiting where it stopped.
    const resumed: StepName[] = [];
    await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients, onStep: (s) => resumed.push(s) });
    expect(resumed[0]).toBe('classify');
  });

  it('a real kill (SIGKILL mid-draft) resumes at draft through the CLI', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'noro-kill-'));
    const env = { ...process.env, NORO_MOCK_MODELS: '1', NORO_STATE_DIR: stateDir, OPENROUTER_API_KEY: '' };
    const run = (extra: Record<string, string>, killAt?: string) =>
      new Promise<{ code: number | null; steps: string[]; stdout: string }>((done) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'this', FIXTURE, '--yes'], { cwd: ROOT, env: { ...env, ...extra } });
        let err = '';
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => {
          err += d;
          if (killAt && err.includes(`noro: ${killAt}\n`)) child.kill('SIGKILL');
        });
        child.on('close', (code) => done({ code, steps: [...err.matchAll(/^noro: (\w+)$/gm)].map((m) => m[1]), stdout }));
      });
    const killed = await run({ NORO_MOCK_HANG: 'draft' }, 'draft');
    expect(killed.code).toBeNull(); // killed by the signal
    expect(killed.steps).toEqual(['ingest', 'compute', 'classify', 'draft']);
    const resumed = await run({});
    expect(resumed.code).toBe(0);
    expect(resumed.steps).toEqual(['draft', 'check', 'panel', 'deliver']);
    expect(resumed.stdout).toMatch(/Checked: \d+ numbers traced/);
  }, 60_000);
});
