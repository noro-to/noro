# Classify

Before the draft, noro labels every fact as signal, noise or luck risk, with a priority and the watchouts that apply. The draft and the panel use these labels to decide what can be a headline. Code can only make a label more cautious, whichever option you pick.

The classify step sees fact labels and coarse descriptors only, never metric values.

## Options

| Option | Settings | Cost |
| --- | --- | --- |
| jev through OpenRouter | `OPENROUTER_API_KEY` | About $0.003 per run |
| jev from TypeSafe | `TYPESAFE_API_KEY` | About $0.003 per run |
| A local decision model | `NORO_CLASSIFY_BASE_URL`, `NORO_CLASSIFY_MODEL` | Free |
| Rules | `NORO_CLASSIFY=rules` | Free |

When `NORO_CLASSIFY` is unset, noro picks the first that applies:

1. `NORO_CLASSIFY_BASE_URL` is set: that endpoint
2. `OPENROUTER_API_KEY` is set: jev through OpenRouter
3. `TYPESAFE_API_KEY` is set: jev from TypeSafe
4. Otherwise: rules

noro prints which classifier it picked, and the report footer names it. `noro doctor` shows it too.

## How noro calls a decision model

jev and the local decision models share one request format, the System One API. noro sends `POST {NORO_CLASSIFY_BASE_URL}/v1/systemone` with `{model, state, questions}` and reads back `answers`. The base URL works with or without a trailing `/v1`.

noro sends at most 64 questions per call, which is Ollama's limit, and splits larger runs into more calls. The key depends on the host: `openrouter.ai` uses `OPENROUTER_API_KEY`, `api.typesafe.ai` uses `TYPESAFE_API_KEY`, and other hosts get no key.

| Variable | Use | Default |
| --- | --- | --- |
| `NORO_CLASSIFY` | `jev` for a System One endpoint, `rules`, or `writer` | Picked as above |
| `NORO_CLASSIFY_BASE_URL` | The System One endpoint | `https://openrouter.ai/api` |
| `NORO_CLASSIFY_MODEL` | The decision model | `typesafe/jev-1.13` on OpenRouter, `jev-latest` on TypeSafe. Required for other hosts |

## jev through OpenRouter

```bash
OPENROUTER_API_KEY=sk-or-v1-0000000000000000
```

The default, and the same key as the default writer. jev costs $0.042 per million input tokens, and output is free. A measured run on an export with 212 facts made 6 calls and used about 62,000 tokens: about $0.003.

## jev from TypeSafe

```bash
TYPESAFE_API_KEY=ts-0000000000000000
```

TypeSafe sells jev directly. Create a key at [console.typesafe.ai](https://console.typesafe.ai). Same price. If you also have an OpenRouter key, noro prefers OpenRouter; set `NORO_CLASSIFY_BASE_URL=https://api.typesafe.ai` to use TypeSafe anyway.

## A local decision model

Local servers serve open decision models through the same System One format. None of them is jev, and none is verified on noro's task yet. noro's labelling was tuned on jev, so expect some differences in what becomes a headline.

### Ollama

Ollama 0.35 or newer.

```bash
ollama pull nimble
```

```bash
NORO_CLASSIFY_BASE_URL=http://localhost:11434
NORO_CLASSIFY_MODEL=nimble
```

`tev1` is a smaller option for machines with less memory.

### llama.cpp

Start a second `llama-server` with a native decision model in GGUF format, such as pplx-decider v1.1 or vLLM-SR d3-flash, on its own port:

```bash
llama-server -hf <decision-model-gguf-repo>:<quant> --port 9932
```

```bash
NORO_CLASSIFY_BASE_URL=http://127.0.0.1:9932
NORO_CLASSIFY_MODEL=pplx-decider-v1.1
```

A chat model on this endpoint returns HTTP 501. It has to be a decision model.

### LM Studio

Load a native decision model, then:

```bash
NORO_CLASSIFY_BASE_URL=http://localhost:1234
NORO_CLASSIFY_MODEL=pplx-decider-v1.1
```

Use the model id that `lms ls` shows.

## Rules

```bash
NORO_CLASSIFY=rules
```

Rules label facts from what code already computed. They are free, offline and give the same answer every time. They can't judge which metric matters most for a given account, so reports read a little more mechanically.

- A fact with no value is noise, priority 3.
- A fact flagged small sample, no baseline or divide by zero is luck risk.
- A small change is noise. A moderate or large change is signal. Rate changes (CTR, CVR, CPA, CPC, ROAS) at campaign or ad-group level also get the volatile-rate watchout.
- Levels and shares are noise, except current-period account totals for spend, conversions, CPA, ROAS and conversion value, which are signal at priority 2.
- Priority 1 goes to at most two account-level signal changes in those primary metrics. Other signals are priority 2. Everything else is priority 3.

## The writing model, opt-in

```bash
NORO_CLASSIFY=writer
```

The writing model answers the same questions with a JSON schema. It sees the same labels and descriptors, never values. noro never picks this on its own: the model that writes the report would also grade the facts, so the check is no longer independent, and the answers carry no probabilities. Each run also costs more writing-model tokens.
