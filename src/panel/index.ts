// Panel: the reviewer personas read the draft as its readers would.
//
// Each persona (prompts/panel/*.md, plus the user's own in <cwd>/.noro/personas/)
// gets one fresh call with only its persona file, the draft and the facts it
// cites (id + label + classification). Never the chat, the data or the values.
// In generate mode `text` is the template, so reviewers see {{fN}} references,
// not numbers. Notes come back as JSON; code keeps a quote only when it is an
// exact substring of the draft, and scrubs any number a reviewer typed (it
// becomes "N") so no reviewer can introduce one.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonObject } from '../draft/chat.js';
import { buildPanelPrompt } from '../draft/prompts.js';
import { scrubNumbers } from '../draft/template.js';
import type { ChatClient, Classification, FactsTable, PanelNote } from '../schema.js';

/** prompts/panel/ at the package root, resolved from this module (src/panel or dist/panel). */
export const BUILTIN_PERSONAS_DIR = fileURLToPath(new URL('../../prompts/panel/', import.meta.url));

export interface Persona {
  id: string;
  text: string;
}

/** Load persona files (every *.md but README.md) from the given directories; a later id replaces an earlier one. */
export function loadPersonas(dirs: string[]): Persona[] {
  const byId = new Map<string, Persona>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && x.toLowerCase() !== 'readme.md').sort()) {
      const id = basename(f, '.md');
      byId.set(id, { id, text: readFileSync(join(dir, f), 'utf8') });
    }
  }
  return [...byId.values()];
}

const SEVERITIES = new Set(['must', 'should', 'consider']);

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function intToWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${intToWords(n % 100)}` : ''}`;
  return `${intToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${intToWords(n % 1000)}` : ''}`;
}

/**
 * Persona files are written for people ("10 seconds", numbered checks). Spell their numbers out so
 * no prompt carries a digit of its own: list markers become dashes, integers become words, and
 * anything else digit-shaped becomes "N".
 */
export function personaWithoutDigits(text: string): string {
  return text
    .replace(/^(\s*)\d+[.)]\s+/gm, '$1- ')
    .replace(/(?<![\d.,])\d{1,6}(?![\d.,]\d)/g, (m) => intToWords(Number(m)))
    .replace(/\p{N}+/gu, 'N');
}

export interface PanelInput {
  text: string;
  facts?: FactsTable;
  chat: ChatClient;
  model: string;
  /** Replaces the built-in personas directory. */
  personasDir?: string;
  /** Extra persona directories loaded after the built-in ones (the harness passes <cwd>/.noro/personas). */
  extraPersonaDirs?: string[];
  labels?: Classification[];
  /** Revision mode: identifiers that may contain digits. */
  allow?: string[];
}

export async function panel(input: PanelInput): Promise<PanelNote[]> {
  const personas = loadPersonas([input.personasDir ?? BUILTIN_PERSONAS_DIR, ...(input.extraPersonaDirs ?? [])]);
  const opts = { allow: input.allow };
  const results = await Promise.all(
    personas.map(async (p) => {
      const prompt = buildPanelPrompt({ persona: p.id, personaText: personaWithoutDigits(p.text), template: input.text, facts: input.facts, labels: input.labels, allow: input.allow });
      const answer = await input.chat.complete({ model: input.model, system: prompt.system, user: prompt.user, json: true });
      let obj: any;
      try {
        obj = parseJsonObject(answer);
      } catch {
        if (/no notes/i.test(answer)) return [];
        throw new Error(`panel: ${p.id} answered with something that isn't JSON`);
      }
      const notes: PanelNote[] = [];
      for (const n of ((obj?.notes ?? []) as any[]).slice(0, 3)) {
        const problem = String(n?.problem ?? n?.note ?? '').trim();
        if (!problem) continue;
        const fix = String(n?.fix ?? '').trim();
        const forWriter = n?.for_writer === true;
        const quote = typeof n?.quote === 'string' && n.quote.trim() && input.text.includes(n.quote.trim()) ? n.quote.trim() : undefined;
        const text = `${forWriter ? 'For the writer: ' : ''}${problem}${fix ? ` Fix: ${fix}` : ''}`;
        notes.push({
          persona: p.id,
          ...(quote ? { quote } : {}),
          note: scrubNumbers(text, input.facts, opts),
          severity: SEVERITIES.has(n?.severity) ? n.severity : 'should',
        });
      }
      return notes;
    }),
  );
  return results.flat();
}
