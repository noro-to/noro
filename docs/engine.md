# noro engine spec

This file documents the Python rules engine (`engine/noro.py`) and the rule schema. The engine's CLI contract below has not changed since v0.1. In v0.2 the TypeScript framework calls it as a tool for the check step (`src/check/`), with a ledger built from the facts table instead of from an original report. The pipeline itself is described in the [README](../README.md); the v0.1 Claude skill this spec was first written for is retired (see [CHANGELOG.md](../CHANGELOG.md)).

**Data rule:** all test data is synthetic. No real employer or client data anywhere.

## Engine CLI contract (`engine/noro.py`)

Every command prints JSON to stdout. Exit codes: 0 = ok/pass, 2 = check failed, 1 = usage or input error. The default rules path is `rules.json` next to `noro.py`. Input files are `.txt` or `.md`. Numbers from images come in through `ledger-add`.

```
python3 noro.py extract REPORT [--out LEDGER]
  → {"source": "REPORT", "word_count": N, "numbers": [
       {"id": "n1", "raw": "$48,213", "value": 48213.0, "unit": "USD", "kind": "currency",
        "context": "...spend increased to $48,213, a 12% increase...", "span": [s, e],
        "origin": "text", "confirmed": true}]}
  kinds: currency | percent | pp | multiplier | count | ratio
  understands: $48,213 · $48.2k · $1.2M · €1,204.50 · 12% · -3.1% · +0.3 pp · 4.1x · ROAS 4.1 · 790 conversions · 1,234
  ignores identifiers: PR-03, Q4, W45, 2026, dates (Oct 12, 2026-10-12, 10/12), times, "top 3" ordinals, version numbers

python3 noro.py ledger-add --ledger LEDGER --raw "$48.2k" --context "Spend tile, top-left" [--source image]
  → adds a number read off an image: origin "image", confirmed false

python3 noro.py derive --ledger LEDGER --op pct_change|diff|ratio|sum|share --ids n2,n1 [--label TEXT]
  → adds {"id": "d1", "value": 12.0, "unit": "%", "kind": "percent", "formula": "(48213-43047)/43047*100",
           "derived": true, "inputs": ["n2", "n1"], "confirmed": false}
  pct_change = (to - from) / from * 100, where --ids from,to

python3 noro.py confirm --ledger LEDGER --ids d1,i3      → marks those numbers confirmed

python3 noro.py check REWRITE --ledger LEDGER --original REPORT [--rules RULES]
  → {"pass": bool,
     "untraced": [{"raw", "value", "span", "nearest": {"id", "raw", "delta"}}],
     "unconfirmed": [ids used in the rewrite whose numbers are not yet confirmed],
     "length": {"original_words": N, "rewrite_words": M, "shorter": bool},
     "tells": [findings],                  (rules with applies_to text|both run on the rewrite)
     "exit": 0|2}
  A number traces when, after normalizing units (k/M suffixes, %, pp, currency),
  |value - ledger.value| <= half a unit of the last digit shown in the rewrite ("$48.2k" matches 48213; "39%" matches 39.14).
  pass = no untraced numbers AND nothing unconfirmed AND shorter AND no tells with severity "error".

python3 noro.py grade REPORT [--rules RULES] [--watchouts]
  → {"score": 0-100, "verdict": "ship"|"tighten"|"rewrite",
     "dims": {"tells": 0-4, "numbers": 0-4, "shape": 0-4, "specificity": 0-4, "actions": 0-4},
     "na": [dims with no applicable rules], "findings": [findings], "watchouts": [findings if --watchouts],
     "judge_rules": [ids of engine:"judge" rules the model should apply itself, e.g. visual]}

finding = {"rule": id, "name", "category", "severity", "match": text, "span": [s, e], "message", "fix"}
```

**Scoring.** Each finding has a weight: error = 4, warning = 1, advisory = 0. A rule adds at most 2 points per report. Each dimension scores `max(0, 4 - sum)`. A dimension with no applicable rules is marked n/a and left out. `score = round(100 * total / (4 * applicable dims))`.

**Verdict:** any error or score < 50 → rewrite; score < 85 → tighten; otherwise ship.

**Category → dimension:**

| Category | Dimension |
| --- | --- |
| tells | tells |
| numbers | numbers |
| shape | shape |
| specificity | specificity |
| actions | actions |
| visual | not scored by the engine (`engine: judge`) |
| watchout | reported separately, never scored |

## Rule schema (YAML source → rules.json)

One file per rule: `rules/<category>/<slug>.yaml`.

```yaml
id: T-hedge-stack            # prefix by category: T tells, N numbers, S shape, P specificity, A actions, V visual, W watchout
slug: hedge-stack            # used for noro.to/slop/<slug>
name: Hedge stack            # human name shown in the checker
category: tells              # tells | numbers | shape | specificity | actions | visual | watchout
severity: warning            # error | warning | advisory
engine: phrase               # phrase | regex | count | judge
applies_to: text             # text | visual | both ; watchouts run on the ORIGINAL only
phrases: ["may potentially", "could potentially"]   # engine phrase: case-insensitive, word-boundary, ’ and ' treated alike
patterns: ['\bseems to (suggest|indicate)\b']        # engine regex: Python re, case-insensitive
unless: '\b(on|by) (mon|tue|wed|thu|fri|sat|sun)'    # optional regex; if it matches the same sentence, the finding is dropped
count: {pattern: '—', max: 1, per: report}          # engine count: flag when matches exceed max (per report | per 100 words)
rubric:                                              # engine judge only: the question and 0–2 anchors the model applies
  question: "Does each chart's title state its point?"
  anchors: {0: "...", 1: "...", 2: "..."}
message: "Hedge stack: '{match}'"
why: "Readers read stacked hedges as AI-written and as the writer not knowing."
fix: "State the claim and what it rests on ('based on 38 conversions'), or cut it."
examples:
  flag: ["This could potentially indicate efficiency may have been impacted."]
  pass: ["CPA rose 39% to $61, based on 790 conversions."]
source: "noro landing page; r/marketing (round 1)"
```

The build validates required fields and fails on duplicate ids or slugs. It writes `{"version": "0.1.0", "rules": [...]}` sorted by id. Judge rules carry their rubric through to `rules.json` unchanged.
