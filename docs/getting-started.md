# Getting started with noro

This guide takes you from nothing to your first report in about ten minutes. You'll use a terminal, but you only need to copy and paste.

## What you need

- **Node 22.19 or newer** (Node 24 recommended). Check with `node --version`. Install it from [nodejs.org](https://nodejs.org).
- **Python 3.9 or newer.** Check with `python3 --version`. The rules engine uses only the standard library.
- **An OpenRouter key.** Sign in at [openrouter.ai](https://openrouter.ai), add credits, and create a key under Keys. It starts with `sk-or-`.
- **Optional: Claude Code** logged in with your Claude plan, if you want the writing steps to run on your subscription (step 3).

## 1. Get noro

```bash
git clone https://github.com/noro-to/noro
cd noro
npm ci
npm run build
```

## 2. Add your key

```bash
cp .env.example .env
```

Open `.env` and put your key after `OPENROUTER_API_KEY=`. `.env` is gitignored, so the key never gets committed. Don't paste it anywhere else.

## 3. Pick who writes

By default the writing steps (draft, panel, revision) run on `anthropic/claude-opus-5.5` through OpenRouter, billed per token.

To run them on your own Claude subscription instead, install [Claude Code](https://claude.com/claude-code), run `claude` once and log in with your Claude account, then set this in `.env`:

```bash
NORO_WRITER=claude-cli
```

The classify step (jev) always uses OpenRouter. The subscription option is for your own use on your own machine; the [README](../README.md#writing-on-your-claude-subscription) explains why.

## 4. Run it on a sample

```bash
npx noro this fixtures/exports/google-ads.csv
```

You'll see each step as it runs: ingest, compute, classify, draft, check, panel, deliver. Then noro shows each flag it has for you, one at a time:

- **keep**: leave the sentence as it is
- **cut**: remove it
- **reword**: type a replacement. Use the numbers already in the report; noro refuses any it can't trace.

The report prints at the end, with a footer like `Checked: 9 numbers traced. Panel: 2 notes, 1 applied.`

## 5. Run it on your own data

Export a campaign report with daily rows from Google Ads, Meta Ads Manager or Amazon DSP, covering at least two weeks so noro can compare them. Then:

```bash
npx noro this ~/Downloads/your-export.csv
```

From another platform? noro guesses which column is spend, clicks and so on, and asks you to confirm before it uses them.

Already have a written report? Give noro the text:

```bash
npx noro this weekly-update.md --format email
```

Formats: `slack`, `email`, `one-page` (the default) and `slide-notes`.

## If a run stops partway

Run the same command again. noro keeps a checkpoint after every step in `.noro/` and carries on from the last one.

## If something goes wrong

- **"OPENROUTER_API_KEY is not set":** check `.env` is in the folder you run `noro` from, and the key is on the `OPENROUTER_API_KEY=` line.
- **"Claude Code is not logged in" or "not a Claude subscription":** run `claude`, log in with your Claude account, and check `claude auth status` shows `claude.ai`.
- **Exit code 2:** the report couldn't pass the number check after one automatic fix. Rerun it, or open an issue with a synthetic copy of the export.
- **"No adapter recognised this export":** run in a terminal so noro can ask you to confirm its guessed columns.

Still stuck? Open an issue at [github.com/noro-to/noro/issues](https://github.com/noro-to/noro/issues). Use synthetic data only.
