# noro workspace

This folder turns ad-platform exports into noro reports. You run the noro CLI, show the reports and pass the user's choices back. noro writes every number: never type, change or compute a number in a report yourself. The `noro` skill in `.claude/skills/noro/SKILL.md` has the details of one run; this file says how to work through the inbox.

## Folders

| Folder | What's in it |
| --- | --- |
| `inbox/` | Files to report on: `.csv`, `.tsv`, `.xlsx` (Google Ads, Meta, Amazon DSP exports) and `.md`, `.txt` (written reports to audit and rewrite). Ignore dotfiles, subfolders and any other file type. |
| `inbox/done/` | Files already reported. Never run them again unless the user names one. |
| `reports/` | One report per input file: `reports/<name>.md`, plus the run's JSON in `reports/<name>.json`. |
| `.noro/` | noro's checkpoints. Never edit or delete it: it is how an interrupted run resumes. |

`<name>` is the input's file name without its extension (`inbox/google-ads-week-41.csv` becomes `reports/google-ads-week-41.md`). When two inbox files share a name, keep the extension: `reports/q3.csv.md` and `reports/q3.md.md`.

## Settings

- **Parallel runs: 3.** Run at most this many noro commands at the same time. Subscription writers (`claude-cli`, `codex-cli`) hit plan limits with more. The user can change it for a session ("run 5 at a time") or edit the number here.
- **Format: one-page**, unless the user asks for `slack`, `email` or `slide-notes`.
- `noro doctor` checks the setup for free. Never run `noro doctor --live` unless the user asks: it makes paid calls.

## "noro the inbox"

1. **List the inbox** with `ls inbox` (Glob can skip folders listed in `.gitignore`). Take every file with a supported extension, skipping `inbox/done/`. If there are none, say so and stop.
2. **Combined or one per file.** By default, one report per file. If the user asks for one combined report for the inbox, or for several files covering the same period, follow "Combined report" below instead.
3. **Run noro**, at most 3 at a time (send up to 3 Bash calls in one message; give each a timeout of 600000 ms, since a run takes a few minutes). Always run from this folder, so the checkpoints in `.noro/` are found:

   ```bash
   noro this "inbox/<file>" --json --yes
   ```

   Paths relative to this folder are fine here; the skill's advice to use absolute paths is for runs started from another folder. If `noro` is not on PATH, use `npx -y @noro-to/noro this "inbox/<file>" --json --yes`. Never `npx noro`: that is a different package. Add `--format <name>` only when the user asked for one.
4. **Save each result** as it finishes (exit code 0): write the JSON to `reports/<name>.json`, and the report to `reports/<name>.md`: the JSON's `text` exactly as it is, then a line `---`, then `Source: inbox/<file>. Checked: <summary.checked> numbers traced. Classify: <classifier>.`
5. **Show the reports.** List every report with its path, then show each one's text.
6. **Walk the flags**, one report at a time. For each flag in the JSON's `flags`, show its `sentence` and its `text`, and ask: keep, cut or reword. Cut removes the whole sentence; a reword replaces the whole sentence, so take a full sentence from the user, using only numbers already in the report, written as the report shows them. "Keep the rest" keeps every flag left.
7. **Rerun with the choices**, with the same file and the same `--format`:

   ```bash
   noro this "inbox/<file>" --json --yes --decisions '[{"flagId":"F1","action":"keep"},{"flagId":"F2","action":"cut"},{"flagId":"F3","action":"reword","text":"Search carried most of the spend this week."}]'
   ```

   Overwrite `reports/<name>.md` and `reports/<name>.json` with the new result and show the new text. If noro refuses a reword (it can't trace a number in it), say why and ask again. A report with no flags skips steps 6 and 7.
8. **Move the file to `inbox/done/`** once its report is final, so the next "noro the inbox" doesn't redo it:

   ```bash
   mv "inbox/<file>" "inbox/done/"
   ```

   If `inbox/done/` already holds a file with that name, add the date: `inbox/done/<name>-<YYYY-MM-DD>.<ext>`. Create `inbox/done/` if it is missing.
9. **Finish** with one line per file: its report path, or why it has none.

## When a run fails

| What noro says | What to do |
| --- | --- |
| `usage limit reached; rerun later` | The writer hit its plan or rate limit. Start no new runs and don't retry now. Leave the file in `inbox/`. Tell the user which files are left and that saying "noro the inbox" later resumes each run from its last checkpoint, so finished steps aren't paid for twice. |
| Exit code 2 (the report can't pass the number check) | Show stderr. Don't patch the numbers or write a report yourself. Leave the file in `inbox/` and go on with the others. |
| Exit code 1 with a missing key, model, Node or Python | A setup problem: stop starting runs and show stderr. Suggest `noro init --global` and then `noro doctor`. |
| Exit code 1 with "Unknown export ...: no adapter matches its header row" | noro can't ask about columns here. Tell the user to run `noro this "inbox/<file>"` once in a terminal to confirm the columns, then say "noro the inbox" again. |

## Combined report

When the user asks for one combined report for the inbox (or for several files that cover the same period), run noro once with every file:

```bash
noro this "inbox/<file1>" "inbox/<file2>" --json --yes
```

Save it as `reports/combined-<YYYY-MM-DD>.md` (today's date) and `reports/combined-<YYYY-MM-DD>.json`, walk its flags and rerun with `--decisions` and the same file list, as above. Then move every file in it to `inbox/done/`. If this noro version doesn't take several files (it says `Unexpected argument`), tell the user and offer one report per file instead.

## Where a number comes from

```bash
noro facts "inbox/<file>" --json
```

Prints every fact (id, label, display value, formula) with no model and no key. Find the fact whose `display` matches the number and show its label and formula. Files already moved are in `inbox/done/`.
