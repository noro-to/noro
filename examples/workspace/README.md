# noro workspace

A folder you open in Claude Code (the desktop app or the CLI). Drop ad-platform exports or written reports into `inbox/`, type **noro the inbox**, and Claude runs one noro report per file, saves each to `reports/`, shows them and walks you through each report's flags.

```text
noro-reports/
  CLAUDE.md                     how Claude works through the inbox
  .claude/settings.json         lets Claude run noro this, noro facts and noro doctor without asking
  .claude/skills/noro/SKILL.md  the noro skill
  .gitignore                    keeps inbox/, reports/, .noro/ and .env out of git
  inbox/                        drop files here
  inbox/done/                   files already reported
  reports/                      one report per file
```

## Set it up

You need Node 22.19+, Python 3.9+, [Claude Code](https://claude.com/claude-code) and noro.

### macOS and Linux

```bash
npm i -g @noro-to/noro          # before the npm release: npm i -g github:noro-to/noro
noro init --workspace           # creates ./noro-reports
```

### Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.13
npm i -g @noro-to/noro
cd $HOME
noro init --workspace           # creates C:\Users\<you>\noro-reports
```

If noro can't find Python, set `NORO_PYTHON=py -3` in `%USERPROFILE%\.config\noro\.env`. Claude Code on Windows needs [Git for Windows](https://git-scm.com/downloads/win) for its shell.

`noro init --workspace <folder>` picks another folder. It never overwrites a file that's already there and lists the ones it skipped. If `~/.config/noro/.env` doesn't exist yet, it then runs the usual `noro init` setup (pick a writing model, paste keys) and saves your keys there, so noro finds them whichever folder Claude starts it from.

Without `noro init`, copy this folder from the repo (`examples/workspace/`) and rename `gitignore` to `.gitignore` (npm doesn't ship files named `.gitignore`, so the template stores it without the dot). Then run `noro init --global` once for your keys.

## Use it

1. Open the folder in Claude Code: in the desktop app, open the folder as a new session; in a terminal, `cd noro-reports` and run `claude`.
2. Drop files into `inbox/`: `.csv`, `.tsv` or `.xlsx` exports from Google Ads, Meta or Amazon DSP, or `.md` and `.txt` reports to audit.
3. Type **noro the inbox**.

Claude runs up to 3 reports at a time, saves each to `reports/<name>.md`, shows them, then asks about each flag (keep, cut or reword) and reruns with your choices. When a file's report is final, Claude moves it to `inbox/done/`, so the next "noro the inbox" only picks up new files.

Want one cross-channel report instead? Ask for "one combined report for the inbox": Claude runs noro once on every file and saves `reports/combined-<date>.md`.

If your writing model hits its plan limit, noro says `usage limit reached; rerun later`. Claude stops starting runs and leaves the unfinished files in `inbox/`. Say "noro the inbox" later and each run resumes from its last checkpoint in `.noro/`.

To change how many reports run at once, say "run 5 at a time", or edit the number under Settings in `CLAUDE.md`.

## Keep it up to date

```bash
noro init --workspace --update            # or: noro init --workspace <folder> --update
```

This refreshes `CLAUDE.md` and `.claude/skills/noro/SKILL.md` from the noro you have installed, so the skill never drifts behind the CLI. A file you edited is saved first as `CLAUDE.md.bak` (or `SKILL.md.bak`). New template files are added; `.claude/settings.json`, `.gitignore`, your inbox and your reports are left alone.

## Permissions

`.claude/settings.json` allows only these commands without a prompt:

- `noro this`, `noro facts` and `noro doctor`
- the same three through `npx -y @noro-to/noro`

Everything else, including saving reports and moving files to `inbox/done/`, asks as usual. Choose "don't ask again" for this folder if you'd rather not be asked. `noro doctor --live` makes a small paid call; Claude only runs it when you ask.

## Privacy

Exports and reports stay in this folder. noro sends data only to the model providers you set up, and never sends raw export rows or metric values. Details: [PRIVACY.md](https://github.com/noro-to/noro/blob/main/PRIVACY.md).
