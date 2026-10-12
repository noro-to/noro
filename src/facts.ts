// `noro facts <file>`: ingest and compute only. No model, no key, no Python.
// AI tools use it to answer "where does this number come from" without a run.

import { extname, join, resolve } from 'node:path';
import { builtinAdaptersDir } from './adapters/loader.js';
import { computeFacts } from './compute/index.js';
import { ingest } from './ingest/index.js';
import type { IngestOptions } from './ingest/index.js';
import type { FactsTable } from './schema.js';

export const EXPORT_EXTS = new Set(['.csv', '.tsv', '.xlsx']);

export class FactsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactsUsageError';
  }
}

export interface FactsResult extends FactsTable {
  source: string;
  platform: string;
  adapter: string;
  /** Ingest warnings (skipped rows, coerced values, micros suspected). */
  warnings: string[];
}

export interface FactsOptions {
  /** Folder for relative paths and <cwd>/.noro/adapters. Default process.cwd(). */
  cwd?: string;
  confirmMapping?: IngestOptions['confirmMapping'];
}

/** Ingest + compute for one export. Throws FactsUsageError for a written report (.md, .txt). */
export async function factsFor(file: string, opts: FactsOptions = {}): Promise<FactsResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const path = resolve(cwd, file);
  const ext = extname(path).toLowerCase();
  if (!EXPORT_EXTS.has(ext)) {
    throw new FactsUsageError(`noro facts reads exports (.csv, .tsv, .xlsx), not ${ext || 'files without an extension'}. A written report's numbers are checked by \`noro this\`.`);
  }
  const dataset = await ingest(path, { confirmMapping: opts.confirmMapping, adaptersDir: [builtinAdaptersDir(), join(cwd, '.noro', 'adapters')] });
  const table = computeFacts(dataset);
  return { source: path, platform: dataset.platform, adapter: dataset.adapter, ...table, warnings: dataset.warnings };
}

/** The facts as an aligned text table: id, label, display, formula. */
export function formatFacts(r: FactsResult): string {
  const rows = r.facts.map((f) => [f.id, f.label, f.value === null ? `n/a (${f.flags.join(', ') || 'no value'})` : f.display, f.formula]);
  const head = ['id', 'label', 'value', 'formula'];
  const widths = [0, 1, 2].map((i) => Math.min(60, Math.max(head[i].length, ...rows.map((row) => row[i].length))));
  const line = (row: string[]) => row.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c)).join('  ').trimEnd();
  const periods = r.periods.previous ? `${r.periods.current} vs ${r.periods.previous}` : r.periods.current;
  return [`${r.platform} (${r.adapter}), ${r.currency}, ${periods}: ${r.facts.length} facts`, '', line(head), ...rows.map(line)].join('\n');
}
