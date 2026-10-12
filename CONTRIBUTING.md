# Contributing to noro

The most useful things you can send are a platform adapter, a rule for slop that got past noro, or a reviewer persona.

All examples must be synthetic or anonymized. Change client and brand names and every number. No real employer or client data.

## Add a platform adapter

An adapter is one YAML file that maps a platform's export columns to noro's standard schema ([docs/schema.md](docs/schema.md)). It's the main way to add a platform.

1. Copy the adapter closest to yours in `src/adapters/` (for example `meta.yaml`) to `src/adapters/<platform>.yaml`.
2. Set its `id`, `platform` and header signature, the headers that tell noro an export came from this platform.
3. Map each column to a schema field. Divide micros fields by 1,000,000, keep the platform's primary conversions column as `conversions`, and put anything the schema doesn't name under `extra`.
4. Add a synthetic fixture: `fixtures/exports/<platform>.csv`, with two weeks of daily rows and invented names and numbers.
5. Add a test in `tests/ts/adapters.test.ts`: the fixture maps to the schema, totals rows are skipped and a few values match by hand.
6. Run `npm test`, then open a pull request.

Not sure about a platform's quirks? Open an [adapter issue](https://github.com/noro-to/noro/issues/new?template=add-platform-adapter.yml) with a synthetic header row first.

## Add a rule

1. Create one file: `rules/<category>/<slug>.yaml`. Categories are `tells`, `numbers`, `shape`, `specificity`, `actions`, `visual` and `watchout`.
2. Fill in the fields from the rule schema in [SPEC.md](SPEC.md). The `id` prefix matches the category (`T-` tells, `N-` numbers, `S-` shape, `P-` specificity, `A-` actions, `V-` visual, `W-` watchout).
3. Add examples:
   - `examples.flag`: sentences the rule must catch. Make the first one an anonymized excerpt of the real report where the slop slipped through.
   - `examples.pass`: close calls the rule must leave alone.
4. Say where it came from in `source`, for example "client report, Sept 2026, anonymized".
5. Write `why` in one sentence a media buyer would agree with, and `fix` as something the writer can do.
6. Build and test:

   ```bash
   pip install pyyaml
   python tools/build_rules.py
   python -m unittest discover -s tests/engine -v && python -m unittest discover -s tests/rules -v
   ```

Never edit `engine/rules.json` by hand. `tools/build_rules.py` writes it.

## Add a persona

1. Copy an existing file in `personas/` (for example `salesperson.md`) to `personas/<name>.md`.
2. Keep the same headings. Describe who the reader is, what they check first, and what makes them stop trusting a report.
3. Give one or two example notes they would leave on a draft.
4. Personas review the rewrite. They never add claims or numbers to it.

## Before you open a pull request

- `npm test` and both Python suites pass.
- One adapter, rule or persona per pull request.
- Plain writing. noro holds its own docs to its own rules.
