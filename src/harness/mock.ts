// TEST-ONLY canned models. Never used unless a test injects them, or the CLI
// runs with NORO_MOCK_MODELS=1 (which it announces on stderr). They make no
// network calls and need no API key. They read only what the real models
// would see (the prompts), so tests can also capture every request.

import type { ChatClient, ChatRequest, JevClient } from '../schema.js';

export interface MockLog {
  chat: ChatRequest[];
  jev: { model: string; state: Record<string, unknown>; questions: unknown[] }[];
}

export interface MockOptions {
  /** Replace the draft answer (a template, or a function of the request). */
  draft?: string | ((req: ChatRequest, attempt: number) => string);
  /** Panel notes per persona id; default: one note from statistics-person, none from the rest. */
  panel?: (persona: string, template: string) => unknown[];
  log?: MockLog;
  /** Never answer the draft request (to test a kill mid-step). The CLI sets it from NORO_MOCK_HANG=draft. */
  hangDraft?: boolean;
}

interface Card {
  id: string;
  label: string;
  cls: string;
}

function cards(user: string): Card[] {
  const out: Card[] = [];
  for (const line of user.split('\n')) {
    const m = line.match(/^\{\{(f\d+)\}\} \| ([^|]+?)(?: \| ([^|]+))?(?: \| flags:.*)?$/);
    if (m) out.push({ id: m[1], label: m[2].trim(), cls: (m[3] ?? '').trim() });
  }
  return out;
}

function between(user: string): string {
  const m = user.match(/"""\n([\s\S]*?)\n"""/);
  return m ? m[1] : '';
}

/** A short report built from the fact cards: the biggest campaign CPA move, its level, and account spend. */
export function mockDraftFrom(user: string): string {
  const cs = cards(user);
  const find = (re: RegExp, cls?: RegExp) => cs.find((c) => re.test(c.label) && (!cls || cls.test(c.cls)));
  const move =
    find(/^CPA, campaign .+, percent change, .*\((up|down)\)$/, /^signal/) ??
    find(/^CPA, campaign .+, percent change, .*\((up|down)\)$/) ??
    find(/percent change, .*\((up|down)\)$/);
  const spend = find(/^Spend, (account|all accounts), current/);
  const lines: string[] = [];
  if (move) {
    const campaign = move.label.match(/campaign (.+?), percent change/)?.[1];
    const metric = move.label.split(',')[0];
    const dir = /\(up\)$/.test(move.label) ? 'rose' : 'fell';
    const level = campaign ? find(new RegExp(`^${metric}, campaign ${campaign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, current`)) : undefined;
    lines.push(`${metric} for ${campaign ?? 'the account'} ${dir} {{${move.id}}}${level ? ` to {{${level.id}}}` : ''}.`);
    lines.push('');
    lines.push(`Why: the move is in ${campaign ?? 'the account'}; the other campaigns held steady. Likely bids or audience, to be confirmed by the media buyer.`);
  } else {
    lines.push('A quiet week in the account.');
  }
  if (spend) lines.push(`Account spend landed at {{${spend.id}}}.`);
  lines.push(`Next: the media buyer reviews ${move?.label.match(/campaign (.+?), percent change/)?.[1] ?? 'the account'} bids by Friday.`);
  return lines.join('\n');
}

/** Keep about the first half of the sentences (revision mode must come out shorter). */
function shorten(template: string): string {
  const sentences = template.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [template];
  const keep = Math.max(1, Math.floor(sentences.length / 2));
  return sentences.slice(0, keep).join(' ').trim();
}

export function createMockChat(opts: MockOptions = {}): ChatClient {
  let draftAttempt = 0;
  return {
    async complete(req) {
      opts.log?.chat.push(req);
      if (req.system.startsWith('You are the reviewer in the persona below.')) {
        const persona = req.system.match(/Persona \(([^)]+)\):/)?.[1] ?? '';
        const template = between(req.user);
        const notes = opts.panel
          ? opts.panel(persona, template)
          : persona === 'statistics-person'
            ? [{ quote: template.split('\n')[0], problem: 'The sample behind this change is not stated.', fix: 'say how many conversions it rests on, or flag it as early', severity: 'consider', for_writer: true }]
            : [];
        return JSON.stringify({ notes });
      }
      if (req.json && req.system.includes('"template"')) {
        const template = between(req.user);
        const rewrite = req.system.includes('editing a paid-media report someone else wrote');
        return JSON.stringify({ template: rewrite ? shorten(template) : template, applied: [], rejected: [] });
      }
      // The draft.
      if (opts.hangDraft) return new Promise<string>(() => {});
      const attempt = draftAttempt++;
      if (typeof opts.draft === 'function') return opts.draft(req, attempt);
      if (typeof opts.draft === 'string') return opts.draft;
      return mockDraftFrom(req.user);
    },
  };
}

export function createMockJev(log?: MockLog): JevClient {
  return {
    async decide(req) {
      log?.jev.push(req);
      const facts = ((req.state as any).facts ?? {}) as Record<string, any>;
      const answers: Record<string, unknown> = {};
      for (const q of req.questions as { id: string; type: string }[]) {
        const [id, what] = q.id.split('__');
        const f = facts[id] ?? {};
        const moved = f.direction === 'up' || f.direction === 'down';
        const big = f.magnitude === 'large' || f.magnitude === 'moderate';
        const label = f.sample === 'small' ? 'luck_risk' : moved && big ? 'signal' : 'noise';
        if (what === 'label') answers[q.id] = { type: 'choice', choice: label, confidence: 0.8, probabilities: { [label]: 0.9 } };
        else if (what === 'priority') answers[q.id] = { type: 'score', score: label === 'signal' && f.change === 'percent change' ? 0 : label === 'noise' ? 2 : 1 };
        else answers[q.id] = { type: 'noul', noul: 0.2 };
      }
      return { answers, model: 'mock/jev' };
    },
  };
}
