# scripts

Maintainer scripts. Nothing here ships in the npm package or the image.

- `build_rules.py`: validates `rules/**/*.yaml` and writes `engine/rules.json`. `--check` exits 1 when the JSON is stale. Needs PyYAML.
- `_gen_*.py`: one-off generators that wrote the first batch of rule files. The YAML files are the source now; edit those, not the generators.

Who edits it: maintainers.
