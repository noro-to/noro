# Writing on your own subscription

If you already pay for a Claude or ChatGPT plan, noro can run the writing steps through the vendor's own command-line tool, logged in as you. You pay nothing per token. Calls count against your plan's usage limits.

| Provider | Tool | Plan | `NORO_MODEL` |
| --- | --- | --- | --- |
| `claude-cli` | Claude Code (`claude`) | Claude Pro or Max | `claude-cli:claude-opus-5-5` |
| `codex-cli` | OpenAI Codex CLI (`codex`) | ChatGPT Plus, Pro or Business | `codex-cli:gpt-6.1-sol` |

Classify still needs its own setup: a jev key, a local decision model or rules. See [classify.md](classify.md).

## The rules both options follow

- **Personal use only.** Your own account, on your own machine, for your own reports. Don't run noro with a subscription writer as a service for other people, and don't use it in a shared container or CI runner.
- **Your own login.** You log in with the vendor's tool. noro never sees, stores or passes your login or its tokens.
- **The unmodified vendor binary.** noro starts the tool you installed, as published, and reads its answer.
- **API keys removed.** noro removes API-key and cloud-provider variables from the tool's environment, so a stray key can't bill another account.
- **Auth check first.** Before the first writing call, noro asks the tool how you are logged in and stops unless it is a subscription login.
- **No tools.** noro turns off the tool's shell, file and web tools and your custom instructions. The tool only answers the prompt.
- **Usage limits.** When you hit your plan's limit, the run stops with "usage limit reached; rerun later". Running the same command later resumes from the last checkpoint, so finished steps aren't paid for twice.

## claude-cli

1. Install [Claude Code](https://claude.com/claude-code), run `claude` once and log in with your Claude account.
2. Check the login: `claude auth status` should show a `claude.ai` login.
3. Set it in `.env`:

```bash
NORO_MODEL=claude-cli:claude-opus-5-5
OPENROUTER_API_KEY=sk-or-v1-0000000000000000   # for classify with jev
```

`NORO_WRITER=claude-cli` still works as an alias. Set `NORO_CLAUDE_BIN` if `claude` isn't on your PATH.

noro runs `claude -p` with no tools and no customizations for each writing call. It removes these variables from that call: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`.

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says:

> Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

> Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription

noro offers no Claude login of its own and routes no one else's requests. If you run noro for other people, use an API provider from [providers.md](providers.md).

## codex-cli

New in v0.2.

1. Install the [Codex CLI](https://learn.chatgpt.com/docs/cli/reference) and run `codex login`. Choose "Sign in with ChatGPT".
2. Check the login: `codex login status` should exit 0 and name a ChatGPT login.
3. Set it in `.env`:

```bash
NORO_MODEL=codex-cli:gpt-6.1-sol
OPENROUTER_API_KEY=sk-or-v1-0000000000000000   # for classify with jev
```

Use any model your plan offers in Codex. Set `NORO_CODEX_BIN` if `codex` isn't on your PATH.

For each writing call, noro runs `codex exec` in a read-only sandbox, in an empty temporary folder, with the shell tool and web search off, your Codex config and rules ignored, and no session files saved. It removes these variables from that call: `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `AZURE_OPENAI_API_KEY`. If `codex login status` shows an API-key login, noro stops.

OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc) documentation says:

> ChatGPT plan usage is available to all open-source partners and selected private clients

and covers "ChatGPT plan usage for open-source and locally hosted apps". OpenAI's [non-interactive mode docs](https://learn.chatgpt.com/docs/non-interactive-mode) describe `codex exec` for scripted use.

## Why there is no Google subscription option

Google AI Pro and Ultra plans now run through Antigravity. Google [replaced Gemini CLI with Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli) for free and Google AI Pro and Ultra users on June 18, 2026. The [Antigravity terms](https://antigravity.google/terms), section 6, say:

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.

noro is a product Google doesn't provide, so noro offers no Antigravity or Gemini CLI writer. Use a Gemini API key with the `google` provider instead. See [providers.md](providers.md#google).

## Coming later

GitHub Copilot CLI (`copilot-cli`). GitHub [documents scripted use](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically) of the CLI "in scripts, CI/CD pipelines, and automation workflows". It is not in v0.2.
