# Contributing to noro

The most useful thing you can send is a rule for slop that got past noro, or a reviewer persona.

All examples must be synthetic or anonymized. Change client and brand names and every number. No real employer or client data.

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
   python -m unittest discover -s tests -v
   ```

Never edit `skills/noro/scripts/rules.json` by hand. `tools/build_rules.py` writes it.

## Add a persona

1. Copy an existing file in `skills/noro/personas/` (for example `salesperson.md`) to `skills/noro/personas/<name>.md`.
2. Keep the same headings. Describe who the reader is, what they check first, and what makes them stop trusting a report.
3. Give one or two example notes they would leave on a draft.
4. Personas review the rewrite. They never add claims or numbers to it.

## Before you open a pull request

- `python tools/build_zip.py` builds `dist/noro.zip` without errors.
- One rule or one persona per pull request.
- Plain writing. noro holds its own docs to its own rules.
