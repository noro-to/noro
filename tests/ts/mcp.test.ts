// noro mcp: the tools noro_this and noro_facts, in process over an in-memory transport (raw
// JSON-RPC, no client package), plus the real stdio server: stdout carries protocol only.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createMockChat, createMockJev } from '../../src/harness/mock.js';
import type { MockLog } from '../../src/harness/mock.js';
import { createNoroMcpServer } from '../../src/mcp/index.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');
const tmp = () => mkdtempSync(join(tmpdir(), 'noro-mcp-'));

type Msg = { jsonrpc: '2.0'; id?: number; method?: string; params?: any; result?: any; error?: any };

/** A minimal JSON-RPC client over the linked in-memory transports. */
async function connect(deps: Parameters<typeof createNoroMcpServer>[0]) {
  const server = createNoroMcpServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (m: Msg) => void>();
  const notifications: Msg[] = [];
  clientSide.onmessage = (m) => {
    const msg = m as Msg;
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    } else notifications.push(msg);
  };
  await server.connect(serverSide);
  await clientSide.start();
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<Msg>((done) => {
      const n = ++id;
      pending.set(n, done);
      void clientSide.send({ jsonrpc: '2.0', id: n, method, ...(params ? { params } : {}) } as never);
    });
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
  return { request, notifications, init, close: () => server.close() };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('noro mcp (in process)', () => {
  const config = { ...loadConfig({}), apiKey: undefined, python: 'python3' };

  it('lists noro_this and noro_facts with their inputs', async () => {
    const c = await connect({ config });
    close = c.close;
    expect(c.init.result.serverInfo.name).toBe('noro');
    const tools = (await c.request('tools/list')).result.tools as { name: string; inputSchema: any }[];
    expect(tools.map((t) => t.name).sort()).toEqual(['noro_facts', 'noro_this']);
    const this_ = tools.find((t) => t.name === 'noro_this')!;
    expect(Object.keys(this_.inputSchema.properties).sort()).toEqual(['decisions', 'format', 'path']);
    expect(this_.inputSchema.required).toEqual(['path']);
  });

  it('noro_facts returns the facts table, with no model and no key', async () => {
    const c = await connect({ config });
    close = c.close;
    const r = (await c.request('tools/call', { name: 'noro_facts', arguments: { path: FIXTURE } })).result;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.facts[0]).toMatchObject({ id: 'f1', label: expect.any(String), display: expect.any(String), formula: expect.any(String) });
    expect(r.content[0].text).toMatch(/^f1\t/m);
  });

  it('relative paths are refused', async () => {
    const c = await connect({ config });
    close = c.close;
    const r = (await c.request('tools/call', { name: 'noro_facts', arguments: { path: 'fixtures/exports/google-ads.csv' } })).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/absolute/);
  });

  it('noro_this: report, traces, flags, summary; then decisions applied on the second call', async () => {
    const log: MockLog = { chat: [], jev: [] };
    const logs: string[] = [];
    const c = await connect({ config, clients: { chat: createMockChat({ log }), jev: createMockJev(log) }, cwd: tmp(), log: (l) => logs.push(l) });
    close = c.close;
    const first = (await c.request('tools/call', { name: 'noro_this', arguments: { path: FIXTURE, format: 'slack' }, _meta: { progressToken: 'p1' } })).result;
    expect(first.isError, first.content?.[0]?.text).toBeFalsy();
    const s = first.structuredContent;
    expect(s.text).toEqual(expect.any(String));
    expect(s.traces.length).toBeGreaterThan(0);
    expect(s.summary.checked).toBe(s.traces.length);
    expect(s.flags.length).toBeGreaterThan(0);
    expect(s.decisions.every((d: { action: string }) => d.action === 'keep')).toBe(true);
    expect(s.classifier).toMatch(/^jev/);
    expect(logs).toContain('noro: deliver');
    const progress = c.notifications.filter((n) => n.method === 'notifications/progress');
    expect(progress.map((n) => n.params.message)).toEqual(['ingest', 'compute', 'classify', 'draft', 'check', 'panel', 'deliver']);

    const flag = s.flags[0];
    const second = (await c.request('tools/call', { name: 'noro_this', arguments: { path: FIXTURE, format: 'slack', decisions: [{ flagId: flag.id, action: 'cut' }] } })).result;
    expect(second.isError, second.content?.[0]?.text).toBeFalsy();
    expect(second.structuredContent.decisions.find((d: { flagId: string }) => d.flagId === flag.id)).toEqual({ flagId: flag.id, action: 'cut' });
    // The text lists what was applied, and no longer asks for decisions.
    expect(first.content[0].text).toContain('Flags (all kept; ask the user keep, cut or reword');
    const secondText = second.content[0].text as string;
    expect(secondText).toContain('Flags (decisions applied):');
    expect(secondText).not.toContain('ask the user');
    expect(secondText).not.toContain('all kept');
    expect(secondText).toContain(`- ${flag.id} [${flag.source}] cut: `);
    if (s.flags.length > 1) expect(secondText).toContain(`- ${s.flags[1].id} [${s.flags[1].source}] kept: `);
  });

  it('a reword without text is refused before the run', async () => {
    const c = await connect({ config, clients: { chat: createMockChat(), jev: createMockJev() }, cwd: tmp() });
    close = c.close;
    const r = (await c.request('tools/call', { name: 'noro_this', arguments: { path: FIXTURE, decisions: [{ flagId: 'F1', action: 'reword' }] } })).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/needs "text"/);
  });

  it('a missing writer key is an actionable error, not a crash', async () => {
    const c = await connect({ config: loadConfig({ NORO_MODEL: 'anthropic:claude-opus-5-5', NORO_CLASSIFY: 'rules' }), cwd: tmp() });
    close = c.close;
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = (await c.request('tools/call', { name: 'noro_this', arguments: { path: FIXTURE } })).result;
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/ANTHROPIC_API_KEY is not set[\s\S]*noro init/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('noro mcp (stdio)', () => {
  it('stdout carries only JSON-RPC while a run writes progress to stderr', async () => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli.ts'), 'mcp'], {
      cwd: tmp(),
      env: { PATH: process.env.PATH, HOME: tmp(), NORO_MOCK_MODELS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const done = new Promise<void>((resolveDone) => {
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.includes('"id":2')) resolveDone();
      });
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'noro_this', arguments: { path: FIXTURE } } });
    await done;
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    const lines = stdout.trim().split('\n');
    for (const l of lines) expect(() => JSON.parse(l), l).not.toThrow();
    const result = JSON.parse(lines.find((l) => l.includes('"id":2'))!).result;
    expect(result.isError, result.content?.[0]?.text).toBeFalsy();
    expect(result.structuredContent.traces.length).toBeGreaterThan(0);
    expect(stderr).toContain('noro: deliver');
  }, 60_000);
});
