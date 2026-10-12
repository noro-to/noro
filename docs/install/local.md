# Local models

You can run the writing steps, the classify step or both on your own machine. With both local, nothing about your data leaves the machine at runtime.

## Writing on a local server

| Server | `NORO_MODEL` | Default base URL | Notes |
| --- | --- | --- | --- |
| Ollama | `ollama:<model>` | `http://localhost:11434` | No key |
| LM Studio | `lmstudio:<model>` | `http://localhost:1234` | No key by default |
| llama.cpp (`llama-server`) | `openai-compatible:<model>` | Set `NORO_BASE_URL=http://127.0.0.1:9931` | Older builds use port 8080 |
| vLLM | `openai-compatible:<model>` | Set `NORO_BASE_URL=http://localhost:8000` | Linux with a GPU |

For `ollama` and `lmstudio`, set `NORO_BASE_URL` only if the server runs somewhere other than the default. The base URL works with or without a trailing `/v1`.

### Ollama

```bash
# macOS or Linux
curl -fsSL https://ollama.com/install.sh | sh
# Windows (PowerShell)
irm https://ollama.com/install.ps1 | iex

OLLAMA_CONTEXT_LENGTH=16384 ollama serve
ollama pull qwen3.8:27b
```

```bash
# .env
NORO_MODEL=ollama:qwen3.8:27b
```

Ollama's default context is 4096 tokens on machines with less than 24 GiB of VRAM. A draft prompt is about 5,000 tokens for an export with 200 facts, and Ollama cuts long prompts without an error. Set `OLLAMA_CONTEXT_LENGTH` to 16384 or more before you start the server. The desktop app has the same setting under Settings. `noro doctor` warns when it is too low.

### LM Studio

```bash
# macOS or Linux
curl -fsSL https://lmstudio.ai/install.sh | bash
# Windows (PowerShell)
irm https://lmstudio.ai/install.ps1 | iex

lms server start
```

Load a model in the app, set its context length to 16384 or more, then:

```bash
# .env
NORO_MODEL=lmstudio:qwen3.8-27b
```

Use the model id that `lms ls` shows.

### llama.cpp

```bash
brew install llama.cpp        # macOS or Linux
winget install llama.cpp      # Windows

llama-server -hf <hugging-face-repo>:<quant> --ctx-size 16384
```

```bash
# .env
NORO_MODEL=openai-compatible:qwen3.8-27b
NORO_BASE_URL=http://127.0.0.1:9931
```

`llama-server` listens on port 9931. Older builds and many Docker examples use 8080.

### vLLM

```bash
uv pip install vllm --torch-backend=auto
vllm serve Qwen/Qwen3.8-27B --max-model-len 16384 --reasoning-parser qwen3
```

```bash
# .env
NORO_MODEL=openai-compatible:Qwen/Qwen3.8-27B
NORO_BASE_URL=http://localhost:8000
```

### Thinking off

Thinking models (Qwen3.x, Gemma 4, gpt-oss) can put their reasoning in the answer text. That breaks noro's JSON parsing and adds untraced numbers that the check step rejects. For the `ollama` and `lmstudio` presets, noro asks the server to turn thinking off. With llama.cpp and vLLM, start the server so reasoning stays out of the answer: vLLM with a `--reasoning-parser` for your model, llama.cpp with its default `--reasoning-format`, or turn reasoning off with `--reasoning-budget 0`.

### Which model

These are open-weight models people recommend for local writing in late 2026. None is verified on noro's task yet. Run `bench/corpus/` on a model before you rely on it.

| Model | Memory (4-bit) | Note |
| --- | --- | --- |
| Qwen3.8-27B | 24 GB GPU or 32 GB Mac | Start here |
| Gemma 4 31B | 24 GB | Strong general model |
| Gemma 4 26B-A4B or Qwen3.5-35B-A3B | 16 to 24 GB | Mixture of experts. Fast for the panel's many calls |
| Mistral Small 3.2 24B | 24 GB | Good on writing lists |
| Qwen3.5-9B or Gemma 4 12B | 8 to 12 GB | Usable for drafts, with more retries |

Model tags differ between servers. Check the exact name in your server's model library.

Small models fail in predictable ways: numbers written as words ("two campaigns"), "doubled", fact ids that don't exist, or a real fact id on a claim its label doesn't support. The check step catches the first three and fails the run or retries. The panel catches some of the last.

## A fully local setup

Ollama serves the writing model and a decision model from one server:

```bash
ollama pull qwen3.8:27b
ollama pull nimble
```

```bash
# .env
NORO_MODEL=ollama:qwen3.8:27b
NORO_CLASSIFY_BASE_URL=http://localhost:11434
NORO_CLASSIFY_MODEL=nimble
```

Or skip the decision model and classify with rules:

```bash
# .env
NORO_MODEL=ollama:qwen3.8:27b
NORO_CLASSIFY=rules
```

[classify.md](classify.md) compares the two. Keep local servers on 127.0.0.1. LM Studio has no auth by default.

## What leaves the machine

In every setup, metric values, formulas, sample sizes and the raw export rows stay on your machine. Models see fact ids and labels only.

| Setup | What leaves | Who receives it |
| --- | --- | --- |
| Default (OpenRouter for writing and classify) | Fact labels (metric, campaign and ad-group names, period labels), coarse descriptors and flags for classify. Fact cards, reviewer personas and `{{f12}}` templates for writing. In revision mode, your report text with its numbers replaced by ids | OpenRouter, TypeSafe and the writing model's provider |
| `claude-cli` or `codex-cli` writer | The same writing payload, under your own plan. Classify as above | Anthropic or OpenAI, plus OpenRouter and TypeSafe |
| A direct API (`anthropic`, `openai`, `bedrock` and so on) | The same payloads | That provider, plus whichever classify endpoint you use |
| Local writer with jev for classify | Classify payload only | OpenRouter and TypeSafe, or TypeSafe alone |
| Local writer with a local decision model or `NORO_CLASSIFY=rules` | Nothing at runtime | No one. Only the model downloads use the network |

Labels can name a client through campaign names. Ollama models tagged `:cloud` run on Ollama's servers, not yours.
