# engine

The Python rules engine: `noro.py` (standard library only, Python 3.9+) and `rules.json`, the 100 rules it runs.

The check step in `src/check/` calls it as a tool. It runs `python3 engine/noro.py check|extract|grade` as a subprocess, passes temp files and reads JSON back. The engine was the core of the v0.1 Claude skill and is tested on its own (`tests/engine`, `tests/rules`), so v0.2 keeps it as is instead of porting it in the same release. It stays a separate tool until the TypeScript port; the CLI contract in [docs/engine.md](../docs/engine.md) is what that port has to match.

Who edits it: maintainers. Never edit `rules.json` by hand. Change a YAML file in `rules/` and run `python3 scripts/build_rules.py`.
