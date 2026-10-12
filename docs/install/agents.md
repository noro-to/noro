# Use noro inside an AI tool

Your AI tool runs noro for you. Ask it to "noro this ~/Downloads/campaign-report.csv" and it runs the CLI, shows you the report and asks about each flag. The tool never writes numbers into the report; noro does.

There are four ways in. Pick the one your tool supports:

| Tool | Skill | Plugin | MCP |
| --- | --- | --- | --- |
| Claude Code | Yes | [Claude plugin](#claude-plugin) | [Yes](#claude-code) |
| Codex | Yes | [Codex plugin](#codex) | [Yes](#codex-1) |
| Hermes Agent | [Yes](#hermes) | No | [Yes](#hermes) |
| Cursor, VS Code, Windsurf, Zed | [skills.sh](#skillssh) | No | [Yes](#mcp) |
| Gemini CLI (API key) | No | No | [Yes](#gemini-cli) |

## Before you start

Install the CLI and store your keys where any folder can find them. AI tools often start noro from a folder of their own choosing, so the folder's `.env` may not be there.

```bash
npm i -g @noro-to/noro
noro init --global      # writes ~/.config/noro/.env
noro doctor
```

Details are in [cli.md](cli.md). Every option below reads `~/.config/noro/.env`, so you don't paste keys into your tool's config.

## Claude plugin

In Claude Code:

```text
/plugin marketplace add noro-to/noro
/plugin install noro@noro
```

From a shell, the same is `claude plugin marketplace add noro-to/noro` and `claude plugin install noro@noro`. The plugin adds the `noro` skill. Ask for a report in plain words, or run `/noro:noro`.

## Codex

```bash
codex plugin marketplace add noro-to/noro
```

Then install noro from the Plugins directory in Codex. Codex reads the same marketplace file as Claude Code.

## Hermes

[Hermes Agent](https://github.com/NousResearch/hermes-agent) reads skills from `~/.hermes/skills/`. Install the skill with either command:

```bash
hermes skills install skills-sh/noro-to/noro/noro
```

```bash
npx skills add noro-to/noro -g -a hermes-agent
```

For structured results, add the MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  noro:
    command: "npx"
    args: ["-y", "@noro-to/noro", "mcp"]
    timeout: 600
    connect_timeout: 30
```

Hermes passes a stdio server only the variables set in that block's `env`, plus a safe baseline. That is why noro reads `~/.config/noro/.env`: your keys reach noro without being copied into the Hermes config.

To get a report every week in Slack or Telegram, see [scheduled.md](scheduled.md#hermes-cron).

## skills.sh

```bash
npx skills add noro-to/noro
```

This installs the skill into every AI tool it detects: Claude Code, Codex, Cursor, VS Code, Zed, Windsurf, Hermes and others. Useful options: `-g` for your user folder instead of the project, `-a claude-code,codex` to pick tools, `-y` to skip questions. Update with `npx skills update noro`.

The skill lives in the repo at `skills/noro/SKILL.md`. It is a thin wrapper: it runs `noro this <file> --json --yes`, shows the report, asks you about each flag and passes your choices back with `--decisions`.

## MCP

`noro mcp` starts a stdio MCP server from the same package. It has two tools:

| Tool | Input | Returns |
| --- | --- | --- |
| `noro_this` | `path` (absolute), optional `format`, optional `decisions` | The report text, traces, flags and run summary |
| `noro_facts` | `path` (absolute) | The facts table: id, label, display value and formula for each fact. No model, no key |

A run takes a few minutes. Raise your tool's MCP timeout to 600 seconds where it has one. noro writes progress to stderr and only protocol messages to stdout.

On Windows, if your tool can't start `npx` directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@noro-to/noro", "mcp"]`. If noro is installed globally, `"command": "noro"` with `"args": ["mcp"]` also works everywhere.

### Claude Code

```bash
claude mcp add --transport stdio --scope user noro -- npx -y @noro-to/noro mcp
```

### Cursor

`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "noro": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@noro-to/noro", "mcp"]
    }
  }
}
```

### VS Code

```bash
code --add-mcp '{"name":"noro","command":"npx","args":["-y","@noro-to/noro","mcp"]}'
```

Or `.vscode/mcp.json` in a project:

```json
{
  "servers": {
    "noro": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@noro-to/noro", "mcp"]
    }
  }
}
```

### Codex

```bash
codex mcp add noro -- npx -y @noro-to/noro mcp
```

Then set the timeouts in `~/.codex/config.toml`. The default tool timeout of 60 seconds is too short for a run.

```toml
[mcp_servers.noro]
command = "npx"
args = ["-y", "@noro-to/noro", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

### Windsurf

Windsurf now keeps its MCP config at `~/.config/devin/mcp_config.json`. Older installs use `~/.codeium/windsurf/mcp_config.json`. Add this to whichever file exists:

```json
{
  "mcpServers": {
    "noro": {
      "command": "npx",
      "args": ["-y", "@noro-to/noro", "mcp"]
    }
  }
}
```

### Zed

In Zed's `settings.json`, or through Settings, AI, MCP Servers, Add Local Server:

```json
{
  "context_servers": {
    "noro": {
      "command": "npx",
      "args": ["-y", "@noro-to/noro", "mcp"],
      "env": {}
    }
  }
}
```

### Gemini CLI

For Gemini CLI users with a paid Gemini API key. Free and Google AI Pro and Ultra users were moved to Antigravity, which noro doesn't support (see [subscriptions.md](subscriptions.md#why-there-is-no-google-subscription-option)). Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "noro": {
      "command": "npx",
      "args": ["-y", "@noro-to/noro", "mcp"],
      "timeout": 600000
    }
  }
}
```

## Passing choices back with `--decisions`

Without a terminal, noro can't ask about flags, so the first run keeps them all and lists them in its JSON output. Your AI tool shows you each flag, asks keep, cut or reword, and runs noro again with your answers:

```bash
noro this ~/Downloads/campaign-report.csv --json --yes \
  --decisions '[{"flagId":"F1","action":"keep"},{"flagId":"F2","action":"cut"},{"flagId":"F3","action":"reword","text":"Search carried most of the spend this week."}]'
```

`--decisions` takes a JSON array or a path to a file holding one. Each entry has a `flagId` from the first run's `flags`, an `action` of `keep`, `cut` or `reword`, and `text` for a reword. Cut and reword act on the same span: the whole sentence the flag's quote sits in (the flag's `sentence`), even when the quote is a single word. Cut removes that sentence; a reword's `text` replaces all of it, so write a full sentence. Flags you leave out are kept. A reword can only use numbers already in the report; noro refuses any it can't trace.

The second run reuses the first run's checkpoints, so only the deliver step runs again and no model is called. Through MCP, pass the same array as the `decisions` input of `noro_this`.

## Looking up facts with `noro facts`

```bash
noro facts ~/Downloads/campaign-report.csv
noro facts ~/Downloads/campaign-report.csv --json
```

`noro facts` runs ingest and compute only and prints every fact with its id, label, display value and formula. It calls no model and needs no key. AI tools use it to answer "where does this number come from" without starting a full run.
