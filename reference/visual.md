# Visual

Load this when the input has an image (screenshot, slide, dashboard, chart) or the output is a one-page visual.

## Reading an image

1. **Transcribe.** Write `WORK/original.md` as the image's words: title, captions, labels, each chart as one `[chart: type, what it shows]` line, with the numbers left out. Text around the image goes in as written, numbers included. The length check measures this file. Image numbers stay out of it so `extract` can't mark a misread as confirmed.
2. **Extract** the text numbers: `python3 scripts/noro.py extract WORK/original.md --out WORK/ledger.json`.
3. **Read the numbers the point rests on:** titles, tiles, data labels, table cells. On a dense dashboard, the ones that bear on the point, not every cell. Prefer printed values. A value read off an axis says so in its context ("Mon dot, read off axis").
4. **Add each one:** `python3 scripts/noro.py ledger-add --ledger WORK/ledger.json --raw '$138' --context "Sun bar label, May–Aug" --source image`.
5. **Confirm with the user** before rewriting. Show the list:

   | id | number | where |
   | --- | --- | --- |
   | i1 | $138 | Sun bar label, May–Aug |
   | i2 | $101 | dashed line, "Other days since May" |

   Fix a misread by adding the right value and confirming only that id. Then `python3 scripts/noro.py confirm --ledger WORK/ledger.json --ids i1,i2`.

## Judging the original

`grade` returns `judge_rules`: ids of `engine: judge` rules in `scripts/rules.json` (category `visual`) that you apply yourself. Answer each rule's `rubric.question` against the image and score it with its `rubric.anchors` (0 to 2). A 0 or 1 marks something to cut or redraw. The usual offenders: a title that names the metric instead of the point, the headline repeated in title, subtitle and text, two periods when the point is one, a side column the text never uses, bars on a cut axis, a legend where a direct label would do.

## Producing a one-page visual

- Fewer charts than the original. Usually one.
- Each chart's title states its point, with its number. The title is the headline; the text doesn't repeat it.
- Honest axes: bars start at zero. No dual axes.
- A comparison only when it is the point. One reference line ("Other days $101") beats a second period.
- No side data: no extra columns, tables or tiles beside the chart.
- One bar or line carries the point, in the one accent color. The rest are gray. Label that value directly; no legend.
- Under the chart, the Why and Next lines. Nothing else.
- In `rewrite.md`, describe each chart in one `[chart: ...]` line that lists every number printed on it, so `check` traces them. Axis ticks don't count; write "bars from zero", not "$0".

## Drawing it

In Claude.ai and Claude Code, draw with Python and matplotlib to a PNG, or build an artifact when the user wants it on a page. Every value plotted comes from the confirmed ledger.

```python
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.rcParams["text.parse_math"] = False    # "$" is currency, not math
days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
cpa = [104, 97, 95, 105, 101, 109, 138]   # confirmed ledger values
fig, ax = plt.subplots(figsize=(7.6, 3.8), dpi=150)
ys = list(range(len(days)))[::-1]
ax.barh(ys, cpa, height=0.62, color=["#2f6fd6" if d == "Sun" else "#cfcfca" for d in days])
ax.axvline(101, color="#555", ls=(0, (3, 3)), lw=1)
ax.text(102.5, 6.45, "Other days $101", fontsize=9)
ax.text(140, 0, "$138", va="center", color="#2f6fd6", weight="bold")
ax.set_yticks(ys, days); ax.set_xlim(0, 155); ax.tick_params(length=0)
for s in ax.spines.values(): s.set_visible(False)
ax.set_title("Since May, Sunday costs $138 per conversion. Other days: $101.", loc="left")
fig.savefig("chart.png", bbox_inches="tight")
```

No code execution: describe the chart in words for the user to build in their own tool.

## The cut list

Every chart, series, column, tile, period or section you remove gets one line, with why. The day-of-week rewrite in `formats.md`:

- January–April comparison (the decision is about now)
- conversions-per-day column
- Thursday's closed January–April gap
- weekend share of spend and conversions (22% / 22%)
- two empty placeholder sections
