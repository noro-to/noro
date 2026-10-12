---
name: noro
description: Turn an ad-platform export (CSV, TSV or XLSX from Google Ads, Meta or Amazon DSP) into a short paid-media report, or audit and rewrite an existing report (.md or .txt), with every number computed by code and traced to a facts table. Use for "noro this <file>" or any request to write, check or tighten a paid-media report.
license: MIT
compatibility: Needs the noro CLI (npm i -g @noro-to/noro, or npx -y @noro-to/noro), Node 22.19+ and Python 3.9+.
allowed-tools: Bash(noro *) Bash(npx -y @noro-to/noro *)
metadata:
  homepage: https://noro.to
  repository: https://github.com/noro-to/noro
  hermes:
    category: analytics
    tags: [paid-media, reporting, google-ads, meta-ads, amazon-dsp]
---

# noro

noro writes the report. You run it, show the result and pass the user's choices back. Never type, change or compute a number in the report yourself: every number comes from noro's facts table.

## 1. Run it

Use an absolute path to the file.

```bash
noro this "/absolute/path/to/export.csv" --json --yes
```

If `noro` is not on PATH, use `npx -y @noro-to/noro this "/absolute/path/to/export.csv" --json --yes`. Never `npx noro`: that is a different package.

Options:
- `--format one-page|slack|email|slide-notes` when the user asks for a shape (default `one-page`).
- `--model <provider>:<id>` only when the user names a writing model for this run.

A run takes a few minutes. Progress goes to stderr; stdout is one JSON object.

## 2. Read the exit code

- **0**: the report is in the JSON. Show `text` as it is. Then show `classifier` and `summary.checked` (numbers traced) in one line.
- **2**: the report can't pass the number check. Say so and show stderr. Don't patch the numbers or write a report yourself.
- **1**: a setup or input problem. Show stderr. A missing key, Node or Python usually has the fix in the message; suggest `noro init --global` and then `noro doctor`.

## 3. Ask about each flag

The first run keeps every flag and lists them in `flags` (`id`, `source`, `text`, `quote`, the part of the report it is about, and `sentence`, the whole sentence holding the quote). Show each flag with its sentence and ask the user: keep, cut or reword. Cut and reword both act on the whole sentence, even when the quote is one word: cut removes the sentence, and a reword replaces the entire sentence. So take a full replacement sentence from the user, not a single word. A reword may only use numbers already in the report, written exactly as the report shows them.

If there are no flags, you're done.

## 4. Pass the choices back

```bash
noro this "/absolute/path/to/export.csv" --json --yes \
  --decisions '[{"flagId":"F1","action":"keep"},{"flagId":"F2","action":"cut"},{"flagId":"F3","action":"reword","text":"Search carried most of the spend this week."}]'
```

Use the same file and the same `--format` as the first run. Flags left out are kept. The second run reuses the first run's checkpoints, so no model is called again. Show the new `text`. If noro refuses a reword (it can't trace a number in it), tell the user why and ask again.

## Where a number comes from

```bash
noro facts "/absolute/path/to/export.csv" --json
```

This prints every fact (id, label, display value, formula) without a model or a key. Use it to answer "where does this number come from": find the fact whose `display` matches the number in the report and show its label and formula.
