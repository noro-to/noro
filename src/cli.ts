#!/usr/bin/env node
// noro CLI.
//   noro this <file>      export (.csv, .tsv, .xlsx) → a report; report (.md, .txt) → audit and rewrite
//   noro facts <file>     ingest + compute only: the facts table. No model, no key
//   noro init [--global]  setup wizard: writes .env (or ~/.config/noro/.env)
//   noro doctor           free setup checks; --live makes one tiny paid call per model, after asking
//   noro mcp              stdio MCP server with the tools noro_this and noro_facts
//
// `noro this` flags: --yes keeps every flag without asking; --json prints the
// Report as JSON; --format slack|email|one-page|slide-notes; --accept-warnings
// goes on past an ingest warning that would otherwise stop the run (a cost
// column that looks like micros); --model <provider>:<id> uses that writing
// model for this run only; --decisions <file|json> applies keep/cut/reword
// choices without asking (flags left out are kept).
// Exit codes for `noro this`: 0 delivered, 2 the report can't pass the check
// (the check failed, or a model or a reword kept writing numbers of its own),
// 1 usage or input error. `noro doctor`: 0 all pass, 1 a check failed, 3 some
// items could not be verified.
// Prompts and progress go to stderr, so stdout carries only the report (or its JSON).
//
// Settings: process env, then ./.env, then ~/.config/noro/.env (src/env.ts).
//
// TEST-ONLY: NORO_MOCK_MODELS=1 swaps both models for canned local ones
// (src/harness/mock.ts): no network, no key. Off unless set, and announced.

import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import type { ChatClient, ColumnMapping, Decision, Flag, JevClient } from './schema.js';
import type { GuessedMapping } from './ingest/index.js';
import { homeDir, loadEnvFiles } from './env.js';
import type { EnvLoad } from './env.js';

// node:sqlite (used by Pi Durable's storage) warns that it is experimental on import. Silence that one warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(text ?? '')) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const FORMAT_NAMES = ['slack', 'email', 'one-page', 'slide-notes'];

const USAGE = `Usage:
  noro this <file> [--format ${FORMAT_NAMES.join('|')}] [--yes] [--json]
                   [--model <provider>:<id>] [--decisions <file|json>] [--accept-warnings]
  noro facts <file> [--json]
  noro init [--global]
  noro doctor [--live] [--yes] [--json]
  noro mcp

  this     write a report from an ad-platform export (.csv, .tsv, .xlsx),
           or audit and rewrite a written report (.md, .txt)
  facts    print the facts table (ingest and compute only; no model, no key)
  init     set up keys and models; writes .env here (--global: ~/.config/noro/.env)
  doctor   check the setup for free (--live: one tiny paid call per model, after asking)
  mcp      start the stdio MCP server (tools noro_this, noro_facts)

  --format           output shape (default: one-page)
  --yes, -y          keep every flag without asking (doctor --live: don't ask)
  --json             print the result as JSON
  --model            writing model for this run only, e.g. openrouter:anthropic/claude-opus-5.5
  --decisions        keep/cut/reword choices: a JSON array or a file holding one,
                     e.g. '[{"flagId":"F1","action":"cut"}]'. Flags left out are kept
  --accept-warnings  go on even when the export looks wrong (e.g. cost in micros)

Settings come from the environment, ./.env, then ~/.config/noro/.env. Run \`noro init\` to set up.
Docs: https://github.com/noro-to/noro/tree/main/docs/install`;

type Command = 'this' | 'facts' | 'init' | 'doctor' | 'mcp';
const COMMANDS: Command[] = ['this', 'facts', 'init', 'doctor', 'mcp'];

interface Args {
  command?: Command;
  file?: string;
  yes: boolean;
  json: boolean;
  format?: string;
  model?: string;
  decisions?: string;
  acceptWarnings: boolean;
  global: boolean;
  live: boolean;
  help: boolean;
  version: boolean;
}

/** Which flags each command takes. */
const ALLOWED: Record<Command, Set<string>> = {
  this: new Set(['yes', 'json', 'format', 'model', 'decisions', 'acceptWarnings']),
  facts: new Set(['json']),
  init: new Set(['global']),
  doctor: new Set(['live', 'yes', 'json']),
  mcp: new Set([]),
};

const FLAG_NAMES: Record<string, string> = {
  yes: '--yes',
  json: '--json',
  format: '--format',
  model: '--model',
  decisions: '--decisions',
  acceptWarnings: '--accept-warnings',
  global: '--global',
  live: '--live',
};

function parseArgs(argv: string[]): Args | string {
  const a: Args = { yes: false, json: false, acceptWarnings: false, global: false, live: false, help: false, version: false };
  const used = new Set<string>();
  const rest: string[] = [];
  const value = (i: number, name: string): string | undefined => {
    const v = argv[i];
    return v === undefined || (v.startsWith('-') && !(name === 'decisions' && v.startsWith('['))) ? undefined : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const eq = x.match(/^--(format|model|decisions)=(.*)$/s);
    if (x === '--yes' || x === '-y') (a.yes = true), used.add('yes');
    else if (x === '--json') (a.json = true), used.add('json');
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--version' || x === '-v') a.version = true;
    else if (x === '--accept-warnings') (a.acceptWarnings = true), used.add('acceptWarnings');
    else if (x === '--global') (a.global = true), used.add('global');
    else if (x === '--live') (a.live = true), used.add('live');
    else if (eq) {
      const name = eq[1] as 'format' | 'model' | 'decisions';
      a[name] = eq[2];
      used.add(name);
    } else if (x === '--format' || x === '--model' || x === '--decisions') {
      const name = x.slice(2) as 'format' | 'model' | 'decisions';
      const v = value(i + 1, name);
      if (v === undefined) return name === 'format' ? `--format needs a value: ${FORMAT_NAMES.join(', ')}.` : name === 'model' ? '--model needs a value like openrouter:anthropic/claude-opus-5.5.' : '--decisions needs a JSON array or a file.';
      a[name] = v;
      used.add(name);
      i++;
    } else if (x.startsWith('-')) return `Unknown option ${x}`;
    else rest.push(x);
  }
  if (a.help || a.version) return a;
  if (a.model !== undefined && a.model.trim() === '') return '--model needs a value like openrouter:anthropic/claude-opus-5.5 (or a provider name, e.g. claude-cli).';
  if (a.decisions !== undefined && a.decisions.trim() === '') return '--decisions needs a JSON array or a file.';
  if (a.format !== undefined && !FORMAT_NAMES.includes(a.format)) {
    return a.format === '' ? `--format needs a value: ${FORMAT_NAMES.join(', ')}.` : `Unknown format "${a.format}". Valid formats: ${FORMAT_NAMES.join(', ')}.`;
  }
  if (!rest.length) return 'Missing command.';
  if (!COMMANDS.includes(rest[0] as Command)) return `Unknown command "${rest[0]}". Did you mean "noro this <file>"?`;
  a.command = rest[0] as Command;
  for (const f of used) if (!ALLOWED[a.command].has(f)) return `${FLAG_NAMES[f]} doesn't apply to "noro ${a.command}".`;
  if (a.command === 'this' || a.command === 'facts') {
    if (!rest[1]) return 'Missing <file>.';
    if (rest.length > 2) return `Unexpected argument "${rest[2]}".`;
    a.file = rest[1];
  } else if (rest.length > 1) return `Unexpected argument "${rest[1]}".`;
  return a;
}

let rl: Interface | undefined;
const ask = async (q: string): Promise<string> => {
  rl ??= createInterface({ input: process.stdin, output: process.stderr });
  return (await rl.question(q)).trim();
};

async function interactiveDecide(flag: Flag): Promise<Decision> {
  process.stderr.write(`\n[${flag.id} · ${flag.source}] ${flag.text}\n`);
  if (flag.quote) process.stderr.write(`  > ${flag.quote}\n`);
  for (;;) {
    const a = (await ask('  keep, cut or reword? [k/c/r] ')).toLowerCase();
    if (a === '' || a === 'k' || a === 'keep') return { flagId: flag.id, action: 'keep' };
    if (a === 'c' || a === 'cut') return { flagId: flag.id, action: 'cut' };
    if (a === 'r' || a === 'reword') {
      const text = await ask('  new sentence, replaces the whole sentence (cite numbers as {{f12}} or exactly as shown): ');
      if (text) return { flagId: flag.id, action: 'reword', text };
    }
  }
}

async function interactiveMapping(g: GuessedMapping): Promise<ColumnMapping | null> {
  process.stderr.write('\nNo adapter recognised this export. Guessed mapping:\n');
  for (const [field, header] of Object.entries(g.mapping)) {
    if (field !== 'extra') process.stderr.write(`  ${field.padEnd(16)} ← ${String(header)}\n`);
  }
  if (g.unmapped.length) process.stderr.write(`  unmapped: ${g.unmapped.join(', ')}\n`);
  const a = (await ask('Use this mapping? [y/N] ')).toLowerCase();
  return a === 'y' || a === 'yes' ? g.mapping : null;
}

async function confirmWarnings(warnings: string[]): Promise<boolean> {
  process.stderr.write(`\nThe export looks wrong:\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`);
  const a = (await ask('Report on it anyway? [y/N] ')).toLowerCase();
  return a === 'y' || a === 'yes';
}

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The canned test models, when NORO_MOCK_MODELS=1. */
async function mockClients(): Promise<{ chat: ChatClient; jev: JevClient } | undefined> {
  const mock = process.env.NORO_MOCK_MODELS === '1';
  if (!mock) return undefined;
  process.stderr.write('noro: NORO_MOCK_MODELS=1, using canned test models (test-only; no network, no key).\n');
  const m = await import('./harness/mock.js');
  return { chat: m.createMockChat({ hangDraft: process.env.NORO_MOCK_HANG === 'draft' }), jev: m.createMockJev() };
}

async function cmdThis(parsed: Args): Promise<number> {
  const file = parsed.file!;
  let decisions: Decision[] | undefined;
  const pre = await import('./preflight.js');
  if (parsed.decisions !== undefined) {
    try {
      decisions = pre.parseDecisionsArg(parsed.decisions);
    } catch (err) {
      process.stderr.write(`noro: ${(err as Error).message}\n`);
      return 1;
    }
  }
  const { loadConfig } = await import('./config.js');
  let config;
  try {
    config = loadConfig(process.env, parsed.model ? { model: parsed.model } : {});
  } catch (err) {
    process.stderr.write(`noro: ${(err as Error).message}\n`);
    return 1;
  }
  if (!existsSync(file)) {
    process.stderr.write(`noro: can't find ${file}\n`);
    return 1;
  }

  const clients = await mockClients();
  let classifier;
  try {
    classifier = pre.classifierFor(config, process.env, clients);
  } catch (err) {
    process.stderr.write(`noro: ${(err as Error).message}\n`);
    return 1;
  }
  if (!clients) {
    const problems = pre.missingForRun(config, classifier, process.env);
    if (problems.length) {
      process.stderr.write(`${problems.map((p) => `noro: ${p}`).join('\n')}\n${pre.SETUP_HINT}\n`);
      return 1;
    }
  }
  // Node and Python before any paid call.
  try {
    config = { ...config, python: pre.preflight(process.env).python };
  } catch (err) {
    process.stderr.write(`noro: ${(err as Error).message}\n`);
    return 1;
  }

  // Say which writing model runs, so a --model value that resolved to a default is never silent.
  const writerDescribe = clients?.chat
    ? 'canned test models (NORO_MOCK_MODELS=1)'
    : config.panelModel === config.draftModel
      ? config.draftModel
      : `${config.draftModel} (panel: ${config.panelModel})`;
  const interactive = !parsed.yes && !decisions && process.stdin.isTTY === true;
  if (!parsed.yes && !decisions && !interactive) process.stderr.write('noro: no terminal to ask in, so every flag is kept (pass --yes to say so).\n');
  const { runNoro, exitCodeFor } = await import('./harness/index.js');
  type RunInput = Parameters<typeof runNoro>[0];
  const { FORMATS } = await import('./draft/prompts.js');
  // FORMAT_NAMES is a static copy for usage text; keep it honest.
  if (FORMAT_NAMES.join() !== Object.keys(FORMATS).join()) throw new Error('cli FORMAT_NAMES out of sync with FORMATS');
  try {
    const input: RunInput = {
      file,
      config,
      clients,
      format: parsed.format,
      acceptWarnings: parsed.acceptWarnings,
      confirmWarnings: interactive ? confirmWarnings : undefined,
      decide: decisions ? pre.decideFrom(decisions) : interactive ? interactiveDecide : async (f) => ({ flagId: f.id, action: 'keep' }),
      ...(decisions ? { decisions } : {}),
      confirmMapping: process.stdin.isTTY && !decisions ? interactiveMapping : undefined,
      onStep: (s) => {
        process.stderr.write(`noro: ${s}\n`);
        if (s === 'classify') process.stderr.write(`noro: classify with ${classifier.describe}\n`);
        if (s === 'draft') process.stderr.write(`noro: write with ${writerDescribe}\n`);
      },
    };
    const report = await runNoro(input);
    for (const w of report.warnings) process.stderr.write(`noro: warning: ${w}\n`);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ...report, classifier: report.summary.classifier ?? classifier.describe }, null, 2)}\n`);
    } else {
      const s = report.summary;
      const words = s.words.original !== undefined ? `, ${s.words.original} → ${s.words.final} words` : '';
      const kept = report.decisions.filter((d) => d.action === 'keep').length;
      process.stdout.write(`${report.text}\n\n---\n`);
      const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
      process.stdout.write(`Checked: ${n(s.checked, 'number')} traced${words}. Panel: ${n(s.panel.notes, 'note')}, ${s.panel.applied} applied.\n`);
      process.stdout.write(`Classify: ${report.summary.classifier ?? classifier.describe}.\n`);
      if (report.flags.length) process.stdout.write(`Flags: ${report.flags.length} (${kept} kept, ${report.flags.length - kept} cut or reworded).\n`);
    }
    return 0;
  } catch (err) {
    const e = err as Error;
    const code = exitCodeFor(err);
    process.stderr.write(`noro: ${code === 2 && e.name === 'RawNumberError' ? "the report can't pass the check: " : ''}${e.message}\n`);
    return code;
  } finally {
    rl?.close();
  }
}

async function cmdFacts(parsed: Args): Promise<number> {
  const { factsFor, formatFacts } = await import('./facts.js');
  if (!existsSync(parsed.file!)) {
    process.stderr.write(`noro: can't find ${parsed.file}\n`);
    return 1;
  }
  try {
    const r = await factsFor(parsed.file!, { confirmMapping: process.stdin.isTTY ? interactiveMapping : undefined });
    for (const w of r.warnings) process.stderr.write(`noro: warning: ${w}\n`);
    process.stdout.write(parsed.json ? `${JSON.stringify(r, null, 2)}\n` : `${formatFacts(r)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`noro: ${(err as Error).message}\n`);
    return 1;
  } finally {
    rl?.close();
  }
}

async function cmdDoctor(parsed: Args, envLoad: EnvLoad): Promise<number> {
  const { runDoctor, formatDoctor } = await import('./doctor/index.js');
  const clients = parsed.live ? await mockClients() : undefined;
  const result = await runDoctor({
    env: process.env,
    envLoad,
    live: parsed.live,
    yes: parsed.yes,
    ask: process.stdin.isTTY ? async (q) => ['y', 'yes'].includes((await ask(q)).toLowerCase()) : undefined,
    clients,
    progress: (l) => process.stderr.write(`noro: ${l}\n`),
  });
  rl?.close();
  process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatDoctor(result)}\n`);
  return result.exitCode;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n\n${USAGE}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  const baseEnv = { ...process.env };
  const home = homeDir();
  if (parsed.command === 'init') {
    const { runInit, terminalPrompter } = await import('./init/index.js');
    return (await runInit({ home, baseEnv, global: parsed.global, prompter: terminalPrompter() })).exitCode;
  }
  const envLoad = loadEnvFiles(process.cwd(), home);
  switch (parsed.command) {
    case 'this':
      return cmdThis(parsed);
    case 'facts':
      return cmdFacts(parsed);
    case 'doctor':
      return cmdDoctor(parsed, envLoad);
    case 'mcp': {
      const { runMcpServer } = await import('./mcp/index.js');
      await runMcpServer();
      return -1; // keeps running until stdin closes
    }
    default:
      return 1;
  }
}

// Never process.exit() right after a write: on a pipe, stdout drains
// asynchronously once the pipe buffer (64 KiB) is full, and exit() would cut
// the output short. Set the exit code and let the event loop drain. Once
// stdout and stderr have flushed, an unref'd timer ends a process that some
// library handle would otherwise keep alive; it never fires while a write is
// still pending.
function finish(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      setTimeout(() => process.exit(code), 1000).unref();
    });
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) finish(code);
  },
  (err) => {
    process.stderr.write(`noro: ${(err as Error)?.stack ?? String(err)}\n`);
    finish(1);
  },
);
