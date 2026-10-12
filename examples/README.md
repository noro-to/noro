# examples

- `noro-weekly.yml`: a GitHub Actions workflow that writes a report every Monday. Copy it into `.github/workflows/` in your own repo; [docs/install/scheduled.md](../docs/install/scheduled.md) explains the setup.
- `workspace/`: the folder `noro init --workspace` creates, for Claude Code: `CLAUDE.md`, the skill, narrow permissions in `.claude/settings.json`, and `inbox/` and `reports/`. Its `gitignore` becomes `.gitignore` when copied. See [docs/install/workspace.md](../docs/install/workspace.md).
- `day-of-week/`: the before and after images in the README, and `_render.py`, which draws them from synthetic numbers (needs matplotlib).

Who edits it: maintainers. Users copy from it.
