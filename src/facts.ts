// `noro facts <file> [file…]`: ingest and compute only. No model, no key, no Python.
// AI tools use it to answer "where does this number come from" without a run.
// Several exports give the combined cross-channel facts table, exactly as
// `noro this` with the same files computes it.

import { basename, extname, join, resolve } from 'node:path';
import { builtinAdaptersDir } from './adapters/loader.js';
import { computeFacts } from './compute/index.js';
import { ingestAll } from './ingest/index.js';
import type { IngestOptions } from './ingest/index.js';
import type { DatasetSource, FactsTable } from './schema.js';

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
  /** One entry per export: file, platform, adapter, currency, rows (plus its mapping and own warnings). */
  sources: DatasetSource[];
}

export interface FactsOptions {
  /** Folder for relative paths and <cwd>/.noro/adapters. Default process.cwd(). */
  cwd?: string;
  confirmMapping?: IngestOptions['confirmMapping'];
}

/**
 * Ingest + compute for one export, or several combined into one cross-channel table.
 * Throws FactsUsageError for a written report (.md, .txt).
 */
export async function factsFor(file: string | string[], opts: FactsOptions = {}): Promise<FactsResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const paths = (typeof file === 'string' ? [file] : file).map((f) => resolve(cwd, f));
  if (!paths.length) throw new FactsUsageError('noro facts needs an export (.csv, .tsv, .xlsx).');
  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    if (!EXPORT_EXTS.has(ext)) {
      throw new FactsUsageError(
        `noro facts reads exports (.csv, .tsv, .xlsx), not ${ext || 'files without an extension'}${paths.length > 1 ? ` (${basename(path)})` : ''}. A written report's numbers are checked by \`noro this\`, on its own.`,
      );
    }
  }
  const dataset = await ingestAll(paths, { confirmMapping: opts.confirmMapping, adaptersDir: [builtinAdaptersDir(), join(cwd, '.noro', 'adapters')] });
  const table = computeFacts(dataset);
  return { source: paths.length === 1 ? paths[0] : dataset.source, platform: dataset.platform, adapter: dataset.adapter, ...table, warnings: dataset.warnings, sources: dataset.sources ?? [] };
}

/** "google-ads.csv (Google Ads, 56 rows), meta.csv (Meta, 56 rows)": what a combined run read. */
export function sourceLine(sources: DatasetSource[]): string {
  return sources.map((s) => `${basename(s.file)} (${s.platform}, ${s.rows} row${s.rows === 1 ? '' : 's'})`).join(', ');
}

/** The facts as an aligned text table: id, label, display, formula. */
export function formatFacts(r: FactsResult): string {
  const rows = r.facts.map((f) => [f.id, f.label, f.value === null ? `n/a (${f.flags.join(', ') || 'no value'})` : f.display, f.formula]);
  const head = ['id', 'label', 'value', 'formula'];
  const widths = [0, 1, 2].map((i) => Math.min(60, Math.max(head[i].length, ...rows.map((row) => row[i].length))));
  const line = (row: string[]) => row.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c)).join('  ').trimEnd();
  const periods = r.periods.previous ? `${r.periods.current} vs ${r.periods.previous}` : r.periods.current;
  const sources = (r.sources?.length ?? 0) > 1 ? [`Sources: ${sourceLine(r.sources)}`] : [];
  return [`${r.platform} (${r.adapter}), ${r.currency}, ${periods}: ${r.facts.length} facts`, ...sources, '', line(head), ...rows.map(line)].join('\n');
}
