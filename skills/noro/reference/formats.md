# Formats

Pick the shape from the output format, then fill it with what the original says and nothing else. Two length rules hold for every format: the rewrite is shorter than the original, and it stays under the format's ceiling. A short original sets a lower ceiling.

| Format | Shape | Ceiling |
| --- | --- | --- |
| Slack / Teams | headline, Why, Next | 60 words |
| Email | subject (the headline), Why, Next | 120 words |
| One-page doc | headline, what happened, Why, Next, Basis if detail is full | 250 words |
| Slide notes | title (the headline), up to 3 bullets, a 2-sentence note | 80 words |
| One-page visual | title (the headline), one chart (two at most), Why, Next | 60 words of text |
| Same as input | the input's sections in its order, empty ones dropped | half the input |

The detail dial (`voice.md`) moves inside the ceiling: headline uses about a third of it, full can reach it.

## Rules for every format

- The headline is the point, with its number. It appears once: first line, subject, slide title or chart title. Never two of those.
- "Why" carries the cause the original gives, with the numbers behind it. A hypothesis keeps "likely" and says who confirms it.
- "Next" carries the action the original names. The original names none: drop the line and tell the writer under the rewrite.
- No headings under 150 words. Above that, sentence-case headings that state a claim.
- Bullets only for parallel items, three at most.

## Quiet week

When the original's news is "on track", the rewrite is three lines in any format, each from the original:

```
CPA $41 against the $45 target, on 312 conversions.
Nothing needs changing.
Next check: the 20 Oct weekly pull.
```

## Skeletons

**Slack / Teams**
```
<The point, with its number.>
Why: <the cause from the original, with its numbers>.
Next: <the action from the original: who, what, by when>.
```

**Email**
```
Subject: <the point, with its number>

<Name>,

<Why, one or two sentences.>

<Next, one sentence. A question to the reader if the original asks one.>

<Sign-off, only if the original has one.>
```

**One-page doc**
```
<The point, with its number.>

What happened: <2 to 4 numbers that bear on the point, each with its change.>
Why: <cause and its numbers>.
Next: <action>.
Basis: <source, dates compared, attribution window, as the original states them>.
```

**Slide notes**
```
Title: <the point as a sentence, with its number>
- <supporting number>
- <supporting number>
Note: <Why in one sentence.> <Next in one sentence.>
```

**One-page visual.** The reference rewrite: a 182-word section with two periods, a side column and two empty placeholders, cut to one chart and three lines:
```
Since May, Sunday costs $138 per conversion. Other days: $101.

[chart: bars from zero, cost per conversion by day, May–August 2026; Sunday highlighted at $138; dashed line "Other days $101"]

Why: CPC held at $13.52, but Sunday's conversion rate is 9.8% (other days 14.1%). The problem is likely after the click, not the ad.

Next: ask the client how Sunday calls and bookings are handled.
```
The title carries the headline, so no sentence repeats it. Chart rules: `visual.md`.

**Same as input.** Keep the input's sections and their order. Cut inside each. Drop a section left empty. Never add one.
