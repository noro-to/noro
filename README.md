# noro

Paid-media reports where every number is traced: noro turns a raw ad-platform export into a short report, with your choice of model writing the words.

> **Quick start**
>
> ```bash
> npm i -g @noro-to/noro
> noro init
> noro this export.csv
> ```
>
> Needs Node 22.19+ and Python 3.9+. `noro init` picks a model and writes `.env`. Other ways to install: [docs/install/](docs/install/README.md).
>
> Prefer drag and drop? `noro init --workspace` makes a folder to open in Claude Code: drop exports into `inbox/` and type "noro the inbox". See [workspace.md](docs/install/workspace.md).

noro is an open-source framework for reports a client or exec can act on. It also audits and rewrites reports someone already wrote. It runs on your machine with the model you choose: an API key, a cloud account, a local model, or your own Claude or ChatGPT plan.

| Before | After |
| --- | --- |
| ![Day-of-week report before noro: an intro, a two-period dumbbell chart with a side column, a long paragraph and two empty placeholder sections](examples/day-of-week/before.png) | ![The same report after noro: a one-line headline, one bar chart with Sunday highlighted, a why line and a next step](examples/day-of-week/after.png) |
| About 95 words plus a two-period chart | About 45 words and one chart |

## Works with

- **AI tools**: Claude Code, Codex, Cursor, VS Code, Windsurf, Zed, Hermes Agent and Gemini CLI, through the plugin, the skill or the `noro mcp` server
- **Writing models**: OpenRouter, Anthropic, OpenAI, Google Gemini, Amazon Bedrock, Google Vertex AI, Azure OpenAI, Mistral, DeepSeek, Groq and any OpenAI-compatible server
- **Local models**: Ollama and LM Studio
- **Your own plan**: Claude Code (`claude-cli`) and the Codex CLI (`codex-cli`), for personal use
- **Classify**: jev on OpenRouter or TypeSafe, a local decision model, or built-in rules
- **Exports**: Google Ads, Meta and Amazon DSP, and any other CSV or XLSX through a column-guessing step you confirm
- **Runs on**: macOS, Linux and Windows, Docker (`ghcr.io/noro-to/noro`), GitHub Codespaces and GitHub Actions

## The rule: the model never does arithmetic

Code computes every number into a facts table. The writing model only ever sees fact ids and labels, writes `{{f12}}` where a number goes, and code fills in the value. A number in the report that doesn't trace to a fact fails the run.

## Install

You need Node 22.19+ (Node 24 recommended) and Python 3.9+. noro checks both before it makes any paid call.

```bash
npm i -g @noro-to/noro
cd ~/reports
noro init                      # pick a model, writes .env
noro this ~/Downloads/campaign-report.csv
```

The package is `@noro-to/noro` and the command is `noro`. The unscoped `noro` package on npm is an unrelated project, so always keep the scope: `npx @noro-to/noro this campaign-report.csv` runs it without installing. Before the first npm release, install from GitHub with `npm i -g github:noro-to/noro`.

No Node or Python on the machine? Use the image:

```bash
docker run --rm -it -v "$PWD:/work" -w /work --env-file .env ghcr.io/noro-to/noro:latest this exports/google-ads.csv
```

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/noro-to/noro)

The full install guide is in [docs/install/](docs/install/README.md): the [CLI](docs/install/cli.md) on macOS, Linux and Windows, [model providers](docs/install/providers.md), [local models](docs/install/local.md), [subscription CLIs](docs/install/subscriptions.md), [AI tools](docs/install/agents.md), [a Claude Code workspace](docs/install/workspace.md), [Docker](docs/install/docker.md), [scheduled reports](docs/install/scheduled.md) and [classify](docs/install/classify.md).

## Pick your model

Set one variable, `NORO_MODEL=<provider>:<model-id>`, in `.env`. The default is `openrouter:anthropic/claude-opus-5.5`.

| You have | Set | Key |
| --- | --- | --- |
| An OpenRouter key | `NORO_MODEL=openrouter:anthropic/claude-opus-5.5` | `OPENROUTER_API_KEY` |
| An Anthropic, OpenAI or Gemini API key | `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol`, `google:gemini-3.1-pro-preview` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` |
| AWS, Google Cloud or Azure | `bedrock:global.anthropic.claude-opus-5-5`, `vertex:gemini-3.1-pro-preview`, `azure:gpt-6.1-sol` | Your cloud credentials |
| Ollama or LM Studio | `ollama:qwen3.8:27b`, `lmstudio:<model>` | None, runs on your machine |
| Claude Code or Codex, logged in | `claude-cli:claude-opus-5-5`, `codex-cli:default` | Your own plan, personal use only |

Mistral, DeepSeek, Groq and any OpenAI-compatible server work too. See [providers.md](docs/install/providers.md). noro's prompts are tuned on Claude Opus 5.5; other models work on a best-effort basis.

Classify (labelling each fact before the draft) uses [jev](https://openrouter.ai/docs/guides/community/jev) when you have an OpenRouter or TypeSafe key, or a local decision model. With neither, noro labels facts with rules from the computed flags. See [classify.md](docs/install/classify.md).

`noro doctor` checks your setup for free. `noro doctor --live` makes one small paid call per model, after asking.

### Example: writing on your Claude plan, jev on OpenRouter

```bash
# .env
NORO_MODEL=claude-cli:claude-opus-5-5   # your own logged-in Claude Code writes
OPENROUTER_API_KEY=sk-or-...            # jev classifies through OpenRouter
```

```bash
noro this report.csv                                              # writes with Claude Code
noro this report.csv --model openrouter:anthropic/claude-opus-5.5 # this run only, on OpenRouter
```

`--model` changes the writing model for one run. `claude-cli` runs your own `claude -p` with no tools and no customizations, strips API keys from that call, and stops unless `claude auth status` shows a subscription login. noro never reads or stores that login. It's for your own use on your own machine: Anthropic's [usage policy](https://code.claude.com/docs/en/legal-and-compliance) doesn't let products route other people's requests through Free, Pro or Max plans. If you run noro for others, use an API provider. Details in [subscriptions.md](docs/install/subscriptions.md).

## Use it from an AI tool

```text
/plugin marketplace add noro-to/noro        # Claude Code, then: /plugin install noro@noro
```

```bash
codex plugin marketplace add noro-to/noro                       # Codex
npx skills add noro-to/noro                                     # Cursor, VS Code, Zed, Windsurf and more
hermes skills install skills-sh/noro-to/noro/noro               # Hermes Agent
claude mcp add --transport stdio --scope user noro -- npx -y @noro-to/noro mcp   # MCP server
```

The skill runs `noro this <file> --json --yes`, shows you the report, asks about each flag and passes your choices back with `--decisions`. `noro mcp` exposes the tools `noro_this` and `noro_facts`. Config for Cursor, VS Code, Codex, Windsurf and Zed is in [agents.md](docs/install/agents.md).

For a folder of exports, `noro init --workspace` creates `noro-reports/` with an `inbox/`, the skill and a `CLAUDE.md`. Open it in Claude Code and type "noro the inbox": one report per file, saved to `reports/`, with each file moved to `inbox/done/` when its report is final. See [workspace.md](docs/install/workspace.md).

## Run it

```bash
noro this ~/Downloads/campaign-report.csv
noro this weekly-update.md --format slack
noro this google-ads.csv meta.csv amazon-dsp.csv   # one cross-channel report for all three
noro facts ~/Downloads/campaign-report.csv     # the facts table only, no model, no key
```

Several exports make one combined report: blended totals across platforms, each platform's share of spend and conversions, and the cross-channel story first. They must share a currency; differing dates are cut to the days they all cover, with a warning. Details in [cli.md](docs/install/cli.md#one-report-across-platforms).

In a source checkout, `fixtures/exports/` holds synthetic Google Ads, Meta and Amazon DSP exports to try it on.

| Flag | What it does |
| --- | --- |
| `--format slack\|email\|one-page\|slide-notes` | Output shape. Default `one-page` |
| `--yes` | Keep every flag without asking |
| `--json` | The report as JSON, with ingest warnings in `warnings` and the input files in `sources` |
| `--model <provider>:<id>` | The writing model for this run only |
| `--decisions <file\|json>` | Apply keep, cut and reword choices without asking |
| `--accept-warnings` | Go on when the export looks wrong. A cost column that looks like micros, or combined exports whose dates differ, otherwise stops the run before any model call |

Exit codes: 0 delivered, 2 the report can't pass the check, 1 a usage or input error.

## How it works

`noro this` runs seven steps. Each one is a checkpointed phase on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), so a run that's killed partway resumes where it stopped the next time you run the same command.

1. **Ingest** (code). Parse the CSV or XLSX and map its columns to one standard schema with the platform adapter.
2. **Compute** (code). Build the facts table: every metric, week-over-week change, share, sample size and baseline, each with an id, a formula and its inputs.
3. **Classify** (jev, a local decision model, or rules). Label each fact signal, noise or luck risk, with a priority and the watchouts that apply. Code can only make a label more cautious.
4. **Draft** (your writing model). Write the report with fact ids only.
5. **Check** (the rules engine). Trace every number to the facts table and run the 100 rules for slop, shaky claims and chart junk.
6. **Panel**. Reviewer personas read the draft as its reader would; their notes are applied or come to you as flags.
7. **Deliver**. You keep, cut or reword each flag, and get the final version.

A written report (`.md` or `.txt`) enters at step 5 in revision mode: its numbers become facts, and the rewrite has to be shorter and trace back to them.

## Privacy

noro has no telemetry, no analytics and no noro server. It sends data only to the model providers you configure, and never sends raw export rows, metric values, formulas or sample sizes. Labels such as campaign names do go out as written, and revision mode sends your prose with every number it recognizes, digits and number words ("five times", "Half") alike, replaced by ids. With a local writer and a local decision model (or `NORO_CLASSIFY=rules`), nothing leaves your machine. Run state stays in `.noro/` in the folder you run from.

Details: [PRIVACY.md](PRIVACY.md). The full policy for the software and noro.to is at [noro.to/privacy](https://noro.to/privacy). To report a vulnerability, see [SECURITY.md](SECURITY.md). Use synthetic data in issues, never real client data.

## Platforms

Google Ads, Meta and Amazon DSP ship as adapters in [`src/adapters/`](src/adapters/). Any other export goes through a column-guessing step that you confirm. The standard schema is in [docs/schema.md](docs/schema.md); it's a draft and the exact fields are still open.

Adding a platform is one YAML file. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

Coming soon:

- Live API connections to Google Ads, Meta and Amazon DSP
- Event triggers: a jev detector notices a CPA jump or a spend spike and wakes an agent

Weekly and monthly reports already work from an export file: see [scheduled.md](docs/install/scheduled.md) and the GitHub Actions template in [examples/noro-weekly.yml](examples/noro-weekly.yml).

## Repository map

| Folder | What's in it | Who edits it |
| --- | --- | --- |
| [`src/`](src/README.md) | The TypeScript pipeline and the `noro` command | Contributors, maintainers |
| [`engine/`](engine/README.md) | The Python rules engine (`noro.py`) and the built `rules.json` | Maintainers |
| [`rules/`](rules/README.md) | One YAML file per rule | Contributors |
| [`prompts/`](prompts/README.md) | Reviewer personas (`panel/`) and the writing guides (`guides/`) | Contributors, maintainers |
| [`skills/`](skills/README.md), `.claude-plugin/` | The agent skill and the Claude Code and Codex plugin | Maintainers |
| [`docs/`](docs/README.md) | Install guides, the schema and the engine contract | Maintainers |
| [`examples/`](examples/README.md) | The weekly GitHub Actions template, the Claude Code workspace template and the README images | Maintainers; users copy from it |
| [`fixtures/`](fixtures/README.md) | Synthetic exports and their generator | Contributors |
| [`bench/`](bench/README.md) | Synthetic reports with gold rewrites | Contributors |
| [`tests/`](tests/README.md) | vitest (`tests/ts`) and the Python suites (`tests/engine`, `tests/rules`) | Contributors, maintainers |
| [`scripts/`](scripts/README.md) | `build_rules.py` and other maintainer scripts | Maintainers |

To build, test or release from a checkout, see [DEVELOP.md](DEVELOP.md).

## Contributing

Adapters, rules and personas are each one file. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Some guardrails were inspired by [marketingskills](https://github.com/coreyhaines31/marketingskills) (MIT) and the [report-builder](https://github.com/anthropics/knowledge-work-plugins/tree/main/small-business/skills/report-builder) skill in Anthropic's knowledge-work-plugins (Apache-2.0).

## License

[MIT](LICENSE). Made by noro contributors at [noro.to](https://noro.to).
