# Privacy

noro runs on your machine. It has no telemetry, no analytics, no update checks and no noro server. The noro contributors never receive your exports, reports or keys.

The full privacy policy, covering this software and noro.to, is at **https://noro.to/privacy**.

## What leaves your machine

noro connects only to the model providers you configure.

| Step | Sent | To |
|---|---|---|
| Classify | Fact labels (metric, campaign and ad-group names, period labels), coarse descriptors with no digits ("up", "large", "small sample"), rule flags, currency code | OpenRouter + TypeSafe (default), TypeSafe directly, or a local decision model |
| Draft, panel, revise | Fact cards (id, label, classification), personas, instructions, and the draft as a template where every number is an id like `{{f12}}` | Your writing provider |
| Revision mode (`.md`, `.txt`) | Your prose, with each number noro recognizes replaced by an id: digits ("$41.40", "38%") and number words ("five times", "Half", "twenty", "first") alike. Words that only look like numbers ("no one") stay as written | Your writing provider |
| `noro doctor --live` | A one-token test, only after you confirm | Each configured provider |

**Never sent:** raw export rows, metric values, display strings, formulas, sample sizes. Code computes every number and assembles the report locally.

**Labels can identify a client.** Campaign names, period labels and revision-mode prose go out as written.

**Nothing leaves at all** with a local writer (Ollama, LM Studio, llama.cpp) plus a local decision model or `NORO_CLASSIFY=rules`.

Requests to OpenRouter carry `HTTP-Referer: https://github.com/noro-to/noro` and `X-Title: noro` for app attribution. They contain nothing about you.

## Providers and CLIs

Each provider handles what noro sends under **your** agreement with it. The `claude-cli` and `codex-cli` writers start your own logged-in Claude Code or Codex CLI. noro never reads or stores that login, and the vendor's CLI follows the vendor's terms, including its own usage data collection.

When an AI agent runs noro (plugin, skill or `noro mcp`), the agent receives the finished report **with real numbers** and sends it to its own model provider.

## What noro stores locally

- `.noro/runs/*.sqlite` in the folder you run noro from: per-run checkpoints with your ingested data, facts, model requests and outputs. Delete `.noro/` to remove them.
- `.env` (current folder) or `~/.config/noro/.env`: your keys, in plain text. Each key is sent only to its own provider. Keep these files out of version control (`.env` and `.noro/` are in `.gitignore`).

## Reporting

Don't post exports, reports, client names or keys in public issues. Security problems: see [SECURITY.md](SECURITY.md). Privacy questions: [CONTACT EMAIL].
