// Harness wiring: one chat client per writing step from NORO_MODEL /
// NORO_DRAFT_MODEL / NORO_PANEL_MODEL, and `decisions` reruns only deliver
// from the finished run's checkpoint, with no model call. No network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { UsageError, runNoro } from '../../src/harness/index.js';
import type { StepName } from '../../src/harness/index.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { ChatClient } from '../../src/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = 'fixtures/exports/google-ads.csv';
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-providers-'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('per-step chat clients', () => {
  it('draft and revise go to NORO_DRAFT_MODEL, the panel to NORO_PANEL_MODEL', async () => {
    const mock = createMockChat();
    const seen: { url: string; model: string; system: string }[] = [];
    vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url: String(url), model: body.model, system: body.messages[0].content });
      expect(body).not.toHaveProperty('temperature');
      const content = await mock.complete({ model: body.model, system: body.messages[0].content, user: body.messages[1].content, json: !!body.response_format || body.messages[1].content.endsWith('Reply with only the JSON object, no other text.') });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch);
    const config = { ...loadConfig({ NORO_MODEL: 'ollama:writer-a', NORO_PANEL_MODEL: 'lmstudio:panel-b' }), apiKey: undefined };
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { jev: createMockJev() } });
    expect(report.summary.models).toEqual({ draft: 'ollama:writer-a', panel: 'lmstudio:panel-b' });
    const panelCalls = seen.filter((s) => s.system.startsWith('You are the reviewer'));
    expect(panelCalls.length).toBeGreaterThan(0);
    for (const c of panelCalls) expect([c.url, c.model]).toEqual(['http://localhost:1234/v1/chat/completions', 'panel-b']);
    const draftCalls = seen.filter((s) => !s.system.startsWith('You are the reviewer') && s.model === 'writer-a');
    expect(draftCalls.length).toBeGreaterThan(0);
    for (const c of draftCalls) expect(c.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('names the classifier in the summary and to onClassifier', async () => {
    const config = { ...loadConfig({}), apiKey: undefined };
    let named = '';
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() }, onClassifier: (d) => (named = d) });
    expect(named).toBe('canned test classifier (NORO_MOCK_MODELS=1)'); // what actually ran, not the configured jev
    expect(report.summary.classifier).toBe(named);
    expect(report).not.toHaveProperty('_deliverInput');
  });
});

describe('decisions', () => {
  const config = { ...loadConfig({}), apiKey: undefined };
  const noModel: ChatClient = {
    async complete() {
      throw new Error('a model was called');
    },
  };

  it('reruns deliver alone from the finished run, with no model call', async () => {
    const stateDir = tmp();
    const first = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients: { chat: createMockChat(), jev: createMockJev() } });
    const quoted = first.flags.find((f) => f.quote && first.text.includes(f.quote));
    expect(quoted, 'the fixture run has a flag with a quote').toBeDefined();

    const steps: StepName[] = [];
    const jev = createMockJev();
    const jevSpy = vi.spyOn(jev, 'decide');
    // Same run identity as the first run: injected clients on both.
    const second = await runNoro({
      file: FIXTURE,
      cwd: ROOT,
      config,
      stateDir,
      clients: { chat: noModel, jev },
      decisions: [{ flagId: quoted!.id, action: 'cut' }],
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['deliver']);
    expect(jevSpy).not.toHaveBeenCalled();
    expect(second.summary.resumed).toBe(true);
    expect(second.text).not.toContain(quoted!.quote);
    expect(second.decisions.find((d) => d.flagId === quoted!.id)?.action).toBe('cut');
    expect(second.decisions.filter((d) => d.flagId !== quoted!.id).every((d) => d.action === 'keep')).toBe(true);
    expect(second).not.toHaveProperty('_deliverInput');

    // Choices apply to the original run each time, not on top of the last rerun.
    const third = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients: { chat: noModel, jev }, decisions: [] });
    expect(third.text).toBe(first.text);
  });

  it('refuses flags the run does not have, and malformed decisions', async () => {
    const stateDir = tmp();
    await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients: { chat: createMockChat(), jev: createMockJev() } });
    const again = (decisions: unknown) => runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir, clients: { chat: noModel, jev: createMockJev() }, decisions: decisions as never });
    await expect(again([{ flagId: 'F999', action: 'cut' }])).rejects.toThrow(/F999/);
    await expect(again([{ flagId: 'F1', action: 'delete' }])).rejects.toBeInstanceOf(UsageError);
    await expect(again([{ flagId: 'F1', action: 'reword' }])).rejects.toThrow(/needs text/);
  });

  it('without a finished run, runs the whole pipeline and applies them', async () => {
    const steps: StepName[] = [];
    const report = await runNoro({ file: FIXTURE, cwd: ROOT, config, stateDir: tmp(), clients: { chat: createMockChat(), jev: createMockJev() }, decisions: [], onStep: (s) => steps.push(s) });
    expect(steps[0]).toBe('ingest');
    expect(report.decisions.every((d) => d.action === 'keep')).toBe(true);
  });
});
