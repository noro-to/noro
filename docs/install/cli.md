# Install the CLI

The package is `@noro-to/noro` and the command it installs is `noro`. The unscoped `noro` package on npm is an unrelated project, so always include the `@noro-to/` scope when you use `npx` or `npm`.

## Install Node and Python

noro needs Node 22.19 or newer (Node 24 LTS recommended) and Python 3.9 or newer. Python runs the rules engine and uses only the standard library. noro checks both before it makes any paid model call.

### macOS

```bash
brew install node@24 python@3.13
node --version      # v24.x
python3 --version   # 3.9 or newer
```

### Linux (Debian or Ubuntu)

Distro Node packages are often older than 22.19. Install Node 24 with [nvm](https://github.com/nvm-sh/nvm), fnm or NodeSource, then:

```bash
sudo apt-get install -y python3
node --version
python3 --version
```

### Windows (native)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.13
node --version
py -3 --version
```

On Windows, `python3` is often missing, or it is the Microsoft Store stub that opens the Store. noro looks for Python in this order and uses the first that is 3.9 or newer:

1. `NORO_PYTHON`, split on spaces, so `NORO_PYTHON=py -3` works
2. `python3`
3. `python`
4. `py -3` (Windows only)

### WSL

WSL (Ubuntu) follows the Linux steps. Windows files live under `/mnt/c/`, for example `/mnt/c/Users/sam/Downloads/campaign-report.csv`.

## Install noro

Pick one.

### npm, global

```bash
npm i -g @noro-to/noro
noro --help
```

### npx, no install

```bash
npx @noro-to/noro this campaign-report.csv
```

### From GitHub, before the npm release

```bash
npm i -g github:noro-to/noro
```

npm builds it during install.

### From source

```bash
git clone https://github.com/noro-to/noro
cd noro
npm ci          # also builds dist/
npm link        # puts noro on your PATH
noro --help
```

## Where noro finds your keys

noro reads each setting from the first place that has it:

1. The process environment
2. `.env` in the current folder
3. `~/.config/noro/.env` (on Windows, `%USERPROFILE%\.config\noro\.env`)

Put your keys in `~/.config/noro/.env` if you start noro from more than one folder, or from an AI tool that picks its own working folder. Keep per-project settings in the folder's `.env`. Run state goes to `.noro/` in the current folder.

```bash
mkdir -p ~/.config/noro
cat >> ~/.config/noro/.env <<'ENV'
OPENROUTER_API_KEY=sk-or-v1-0000000000000000
ENV
chmod 600 ~/.config/noro/.env
```

## Set up with `noro init`

```bash
cd ~/reports
noro init
```

`noro init` checks what you already have, all for free: keys in the environment and in both `.env` files, `claude` and `codex` on your PATH, Ollama on port 11434, LM Studio on port 1234, and AWS or Google Cloud credentials. Then it offers presets, the ones it detected first:

1. jev through OpenRouter for classify, your own Claude Code login for writing (`claude-cli`)
2. OpenRouter for everything
3. A direct API: Anthropic, OpenAI or Google
4. A cloud account: Bedrock, Vertex or Azure
5. A local server: Ollama or LM Studio
6. Your ChatGPT plan through Codex (`codex-cli`)

The subscription presets show the personal-use terms and need an explicit `y`. noro asks for missing keys with hidden input and never prints them.

It then writes `.env` in the current folder. It updates existing lines, keeps your comments, saves the old file as `.env.bak` and sets the file to mode 600. It warns if `.gitignore` doesn't list `.env`. Use `noro init --global` to write `~/.config/noro/.env` instead. `noro init` ends by running `noro doctor`.

## Check your setup with `noro doctor`

```bash
noro doctor
```

```text
config    .env (3 keys), ~/.config/noro/.env (1 key)
writer    claude-cli  claude-opus-5-5   [personal use only]
          ok  claude found on PATH
          ok  logged in with a Claude subscription
classify  jev via OpenRouter  typesafe/jev-1.13
          ok  OPENROUTER_API_KEY set (sk-or-...0000), key valid
engine    ok  python3 3.12
state     .noro: no runs in progress
live      skipped. Run `noro doctor --live` for a paid test call.
```

Every check is free. Key checks use each provider's free key or model-list endpoint, and keys show only as a short fingerprint. Bedrock, Vertex and Azure credentials show as "found (not verified)", because verifying them takes a paid call. For Ollama, doctor warns when the context length is below 16384.

`noro doctor --live` makes one 16-token call per writing model and one single-fact classify call. It shows the estimated cost and asks before it spends anything. Add `--yes` to skip the question. `--json` prints the result as JSON.

Exit codes: 0 all checks pass, 1 a check failed, 3 some items could not be verified.

## Run it

```bash
noro this fixtures/exports/google-ads.csv      # in a source checkout
noro this ~/Downloads/campaign-report.csv
noro this weekly-update.md --format slack
```

| Flag | What it does |
| --- | --- |
| `--format slack\|email\|one-page\|slide-notes` | Output shape. Default `one-page` |
| `--yes` | Keep every flag without asking |
| `--json` | Print the report as JSON |
| `--model <provider>:<id>` | Use this writing model for this run only. See [providers.md](providers.md#switching-model-for-one-run) |
| `--decisions <file\|json>` | Apply keep, cut and reword choices without asking. See [agents.md](agents.md#passing-choices-back-with---decisions) |

`noro facts <file>` runs only ingest and compute and prints the facts table. It calls no model and needs no key. Add `--json` for the full table.

Exit codes for `noro this`: 0 delivered, 2 the report can't pass the number check, 1 a usage or input error.
