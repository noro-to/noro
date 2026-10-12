# noro

**No more AI report slop.**

noro is a free skill for Claude. Give it an ad-performance report you already have, written or visual, and it returns a shorter, plain version. It does no analysis of its own.

| Before | After |
| --- | --- |
| ![Day-of-week report before noro: an intro, a two-period dumbbell chart with a side column, a long paragraph and two empty placeholder sections](examples/day-of-week/before.png) | ![The same report after noro: a one-line headline, one bar chart with Sunday highlighted, a why line and a next step](examples/day-of-week/after.png) |
| About 95 words plus a two-period chart | About 45 words and one chart |

## What it does

- **Shorter, always.** Fewer words and fewer charts than the original.
- **Every number checked.** A script traces each number in the rewrite back to the original. A number the original didn't have is computed by the script and confirmed by you.
- **No slop, written or visual.** AI-sounding phrases, filler and chart junk are cut.
- **Doubtful claims flagged.** noro points them out and never changes them quietly.

## Install

**Claude.ai** (Pro, Max, Team or Enterprise)

1. Download `noro.zip` from the [latest release](https://github.com/noro-to/noro/releases/latest).
2. Go to Settings → Capabilities and turn on **Code execution and file creation**.
3. In the Skills section on the same page, click **Upload skill** and choose `noro.zip`.

**Claude Code** (run inside a session)

```text
/plugin marketplace add noro-to/noro
/plugin install noro@noro
```

Pick a scope when asked. If Claude Code says `Run /reload-plugins to apply`, run it.

Step-by-step guide with screenshots: [docs/getting-started.md](docs/getting-started.md).

## Use it

Paste or attach a report and say **"noro this"**. That one command runs the full flow every time:

```text
your report  →  "noro this"  →  the rewrite + the review panel's notes
```

The first run asks who reads the report, who should review the draft, whether to flag watchouts, and how you like it written. noro saves the answers. Every run asks which format you want back: Slack or Teams, email, one-page doc, slide notes, one-page visual, or the same as the input.

## How it works

1. A script pulls every number out of the original into a ledger. Numbers read off a screenshot are confirmed by you first.
2. Claude rewrites the report for your audience, cutting what doesn't change the decision.
3. Reviewers you pick (media buyer, salesperson, cross-functional partner, statistics person, ADHD reader, or your own) read the draft and push back.
4. The script checks the rewrite: every number traces, nothing unconfirmed, shorter than the original, no slop rules hit.
5. You get the rewrite plus any claims flagged for you to decide on.

## Works with

noro reads reports from any tool, including the Meta and Google Ads connectors, Supermetrics exports, claude-ads bundles and CSV.

## Contributing

Every rule is one YAML file in [`rules/`](rules/) with an example that should be flagged and one that should pass. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Some guardrails were inspired by [marketingskills](https://github.com/coreyhaines31/marketingskills) (MIT) and the [report-builder](https://github.com/anthropics/knowledge-work-plugins/tree/main/small-business/skills/report-builder) skill in Anthropic's knowledge-work-plugins (Apache-2.0).

## License

[MIT](LICENSE). Made by noro contributors at [noro.to](https://noro.to).
