# Install noro

These pages cover noro v0.2. Pick one row from each table below, then follow the linked page.

noro uses two models. A writing model drafts and revises the report. A decision model (jev, or a local one) labels each fact before the draft; without one, noro labels facts with rules. If you have neither key yet, start with the [CLI page](cli.md) and run `noro init`. It asks a few questions and writes your `.env`.

## How you run noro

| You want to | Use | Page |
| --- | --- | --- |
| Run it in a terminal | `npm i -g @noro-to/noro`, then `noro this <file>` | [cli.md](cli.md) |
| Ask for it inside Claude Code, Codex, Hermes Agent, Cursor, VS Code, Windsurf, Zed or Gemini CLI | The Claude plugin, the Codex plugin, the Hermes skill, `npx skills add noro-to/noro`, or the `noro mcp` server | [agents.md](agents.md) |
| Drop files into a folder and type "noro the inbox" in Claude Code | `noro init --workspace` | [workspace.md](workspace.md) |
| Run it with no Node or Python on the machine | `ghcr.io/noro-to/noro` | [docker.md](docker.md) |
| Get a report every week or month | GitHub Actions, Hermes cron, cron, systemd or launchd | [scheduled.md](scheduled.md) |

## Which model writes

Set one variable: `NORO_MODEL=<provider>:<model-id>`. The default is `openrouter:anthropic/claude-opus-5.5`.

| Provider | Billing | Example `NORO_MODEL` | Page |
| --- | --- | --- | --- |
| `openrouter` | Per token | `openrouter:anthropic/claude-opus-5.5` | [providers.md](providers.md#openrouter) |
| `anthropic` | Per token | `anthropic:claude-opus-5-5` | [providers.md](providers.md#anthropic) |
| `openai` | Per token | `openai:gpt-6.1-sol` | [providers.md](providers.md#openai) |
| `google` (Gemini API) | Per token | `google:gemini-3.1-pro-preview` | [providers.md](providers.md#google) |
| `bedrock` | Your AWS account | `bedrock:global.anthropic.claude-opus-5-5` | [providers.md](providers.md#bedrock) |
| `vertex` | Your Google Cloud account | `vertex:gemini-3.1-pro-preview` | [providers.md](providers.md#vertex) |
| `azure` | Your Azure account | `azure:gpt-6.1-sol` | [providers.md](providers.md#azure) |
| `mistral`, `deepseek`, `groq` | Per token | `mistral:mistral-large-4` | [providers.md](providers.md#mistral) |
| `openai-compatible` | Whoever runs the server | `openai-compatible:my-model` | [providers.md](providers.md#openai-compatible) |
| `ollama`, `lmstudio`, llama.cpp, vLLM | Free, on your machine | `ollama:qwen3.8:27b` | [local.md](local.md) |
| `claude-cli`, `codex-cli` | Your own Claude or ChatGPT plan, personal use | `claude-cli:claude-opus-5-5` | [subscriptions.md](subscriptions.md) |

noro's prompts are tuned on Claude Opus 5.5. Other models work on a best-effort basis until they are benchmarked on `bench/corpus/`.

## How classify runs

| Option | What you set | Cost | Page |
| --- | --- | --- | --- |
| jev through OpenRouter (default) | `OPENROUTER_API_KEY` | About $0.003 per run | [classify.md](classify.md#jev-through-openrouter) |
| jev from TypeSafe directly | `TYPESAFE_API_KEY` | About $0.003 per run | [classify.md](classify.md#jev-from-typesafe) |
| A local decision model | `NORO_CLASSIFY_BASE_URL`, `NORO_CLASSIFY_MODEL` | Free | [classify.md](classify.md#a-local-decision-model) |
| Rules from the computed facts | `NORO_CLASSIFY=rules`, or no key at all | Free | [classify.md](classify.md#rules) |

## Requirements

| Need | Version | Notes |
| --- | --- | --- |
| Node | 22.19 or newer, 24 LTS recommended | Not needed with Docker |
| Python | 3.9 or newer | Standard library only. Runs the rules engine. Not needed with Docker |
| A writing model | Any row above | A key, a cloud account, a local server or a logged-in subscription CLI |
| A decision model | Optional | Without one, noro classifies with rules |
| OS | macOS, Linux, Windows (native or WSL) | See [cli.md](cli.md#install-node-and-python) |

## New in v0.2

- `noro init`, `noro doctor`, `noro facts` and `noro mcp`
- `NORO_MODEL` with every provider listed above, plus `codex-cli`
- Classify through any System One endpoint, or with rules
- `--decisions` for agents that pass keep, cut and reword choices back
- `noro init --workspace`: a Claude Code folder with an inbox, the skill and a `CLAUDE.md`
- The Claude plugin, the Codex plugin and the skill in `skills/noro/`
- The Docker image and the scheduled-run templates
- Keys in `~/.config/noro/.env` for runs started from any folder
