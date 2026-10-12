#!/usr/bin/env node
// A stand-in for the `claude` binary in tests/ts/claude-cli.test.ts. It records
// its argv, stdin and the auth-related env vars to FAKE_CLAUDE_LOG, and answers
// like `claude auth status` / `claude -p --output-format json`.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stdin = args[0] === '-p' ? readFileSync(0, 'utf8') : '';
const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  appendFileSync(log, JSON.stringify({ args, stdin, apiKey: process.env.ANTHROPIC_API_KEY ?? null, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK ?? null }) + '\n');
}
if (args[0] === 'auth') {
  const method = process.env.FAKE_CLAUDE_AUTH ?? 'claude.ai';
  process.stdout.write(JSON.stringify({ loggedIn: method !== 'none', authMethod: method, apiProvider: 'firstParty' }));
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_FAIL) {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${stdin.trim()}` }));
