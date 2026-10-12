import { it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join, resolve } from 'node:path';
import { runNoro } from '../../../src/harness/index.js';
import { createMockChat, createMockJev } from '../../../src/harness/mock.js';
import { loadConfig } from '../../../src/config.js';
it('rev', async () => {
  const base = createMockChat();
  const chat = { async complete(req: any) {
    if (req.json && req.system.includes('editing a paid-media report')) {
      const t = req.user.match(/"""\n([\s\S]*?)\n"""/)[1];
      writeFileSync('/tmp/claude-0/-home-user/a433babc-9f72-5f75-91dc-b9cec8111bab/scratchpad/tmpl.txt', req.system + '\n=====\n' + req.user);
      const a = t.match(/Spend came in at \{\{(f\d+)\}\}, which represents a \{\{(f\d+)\}\}/);
      const c = t.match(/CPA improved to \{\{(f\d+)\}\} from \{\{(f\d+)\}\}/);
      return JSON.stringify({ template: `Spend rose {{${a[2]}}} to {{${a[1]}}}, and CPA improved to {{${c[1]}}} from {{${c[2]}}}.\nNext: raise the daily budget on Search – NB – Cat Litter, which is limited by budget.`, applied: [], rejected: [] });
    }
    return base.complete(req);
  } };
  const r = await runNoro({ file: 'bench/corpus/01-weekly-email-hedges/original.md', cwd: resolve('.'), config: { ...loadConfig({}), apiKey: undefined }, stateDir: mkdtempSync(join(tmpdir(), 'x')), clients: { chat, jev: createMockJev() } });
  (await import('node:fs')).writeFileSync('/tmp/claude-0/-home-user/a433babc-9f72-5f75-91dc-b9cec8111bab/scratchpad/rev.json', JSON.stringify(r, null, 1));
});
