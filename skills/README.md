# skills

`noro/SKILL.md` is the agent skill: a thin wrapper that runs `noro this <file> --json --yes`, shows the report, asks about each flag and passes the answers back with `--decisions`. The same file serves Claude Code and Codex (through `.claude-plugin/`), skills.sh (`npx skills add noro-to/noro`) and Hermes Agent (fields under `metadata.hermes`).

Who edits it: maintainers. Keep it a wrapper around the CLI; the pipeline logic lives in `src/`.
