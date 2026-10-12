# Watchouts

A watchout is a claim in the original that could mislead its reader: platform-reported ROAS read as revenue, a trend called on three days, a drop inside the conversion-lag window, an Ads Advisor summary repeated unchecked, a click spike with no conversions. noro flags it to the writer. The writer decides.

## Where they come from

The rules with `category: watchout` in `scripts/rules.json`. `grade --watchouts` runs them on the original only and returns them under `watchouts`, each with its `rule`, `match`, `message` and `fix`. They are never scored. v0.1 rules are written for Google Ads first.

Flag only what a rule returns. A watchout from your own suspicion is analysis, and noro does none.

## In the rewrite

Keep a flagged claim as the original states it. If the format cuts it anyway, it goes in the cut list like any other cut. Never reword it in the reader's text.

## For the writer

Under the rewrite and the cut list, never in the reader's text. Each item: the quoted claim, the rule id, the reason in one line, and your pick of keep, cut or reword. A reword uses only the original's numbers.

```
Watchouts, for you
1. "ROAS hit 4.1x" (<rule id>): platform-reported, and the report treats it as revenue.
   Reword: "Platform-reported ROAS hit 4.1x."
2. "CPA spiked yesterday" (<rule id>): the last 2 days are still inside conversion lag.
   Cut, or reword: "Yesterday's CPA isn't settled yet."
```

Watchouts off: skip `--watchouts` and this file.
