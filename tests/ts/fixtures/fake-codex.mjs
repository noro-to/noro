#!/usr/bin/env node
// A stand-in for the `codex` binary in tests/ts/providers-cli.test.ts. It records
// its argv, cwd, stdin, the system prompt file and the billing env vars to
// FAKE_CODEX_LOG, and answers like `codex login status` / `codex exec -o <file> -`.
//   FAKE_CODEX_AUTH = chatgpt (default) | apikey | none
//   FAKE_CODEX_LIMIT = 1 → exit 1 with a plan usage-limit message
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;
const record = (extra) => {
  if (!log) return;
  const leaked = {};
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY']) leaked[k] = process.env[k] ?? null;
  appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), cwdFiles: readdirSync(process.cwd()), leaked, ...extra }) + '\n');
};

if (args[0] === 'login' && args[1] === 'status') {
  record({});
  const auth = process.env.FAKE_CODEX_AUTH ?? 'chatgpt';
  if (auth === 'none') {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stderr.write(auth === 'apikey' ? 'Logged in using an API key - sk-proj-***\n' : 'Logged in using ChatGPT\n');
  process.exit(0);
}

if (args[0] === 'exec') {
  const stdin = readFileSync(0, 'utf8');
  const cfg = args.filter((_, i) => args[i - 1] === '-c');
  const instr = cfg.find((c) => c.startsWith('model_instructions_file='));
  const system = instr ? readFileSync(JSON.parse(instr.slice('model_instructions_file='.length)), 'utf8') : null;
  record({ stdin, system });
  if (process.env.FAKE_CODEX_LIMIT) {
    process.stderr.write("ERROR: You've hit your usage limit. Upgrade to Pro or try again later.\n");
    process.exit(1);
  }
  const out = args[args.indexOf('-o') + 1];
  writeFileSync(out, `echo: ${stdin.trim()}\n`);
  process.stderr.write('codex progress on stderr\n');
  process.exit(0);
}

process.stderr.write(`fake codex: unexpected args ${args.join(' ')}\n`);
process.exit(2);
