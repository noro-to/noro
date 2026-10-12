# Changelog

All notable changes to noro are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-12: framework restructure

noro is now an open-source, self-hosted TypeScript framework that runs with the model you choose: an API key, a cloud account, a local model or your own Claude or ChatGPT plan. It generates paid-media reports from raw ad-platform exports, and it still audits and rewrites existing reports. The last Claude skill build is the snapshot commit [`8ac1033`](https://github.com/noro-to/noro/commit/8ac1033ac0deabf6daa04fc663ddc52c8cf8995c) ("Snapshot: Claude skill v0.1.0 before framework restructure").

### Why the skill was retired

The skill only ran inside Claude.ai and Claude Code, and it could only rewrite a report someone had already written. The framework reads the export itself, so code computes every number before a model sees anything. It runs anywhere Node runs, with the model you choose, and each step is checkpointed on Pi Durable so an interrupted run resumes where it stopped.

### Added: run anywhere, with any model

- **Writing providers.** `NORO_MODEL=<provider>:<model-id>` picks the writing model (split on the first colon; a bare id means OpenRouter). Providers: `openrouter` (default `openrouter:anthropic/claude-opus-5.5`), `anthropic`, `openai`, `google` (Gemini API), `bedrock`, `vertex`, `azure`, `mistral`, `deepseek`, `groq`, `openai-compatible` (`NORO_BASE_URL`, `NORO_API_KEY`), and the local presets `ollama` and `lmstudio`. `NORO_DRAFT_MODEL` and `NORO_PANEL_MODEL` stay as per-step overrides, and `NORO_WRITER=claude-cli` is kept as an alias.
- **Subscription CLIs, personal use.** `codex-cli` joins `claude-cli`: your own logged-in Codex runs read-only in an empty folder, with API-key settings stripped.
- **`--model <provider>:<id>`** switches the writing model for one run.
- **`noro init`** (setup wizard with presets, hidden key input, `.env` written in place with a backup and mode 600) and **`noro doctor`** (free checks, keys shown as fingerprints; `--live` makes a paid one-token test only after asking).
- **`noro facts <file>`**: ingest and compute only, no model and no key.
- **Combined cross-channel reports.** `noro this google.csv meta.csv amazon.csv` writes one report across platforms: blended "all channels" totals, each platform's totals, rates, week-over-week changes and share of total spend and conversions, and campaign facts per platform. The writer is told to lead with the cross-channel story when platforms diverge. Exports in different currencies are refused (no conversion), a written report can't be mixed in, and differing dates are cut to the days every file covers with a warning that stops the run unless `--accept-warnings`. `--json` lists the input files in `sources`; the run key hashes every file, so resume works. `noro facts` and the MCP tools (`paths`) take several files too. Single-file facts and run keys are unchanged.
- **`--decisions <file|json>`**: keep, cut and reword choices passed back by an agent; only the deliver step reruns.
- **Keys from `~/.config/noro/.env`** as well as `./.env`, so AI tools can start noro from any folder. Node and Python are checked before any paid call, with a Windows-aware Python lookup (`NORO_PYTHON`, split on spaces, alone when set; else `python3`, `python`, `py -3`).
- **Classify options.** jev through any System One endpoint (`NORO_CLASSIFY_BASE_URL`): OpenRouter, TypeSafe directly (`TYPESAFE_API_KEY`) or a local decision model. Keys go only to their own host, at most 64 questions per call. Without a key, deterministic rules from the computed flags (`NORO_CLASSIFY=rules`); classifying with the writing model is opt-in (`NORO_CLASSIFY=writer`). noro prints which classifier it picked.
- **`noro mcp`**: a stdio MCP server with the tools `noro_this` and `noro_facts`, for Claude Code, Codex, Cursor, VS Code, Windsurf, Zed and Hermes.
- **The Claude Code and Codex plugin and the skill**, back as a thin wrapper around the CLI: `skills/noro/SKILL.md`, `.claude-plugin/plugin.json` and `marketplace.json` (`/plugin install noro@noro`, `npx skills add noro-to/noro`).
- **Distribution.** The npm package `@noro-to/noro` (the command is still `noro`), published with provenance. The image `ghcr.io/noro-to/noro` (Node 24, Python 3, amd64 and arm64). A Codespaces devcontainer. A release workflow. A weekly GitHub Actions template in `examples/noro-weekly.yml`, plus cron, systemd and launchd examples in `docs/install/scheduled.md`.
- **Docs.** `docs/install/` covers every install path, provider and classify option. `SECURITY.md` explains private vulnerability reporting. `PRIVACY.md` lists what leaves your machine. Issue templates ask for synthetic data only.

### Fixed: hardening from review

- The digit rule now refuses numbers written in words ("forty-one dollars", "double", "twice the", "two-fold", "by a third", "cut in half", "one in five", "a dozen", "only three", "two thirds", "first", "second"), any Unicode numeral (superscripts, vulgar fractions, roman numerals, circled digits), invisible characters that split a word, and references run into digits, units, signs or other references (`{{f1}}{{f2}}`, `{{f1}}k`, `-{{f1}}`). Ordinary phrases ("no one", "one of the", "third-party", "double-check", "this quarter") still pass.
- Revision mode allows only strict identifiers (letter-led codes such as Q4, H2, FY26, PR-07; years; dates; period labels). Every other digit run in a pasted report becomes a fact, so no model sees it.
- Rewords at deliver go through the same check as model output.
- Ingest warnings reach the report (`warnings` in `--json`, stderr otherwise). A plain cost column that looks like micros stops the run before any model call unless you pass `--accept-warnings` or confirm.
- An unknown `--format` is a usage error (exit 1). A report whose writer keeps breaking the digit rule exits 2. Mock runs never resume under real models. `<cwd>/.noro/adapters` loads when `cwd` is not the process directory. The footer says "1 note".
- The engine call splits the Python command the same way the lookup does, so `py -3` on Windows and `NORO_PYTHON="python3 -I"` run the check step.
- `noro doctor --live` really caps its test call at 16 output tokens: chat requests take `maxTokens`, and the API clients send it (`claude-cli` and `codex-cli` have no such flag and ignore it).
- A change cited right after "rose" or "fell" renders without its redundant sign ("rose 38%").
- Revision mode: a number word the pasted original already used ("the two", "six months", "nine campaigns") may stay in the rewrite, since no code computed it. A number word the original didn't use is still refused, a bare scale word ("million") never passes, and generate mode stays strict.
- From the final review: piped output is no longer cut at 64 KiB (the CLI sets the exit code and lets stdout drain instead of exiting). Reword replaces the whole sentence, the same span cut removes, and each flag names that sentence. `noro_this` lists the applied action per flag after decisions instead of asking again. Placeholder keys (`sk-or-v1-0000...`, `sk-or-...`) count as unset and `noro doctor` warns, and `.env.example` ships no key. Revision mode turns number words into facts as written, so no model sees them. An empty `--model` is a usage error and a bare provider name (`claude-cli`) means its default model. `.env` is written mode 600 from the first byte, `.noro/` is 700 and checkpoints 600, and the weekly workflow no longer uploads checkpoints as an artifact. A broken `NORO_PYTHON` fails clearly, mock runs name the canned classifier, subscription CLI logins are checked before classify, and ingest errors show short header names only.

### Added: the framework

- `noro this <export.csv|.xlsx>` generates a report. `noro this <report.md|.txt>` audits and rewrites one (revision mode, which enters at the check step).
- The seven-step pipeline: ingest, compute, classify, draft, check, panel, deliver. The model never does arithmetic: code builds a facts table, and the writing model only cites fact ids.
- Platform adapters (`src/adapters/*.yaml`) for Google Ads, Meta and Amazon DSP, plus a column-guessing step for unknown exports.
- Classification with jev (`typesafe/jev-1.13`). Writing (draft, panel, revision) defaults to `anthropic/claude-opus-5.5`, configurable in `.env`.
- Synthetic fixtures in `fixtures/exports/`, vitest tests, and a Node job in CI.
- Issue templates for new platform adapters and for slop that slipped through.

### Changed

- Node 22.19 or newer is required (Node 24 recommended). `npm ci` builds through a `prepare` script. `npm run lint` also type-checks the tests and `fixtures/generate.ts`.
- The engine moved from `skills/noro/scripts/` to `engine/` (`noro.py`, `rules.json`). Its CLI contract is unchanged, and the TypeScript pipeline calls it as a tool for the check step.
- The reviewer personas moved from `skills/noro/personas/` to `prompts/panel/`, and the writing guides from `skills/noro/reference/` to `prompts/guides/`. Their content is unchanged except for the Claude-specific install notes.
- `SPEC.md` is now `docs/engine.md`, `tools/` is now `scripts/` (`scripts/build_rules.py` writes `engine/rules.json`), and the privacy notes are `PRIVACY.md` at the root, next to `SECURITY.md`.
- Every top-level folder has a short `README.md` saying what is in it and who edits it. `DEVELOP.md` covers building, testing and releasing.
- The agent-facing instructions from `skills/noro/SKILL.md` now live in `prompts/guides/contract.md` and the draft and panel prompts.

### Removed

- The v0.1 `.claude-plugin/plugin.json` and `marketplace.json`, which installed the old skill. The v0.2 plugin replaces them and runs the CLI.
- `tools/build_zip.py` and the `noro.zip` build (the Claude.ai upload).
- The zip build and release-upload jobs in `.github/workflows/ci.yml`.
- The v0.1 `skills/noro/SKILL.md` (its instructions are folded into `prompts/guides/contract.md` and the prompts). The v0.2 skill at the same path is a thin wrapper around the CLI.
- The Claude.ai and plugin install sections in `README.md` and `docs/getting-started.md`.

## [0.1.0] - 2026-10-12

First release.

### Added

- The noro skill for Claude.ai (`noro.zip` upload) and Claude Code (plugin and marketplace in this repo).
- Rewrites an existing ad-performance report, written or visual, into a shorter, plain version. No analysis of its own.
- Number checks by script (`scripts/noro.py`): `extract`, `ledger-add`, `derive`, `confirm`, `check` and `grade`. Every number in a rewrite must trace to the original or be derived by the script and confirmed by the user.
- Slop rules in `rules/`, one YAML file each, built into `scripts/rules.json`. Categories: tells, numbers, shape, specificity, actions, visual and watchouts.
- Intake: output format on every run. Audience, reviewers, watchouts and voice on the first run, then saved.
- Reviewer personas: media buyer, CFO and skeptical client.
- Optional watchouts that flag doubtful claims in the original, Google Ads first.
- Synthetic benchmark corpus in `bench/corpus/`.
- CI that builds the rules, runs the tests, builds `noro.zip`, and attaches it to tagged releases.

[0.2.0]: https://github.com/noro-to/noro/compare/8ac1033...v0.2.0
[0.1.0]: https://github.com/noro-to/noro/commit/8ac1033ac0deabf6daa04fc663ddc52c8cf8995c
