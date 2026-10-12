# fixtures

Synthetic ad-platform exports for tests and for trying noro: Google Ads (CSV and XLSX), Meta, Amazon DSP, and one unknown platform for the column-guessing step.

`generate.ts` writes all of them from one story, described at the top of the file. Regenerate with `npx tsx fixtures/generate.ts` from the repo root, then run `npm test`.

Who edits it: contributors (a new adapter needs a fixture). Every name and number is invented. Never add a real export.
