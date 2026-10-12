# rules

One YAML file per rule, in seven categories: `tells`, `numbers`, `shape`, `specificity`, `actions`, `visual` and `watchout`. The schema is in [docs/engine.md](../docs/engine.md).

`python3 scripts/build_rules.py` validates every file and writes `engine/rules.json`, which is what the engine reads. CI fails when `rules.json` is out of date.

Who edits it: contributors. A new rule is one file with examples that must flag and examples that must pass. See [CONTRIBUTING.md](../CONTRIBUTING.md#add-a-rule).
