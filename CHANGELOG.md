# Changelog

All notable changes to noro are listed here. Versions follow [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/noro-to/noro/releases/tag/v0.1.0
