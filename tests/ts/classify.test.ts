// Classify v0.2: the System One wire format, keys by host, the 64-question cap,
// resolveClassifier's selection order, the rules classifier and writer mode.
// No network: HTTP goes to a local server or a stubbed fetch.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ClassifyConfigError,
  MAX_QUESTIONS_PER_CALL,
  MissingApiKeyError,
  buildJevRequests,
  buildWriterRequests,
  classify,
  classifyByRules,
  classifyKeyEnv,
  classifyWithWriter,
  createJevClient,
  createSystemOneClient,
  defaultClassifyModel,
  describeFact,
  resolveClassifier,
  systemOneUrl,
} from '../../src/classify/index.js';
import { computeFacts } from '../../src/compute/index.js';
import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { createMockJev } from '../../src/harness/mock.js';
import { ingest } from '../../src/ingest/index.js';
import type { ChatClient, ChatRequest, Fact, FactsTable } from '../../src/schema.js';
import { assertNoNumbers } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'fixtures/exports/google-ads.csv');

let facts: FactsTable;
beforeAll(async () => {
  facts = computeFacts(await ingest(FIXTURE));
});

type ClassifyFields = { classify?: string; classifyBaseUrl?: string; typesafeKey?: string };

/** A config with the classify fields present (so nothing is read from process.env). */
function cfg(over: Partial<Config> & ClassifyFields = {}): Config {
  return { ...loadConfig({}), apiKey: undefined, classify: undefined, classifyBaseUrl: undefined, typesafeKey: undefined, ...over } as Config;
}

/** A config from before B1 added the classify fields: settings then come from the env. */
function legacyCfg(over: Partial<Config> = {}): Config {
  const c = { ...loadConfig({}), apiKey: undefined, ...over } as Record<string, unknown>;
  delete c.classify;
  delete c.classifyBaseUrl;
  delete c.typesafeKey;
  return c as unknown as Config;
}

/** Strip bare fact ids (f12, f12__label, `facts.f12`) before the digit check. */
const stripIds = (s: string) => s.replace(/(?<![\p{L}\p{Nd}])f\d+(?!\p{Nd})/gu, ' ');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('System One endpoint', () => {
  it('builds {base}/v1/systemone with or without a trailing /v1', () => {
    for (const b of ['https://openrouter.ai/api', 'https://openrouter.ai/api/', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/systemone']) {
      expect(systemOneUrl(b)).toBe('https://openrouter.ai/api/v1/systemone');
    }
    expect(systemOneUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/systemone');
    expect(systemOneUrl('https://api.typesafe.ai/v1')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(() => systemOneUrl('localhost:11434')).toThrow(ClassifyConfigError);
  });

  it('keys and default models go by host', () => {
    expect(classifyKeyEnv('https://openrouter.ai/api')).toBe('OPENROUTER_API_KEY');
    expect(classifyKeyEnv('https://api.typesafe.ai')).toBe('TYPESAFE_API_KEY');
    expect(classifyKeyEnv('http://localhost:11434')).toBeUndefined();
    expect(classifyKeyEnv('https://typesafe.ai.example.com')).toBeUndefined();
    expect(defaultClassifyModel('https://openrouter.ai/api')).toBe('typesafe/jev-1.13');
    expect(defaultClassifyModel('https://api.typesafe.ai')).toBe('jev-latest');
    expect(defaultClassifyModel('http://127.0.0.1:9932')).toBeUndefined();
  });

  it('sends {model, state, questions keyed by id} with the host key, and reads answers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'gen', model: 'typesafe/jev-1.13-x', answers: { q__label: { type: 'noul', noul: 0.9 } }, usage: { cost: 0 } }), { status: 200 });
    });
    const client = createSystemOneClient({ baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or-test' });
    const res = (await client.decide({ model: 'typesafe/jev-1.13', state: { a: 'b' }, questions: [{ id: 'q__label', type: 'noul', instructions: 'x?' }] })) as any;
    expect(res.answers.q__label.noul).toBe(0.9);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-test');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'typesafe/jev-1.13',
      state: { a: 'b' },
      questions: { q__label: { type: 'noul', instructions: 'x?' } },
    });
  });

  it('never sends a key to a host that is not its own', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    });
    const config = cfg({ apiKey: 'sk-or-secret', typesafeKey: 'ts-secret', classifyBaseUrl: 'http://localhost:11434', classifyModel: 'nimble' });
    await createJevClient(config).decide({ model: 'nimble', state: {}, questions: [] });
    const ts = cfg({ apiKey: 'sk-or-secret', typesafeKey: 'ts-secret', classifyBaseUrl: 'https://api.typesafe.ai' });
    await createJevClient(ts).decide({ model: 'jev-latest', state: {}, questions: [] });
    expect(seen[0].Authorization).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toMatch(/secret/);
    expect(seen[1].Authorization).toBe('Bearer ts-secret');
    expect(seen[1]['X-Title']).toBeUndefined();
  });

  it('throws MissingApiKeyError naming the host key, before any request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = createSystemOneClient({ baseUrl: 'https://api.typesafe.ai' });
    await expect(client.decide({ model: 'jev-latest', state: {}, questions: [] })).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(client.decide({ model: 'jev-latest', state: {}, questions: [] })).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('classifies a whole export through a local System One server, at most 64 questions per call', async () => {
    const mock = createMockJev();
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const body = JSON.parse(raw);
        bodies.push({ url: req.url, auth: req.headers.authorization, body });
        // The wire carries questions as a map; the mock's logic reads a list.
        const questions = Object.entries(body.questions).map(([id, q]) => ({ id, ...(q as object) }));
        const answer = await mock.decide({ model: body.model, state: body.state, questions });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...(answer as object), usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const c = resolveClassifier(cfg({ apiKey: 'sk-or-should-not-be-sent', classifyBaseUrl: `http://127.0.0.1:${port}/v1`, classifyModel: 'nimble' }));
      expect(c.mode).toBe('jev');
      expect(c.describe).toBe(`jev (nimble on 127.0.0.1:${port})`);
      const labels = await c.run(facts);
      expect(labels).toHaveLength(facts.facts.length);
      expect(bodies.length).toBe(buildJevRequests(facts, 'nimble').length);
      for (const b of bodies) {
        expect(b.url).toBe('/v1/systemone');
        expect(b.auth).toBeUndefined();
        expect(b.body.model).toBe('nimble');
        expect(Object.keys(b.body.questions).length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_CALL);
      }
      const dg05 = facts.facts.find((x) => x.label.startsWith('CPA, campaign DG-05 Demand Gen, percent change'))!;
      expect(labels.find((l) => l.factId === dg05.id)!.label).toBe('luck_risk');
    } finally {
      server.close();
    }
  });

  it('batches never exceed 64 questions and cover every askable fact once', () => {
    const reqs = buildJevRequests(facts, 'm');
    const ids = reqs.flatMap((r) => Object.keys(r.state.facts as object));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(facts.facts.filter((f) => f.value !== null).length);
    for (const r of reqs) expect(r.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_CALL);
    expect(Math.max(...reqs.map((r) => r.questions.length))).toBeGreaterThan(MAX_QUESTIONS_PER_CALL - 4);
  });
});

describe('resolveClassifier', () => {
  const pick = (over: Partial<Config> & ClassifyFields, deps = {}) => {
    const c = resolveClassifier(cfg(over), deps);
    return `${c.mode} | ${c.describe}`;
  };

  it('follows the selection order: NORO_CLASSIFY, base URL, OpenRouter key, TypeSafe key, rules', () => {
    expect(pick({})).toBe('rules | rules');
    expect(pick({ typesafeKey: 'ts' })).toBe('jev | jev (jev-latest on api.typesafe.ai)');
    expect(pick({ apiKey: 'or', typesafeKey: 'ts' })).toBe('jev | jev (typesafe/jev-1.13 on openrouter.ai)');
    expect(pick({ apiKey: 'or', typesafeKey: 'ts', classifyBaseUrl: 'https://api.typesafe.ai' })).toBe('jev | jev (jev-latest on api.typesafe.ai)');
    expect(pick({ apiKey: 'or', classifyBaseUrl: 'http://localhost:11434', classifyModel: 'nimble' })).toBe('jev | jev (nimble on localhost:11434)');
    expect(pick({ apiKey: 'or', classify: 'rules' })).toBe('rules | rules');
    expect(pick({ classify: 'writer' })).toMatch(/^writer \| writer \(.+\)$/);
    expect(pick({ classify: 'writer' }, { writerModel: 'claude-cli:claude-opus-5-5' })).toBe('writer | writer (claude-cli:claude-opus-5-5)');
    expect(pick({ classify: 'JEV' })).toBe('jev | jev (typesafe/jev-1.13 on openrouter.ai)');
  });

  it('reports a missing key for the chosen host and throws it at run time', async () => {
    const c = resolveClassifier(cfg({ classify: 'jev' }));
    expect(c.missingKey).toBe('OPENROUTER_API_KEY');
    await expect(c.run(facts)).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(resolveClassifier(cfg({ apiKey: 'or' })).missingKey).toBeUndefined();
    expect(resolveClassifier(cfg({ classifyBaseUrl: 'http://localhost:11434', classifyModel: 'nimble' })).missingKey).toBeUndefined();
  });

  it('needs a model for hosts without a default', async () => {
    const c = resolveClassifier(cfg({ classifyBaseUrl: 'http://localhost:1234' }));
    expect(c.describe).toBe('jev (no model set on localhost:1234)');
    await expect(c.run(facts)).rejects.toThrow(/NORO_CLASSIFY_MODEL/);
  });

  it('rejects unknown NORO_CLASSIFY values and bad base URLs', () => {
    expect(() => resolveClassifier(cfg({ classify: 'gpt' }))).toThrow(ClassifyConfigError);
    expect(() => resolveClassifier(cfg({ classifyBaseUrl: 'not a url' }))).toThrow(ClassifyConfigError);
  });

  it('an injected jev client is used when nothing explicit says otherwise', async () => {
    const jev = createMockJev();
    const c = resolveClassifier(cfg({}), { jev });
    expect(c.mode).toBe('jev');
    expect(c.missingKey).toBeUndefined();
    const labels = await c.run(facts);
    expect(labels).toEqual(await classify(facts, createMockJev(), { model: 'typesafe/jev-1.13' }));
    expect(resolveClassifier(cfg({ classify: 'rules' }), { jev }).mode).toBe('rules');
  });

  it('reads NORO_CLASSIFY, NORO_CLASSIFY_BASE_URL, NORO_CLASSIFY_MODEL and TYPESAFE_API_KEY from the env for a Config without those fields', () => {
    const c = legacyCfg();
    expect(resolveClassifier(c, { env: {} }).describe).toBe('rules');
    expect(resolveClassifier(c, { env: { TYPESAFE_API_KEY: 'ts' } }).describe).toBe('jev (jev-latest on api.typesafe.ai)');
    expect(resolveClassifier(c, { env: { NORO_CLASSIFY_BASE_URL: 'http://localhost:11434', NORO_CLASSIFY_MODEL: 'nimble' } }).describe).toBe(
      'jev (nimble on localhost:11434)',
    );
    expect(resolveClassifier(legacyCfg({ apiKey: 'or' }), { env: { NORO_CLASSIFY: 'rules' } }).mode).toBe('rules');
  });

  it('rules mode makes no call at all', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const c = resolveClassifier(cfg({ classify: 'rules', apiKey: 'or' }));
    expect(await c.run(facts)).toEqual(classifyByRules(facts));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('rules classifier', () => {
  const find = (prefix: string) => facts.facts.find((f) => f.label.startsWith(prefix))!;

  it('labels every fact, the same way every time', () => {
    const a = classifyByRules(facts);
    expect(a).toHaveLength(facts.facts.length);
    expect(a.map((c) => c.factId)).toEqual(facts.facts.map((f) => f.id));
    expect(classifyByRules(facts)).toEqual(a);
  });

  it('small sample, no baseline and divide by zero are luck risk; no value is noise, priority 3', () => {
    const labels = new Map(classifyByRules(facts).map((c) => [c.factId, c]));
    for (const f of facts.facts) {
      const c = labels.get(f.id)!;
      if (f.value === null) expect(c).toMatchObject({ label: 'noise', priority: 3 });
      else if (f.flags.some((x) => ['small_sample', 'no_baseline', 'divide_by_zero'].includes(x))) expect(c.label).toBe('luck_risk');
      if (f.flags.includes('small_sample')) expect(c.watchouts).toContain('W-small-sample-size');
    }
    const dg05 = labels.get(find('CPA, campaign DG-05 Demand Gen, percent change').id)!;
    expect(dg05.label).toBe('luck_risk');
  });

  it('changes follow the magnitude bucket; levels are noise except current account primary totals', () => {
    const labels = new Map(classifyByRules(facts).map((c) => [c.factId, c]));
    for (const f of facts.facts) {
      if (f.value === null || f.flags.length) continue;
      const d = describeFact(f);
      const c = labels.get(f.id)!;
      if (d.change === 'percent change' || d.change === 'percentage-point change' || d.change === 'share change') {
        expect(c.label, f.label).toBe(d.magnitude === 'small' ? 'noise' : 'signal');
      } else if (d.change === 'absolute change') {
        expect(c.label, f.label).toBe('noise');
      }
    }
    expect(labels.get(find('Spend, account, current week').id)).toMatchObject({ label: 'signal', priority: 2 });
    expect(labels.get(find('ROAS, account, current week').id)).toMatchObject({ label: 'signal', priority: 2 });
    expect(labels.get(find('Spend, account, previous week').id)!.label).toBe('noise');
    expect(labels.get(find('Impressions, account, current week').id)!.label).toBe('noise');
    expect(labels.get(find('Spend, campaign DG-05 Demand Gen, current week').id)!.label).toBe('noise');
  });

  it('priority 1 goes to at most two account-level signal changes in primary metrics', () => {
    const all = classifyByRules(facts);
    const p1 = all.filter((c) => c.priority === 1);
    expect(p1.length).toBeGreaterThan(0);
    expect(p1.length).toBeLessThanOrEqual(2);
    for (const c of p1) {
      const f = facts.facts.find((x) => x.id === c.factId)!;
      const d = describeFact(f);
      expect(c.label).toBe('signal');
      expect(d.scope).toBe('account');
      expect(['spend', 'conversions', 'cpa', 'roas', 'conversion_value']).toContain(d.metric);
      expect(d.change).not.toBe('level');
    }
    for (const c of all) if (c.label !== 'signal') expect(c.priority).toBe(3);
  });

  it('rate changes below account level get the volatile watchout; account ones do not', () => {
    const labels = new Map(classifyByRules(facts).map((c) => [c.factId, c]));
    expect(labels.get(find('CTR, campaign DG-05 Demand Gen, percent change').id)!.watchouts).toContain('W-volatile-rate-claim');
    expect(labels.get(find('CTR, account, percent change').id)!.watchouts).not.toContain('W-volatile-rate-claim');
    expect(labels.get(find('Spend, campaign DG-05 Demand Gen, percent change').id)!.watchouts).not.toContain('W-volatile-rate-claim');
    expect(labels.get(find('ROAS, account, current week').id)!.watchouts).toContain('W-platform-roas-as-cause');
  });

  it('handles a fact with no value and a no-baseline fact on a tiny table', () => {
    const base: Fact = { id: 'f1', key: 'k1', label: 'Spend, account, percent change', value: 30, kind: 'pct_change' as Fact['kind'], unit: '%', display: '30%', formula: '', inputs: [], scope: { metric: 'spend', period: 'previous_to_current', dimension: 'pct_change' }, flags: [] };
    const table: FactsTable = {
      currency: 'USD',
      periods: { current: 'this week' },
      facts: [base, { ...base, id: 'f2', key: 'k2', value: null }, { ...base, id: 'f3', key: 'k3', flags: ['no_baseline'] }],
    };
    const [a, b, c] = classifyByRules(table);
    expect(a).toMatchObject({ label: 'signal', priority: 1 });
    expect(b).toMatchObject({ label: 'noise', priority: 3 });
    expect(c).toMatchObject({ label: 'luck_risk', priority: 3 });
    expect(c.watchouts).toContain('W-metric-without-baseline');
  });
});

describe('writer mode', () => {
  function chatAnswering(answer: (req: ChatRequest) => string, log: ChatRequest[] = []): ChatClient {
    return {
      async complete(req) {
        log.push(req);
        return answer(req);
      },
    };
  }

  /** Every fact id in a request's state, answered the same way. */
  const answerAll = (entry: object) => (req: ChatRequest) => {
    const state = JSON.parse(req.user.slice(req.user.indexOf('{')));
    return JSON.stringify({ facts: Object.fromEntries(Object.keys(state.facts).map((id) => [id, entry])) });
  };

  it('prompts carry ids, labels and descriptors only: no digit beyond ids and names, no value fields', () => {
    for (const { req } of buildWriterRequests(facts, 'anthropic/claude-opus-5.5')) {
      assertNoNumbers(stripIds(`${req.system}\n${req.user}`), facts);
      expect(req.user).not.toMatch(/"(value|display|formula|sampleSize)"/);
      expect(req.json).toBe(true);
    }
    for (const f of facts.facts) {
      if (f.value === null) continue;
      const all = buildWriterRequests(facts, 'm').map((r) => r.req.user).join('\n');
      expect(all).not.toContain(f.formula);
    }
  });

  it('maps label, prominence and volatile; code still moves toward caution', async () => {
    const log: ChatRequest[] = [];
    const chat = chatAnswering(answerAll({ label: 'signal', prominence: 'lead', volatile: true }), log);
    const labels = await classifyWithWriter(facts, chat, { model: 'w' });
    expect(labels).toHaveLength(facts.facts.length);
    expect(log.every((r) => r.model === 'w')).toBe(true);
    const by = new Map(labels.map((c) => [c.factId, c]));
    const small = facts.facts.find((f) => f.flags.includes('small_sample') && f.value !== null)!;
    expect(by.get(small.id)!.label).toBe('luck_risk');
    const spend = facts.facts.find((f) => f.label.startsWith('Spend, account, percent change'))!;
    expect(by.get(spend.id)).toMatchObject({ label: 'signal', priority: 1 });
    expect(by.get(spend.id)!.watchouts).not.toContain('W-volatile-rate-claim');
    const ctr = facts.facts.find((f) => f.label.startsWith('CTR, account, percent change'))!;
    expect(by.get(ctr.id)!.watchouts).toContain('W-volatile-rate-claim');
  });

  it('unknown labels become noise, missing facts noise priority 3', async () => {
    const chat = chatAnswering(() => JSON.stringify({ facts: { [facts.facts[0].id]: { label: 'headline', prominence: 'supporting' } } }));
    const labels = await classifyWithWriter(facts, chat, { model: 'w' });
    expect(labels[0]).toMatchObject({ label: 'noise', priority: 2 });
    expect(labels[1]).toMatchObject({ label: 'noise', priority: 3 });
  });

  it('retries once on an answer that is not JSON, then fails', async () => {
    const log: ChatRequest[] = [];
    let n = 0;
    const flaky = chatAnswering((req) => (n++ === 0 ? 'Sure! Here you go.' : answerAll({ label: 'noise', prominence: 'background' })(req)), log);
    await expect(classifyWithWriter(facts, flaky, { model: 'w' })).resolves.toHaveLength(facts.facts.length);
    const bad = chatAnswering(() => 'no json here');
    await expect(classifyWithWriter(facts, bad, { model: 'w' })).rejects.toThrow(/not JSON/);
  });

  it('resolveClassifier writer mode uses deps.chat and fails clearly without it', async () => {
    const log: ChatRequest[] = [];
    const chat = chatAnswering(answerAll({ label: 'noise', prominence: 'background', volatile: false }), log);
    const c = resolveClassifier(cfg({ classify: 'writer', apiKey: 'or' }), { chat, writerModel: 'openrouter:anthropic/claude-opus-5.5' });
    await c.run(facts);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].model).toBe('openrouter:anthropic/claude-opus-5.5');
    await expect(resolveClassifier(cfg({ classify: 'writer' })).run(facts)).rejects.toThrow(/writing model client/);
  });
});
