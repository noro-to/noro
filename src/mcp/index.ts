// `noro mcp`: a stdio MCP server in the same package as the CLI.
//
// Tools:
//   noro_this   {path (absolute), format?, decisions?} → the report text, traces, flags and run summary
//   noro_facts  {path (absolute)}                      → the facts table (no model, no key)
//
// stdout carries only MCP protocol messages. Progress goes to stderr, and as
// MCP progress notifications when the client sent a progress token. The run
// is in-process (runNoro), so checkpoints and resume work as in the CLI: the
// first call keeps every flag and lists them; the agent asks the user and calls
// again with `decisions`.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import type { Transport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Config } from '../config.js';
import { factsFor } from '../facts.js';
import { homeDir, loadEnvFiles } from '../env.js';
import { classifierFor, decideFrom, missingForRun, preflight, SETUP_HINT } from '../preflight.js';
import type { ChatClient, Decision, Flag, JevClient } from '../schema.js';

const FORMATS = ['one-page', 'slack', 'email', 'slide-notes'] as const;

export interface McpDeps {
  /** Config for runs; default loadConfig() at call time. */
  config?: Config;
  /** Injected model clients (tests). NORO_MOCK_MODELS=1 also gives the canned ones. */
  clients?: { chat?: ChatClient; jev?: JevClient };
  /** Folder for state (.noro) and adapters. Default process.cwd(). */
  cwd?: string;
  /** Progress lines. Default stderr. Never stdout. */
  log?: (line: string) => void;
  /** Override the Python lookup (tests). */
  python?: string;
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APPLIED: Record<Decision['action'], string> = { keep: 'kept', cut: 'cut', reword: 'reworded' };

/**
 * The flag list under the report text. Without decisions every flag was kept and
 * the agent should ask the user; with decisions, each flag's applied action.
 */
export function flagSummary(flags: Flag[], decisions?: Decision[]): string {
  const line = (f: Flag) => `${f.text}${f.quote ? `\n  > ${f.quote}` : ''}`;
  if (!decisions) {
    return `Flags (all kept; ask the user keep, cut or reword, then call again with decisions):\n${flags.map((f) => `- ${f.id} [${f.source}] ${line(f)}`).join('\n')}`;
  }
  const byId = new Map(decisions.map((d) => [d.flagId, d]));
  return `Flags (decisions applied):\n${flags
    .map((f) => {
      const d = byId.get(f.id);
      const action = APPLIED[d?.action ?? 'keep'];
      return `- ${f.id} [${f.source}] ${action}${d?.action === 'reword' ? ` as "${d.text}"` : ''}: ${line(f)}`;
    })
    .join('\n')}`;
}

export function createNoroMcpServer(deps: McpDeps = {}): McpServer {
  const log = deps.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const server = new McpServer({ name: 'noro', version: version() });

  server.registerTool(
    'noro_this',
    {
      title: 'Write or audit a paid-media report',
      description:
        'Generate a short paid-media report from an ad-platform export (.csv, .tsv, .xlsx: Google Ads, Meta, Amazon DSP), ' +
        'or audit and rewrite an existing report (.md, .txt). Every number is computed by code and traced to a fact; never edit numbers yourself. ' +
        'The first call keeps every flag and returns them in `flags`: show each to the user with its `sentence`, ask keep, cut or reword, then call again with `decisions` ' +
        '(cut removes the whole sentence; a reword replaces the whole sentence) ' +
        '(only the deliver step reruns). A run takes a few minutes.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the export or report'),
        format: z.enum(FORMATS).optional().describe('Output shape. Default one-page'),
        decisions: z
          .array(
            z.object({
              flagId: z.string().describe('A flag id from the first call, e.g. F1'),
              action: z.enum(['keep', 'cut', 'reword']),
              text: z.string().optional().describe('For a reword: a full sentence that replaces the whole sentence the flag is about (its `sentence`). Only numbers already in the report'),
            }),
          )
          .optional()
          .describe('Keep, cut or reword choices from the user. Flags left out are kept'),
      }),
    },
    async ({ path, format, decisions }, ctx) => {
      if (!isAbsolute(path)) return text(`path must be absolute, got "${path}".`, true);
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let step = 0;
      let describe = '';
      const onStep = (s: string) => {
        log(`noro: ${s}`);
        if (s === 'classify') log(`noro: classify with ${describe}`);
        if (progressToken !== undefined) {
          ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: ++step, total: 7, message: s } }).catch(() => {});
        }
      };
      let decisionList: Decision[] | undefined;
      try {
        decisionList = decisions?.map((d) => {
          if (d.action === 'reword') {
            if (!d.text?.trim()) throw new Error(`decision for ${d.flagId}: a reword needs "text"`);
            return { flagId: d.flagId, action: 'reword' as const, text: d.text };
          }
          return { flagId: d.flagId, action: d.action };
        });
      } catch (err) {
        return text((err as Error).message, true);
      }

      try {
        const { loadConfig } = await import('../config.js');
        let config = deps.config ?? loadConfig();
        const mock = process.env.NORO_MOCK_MODELS === '1';
        let clients = deps.clients;
        if (!clients && mock) {
          const m = await import('../harness/mock.js');
          clients = { chat: m.createMockChat(), jev: m.createMockJev() };
        }
        const classifier = classifierFor(config, process.env, clients);
        describe = classifier.describe;
        if (!clients?.chat) {
          const problems = missingForRun(config, clients?.jev ? {} : classifier, process.env);
          if (problems.length) return text(`${problems.join('\n')}\n${SETUP_HINT}`, true);
        }
        config = { ...config, python: deps.python ?? preflight(process.env).python };
        const { runNoro } = await import('../harness/index.js');
        type RunInput = Parameters<typeof runNoro>[0];
        const input: RunInput = {
          file: path,
          cwd: deps.cwd,
          config,
          clients,
          format,
          decide: decideFrom(decisionList ?? []),
          ...(decisionList ? { decisions: decisionList } : {}),
          onStep,
        };
        const report = await runNoro(input);
        const structured = {
          text: report.text,
          traces: report.traces,
          flags: report.flags,
          decisions: report.decisions,
          summary: report.summary,
          warnings: report.warnings,
          classifier: report.summary.classifier ?? classifier.describe,
        };
        const flagLines = report.flags.length ? `\n\n${flagSummary(report.flags, decisionList ? report.decisions : undefined)}` : '';
        return { content: [{ type: 'text' as const, text: `${report.text}${flagLines}` }], structuredContent: structured };
      } catch (err) {
        const e = err as Error;
        if (e.name === 'CheckFailedError' || e.name === 'RawNumberError') return text(`The report can't pass the number check: ${e.message}`, true);
        return text(e.message, true);
      }
    },
  );

  server.registerTool(
    'noro_facts',
    {
      title: 'Look up the facts table',
      description:
        'Run ingest and compute only on an ad-platform export and return every fact: id, label, display value and formula. ' +
        'No model and no key. Use it to answer "where does this number come from".',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the export (.csv, .tsv, .xlsx)'),
      }),
    },
    async ({ path }) => {
      if (!isAbsolute(path)) return text(`path must be absolute, got "${path}".`, true);
      try {
        const r = await factsFor(path, { cwd: deps.cwd });
        const facts = r.facts.map((f) => ({ id: f.id, label: f.label, display: f.value === null ? null : f.display, formula: f.formula, flags: f.flags }));
        const structured = { source: r.source, platform: r.platform, currency: r.currency, periods: r.periods, warnings: r.warnings, facts };
        const lines = facts.map((f) => `${f.id}\t${f.label}\t${f.display ?? 'n/a'}\t${f.formula}`);
        return { content: [{ type: 'text' as const, text: `${r.platform}, ${r.currency}, ${facts.length} facts\nid\tlabel\tvalue\tformula\n${lines.join('\n')}` }], structuredContent: structured };
      } catch (err) {
        return text((err as Error).message, true);
      }
    },
  );

  return server;
}

/** Start the stdio server: settings from the env files, then serve until stdin closes. */
export async function runMcpServer(transport?: Transport): Promise<void> {
  loadEnvFiles(process.cwd(), homeDir());
  const server = createNoroMcpServer();
  let t = transport;
  if (!t) {
    const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
    t = new StdioServerTransport();
    // Stdin closed: close the server and let pending stdout writes drain
    // (process.exit() here could cut a reply short). The unref'd timer only
    // ends a process that a library handle keeps alive.
    process.stdin.on('end', () => {
      process.exitCode = 0;
      server.close().catch(() => {}).finally(() => {
        process.stdout.write('', () => setTimeout(() => process.exit(0), 1000).unref());
      });
    });
  }
  await server.connect(t);
  process.stderr.write(`noro: MCP server ready on stdio (noro ${version()})\n`);
}
