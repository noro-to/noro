# Changelog

All notable changes to noro are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-12: framework restructure

noro is now an open-source, self-hosted TypeScript framework that runs on your own OpenRouter key. It generates paid-media reports from raw ad-platform exports, and it still audits and rewrites existing reports. The last Claude skill build is the snapshot commit [`8ac1033`](https://github.com/noro-to/noro/commit/8ac1033ac0deabf6daa04fc663ddc52c8cf8995c) ("Snapshot: Claude skill v0.1.0 before framework restructure").

### Why the skill was retired

The skill only ran inside Claude.ai and Claude Code, and it could only rewrite a report someone had already written. The framework reads the export itself, so code computes every number before a model sees anything. It runs anywhere Node runs, with any OpenRouter model, and each step is checkpointed on Pi Durable so an interrupted run resumes where it stopped.

### Added

- `noro this <export.csv|.xlsx>` generates a report. `noro this <report.md|.txt>` audits and rewrites one (revision mode, which enters at the check step).
- The seven-step pipeline: ingest, compute, classify, draft, check, panel, deliver. The model never does arithmetic: code builds a facts table, and the writing model only cites fact ids.
- Platform adapters (`src/adapters/*.yaml`) for Google Ads, Meta and Amazon DSP, plus a column-guessing step for unknown exports.
- Classification with jev (`typesafe/jev-1.13`). Writing (draft, panel, revision) defaults to `anthropic/claude-opus-5.5`, configurable in `.env`.
- Synthetic fixtures in `fixtures/exports/`, vitest tests, and a Node job in CI.
- Issue templates for new platform adapters and for slop that slipped through.

### Changed

- The engine moved from `skills/noro/scripts/` to `engine/` (`noro.py`, `rules.json`). Its CLI contract is unchanged, and the TypeScript pipeline calls it as a tool for the check step.
- `personas/` and `reference/` moved up from `skills/noro/`. Their content is unchanged except for the Claude-specific install notes.
- `tools/build_rules.py` writes `engine/rules.json`.
- The agent-facing instructions from `skills/noro/SKILL.md` now live in `reference/contract.md` and the draft and panel prompts.

### Removed

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (the Claude Code plugin and marketplace).
- `tools/build_zip.py` and the `noro.zip` build (the Claude.ai upload).
- The zip build and release-upload jobs in `.github/workflows/ci.yml`.
- `skills/noro/SKILL.md` (folded into `reference/contract.md` and the prompts).
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
