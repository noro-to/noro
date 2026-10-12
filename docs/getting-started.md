# Getting started with noro

This guide takes you from nothing to your first report in about ten minutes. You'll use a terminal, but you only need to copy and paste. For every other way to run noro (Docker, AI tools, schedules, other models), see [install/](install/README.md).

## What you need

- **Node 22.19 or newer** (Node 24 recommended). Check with `node --version`. Install it from [nodejs.org](https://nodejs.org).
- **Python 3.9 or newer.** Check with `python3 --version` (on Windows, `py -3 --version`). The rules engine uses only the standard library.
- **A writing model.** The simplest is an OpenRouter key: sign in at [openrouter.ai](https://openrouter.ai), add credits, and create a key under Keys. It starts with `sk-or-`. An Anthropic, OpenAI or Gemini key, a cloud account, a local model, or your own logged-in Claude Code also work (step 3).

noro checks Node and Python before it makes any paid call.

## 1. Install noro

```bash
npm i -g @noro-to/noro
noro --help
```

The package is `@noro-to/noro` and the command is `noro`. The unscoped `noro` on npm is a different project, so keep the `@noro-to/` scope whenever you use `npm` or `npx`. Before the first npm release, use `npm i -g github:noro-to/noro`.

## 2. Set up with `noro init`

Make a folder for your reports and run the setup there:

```bash
mkdir -p ~/reports && cd ~/reports
noro init
```

`noro init` looks for keys you already have, Claude Code or Codex on your PATH, and Ollama or LM Studio running locally. It offers presets, asks for any missing key with hidden input, and writes `.env` in this folder (or `~/.config/noro/.env` with `--global`, for runs started from any folder). It ends by running `noro doctor`, which checks everything for free.

Prefer to write `.env` yourself? This is all you need for the default setup:

```bash
# .env
OPENROUTER_API_KEY=sk-or-...
```

Keep `.env` out of version control and don't paste your key anywhere else.

## 3. Pick who writes

By default the writing steps (draft, panel, revision) run on `anthropic/claude-opus-5.5` through OpenRouter, billed per token. To change it, set `NORO_MODEL=<provider>:<model-id>` in `.env`, for example `anthropic:claude-opus-5-5` or `ollama:qwen3.8:27b`. Every provider is in [install/providers.md](install/providers.md).

To write on your own Claude plan instead, install [Claude Code](https://claude.com/claude-code), run `claude` once and log in, then set:

```bash
# .env
NORO_MODEL=claude-cli:claude-opus-5-5   # your own Claude Code writes
OPENROUTER_API_KEY=sk-or-...            # jev still classifies through OpenRouter
```

To run one report on OpenRouter without changing `.env`:

```bash
noro this report.csv --model openrouter:anthropic/claude-opus-5.5
```

The subscription option is for your own use on your own machine; [install/subscriptions.md](install/subscriptions.md) explains why.

## 4. Run it on a sample

Grab a synthetic export from the repo and run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/noro-to/noro/main/fixtures/exports/google-ads.csv
noro this google-ads.csv
```

You'll see each step as it runs: ingest, compute, classify, draft, check, panel, deliver. noro also says which classifier it picked. Then it shows each flag it has for you, one at a time:

- **keep**: leave the sentence as it is
- **cut**: remove the whole sentence the flag is about
- **reword**: type a new sentence; it replaces that whole sentence. Use the numbers already in the report; noro refuses any it can't trace.

A flag on a single word (a jargon term like "CPA") still acts on its whole sentence, and the flag says which sentence that is.

The report prints at the end, with a footer like `Checked: 9 numbers traced. Panel: 2 notes, 1 applied.`

## 5. Run it on your own data

Export a campaign report with daily rows from Google Ads, Meta Ads Manager or Amazon DSP, covering at least two weeks so noro can compare them. Then:

```bash
noro this ~/Downloads/your-export.csv
```

From another platform? noro guesses which column is spend, clicks and so on, and asks you to confirm before it uses them.

Already have a written report? Give noro the text:

```bash
noro this weekly-update.md --format email
```

Formats: `slack`, `email`, `one-page` (the default) and `slide-notes`. `noro facts <file>` prints just the facts table, with no model and no key.

## If a run stops partway

Run the same command again from the same folder. noro keeps a checkpoint after every step in `.noro/` and carries on from the last one.

## If something goes wrong

Run `noro doctor` first. It checks Node, Python, your keys (shown only as a short fingerprint), your writing model and your classifier, all for free.

- **A missing key:** check `.env` is in the folder you run `noro` from, or put the key in `~/.config/noro/.env`.
- **"needs Python 3.9+":** install Python 3, or point `NORO_PYTHON` at it (on Windows, `NORO_PYTHON=py -3`).
- **"Claude Code is not logged in" or "not a Claude subscription":** run `claude`, log in with your Claude account, and check `claude auth status` shows `claude.ai`.
- **Exit code 2:** the report couldn't pass the number check after one automatic fix. Rerun it, or open an issue with a synthetic copy of the export.
- **"No adapter recognised this export":** run in a terminal so noro can ask you to confirm its guessed columns.

Still stuck? Open an issue at [github.com/noro-to/noro/issues](https://github.com/noro-to/noro/issues). Use synthetic data only. Don't paste real client data.
