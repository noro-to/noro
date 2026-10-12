# src

The TypeScript pipeline. `cli.ts` is the `noro` command; `harness/` runs the seven steps as one checkpointed task.

| Folder | Step or role |
| --- | --- |
| `ingest/`, `adapters/` | 1. Parse CSV or XLSX and map columns to the standard schema (one YAML file per platform) |
| `compute/` | 2. Build the facts table. All arithmetic happens here |
| `classify/` | 3. Label each fact with jev, a local decision model or rules |
| `draft/` | 4. Write with fact ids only; also the claude-cli and codex-cli clients |
| `check/` | 5. Run the Python engine on the draft |
| `panel/` | 6. Reviewer personas from `prompts/panel/` |
| `deliver/` | 7. Apply keep, cut and reword choices and render the report |
| `providers/` | One chat client per `<provider>:<model-id>` |
| `init/`, `doctor/`, `mcp/` | `noro init`, `noro doctor`, `noro mcp` |

`schema.ts` holds the shared types, `config.ts` and `env.ts` read settings, and `preflight.ts` checks Node, Python and keys before a paid call.

Who edits it: contributors and maintainers. See [DEVELOP.md](../DEVELOP.md).
