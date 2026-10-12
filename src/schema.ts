// Shared types for the whole pipeline. docs/schema.md describes the standard
// schema in prose; keep the two in step. The core rule: code computes every
// number (Fact), models only ever see and cite fact ids.

// ---------------------------------------------------------------- 1. ingest

/** One row of an export after the platform adapter has mapped it. */
export interface Row {
  /** ISO date (YYYY-MM-DD) when the export is daily; otherwise undefined and `period` is set. */
  date?: string;
  /** Free-form period label when the export is not daily, e.g. "2026-W40" or "2026-09". */
  period?: string;
  platform: string;
  account: string;
  campaign: string;
  /** Ad group (Google Ads), ad set (Meta) or line item (Amazon DSP). */
  adGroup?: string;
  /** Major currency units. Adapters convert micros. */
  spend: number;
  impressions: number;
  clicks: number;
  /** The platform's primary conversions column (Google Ads "Conversions", not "All conv."). */
  conversions: number;
  /** Major currency units. */
  conversionValue: number;
  /** Platform-specific fields the schema doesn't name, keyed by the adapter's field name. */
  extra: Record<string, string | number>;
}

export type SchemaField =
  | 'date'
  | 'period'
  | 'account'
  | 'campaign'
  | 'adGroup'
  | 'spend'
  | 'impressions'
  | 'clicks'
  | 'conversions'
  | 'conversionValue';

/** Schema field (or `extra.<name>`) → raw column header in the export. */
export type ColumnMapping = Partial<Record<SchemaField, string>> & { extra?: Record<string, string> };

export interface Dataset {
  /** Source file path as given. */
  source: string;
  platform: string;
  /** Adapter id, e.g. "google-ads", or "guessed" when the user confirmed a guessed mapping. */
  adapter: string;
  currency: string;
  mapping: ColumnMapping;
  rows: Row[];
  /** Non-fatal notes from ingest (skipped total rows, coerced values, micros converted). */
  warnings: string[];
}

// ---------------------------------------------------------------- 2. compute

/** Matches the engine ledger's number kinds (docs/engine.md). */
export type FactKind = 'currency' | 'percent' | 'pp' | 'multiplier' | 'count' | 'ratio';

export type FactFlag = 'divide_by_zero' | 'small_sample' | 'no_baseline';

export interface Fact {
  /** "f1", "f2", ... stable within one run. Models cite these as {{f12}}. */
  id: string;
  /** Machine key, e.g. "cpa:campaign=PR-03:period=current". Unique per facts table. */
  key: string;
  /** Human label the model sees instead of the value, e.g. "CPA, campaign PR-03, last 7 days". */
  label: string;
  /** null when it can't be computed (divide by zero, missing input). */
  value: number | null;
  kind: FactKind;
  /** Unit as the engine expects: "USD" (or the dataset currency), "%", "pp", "x", or "" for counts. */
  unit: string;
  /** The exact text code renders in the report, e.g. "$61.03", "38%", "4.1x", "790". */
  display: string;
  /** Human-readable formula with inputs, e.g. "spend / conversions = 48213.00 / 790". */
  formula: string;
  /** Fact ids this fact was computed from, or "row:<field>" for sums straight off the rows. */
  inputs: string[];
  /** What the fact is about. Any of these may be absent for account-level facts. */
  scope: { metric: string; campaign?: string; adGroup?: string; period?: 'current' | 'previous' | string; dimension?: string };
  /** Sample behind the fact (conversions for CPA/CVR, clicks for CTR, etc.). */
  sampleSize?: number;
  flags: FactFlag[];
}

export interface FactsTable {
  currency: string;
  /** Labels of the current and comparison windows, e.g. {current: "Oct 6–12", previous: "Sep 29–Oct 5"}. */
  periods: { current: string; previous?: string };
  facts: Fact[];
}

// ---------------------------------------------------------------- 3. classify

export type FactLabel = 'signal' | 'noise' | 'luck_risk';

export interface Classification {
  factId: string;
  label: FactLabel;
  /** 1 = lead with it, 3 = background. */
  priority: 1 | 2 | 3;
  /** Watchout rule ids that apply, e.g. "W-small-sample-size". */
  watchouts: string[];
}

// ---------------------------------------------------------------- 4. draft

export interface Draft {
  /** What the model wrote: prose with {{f12}} references and no raw numbers. */
  template: string;
  /** Template with every {{fN}} replaced by that fact's `display` (done by code). */
  rendered: string;
  /** Fact ids the template cites, in order of first use. */
  factIds: string[];
}

// ---------------------------------------------------------------- 5. check

export interface EngineFinding {
  rule: string;
  name: string;
  category: string;
  severity: 'error' | 'warning' | 'advisory';
  match: string;
  span: [number, number];
  message: string;
  fix: string;
}

export interface CheckReport {
  pass: boolean;
  mode: 'generate' | 'revise';
  /** Numbers in the text that don't trace to a fact (generate) or the original (revise). */
  untraced: { raw: string; value: number; span: [number, number]; nearest?: { id: string; raw: string; delta: number } }[];
  /** null in generate mode: there is no original to be shorter than. */
  length: { original_words: number; rewrite_words: number; shorter: boolean } | null;
  findings: EngineFinding[];
  /** Raw engine JSON, kept for debugging. */
  engine: unknown;
}

// ---------------------------------------------------------------- 6. panel

export interface PanelNote {
  /** Persona file stem, e.g. "media-buyer". */
  persona: string;
  /** The sentence of the report the note is about, quoted exactly, if any. */
  quote?: string;
  note: string;
  severity: 'must' | 'should' | 'consider';
}

// ---------------------------------------------------------------- 7. deliver

export interface Flag {
  id: string;
  source: 'check' | 'panel' | 'watchout';
  /** What the user sees. Never contains a number that isn't a fact display. */
  text: string;
  /** The span of the report the flag is about, if any. */
  quote?: string;
}

export type Decision = { flagId: string; action: 'keep' } | { flagId: string; action: 'cut' } | { flagId: string; action: 'reword'; text: string };

export interface Report {
  /** The final report text the user approved. */
  text: string;
  /** Every number in `text` and the fact it traces to. */
  traces: { raw: string; factId: string }[];
  flags: Flag[];
  decisions: Decision[];
}

// ---------------------------------------------------------------- model clients
// Interfaces so tests can mock both models. Real implementations live in
// src/draft (chat) and src/classify (jev).

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  /** Ask for JSON output. */
  json?: boolean;
}

export interface ChatClient {
  complete(req: ChatRequest): Promise<string>;
}

export interface JevClient {
  /** One call to the decisions endpoint. Shape of state/questions/answers follows the jev guide. */
  decide(req: { model: string; state: Record<string, unknown>; questions: unknown[] }): Promise<unknown>;
}
