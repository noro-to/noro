# tests

- `ts/`: vitest tests for the TypeScript pipeline, run with `npm test`. Models are mocked, so no key is needed. `ts/fixtures/` holds fake `claude` and `codex` binaries and edge-case exports.
- `engine/`: unittest suite for `engine/noro.py`. Run `python3 -m unittest discover -s tests/engine -v`.
- `rules/`: checks every rule's `examples.flag` and `examples.pass`. Run `python3 -m unittest discover -s tests/rules -v`.

Who edits it: contributors and maintainers. A new adapter, rule or provider comes with its test.
