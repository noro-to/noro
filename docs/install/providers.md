# Writing providers

The writing steps (draft, panel, revise) run on one chat model. You choose it with one line in `.env`:

```bash
NORO_MODEL=<provider>:<model-id>
```

noro splits the value on the first colon, so model ids that contain colons work. A provider name on its own (`claude-cli`, `codex-cli`, `anthropic`) means that provider's default model, as does `<provider>:` with nothing after the colon. Any other value with no provider prefix means `openrouter`, so older `.env` files keep working. An empty `--model` is an error. `noro this` prints the writing model it uses (`noro: write with ...`). The model id is always the provider's own id for that model.

| Variable | Use |
| --- | --- |
| `NORO_MODEL` | The writing model for every writing step. Default `openrouter:anthropic/claude-opus-5.5` |
| `NORO_DRAFT_MODEL` | Overrides `NORO_MODEL` for the draft and revise steps only. Same format |
| `NORO_PANEL_MODEL` | Overrides `NORO_MODEL` for the panel step only. Same format |
| `NORO_WRITER=claude-cli` | Kept as an alias for `NORO_MODEL=claude-cli:claude-opus-5-5`. See [subscriptions.md](subscriptions.md) |

Each provider reads its credentials from its standard environment variables. noro adds no copies of them. Put them in `.env` or `~/.config/noro/.env` (see [cli.md](cli.md#where-noro-finds-your-keys)) and run `noro doctor` to check them for free.

Two notes apply to every provider:

- **Quality.** noro's prompts and its 100 rules are tuned on Claude Opus 5.5. Every other model is best-effort until it has been benchmarked on `bench/corpus/`. A weaker model doesn't produce wrong numbers, because code fills them in and the check step rejects any it can't trace. It produces more retries and more flags.
- **Sampling.** noro sends no temperature or other sampling parameters. Claude Opus 5.5 rejects them, and the reports don't need them.

The classify step is configured separately. See [classify.md](classify.md).

## Switching model for one run

`--model <provider>:<id>` on `noro this` sets the writing model for that run only. It takes the same format as `NORO_MODEL` and also replaces `NORO_DRAFT_MODEL` and `NORO_PANEL_MODEL` for the run. Settings apply in this order, first wins:

1. The `--model` flag
2. The process environment
3. `.env` in the current folder
4. `~/.config/noro/.env`
5. noro's defaults

For example, with this `.env`:

```bash
NORO_MODEL=claude-cli:claude-opus-5-5
OPENROUTER_API_KEY=sk-or-v1-0000000000000000   # used for classify with jev
```

this writes on your own Claude plan:

```bash
noro this report.csv
```

and this runs the same report on OpenRouter, billed per token:

```bash
noro this report.csv --model openrouter:anthropic/claude-opus-5.5
```

The model is part of the run's identity, so the two runs keep separate checkpoints.

## openrouter

```bash
OPENROUTER_API_KEY=sk-or-v1-0000000000000000
NORO_MODEL=openrouter:anthropic/claude-opus-5.5
```

The default. One key covers writing and classify (jev). Create the key at [openrouter.ai](https://openrouter.ai) under Keys. Any model in OpenRouter's list works, for example `openrouter:openai/gpt-6.1-sol` or `openrouter:google/gemini-3.1-pro-preview`.

## anthropic

```bash
ANTHROPIC_API_KEY=sk-ant-0000000000000000
NORO_MODEL=anthropic:claude-opus-5-5
```

Anthropic's API directly. Note the id: `claude-opus-5-5` with dashes, where OpenRouter uses `anthropic/claude-opus-5.5`. Opus 5.5 rejects a temperature setting and a request to turn thinking off, so noro sends neither.

## openai

```bash
OPENAI_API_KEY=sk-proj-0000000000000000
NORO_MODEL=openai:gpt-6.1-sol
```

## google

```bash
GEMINI_API_KEY=AIza0000000000000000
NORO_MODEL=google:gemini-3.1-pro-preview
```

The Gemini API from Google AI Studio. This is the option for Google users; there is no Google subscription option (see [subscriptions.md](subscriptions.md#why-there-is-no-google-subscription-option)).

## bedrock

```bash
AWS_PROFILE=reports
AWS_REGION=us-east-1
NORO_MODEL=bedrock:global.anthropic.claude-opus-5-5
```

Amazon Bedrock with the standard AWS credential chain: `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` with `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, or an instance role. Use a cross-region prefix (`global.`, `us.`, `eu.` or `au.`) that your account has access to. `noro doctor` reports Bedrock credentials as found but not verified, since checking them takes a paid call.

## vertex

```bash
GOOGLE_CLOUD_PROJECT=acme-reports-000000
GOOGLE_CLOUD_LOCATION=global
NORO_MODEL=vertex:gemini-3.1-pro-preview
```

Gemini on Google Cloud Vertex AI. Log in once with `gcloud auth application-default login`, or set `GOOGLE_CLOUD_API_KEY`. In v0.2 the `vertex` provider runs Gemini models only. For Claude on a cloud account, use `bedrock`.

## azure

```bash
AZURE_OPENAI_API_KEY=0000000000000000
AZURE_OPENAI_RESOURCE_NAME=acme-openai
NORO_MODEL=azure:gpt-6.1-sol
```

Azure OpenAI. Set `AZURE_OPENAI_BASE_URL` instead of `AZURE_OPENAI_RESOURCE_NAME` if you use a custom endpoint. The model id is your deployment of the model. If your deployment names differ from the model ids, map them with `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. In v0.2 the `azure` provider runs OpenAI models only; Claude on Microsoft Foundry is not supported.

## mistral

```bash
MISTRAL_API_KEY=0000000000000000
NORO_MODEL=mistral:mistral-large-4
```

## deepseek

```bash
DEEPSEEK_API_KEY=sk-0000000000000000
NORO_MODEL=deepseek:deepseek-v4-pro
```

## groq

```bash
GROQ_API_KEY=gsk_0000000000000000
NORO_MODEL=groq:openai/gpt-oss-120b
```

Fast and cheap. Expect plainer writing and more flags than with a frontier model.

## openai-compatible

```bash
NORO_BASE_URL=https://llm.example.internal
NORO_API_KEY=0000000000000000
NORO_MODEL=openai-compatible:acme-writer-70b
```

Any server that speaks the OpenAI chat completions API: LiteLLM, a company gateway, vLLM, llama.cpp and others. `NORO_BASE_URL` works with or without a trailing `/v1`. `NORO_API_KEY` is optional; leave it out for servers without auth. For servers on your own machine, see [local.md](local.md), which also covers the `ollama` and `lmstudio` presets.

## Mixing models per step

```bash
NORO_MODEL=anthropic:claude-opus-5-5
NORO_PANEL_MODEL=openrouter:deepseek/deepseek-v4-pro
```

The panel makes the most calls. A cheaper panel model lowers the cost of a run, at some cost to the notes it gives.
