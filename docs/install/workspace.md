# A noro workspace for Claude Code

A workspace is a folder you open in Claude Code (the desktop app or the CLI) and drop files into. Put exports or written reports in `inbox/`, type **noro the inbox**, and Claude runs one noro report per file, saves each to `reports/`, shows them, walks you through each report's flags and moves the finished files to `inbox/done/`.

It suits people who would rather drag files into a folder than type paths in a terminal. The template is in the repo at [`examples/workspace/`](../../examples/workspace/README.md) and ships in the npm package.

## Create it

Install Node 22.19+, Python 3.9+ ([cli.md](cli.md#install-node-and-python)), [Claude Code](https://claude.com/claude-code) and noro, then run `noro init --workspace`.

macOS and Linux:

```bash
npm i -g @noro-to/noro
noro init --workspace              # creates ./noro-reports
```

Windows (PowerShell):

```powershell
npm i -g @noro-to/noro
cd $HOME
noro init --workspace              # creates C:\Users\<you>\noro-reports
```

Before the npm release, install with `npm i -g github:noro-to/noro`.

`noro init --workspace <folder>` uses another folder. `noro init --workspace`:

1. Copies the template from the installed package. A file that's already in the folder is never overwritten; noro lists the ones it skipped.
2. Copies the noro skill (`skills/noro/SKILL.md`) to `.claude/skills/noro/SKILL.md`, so the folder has the skill of the noro you installed.
3. If `~/.config/noro/.env` doesn't exist, runs the usual `noro init` setup and saves your writing model and keys there, so noro finds them whichever folder Claude starts it from. Without a terminal it prints the next step (`noro init --global`) instead. If the file exists, it asks nothing.

## What's in it

| Path | What it does |
| --- | --- |
| `CLAUDE.md` | Tells Claude how to work through the inbox: one report per file, at most 3 at a time, flags, `--decisions`, `inbox/done/`, and what to do when a run fails |
| `.claude/skills/noro/SKILL.md` | The noro skill, the same file as `skills/noro/SKILL.md` |
| `.claude/settings.json` | Lets Claude run `noro this`, `noro facts` and `noro doctor` (and the same through `npx -y @noro-to/noro`) without asking. Nothing else |
| `.gitignore` | Keeps `inbox/`, `reports/`, `.noro/` and `.env` out of git |
| `README.md` | How to use the folder |
| `inbox/`, `inbox/done/`, `reports/` | Files to report on, files already reported, and the reports |

## Use it

1. Open the folder in Claude Code. Desktop app: open the folder as a new session. Terminal: `cd noro-reports` and run `claude`.
2. Drop files into `inbox/`: `.csv`, `.tsv` or `.xlsx` exports from Google Ads, Meta or Amazon DSP, or `.md` and `.txt` reports to audit and rewrite.
3. Type **noro the inbox**.

For each file, Claude runs `noro this "inbox/<file>" --json --yes`, saves the report to `reports/<name>.md` (and the JSON next to it), and shows it. Then it shows each flag and asks keep, cut or reword, reruns with `--decisions`, and saves the final version. A finished file moves to `inbox/done/`, so the next "noro the inbox" only picks up new files.

### How many at once

Claude runs at most 3 reports at the same time. Subscription writers (`claude-cli`, `codex-cli`) hit plan limits with more. Say "run 5 at a time" for one session, or change the number under Settings in `CLAUDE.md`.

### When the plan limit hits

noro stops with `usage limit reached; rerun later`. Claude starts no new runs and leaves the unfinished files in `inbox/`. Say "noro the inbox" again later: each run resumes from its last checkpoint in `.noro/`, so finished steps aren't paid for twice.

### One combined report

Ask for "one combined report for the inbox", or name several files that cover the same period. Claude runs `noro this <file1> <file2> … --json --yes` once and saves `reports/combined-<date>.md`. Otherwise you get one report per file.

## Keep the skill up to date

The skill and `CLAUDE.md` in the folder are copies, so they can fall behind when you upgrade noro. After `npm i -g @noro-to/noro@latest`, run:

```bash
noro init --workspace --update             # or: noro init --workspace <folder> --update
```

It replaces `CLAUDE.md` and `.claude/skills/noro/SKILL.md` with the installed version. A copy that differs (because you edited it, or it's from an older noro) is saved first as `CLAUDE.md.bak` or `SKILL.md.bak` (then `.bak2`, `.bak3`). Template files missing from the folder are added; `.claude/settings.json`, `.gitignore`, `README.md`, the inbox and the reports are left alone.

## Permissions

`.claude/settings.json` allows six commands without a prompt, as Claude Code permission rules:

```json
{
  "permissions": {
    "allow": [
      "Bash(noro this:*)",
      "Bash(noro facts:*)",
      "Bash(noro doctor:*)",
      "Bash(npx -y @noro-to/noro this:*)",
      "Bash(npx -y @noro-to/noro facts:*)",
      "Bash(npx -y @noro-to/noro doctor:*)"
    ]
  }
}
```

`:*` at the end makes each a prefix rule: the command and any arguments. Everything else, including saving a report and moving a file to `inbox/done/`, asks as usual; choose "don't ask again" for the folder if you'd rather not be asked. Don't widen these to `Bash(*)` or `Bash(npx:*)`.

## Without `noro init`

Copy `examples/workspace/` from the repo, rename `gitignore` to `.gitignore` (npm doesn't ship files named `.gitignore`, so the template stores it without the dot) and run `noro init --global` once for your keys.

## Move an existing folder to the template

Already have a folder you use this way? Back it up, then run `noro init --workspace <that folder>`. Your files stay: it only adds what's missing and lists what it skipped. To take the template's `CLAUDE.md` and skill too, add `--update`; your old copies are saved as `.bak`. Compare them and copy back anything of your own, such as a different number of parallel runs.
