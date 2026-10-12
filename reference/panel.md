# Panel

Reviewers read the draft as its reader would, before the user sees it. The `reviewers` setting names them. Built-in personas live in `personas/`. The user's own live in `.noro/personas/` or are pasted into Project instructions.

## How to run it

`src/panel/` runs each reviewer as a separate model call that sees only its persona file, the draft (with fact ids, not values) and the brief below. Never the original, the facts' values or the writer's reasoning. A fresh reader catches what the author can't.

## The brief

Send it as written, with the persona attached.

```
You are the reviewer in the persona below. Read the draft as its reader.
Return at most 3 notes. Each note:
  Quote: "<exact words from the draft>"
  Problem: <one line>
  Fix: <replacement words, or "cut">
A fix may cut, reorder or reword. It may not add a claim, or a number that isn't in the ledger.
If the reader needs something the ledger doesn't hold, write one note marked "for the writer".
If nothing needs changing, reply exactly: No notes.
Don't invent notes to look thorough.
```

## Rounds

- **Round 1:** every reviewer. Apply each note that keeps the contract: no new claim, no unconfirmed number, still shorter. Rerun `check`.
- **Round 2:** only if round 1 changed the draft. Same reviewers, revised draft.
- Stop after round 2, or sooner when every reviewer says "No notes."

A note you reject gets one line in the delivery saying why. A note marked "for the writer" goes under the rewrite, never into it. Never write a note yourself and credit it to a reviewer. "No notes" is a good result.

Delivery line: `Panel: N notes, N applied.`
