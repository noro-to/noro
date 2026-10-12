# Scheduled reports

noro can write a report every week or month with no one at the keyboard.

Live connections to Google Ads, Meta and Amazon DSP are coming. Until then, a scheduled run reads an export file you provide: a file you commit, or one a step downloads before noro runs.

## What every scheduled run needs

- `--yes`, so noro keeps every flag without asking.
- An export from Google Ads, Meta or Amazon DSP, or a committed `.noro/adapters/*.yaml` for another platform. Column guessing needs someone to confirm it, so it can't run unattended.
- An API provider for writing. `claude-cli` and `codex-cli` are for personal use on your own machine and don't belong in CI.
- One run at a time. A run's checkpoint file has one owner, so don't start a second run while the first is still going.

## GitHub Actions

Copy this into `.github/workflows/noro-weekly.yml` in your own repo. Add `OPENROUTER_API_KEY` under Settings, Secrets and variables, Actions.

```yaml
name: noro weekly
on:
  schedule:
    - cron: "17 7 * * 1"   # Mondays 07:17 UTC
  workflow_dispatch:
concurrency:
  group: noro
  cancel-in-progress: false
jobs:
  report:
    runs-on: ubuntu-latest   # python3 is preinstalled
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "24"
      - uses: actions/cache@v6
        with:
          path: .noro/runs
          key: noro-runs-${{ github.run_id }}
          restore-keys: noro-runs-
      # Bring this week's export, for example:
      # - run: curl -fsSL "$EXPORT_URL" -o exports/latest.csv
      #   env:
      #     EXPORT_URL: ${{ secrets.EXPORT_URL }}
      - run: npx -y @noro-to/noro@0.2 this exports/latest.csv --yes --format email > report.md
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: noro-report
          path: |
            report.md
            .noro/runs/
```

- **Cache.** `.noro/runs` holds one checkpoint file per run. Caching it means a re-run of a failed job resumes where it stopped instead of paying for the model calls again.
- **Concurrency.** The `noro` group stops two runs from writing the same checkpoint.
- **Artifact.** The report, plus the checkpoint for a failed run, is attached to every job.
- **Secrets.** Add one secret per variable your provider needs, for example `ANTHROPIC_API_KEY`, and pass it in `env`. Set `NORO_MODEL` there too if you don't use the default.
- **Committed config.** Commit `.noro/adapters/` and `.noro/personas/` if you use them. They are settings, not cache.

For a monthly report, use `cron: "17 7 1 * *"`. GitHub can delay scheduled runs, and it disables schedules in repos with no activity for 60 days.

## Hermes cron

If you use [Hermes Agent](https://github.com/NousResearch/hermes-agent) with the noro skill (see [agents.md](agents.md#hermes)), Hermes can run the report and post it to Slack or Telegram:

```bash
hermes cron create "every monday 9am" \
  "noro this ~/exports/latest.csv --format slack" \
  --skill noro --name noro-weekly --deliver slack
```

Use `--deliver telegram` for Telegram. Hermes runs on your own machine, so it can use any writer, including `claude-cli` on your own plan.

## cron

`.env` and `.noro/` are read from the current folder, so `cd` first. Use absolute paths, because cron's PATH doesn't include nvm or Homebrew.

```cron
17 7 * * 1 cd /home/sam/reports && /usr/local/bin/noro this exports/latest.csv --yes > out/$(date +\%F).md 2>> noro.log
```

## systemd (Linux)

`~/.config/systemd/user/noro.service`:

```ini
[Unit]
Description=noro weekly report

[Service]
Type=oneshot
WorkingDirectory=%h/reports
ExecStart=/usr/local/bin/noro this exports/latest.csv --yes
StandardOutput=append:%h/reports/out/report.md
```

`~/.config/systemd/user/noro.timer`:

```ini
[Unit]
Description=noro weekly report

[Timer]
OnCalendar=Mon *-*-* 07:17
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now noro.timer
loginctl enable-linger "$USER"   # run even when you're logged out
```

## launchd (macOS)

`~/Library/LaunchAgents/to.noro.weekly.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>to.noro.weekly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/noro</string>
    <string>this</string>
    <string>exports/latest.csv</string>
    <string>--yes</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/sam/reports</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>7</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/sam/reports/out/report.md</string>
  <key>StandardErrorPath</key>
  <string>/Users/sam/reports/noro.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/to.noro.weekly.plist
```

launchd doesn't load your shell profile. If `noro` runs from nvm, use the full path to that Node's `noro` in `ProgramArguments`.

## Docker on a schedule

Any of the schedulers above can run the image instead of a local install. Drop `-it` and add `--yes`:

```bash
cd /home/sam/reports && docker run --rm -v "$PWD:/work" -w /work --env-file .env \
  ghcr.io/noro-to/noro:0.2.0 this exports/latest.csv --yes > out/report.md
```
