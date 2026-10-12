# Developing noro

How to build, test and release noro, and where each part of the pipeline lives. For what to contribute and the rules for examples, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Set up

You need Node 22.19+ (Node 24 recommended) and Python 3.9+. PyYAML is needed only to rebuild the rules.

```bash
git clone https://github.com/noro-to/noro && cd noro
npm ci            # installs and builds dist/ (prepare script)
npm link          # optional: puts noro on your PATH
pip install pyyaml
```

`npm run noro -- this fixtures/exports/google-ads.csv` runs the CLI from source with tsx. Set `NORO_MOCK_MODELS=1` to run the whole pipeline with no key and no model call.

## Build and test

| Command | What it does |
| --- | --- |
| `npm run lint` | Type-checks `src/`, the tests and `fixtures/generate.ts` |
| `npm run build` | Compiles to `dist/` and copies the adapter YAML files |
| `npm test` | The vitest suite in `tests/ts`. Models are mocked; no key needed |
| `python3 -m unittest discover -s tests/engine -v` | The engine suite |
| `python3 -m unittest discover -s tests/rules -v` | Every rule's flag and pass examples |
| `python3 scripts/build_rules.py` | Validates `rules/` and writes `engine/rules.json`. `--check` writes nothing: it validates, then exits 1 if `engine/rules.json` differs from what `rules/` would build |
| `npm pack --dry-run` | Lists what the npm package will ship |
| `docker build -t noro .` | Builds the image |

CI (`.github/workflows/ci.yml`) runs all of these on every push, and fails when `engine/rules.json` doesn't match `rules/`: it runs `build_rules.py` and then `git diff --exit-code engine/rules.json`.

## Fixtures

The exports in `fixtures/exports/` are generated from one synthetic story. After changing `fixtures/generate.ts`:

```bash
npx tsx fixtures/generate.ts
npm test
```

Tests that pin exact numbers will tell you what moved. Never commit a real export.

## Release

1. Set the version in `package.json` and add the entry to `CHANGELOG.md`.
2. Tag the commit `v<version>` (for example `v0.2.0`) and push the tag.
3. `.github/workflows/release.yml` checks that the tag matches `package.json`, runs the tests, publishes `@noro-to/noro` to npm with provenance and pushes `ghcr.io/noro-to/noro` for amd64 and arm64.

The one-time npm and GHCR setup is in the comment at the top of `release.yml`.

## Architecture

`noro this` runs seven steps as one durable task on Pi Durable (`src/harness/`). Each step is a checkpointed phase, so an interrupted run resumes at the step it stopped in.

| Step | Code | Model |
| --- | --- | --- |
| 1. Ingest | `src/ingest/`, `src/adapters/` | none |
| 2. Compute | `src/compute/` | none |
| 3. Classify | `src/classify/` | jev, a local decision model, or rules |
| 4. Draft | `src/draft/` | the writing model, through `src/providers/` |
| 5. Check | `src/check/` calls `engine/noro.py` | none |
| 6. Panel | `src/panel/`, personas in `prompts/panel/` | the panel model |
| 7. Deliver | `src/deliver/` | none |

The rule that holds it together: models never see a number. Compute builds a facts table, models write `{{f12}}` where a number goes, and `src/draft/template.ts` fills in values and refuses any digit or number word that isn't a fact. A pasted report (revision mode) enters at step 5, with its numbers turned into facts first.

The Python engine is called as a subprocess. It is the tested core from v0.1 and stays a separate tool until it is ported to TypeScript; see [engine/README.md](engine/README.md).

## Where to add things

- **A platform adapter**: one YAML file in `src/adapters/`, a synthetic fixture in `fixtures/exports/`, and a test in `tests/ts/adapters.test.ts`. Users can drop their own in `.noro/adapters/`.
- **A rule**: one YAML file in `rules/<category>/`, then `python3 scripts/build_rules.py` and the rules suite. Field reference in [docs/engine.md](docs/engine.md).
- **A reviewer persona**: one Markdown file in `prompts/panel/`. Users can add their own in `.noro/personas/`.
- **A writing provider**: an entry in `src/providers/registry.ts` (id, env vars, default model, docs link), a case in `createChatClientFor` in `src/providers/index.ts` (an OpenAI-style server reuses `openai-chat.ts`; anything pi-ai supports goes through `pi-ai.ts`), a wire test in `tests/ts/providers-http.test.ts`, and a section in `docs/install/providers.md`. A client forwards only the system and user text, sends no sampling parameters, and honors `ChatRequest.maxTokens` when it can.
