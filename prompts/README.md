# prompts

Text written for models, kept as plain Markdown.

- `panel/`: the built-in reviewer personas. The panel step loads every `.md` file here except `README.md`, plus the user's own from `.noro/personas/`. These ship in the npm package.
- `guides/`: the writing guides from the v0.1 skill (contract, voice, formats, intake, panel, visual, watchouts). The draft and panel prompts in `src/draft/prompts.ts` are adapted from them, so the CLI never reads these files at run time.

Who edits it: contributors add personas; maintainers change the guides and keep `src/draft/prompts.ts` in step with them.
