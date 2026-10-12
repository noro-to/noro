// Check: the bridge to the Python engine (engine/noro.py). The engine's CLI
// contract is in docs/engine.md and is not changed here; this module writes temp
// files, runs `check` / `extract` / `grade` as a subprocess and maps the JSON.
//
// generate mode (a draft rendered from the facts table)
//   The ledger is factsToLedger(facts): one confirmed number per non-null fact.
//   The engine requires --original, so the text itself is passed as the
//   original; the engine's length test and its `pass` are ignored.
//   pass = no untraced numbers AND no finding of severity "error".
//   (unconfirmed is always empty: every fact entry is confirmed.)
//   CheckReport.length = null.
//
// revise mode (a pasted report, possibly rewritten)
//   original = input.original, or the text itself when none is given. The
//   ledger is `extract` of the original, plus the facts ledger when facts are
//   given (so a revision may use computed facts). Length applies.
//   pass = no untraced AND rewrite shorter than original AND no "error"
//   finding. The engine's `unconfirmed` list is not part of pass: extract and
//   factsToLedger only write confirmed entries, so it is always empty here;
//   the raw engine JSON keeps it.
//   Note: when the text IS the original, `shorter` is false, so pass is false.
//
// watchouts: when input.watchouts is true, `grade --watchouts` runs on the
// original (revise) or the text (generate) and its watchout findings (category
// "watchout") are appended to findings. They never affect pass.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { ENGINE_CURRENCIES } from '../compute/format.js';
import type { CheckReport, EngineFinding, FactsTable } from '../schema.js';

/** engine/noro.py, resolved from this module (src/check or dist/check), not from cwd. */
export const ENGINE_PATH = fileURLToPath(new URL('../../engine/noro.py', import.meta.url));

export class EngineError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface LedgerEntry {
  id: string;
  raw: string;
  value: number;
  unit: string;
  kind: string;
  context: string;
  span: null;
  origin: string;
  confirmed: boolean;
}

export interface Ledger {
  source: string;
  word_count: number;
  numbers: LedgerEntry[];
}

/**
 * Engine ledger JSON (the shape `extract --out` writes) with one confirmed
 * number per fact that has a value. A currency the engine can't read as
 * currency (anything but USD, EUR, GBP, CAD, AUD) is shown as "1,204 JPY",
 * which the engine reads as a count, so its entry is written as a count.
 */
export function factsToLedger(facts: FactsTable): Ledger {
  const numbers: LedgerEntry[] = [];
  for (const f of facts.facts) {
    if (f.value === null) continue;
    let kind: string = f.kind;
    let unit = f.unit;
    if (kind === 'currency' && !ENGINE_CURRENCIES.has(unit.toUpperCase())) {
      kind = 'count';
      unit = '';
    }
    numbers.push({
      id: f.id,
      raw: f.display,
      value: f.value,
      unit,
      kind,
      context: f.label,
      span: null,
      origin: 'facts',
      confirmed: true,
    });
  }
  return { source: 'facts', word_count: 0, numbers };
}

interface EngineRun {
  code: number;
  json: any;
  stdout: string;
  stderr: string;
}

/** Run engine/noro.py with args. Exit 0 and 2 are results; exit 1 (or anything else) throws EngineError. */
export function runEngine(args: string[], python?: string): Promise<EngineRun> {
  const py = python || loadConfig().python;
  return new Promise((resolve, reject) => {
    const child = spawn(py, [ENGINE_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err) =>
      reject(new EngineError(`could not run ${py} ${ENGINE_PATH}: ${err.message}`, null, stderr, stdout)),
    );
    child.on('close', (code) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      if ((code === 0 || code === 2) && json !== undefined) {
        resolve({ code, json, stdout, stderr });
        return;
      }
      const why = json && typeof json.error === 'string' ? json.error : stderr.trim() || stdout.trim() || 'no output';
      reject(new EngineError(`engine ${args[0]} failed (exit ${code}): ${why}`, code, stderr, stdout));
    });
  });
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'noro-check-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mapUntraced(list: any[]): CheckReport['untraced'] {
  return (list ?? []).map((u) => ({
    raw: String(u.raw),
    value: Number(u.value),
    span: [u.span[0], u.span[1]] as [number, number],
    ...(u.nearest ? { nearest: { id: String(u.nearest.id), raw: String(u.nearest.raw), delta: Number(u.nearest.delta) } } : {}),
  }));
}

function rulesArgs(rulesPath?: string): string[] {
  return rulesPath ? ['--rules', rulesPath] : [];
}

export interface CheckInput {
  text: string;
  mode: 'generate' | 'revise';
  facts?: FactsTable;
  original?: string;
  python?: string;
  rulesPath?: string;
  watchouts?: boolean;
}

/** Gate a report: every number traces, no error-severity rule fires (and, in revise mode, it got shorter). */
export async function check(input: CheckInput): Promise<CheckReport> {
  const { text, mode, python, rulesPath } = input;
  if (mode !== 'generate' && mode !== 'revise') throw new Error(`check: unknown mode ${String(mode)}`);
  if (mode === 'generate' && !input.facts) throw new Error('check: generate mode needs the facts table');

  return withTemp(async (dir) => {
    const rewritePath = join(dir, 'rewrite.md');
    const originalPath = join(dir, 'original.md');
    const ledgerPath = join(dir, 'ledger.json');
    const original = mode === 'revise' ? (input.original ?? text) : text;
    await writeFile(rewritePath, text, 'utf8');
    await writeFile(originalPath, original, 'utf8');

    let ledger: Ledger;
    if (mode === 'generate') {
      ledger = factsToLedger(input.facts!);
    } else {
      const ex = await runEngine(['extract', originalPath], python);
      ledger = { source: 'original', word_count: ex.json.word_count, numbers: ex.json.numbers };
      if (input.facts) ledger.numbers.push(...factsToLedger(input.facts).numbers);
    }
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');

    const run = await runEngine(['check', rewritePath, '--ledger', ledgerPath, '--original', originalPath, ...rulesArgs(rulesPath)], python);
    const e = run.json;
    const untraced = mapUntraced(e.untraced);
    const findings: EngineFinding[] = [...(e.tells ?? [])];
    const noErrors = !findings.some((f) => f.severity === 'error');

    let length: CheckReport['length'] = null;
    let pass: boolean;
    if (mode === 'generate') {
      pass = untraced.length === 0 && noErrors;
    } else {
      length = { original_words: e.length.original_words, rewrite_words: e.length.rewrite_words, shorter: e.length.shorter };
      pass = untraced.length === 0 && length.shorter && noErrors;
    }

    let watchoutRun: unknown;
    if (input.watchouts) {
      const g = await runEngine(['grade', mode === 'revise' ? originalPath : rewritePath, '--watchouts', ...rulesArgs(rulesPath)], python);
      watchoutRun = g.json;
      findings.push(...((g.json.watchouts ?? []) as EngineFinding[]));
    }

    return {
      pass,
      mode,
      untraced,
      length,
      findings,
      engine: watchoutRun === undefined ? e : { check: e, grade: watchoutRun },
    };
  });
}

/** Run `grade` on a report and return the engine's JSON (score, verdict, dims, findings, ...). */
export async function grade(text: string, opts: { python?: string; watchouts?: boolean; rulesPath?: string } = {}): Promise<unknown> {
  return withTemp(async (dir) => {
    const p = join(dir, 'report.md');
    await writeFile(p, text, 'utf8');
    const run = await runEngine(['grade', p, ...(opts.watchouts ? ['--watchouts'] : []), ...rulesArgs(opts.rulesPath)], opts.python);
    return run.json;
  });
}
