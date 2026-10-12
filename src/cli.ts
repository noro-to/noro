#!/usr/bin/env node
// noro CLI: `noro this <export.csv|.xlsx|report.md>`.
//   export (.csv, .tsv, .xlsx) → generate a report (ingest … deliver)
//   report (.md, .txt)         → revision mode, entering at check
// Flags: --yes keeps every flag without asking; --json prints the Report as
// JSON; --format slack|email|one-page|slide-notes.
// Exit codes: 0 delivered, 2 the check can't pass, 1 usage or input error.
// Prompts go to stderr, so stdout carries only the report (or its JSON).
//
// TEST-ONLY: NORO_MOCK_MODELS=1 swaps both models for canned local ones
// (src/harness/mock.ts): no network, no key. Off unless set, and announced.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import type { ColumnMapping, Decision, Flag } from './schema.js';
import type { GuessedMapping } from './ingest/index.js';

// node:sqlite (used by Pi Durable's storage) warns that it is experimental on import. Silence that one warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(text ?? '')) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const USAGE = `Usage: noro this <file> [--yes] [--json] [--format slack|email|one-page|slide-notes]

  <file>  an ad-platform export (.csv, .tsv, .xlsx) to report on,
          or a written report (.md, .txt) to audit and rewrite.

  --yes     keep every flag without asking
  --json    print the final report as JSON
  --format  output shape (default: one-page)

Needs OPENROUTER_API_KEY (in the environment or in .env in this folder).`;

/** Load KEY=value lines from .env without overriding what the environment already has. */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

interface Args {
  file?: string;
  yes: boolean;
  json: boolean;
  format?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const a: Args = { yes: false, json: false, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--yes' || x === '-y') a.yes = true;
    else if (x === '--json') a.json = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--format') a.format = argv[++i];
    else if (x.startsWith('--format=')) a.format = x.slice('--format='.length);
    else if (x.startsWith('-')) return `Unknown option ${x}`;
    else rest.push(x);
  }
  if (a.help) return a;
  if (rest[0] !== 'this') return rest.length ? `Unknown command "${rest[0]}". Did you mean "noro this <file>"?` : 'Missing command.';
  if (!rest[1]) return 'Missing <file>.';
  if (rest.length > 2) return `Unexpected argument "${rest[2]}".`;
  a.file = rest[1];
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
      const text = await ask('  new words (cite numbers as {{f12}} or exactly as shown): ');
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
  loadDotEnv(join(process.cwd(), '.env'));
  const { loadConfig } = await import('./config.js');
  const config = loadConfig();
  const file = parsed.file!;
  if (!existsSync(file)) {
    process.stderr.write(`noro: can't find ${file}\n`);
    return 1;
  }

  const mock = process.env.NORO_MOCK_MODELS === '1';
  let clients: { chat?: import('./schema.js').ChatClient; jev?: import('./schema.js').JevClient } | undefined;
  if (mock) {
    process.stderr.write('noro: NORO_MOCK_MODELS=1, using canned test models (test-only; no network, no key).\n');
    const m = await import('./harness/mock.js');
    clients = { chat: m.createMockChat({ hangDraft: process.env.NORO_MOCK_HANG === 'draft' }), jev: m.createMockJev() };
  } else if (!config.apiKey) {
    process.stderr.write(
      'noro: OPENROUTER_API_KEY is not set. The classify step (jev) always uses OpenRouter' +
        (config.writer === 'claude-cli' ? '; your writing steps use Claude Code.\n' : ', and so do the writing steps unless NORO_WRITER=claude-cli.\n') +
        '  Get a key at https://openrouter.ai/settings/keys, then either\n' +
        '    cp .env.example .env   and put the key in .env, or\n' +
        '    export OPENROUTER_API_KEY=sk-or-...\n',
    );
    return 1;
  }

  const interactive = !parsed.yes && process.stdin.isTTY === true;
  if (!parsed.yes && !interactive) process.stderr.write('noro: no terminal to ask in, so every flag is kept (pass --yes to say so).\n');
  const { runNoro, CheckFailedError } = await import('./harness/index.js');
  try {
    const report = await runNoro({
      file,
      config,
      clients,
      format: parsed.format,
      decide: interactive ? interactiveDecide : async (f) => ({ flagId: f.id, action: 'keep' }),
      confirmMapping: process.stdin.isTTY ? interactiveMapping : undefined,
      onStep: (s) => process.stderr.write(`noro: ${s}\n`),
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const s = report.summary;
      const words = s.words.original !== undefined ? `, ${s.words.original} → ${s.words.final} words` : '';
      const kept = report.decisions.filter((d) => d.action === 'keep').length;
      process.stdout.write(`${report.text}\n\n---\n`);
      process.stdout.write(`Checked: ${s.checked} numbers traced${words}. Panel: ${s.panel.notes} notes, ${s.panel.applied} applied.\n`);
      if (report.flags.length) process.stdout.write(`Flags: ${report.flags.length} (${kept} kept, ${report.flags.length - kept} cut or reworded).\n`);
    }
    return 0;
  } catch (err) {
    const e = err as Error;
    if (err instanceof CheckFailedError) {
      process.stderr.write(`noro: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`noro: ${e.message}\n`);
    return 1;
  } finally {
    rl?.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`noro: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  },
);
