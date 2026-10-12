// Harness: the seven steps as one durable Pi Durable task.
//
// Why a task and not tools: Pi Durable runs tools inside an agent loop, where
// a model decides which tool to call next. noro's order must not be a model's
// choice, so the pipeline is a durable task (defineTask) instead: a state
// machine whose phases are the steps, in an order fixed by this code
// (STEPS below). Pi Durable commits the task's checkpoint after every phase,
// in SQLite at <cwd>/<stateDir>/noro.sqlite. Each phase is "replay safe" in
// the tool sense: if the process dies mid-phase, the next run reruns that
// phase from the last checkpoint, so every step is written to be safe to
// repeat (pure code, or a model call whose output is checked again).
//
// Resume: a run is keyed by a hash of the input file's bytes, the mode, the
// format, the three models and where the models come from (real clients,
// injected ones, or the CLI's NORO_MOCK_MODELS canned ones), so a mock run
// never resumes under real models or the other way round. Rerunning the same input finds the live task
// with that key and waits on it: Pi Durable continues from the last committed
// phase, so completed steps are not executed again (onStep fires only for
// steps that run). A finished or failed run is not reused; the next run of
// the same input starts fresh.
//
// stopAfter: the phase commits its checkpoint, then parks; runNoro closes the
// Harness (which is what a kill looks like to Pi Durable) and throws
// StopAfterError. The next run resumes at the following step.
//
// Revision mode (.md / .txt): the task starts at `check`, with the pasted
// report standing in for the draft.
//
// Ingest warnings travel with the run and come back as NoroReport.warnings.
// A warning that would make every number wrong (a plain cost column that
// looks like micros) stops the run in the ingest step, before any model call,
// unless `acceptWarnings` is set or `confirmWarnings` says yes.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension, defineTask, Harness } from '@earendil-works/pi-durable';
import type { PhaseHandler, TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { builtinAdaptersDir } from '../adapters/loader.js';
import { check, runEngine } from '../check/index.js';
import { resolveClassifier } from '../classify/index.js';
import type { ResolvedClassifier } from '../classify/index.js';
import { computeFacts } from '../compute/index.js';
import { DEFAULT_CLASSIFY_MODEL, loadConfig } from '../config.js';
import type { Config } from '../config.js';
import { draft, reviseDetailed, scrubNumbers, templateQuote, templatize } from '../draft/index.js';
import type { FoundNumber, ReviseResult } from '../draft/index.js';
import { DEFAULT_FORMAT, FORMATS } from '../draft/prompts.js';
import { buildFlags, deliver } from '../deliver/index.js';
import { IngestWarningError, blockingWarnings, ingest } from '../ingest/index.js';
import type { IngestOptions } from '../ingest/index.js';
import { panel } from '../panel/index.js';
import { createChatClientFor, nativeModelId, parseModelRef } from '../providers/index.js';
import type {
  ChatClient,
  CheckReport,
  Classification,
  Dataset,
  Decision,
  Draft,
  FactsTable,
  Flag,
  JevClient,
  PanelNote,
  Report,
} from '../schema.js';

export type StepName = 'ingest' | 'compute' | 'classify' | 'draft' | 'check' | 'panel' | 'deliver';

/** The pipeline order. Code, not a model, decides it. */
export const STEPS: readonly StepName[] = ['ingest', 'compute', 'classify', 'draft', 'check', 'panel', 'deliver'];
const REVISE_ENTRY: StepName = 'check';

export class StopAfterError extends Error {
  constructor(readonly step: StepName) {
    super(`Stopped after ${step} (checkpointed). Run again to resume.`);
    this.name = 'StopAfterError';
  }
}

/** The check could not pass, even after one automatic revision. */
export class CheckFailedError extends Error {
  constructor(
    message: string,
    readonly report: CheckReport,
  ) {
    super(message);
    this.name = 'CheckFailedError';
  }
}

export interface RunSummary {
  mode: 'generate' | 'revise';
  /** Numbers in the final text, each traced to a fact. */
  checked: number;
  words: { original?: number; final: number };
  panel: { notes: number; applied: number };
  /** True when this run continued a checkpointed run (or reused one to apply --decisions). */
  resumed: boolean;
  /** The classifier that labels the facts, e.g. "jev (typesafe/jev-1.13 on openrouter.ai)" or "rules". */
  classifier?: string;
  /** The writing models, as `<provider>:<model-id>`. */
  models?: { draft: string; panel: string };
}

export interface NoroReport extends Report {
  summary: RunSummary;
  /** Ingest warnings (skipped rows, coerced values, micros converted or suspected). Empty in revision mode. */
  warnings: string[];
}

/** A bad argument to runNoro (an unknown format). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RunNoroInput {
  file: string;
  cwd?: string;
  config?: Config;
  clients?: { chat?: ChatClient; jev?: JevClient };
  decide?: (f: Flag) => Promise<Decision>;
  stateDir?: string;
  stopAfter?: StepName;
  onStep?: (s: StepName) => void;
  confirmMapping?: IngestOptions['confirmMapping'];
  /** Output format: slack | email | one-page | slide-notes. Default one-page. Anything else is a UsageError. */
  format?: string;
  /** Go on past ingest warnings that would otherwise stop the run (see blockingWarnings). */
  acceptWarnings?: boolean;
  /** Asked when such a warning stops the run; return true to go on anyway. */
  confirmWarnings?: (warnings: string[]) => Promise<boolean>;
  /**
   * Keep / cut / reword choices, applied without asking (omitted flags are kept; a reword that adds
   * an untraced number is refused). When a finished run of the same input and settings exists, only
   * deliver reruns from its checkpoint: no model call. Wins over `decide`.
   */
  decisions?: Decision[];
  /** Called once, before any step, with the classifier noro picked (for the CLI's "classify:" line). */
  onClassifier?: (describe: string) => void;
}

const REVISION_EXTS = new Set(['.md', '.txt', '.markdown']);

/** Everything a step hands to the next, as committed in the checkpoint. JSON only. */
interface RunData {
  dataset?: Dataset;
  facts?: FactsTable;
  labels?: Classification[];
  draft?: Draft;
  check?: CheckReport;
  /** Revision mode: the pasted report and the identifiers its extractor ignored. */
  original?: string;
  allow?: string[];
  /** Notes the reviser didn't apply: they become flags. */
  notes?: PanelNote[];
  panel?: { notes: number; applied: number };
  /** Ingest warnings, carried to the report. */
  warnings?: string[];
}

type Checkpoint = { phase: StepName; data: RunData };
interface TaskInput {
  runKey: string;
  mode: 'generate' | 'revise';
  file: string;
  format: string;
  [k: string]: string;
}

const TASK_KIND = 'noro.pipeline';
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const lean = (c: CheckReport): CheckReport => ({ ...c, engine: null });

/** Where a run's checkpoints live: <stateDir>/runs/<runKey>.sqlite. */
export function runDbPath(stateDir: string, runKey: string): string {
  return join(stateDir, 'runs', `${runKey}.sqlite`);
}

/** Where the models come from: the configured ones, clients a caller injected, or the CLI's canned mock. */
export interface ModelSource {
  injected?: { chat: boolean; jev: boolean };
  mock?: boolean;
  /** The resolved classifier: its mode, and the System One host for jev. Default: jev on openrouter.ai. */
  classifier?: { mode: string; host?: string };
}

const OPENROUTER_HOST = 'openrouter.ai';
const LEGACY_WRITERS = new Set(['openrouter', 'claude-cli']);

/** The v0.1 spelling of a model on a v0.1 writer: an OpenRouter-style id (claude-cli's old default was anthropic/claude-opus-5.5). */
function legacyModel(provider: string, id: string): string {
  return provider === 'claude-cli' && id === 'claude-opus-5-5' ? 'anthropic/claude-opus-5.5' : id;
}

/**
 * The run's identity: input bytes, mode, format, models, classifier, and where the models come from.
 * A setup v0.1 could express (openrouter or claude-cli for both writing steps, jev on OpenRouter) hashes
 * exactly as v0.1 did, so in-flight runs keep resuming after the upgrade. Anything else adds fields.
 */
export function runKeyFor(file: string, mode: string, format: string, cfg: Config, source: ModelSource = {}): string {
  const h = createHash('sha256');
  const origin = { injected: source.injected ?? { chat: false, jev: false }, mock: source.mock ?? false };
  const d = parseModelRef(cfg.draftModel);
  const p = parseModelRef(cfg.panelModel);
  const classifyModel = cfg.classifyModel ?? DEFAULT_CLASSIFY_MODEL;
  const cls = source.classifier ?? { mode: 'jev', host: OPENROUTER_HOST };
  const key: Record<string, unknown> =
    d.provider === p.provider && LEGACY_WRITERS.has(d.provider)
      ? { v: 2, mode, format, writer: d.provider, models: [legacyModel(d.provider, d.id), legacyModel(p.provider, p.id), classifyModel], origin }
      : { v: 3, mode, format, models: [cfg.draftModel, cfg.panelModel, classifyModel], origin };
  if (cls.mode !== 'jev' || (cls.host ?? OPENROUTER_HOST) !== OPENROUTER_HOST) key.classifier = cls.host ? `${cls.mode}@${cls.host}` : cls.mode;
  const endpoints = [d, p].filter((r) => ['openai-compatible', 'ollama', 'lmstudio'].includes(r.provider));
  if (endpoints.length && cfg.noroBaseUrl) {
    try {
      key.endpoint = new URL(cfg.noroBaseUrl).host; // host only, never a key
    } catch {
      key.endpoint = cfg.noroBaseUrl;
    }
  }
  h.update(JSON.stringify(key));
  h.update(readFileSync(file));
  return h.digest('hex').slice(0, 32);
}

/** The jev host a classifier describe names ("jev (m on host)"), for the run key. */
export function classifierSource(c: ResolvedClassifier): { mode: string; host?: string } {
  if (c.mode !== 'jev') return { mode: c.mode };
  const host = c.describe.match(/ on ([^)\s]+)\)?\s*$/)?.[1];
  return { mode: 'jev', host: host ?? OPENROUTER_HOST };
}

/** Turn a decisions list into a `decide` function, after checking it names real flags. */
function decideFrom(decisions: Decision[]): (f: Flag) => Promise<Decision> {
  const byId = new Map<string, Decision>();
  for (const d of decisions) {
    if (!d || typeof d.flagId !== 'string') throw new UsageError('Each decision needs a flagId, e.g. {"flagId":"F1","action":"keep"}.');
    const action = (d as { action?: unknown }).action;
    if (action !== 'keep' && action !== 'cut' && action !== 'reword') throw new UsageError(`Decision for ${d.flagId}: action must be keep, cut or reword.`);
    if (d.action === 'reword' && (typeof d.text !== 'string' || !d.text.trim())) throw new UsageError(`Decision for ${d.flagId}: a reword needs text.`);
    byId.set(d.flagId, d);
  }
  return async (f) => byId.get(f.id) ?? { flagId: f.id, action: 'keep' };
}

function checkDecisionIds(decisions: Decision[], flags: Flag[]): void {
  const known = new Set(flags.map((f) => f.id));
  const unknown = decisions.map((d) => d.flagId).filter((id) => !known.has(id));
  if (unknown.length) {
    throw new UsageError(`The decisions name flags this run doesn't have: ${unknown.join(', ')}. Flags: ${flags.map((f) => f.id).join(', ') || 'none'}.`);
  }
}

/** Pre-deliver data kept in the finished run's outcome, so --decisions can rerun deliver alone. */
const DELIVER_INPUT = '_deliverInput';

const SEVERITY: Record<string, PanelNote['severity']> = { error: 'must', warning: 'should', advisory: 'consider' };

/** Check results as notes a model may read: quotes in template form, numbers scrubbed. */
function checkNotes(c: CheckReport, d: Draft, facts: FactsTable, allow: string[] = [], original?: string): PanelNote[] {
  const opts = { allow };
  const notes: PanelNote[] = [];
  for (const u of c.untraced) {
    const q = templateQuote(d, facts, u.raw);
    notes.push({
      persona: 'check',
      ...(q ? { quote: q } : {}),
      note: original ? 'This number is not in the original report. Cut it or use a reference from the list.' : 'This number does not trace to the facts table. Cite a fact reference instead.',
      severity: 'must',
    });
  }
  if (c.length && !c.length.shorter) notes.push({ persona: 'check', note: 'The rewrite is not shorter than the original. Cut harder.', severity: 'must' });
  for (const f of c.findings) {
    if (f.category === 'watchout') continue; // watchouts go to the writer as flags, never silently changed
    if (f.severity === 'advisory') continue;
    const q = f.match ? templateQuote(d, facts, f.match) : undefined;
    notes.push({
      persona: 'check',
      ...(q ? { quote: q } : {}),
      note: scrubNumbers(`${f.name}: ${f.message}${f.fix ? ` Fix: ${f.fix}` : ''}`, facts, opts),
      severity: SEVERITY[f.severity] ?? 'should',
    });
  }
  return notes;
}

/** Engine spans count code points; JS strings count UTF-16 units. Re-find each raw near its span. */
function alignSpans(text: string, numbers: { raw: string; span: [number, number]; value?: number; kind?: string; unit?: string }[]): FoundNumber[] {
  const out: FoundNumber[] = [];
  let from = 0;
  for (const n of numbers) {
    let at = text.slice(n.span[0], n.span[1]) === n.raw ? n.span[0] : text.indexOf(n.raw, from);
    if (at < 0) at = text.indexOf(n.raw);
    if (at < 0) continue;
    out.push({ raw: n.raw, span: [at, at + n.raw.length], value: n.value, kind: n.kind, unit: n.unit });
    from = at + n.raw.length;
  }
  return out;
}

export async function runNoro(input: RunNoroInput): Promise<NoroReport> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const config = input.config ?? loadConfig();
  const file = resolve(cwd, input.file);
  const mode: 'generate' | 'revise' = REVISION_EXTS.has(extname(file).toLowerCase()) ? 'revise' : 'generate';
  const format = input.format ?? DEFAULT_FORMAT;
  if (!FORMATS[format]) throw new UsageError(`Unknown format "${format}". Use one of: ${Object.keys(FORMATS).join(', ')}.`);
  // One client per writing step (draft + revise share one). Creating them never needs a credential.
  const draftChat = input.clients?.chat ?? createChatClientFor(config.draftModel, config);
  const panelChat = input.clients?.chat ?? (config.panelModel === config.draftModel ? draftChat : createChatClientFor(config.panelModel, config));
  const draftModel = nativeModelId(config.draftModel);
  const panelModel = nativeModelId(config.panelModel);
  const classifier = resolveClassifier(config, { jev: input.clients?.jev, chat: draftChat, writerModel: draftModel });
  input.onClassifier?.(classifier.describe);
  const decisions = input.decisions;
  const decide = decisions ? decideFrom(decisions) : (input.decide ?? (async (f: Flag): Promise<Decision> => ({ flagId: f.id, action: 'keep' })));
  const stateDir = resolve(cwd, input.stateDir ?? config.stateDir);
  const runKey = runKeyFor(file, mode, format, config, {
    injected: { chat: input.clients?.chat !== undefined, jev: input.clients?.jev !== undefined },
    mock: process.env.NORO_MOCK_MODELS === '1',
    classifier: input.clients?.jev ? undefined : classifierSource(classifier),
  });
  const runInfo = { classifier: classifier.describe, models: { draft: config.draftModel, panel: config.panelModel } };
  const personaDirs = [join(cwd, '.noro', 'personas')];

  // ------------------------------------------------------------- the steps
  // Each returns the data for the next checkpoint. They only read `data`.
  const steps: Record<StepName, (data: RunData) => Promise<RunData>> = {
    async ingest() {
      const dataset = await ingest(file, {
        confirmMapping: input.confirmMapping,
        // The built-ins plus <cwd>/.noro/adapters (ingest alone would look under process.cwd()).
        adaptersDir: [builtinAdaptersDir(), join(cwd, '.noro', 'adapters')],
      });
      const blocking = blockingWarnings(dataset);
      if (blocking.length && !input.acceptWarnings && !(input.confirmWarnings && (await input.confirmWarnings(blocking)))) {
        throw new IngestWarningError(blocking);
      }
      return { dataset };
    },
    async compute(d) {
      return { facts: computeFacts(d.dataset!), warnings: d.dataset!.warnings }; // the dataset is dropped from here on
    },
    async classify(d) {
      return { ...d, labels: await classifier.run(d.facts!) };
    },
    async draft(d) {
      return { ...d, draft: await draft({ facts: d.facts!, labels: d.labels!, chat: draftChat, model: draftModel, format }) };
    },
    async check(d) {
      if (mode === 'revise') {
        // The pasted report stands in for the draft. Its numbers become facts so no model ever sees them.
        const original = readFileSync(file, 'utf8');
        const ex = await runEngine(['extract', file], config.python);
        const t = templatize(original, alignSpans(original, ex.json.numbers ?? []));
        const draftLike: Draft = { template: t.template, rendered: original, factIds: t.facts.facts.map((f) => f.id) };
        // Graded against itself, so `shorter` is false; this check only collects findings and watchouts.
        const c = await check({ text: original, mode: 'revise', original, watchouts: true, python: config.python });
        return { facts: t.facts, allow: t.allow, original, draft: draftLike, check: lean(c) };
      }
      let current = d.draft!;
      let c = await check({ text: current.rendered, mode: 'generate', facts: d.facts!, watchouts: true, python: config.python });
      if (!c.pass) {
        const r = await reviseDetailed({ template: current.template, notes: checkNotes(c, current, d.facts!), facts: d.facts!, chat: draftChat, model: draftModel, labels: d.labels });
        current = r.draft;
        c = await check({ text: current.rendered, mode: 'generate', facts: d.facts!, watchouts: true, python: config.python });
        if (!c.pass) throw new CheckFailedError(describeFailure(c), lean(c));
      }
      return { ...d, draft: current, check: lean(c) };
    },
    async panel(d) {
      const facts = d.facts!;
      const allow = d.allow ?? [];
      const notes = await panel({ text: d.draft!.template, facts, chat: panelChat, model: panelModel, labels: d.labels, allow, extraPersonaDirs: personaDirs });
      if (mode === 'revise') {
        const fromCheck = checkNotes(d.check!, d.draft!, facts, allow);
        const all = [...fromCheck, ...notes];
        let r: ReviseResult = await reviseDetailed({ template: d.draft!.template, notes: all, facts, chat: draftChat, model: draftModel, allow, task: 'rewrite' });
        let c = await check({ text: r.draft.rendered, mode: 'revise', original: d.original!, watchouts: true, python: config.python });
        if (!c.pass) {
          const fix = checkNotes(c, r.draft, facts, allow, d.original);
          const again = await reviseDetailed({ template: r.draft.template, notes: fix, facts, chat: draftChat, model: draftModel, allow, task: 'rewrite' });
          r = { ...again, applied: r.applied, rejected: r.rejected };
          c = await check({ text: r.draft.rendered, mode: 'revise', original: d.original!, watchouts: true, python: config.python });
          if (!c.pass) throw new CheckFailedError(describeFailure(c), lean(c));
        }
        const applied = new Set(r.applied.filter((i) => i >= fromCheck.length).map((i) => i - fromCheck.length));
        return { ...d, draft: r.draft, check: lean(c), notes: notes.filter((_, i) => !applied.has(i)), panel: { notes: notes.length, applied: applied.size } };
      }
      if (notes.length === 0) return { ...d, notes: [], panel: { notes: 0, applied: 0 } };
      try {
        const r = await reviseDetailed({ template: d.draft!.template, notes, facts, chat: panelChat, model: panelModel, labels: d.labels, task: 'apply' });
        const c = await check({ text: r.draft.rendered, mode: 'generate', facts, watchouts: true, python: config.python });
        if (c.pass) {
          const applied = new Set(r.applied);
          return { ...d, draft: r.draft, check: lean(c), notes: notes.filter((_, i) => !applied.has(i)), panel: { notes: notes.length, applied: applied.size } };
        }
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'RawNumberError') throw err;
      }
      // The revision broke the rules: keep the checked draft, every note goes to the writer.
      return { ...d, notes, panel: { notes: notes.length, applied: 0 } };
    },
    async deliver(d) {
      const flags = buildFlags(d.check!, d.notes ?? [], d.labels, { facts: d.facts, draft: d.draft, allow: d.allow });
      if (decisions) checkDecisionIds(decisions, flags);
      const report = await deliver({ text: d.draft!.rendered, facts: d.facts, flags, decide, allow: d.allow, prefer: d.draft!.factIds });
      // The final text, after the user's cuts and rewords, must still trace.
      const final =
        mode === 'revise'
          ? await check({ text: report.text, mode: 'revise', original: d.original!, python: config.python })
          : await check({ text: report.text, mode: 'generate', facts: d.facts!, python: config.python });
      if (final.untraced.length) throw new CheckFailedError(describeFailure(final), lean(final));
      const result: NoroReport = {
        ...report,
        summary: {
          mode,
          checked: report.traces.length,
          words: { ...(d.original ? { original: words(d.original) } : {}), final: words(report.text) },
          panel: d.panel ?? { notes: 0, applied: 0 },
          resumed: false,
          ...runInfo,
        },
        warnings: d.warnings ?? [],
      };
      return { ...d, result: { ...result, [DELIVER_INPUT]: d } } as RunData & { result: NoroReport };
    },
  };

  // ------------------------------------------------------- the durable task
  const order = mode === 'revise' ? STEPS.slice(STEPS.indexOf(REVISE_ENTRY)) : STEPS;
  let stopReached: () => void = () => {};
  const parked = new Promise<'parked'>((r) => (stopReached = () => r('parked')));
  let failure: unknown;

  const phases = {} as Record<StepName, PhaseHandler<TaskInput, Checkpoint, Checkpoint, NoroReport, object>>;
  for (const name of STEPS) {
    phases[name] = async (task, runtime, context) => {
      const next = order[order.indexOf(name) + 1];
      let data: RunData;
      try {
        input.onStep?.(name);
        data = await steps[name](task.state.checkpoint.data);
      } catch (err) {
        failure = err;
        const e = err instanceof Error ? err : new Error(String(err));
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message: e.message, detail: { name: e.name, step: name } } } }), context);
        return;
      }
      await runtime.commit(
        () =>
          next
            ? { status: 'running', checkpoint: { phase: next, data } }
            : { status: 'terminal', outcome: { status: 'completed', result: (data as RunData & { result: NoroReport }).result } },
        context,
      );
      if (input.stopAfter === name && next) {
        stopReached();
        await runtime.sleep(runtime.now() + 86_400_000, context); // cancelled when runNoro closes the Harness
      }
    };
  }
  const Pipeline = defineTask<TaskInput, Checkpoint, NoroReport>({
    name: TASK_KIND,
    version: 1,
    initial: (i) => ({ phase: i.mode === 'revise' ? REVISE_ENTRY : 'ingest', data: {} }),
    phases,
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: 'noro', tasks: [Pipeline] }));
  const ctx = BACKGROUND_CONTEXT;
  // One SQLite file per run key. Pi Durable's scheduler resumes every pending task in a storage, so
  // keeping each input's run in its own file means opening one run never wakes another.
  mkdirSync(join(stateDir, 'runs'), { recursive: true });
  const harness = await Harness.open(await openNodeSqliteStorage(runDbPath(stateDir, runKey)), { models: createModels(), registry }, ctx);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await harness.close(ctx);
    }
  };
  try {
    const root = await harness.root(ctx);
    const live = await harness.commit(async (tx) => {
      let cursor: unknown;
      do {
        const page = await tx.scanTasks({ kind: TASK_KIND, order: 'descending' }, 50, cursor as never);
        for (const t of page.items) {
          const i = t.input as TaskInput;
          if (i?.runKey === runKey && t.state.status !== 'terminal' && t.state.status !== 'completing') return t.id;
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return undefined;
    }, ctx);
    if (live === undefined && decisions) {
      // Apply the choices to the last finished run of this input: deliver only, from its checkpoint.
      const done = await harness.commit(async (tx) => {
        let cursor: unknown;
        do {
          const page = await tx.scanTasks({ kind: TASK_KIND, order: 'descending' }, 50, cursor as never);
          for (const t of page.items) {
            const i = t.input as TaskInput;
            const o = t.state.status === 'terminal' ? (t.state.outcome as { status: string; result?: Record<string, unknown> }) : undefined;
            if (i?.runKey === runKey && o?.status === 'completed' && o.result?.[DELIVER_INPUT]) return o.result[DELIVER_INPUT] as RunData;
          }
          cursor = page.next;
        } while (cursor !== undefined);
        return undefined;
      }, ctx);
      if (done) {
        input.onStep?.('deliver');
        const out = (await steps.deliver(done)) as RunData & { result: NoroReport };
        return publicReport(out.result, true);
      }
    }
    const resumed = live !== undefined;
    const id = (live ??
      (await root.commit((tx) => tx.createTask(Pipeline, { runKey, mode, file, format }, { ownership: { kind: 'conversation' } }), ctx))) as TaskId<NoroReport>;

    const settled = harness.waitForTask(id, ctx);
    const first = await Promise.race([settled, parked]);
    if (first === 'parked') {
      settled.catch(() => {});
      await close();
      throw new StopAfterError(input.stopAfter!);
    }
    const outcome = first.state.outcome;
    if (outcome.status === 'completed') return publicReport(outcome.result, resumed);
    if (failure) throw failure;
    const msg = outcome.status === 'failed' || outcome.status === 'faulted' ? outcome.error.message : `run ${outcome.status}`;
    throw new Error(`noro run failed: ${msg}`);
  } finally {
    await close();
  }
}

/** The report as callers see it: without the deliver checkpoint it carries in storage. */
function publicReport(r: NoroReport, resumed: boolean): NoroReport {
  const { [DELIVER_INPUT]: _drop, ...rest } = r as NoroReport & { [DELIVER_INPUT]?: unknown };
  return { ...rest, summary: { ...rest.summary, resumed } } as NoroReport;
}

/**
 * The CLI exit code for an error out of runNoro: 2 when the report can't pass the check (the check
 * failed, or a model or a reword kept breaking the digit rule after its retries), 1 otherwise.
 */
export function exitCodeFor(err: unknown): 1 | 2 {
  const name = err instanceof Error ? err.name : '';
  return name === 'CheckFailedError' || name === 'RawNumberError' ? 2 : 1;
}

function describeFailure(c: CheckReport): string {
  const parts: string[] = [];
  if (c.untraced.length) parts.push(`${c.untraced.length} untraced number(s): ${c.untraced.map((u) => u.raw).join(', ')}`);
  const errors = c.findings.filter((f) => f.severity === 'error' && f.category !== 'watchout');
  if (errors.length) parts.push(`rule errors: ${errors.map((f) => f.rule).join(', ')}`);
  if (c.length && !c.length.shorter) parts.push(`not shorter (${c.length.rewrite_words} vs ${c.length.original_words} words)`);
  return `Check failed: ${parts.join('; ') || 'unknown reason'}`;
}
