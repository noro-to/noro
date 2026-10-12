# Getting started with noro

Run **noro this** on any ad report, written or visual. Answer the intake questions once, and noro reuses those settings every time after.

noro gives you back a shorter, plain version with every number checked. This guide gets it running in about five minutes. You don't need to know how to code.

There are two ways to use noro. Pick the one that matches where you use Claude:

- **Claude.ai**: the Claude website or the Claude desktop app. Most people want this one.
- **Claude Code**: Claude in a terminal, the desktop app's Code tab, or VS Code.

## Option A: Claude.ai

**What you need:** a Pro, Max, Team or Enterprise plan. On Enterprise, an Owner has to turn on code execution and Skills for the organization first (Admin settings → Capabilities).

### 1. Download noro

Go to [github.com/noro-to/noro/releases/latest](https://github.com/noro-to/noro/releases/latest). Under **Assets**, click `noro.zip`.

Keep it as a zip file. If your Mac unzipped it into a folder called `noro`, right-click that folder and choose **Compress "noro"** to get `noro.zip` back.

[screenshot: the release page with noro.zip under Assets]

### 2. Turn on code execution

noro runs a small script to check numbers, so Claude needs to be allowed to run code.

1. Click your initials in the bottom-left corner, then **Settings**.
2. Open **Capabilities**.
3. Turn on **Code execution and file creation**.

[screenshot: Settings → Capabilities with "Code execution and file creation" switched on]

### 3. Upload noro

On the same Capabilities page, find the **Skills** section and click **Upload skill**. Choose `noro.zip`. noro now shows in your Skills list. Make sure its switch is on.

[screenshot: the Skills section with noro listed and switched on]

### 4. Try it

Start a new chat. Paste a report, or attach it (a doc, PDF, slides or a dashboard screenshot all work), and type **noro this**.

The first time, noro asks a few questions (see [Your first run](#your-first-run)). At the end it gives you a short settings block. Paste that block into your Project instructions, or ask Claude to remember it, and noro will skip those questions next time.

[screenshot: a chat with a pasted report and the message "noro this"]

## Option B: Claude Code

**What you need:** Claude Code installed and signed in. If you don't have it yet, follow Anthropic's [quickstart](https://code.claude.com/docs/en/quickstart). New to terminals? Start with the [terminal guide](https://code.claude.com/docs/en/terminal-guide).

### 1. Open Claude Code

Open a terminal, go to the folder you work in, and type `claude`.

### 2. Add noro and install it

Type these two lines one at a time, pressing Enter after each:

```text
/plugin marketplace add noro-to/noro
/plugin install noro@noro
```

After the first line you should see `Successfully added marketplace: noro`. The second line opens noro's details. Choose **Install for you (user scope)** so noro works in every folder.

[screenshot: the plugin panel showing noro with the three install choices]

If Claude Code then says `Run /reload-plugins to apply`, type `/reload-plugins`.

Installed this way, noro also works in the desktop app's Code tab and in VS Code on the same computer. Cloud sessions at claude.ai/code don't load it.

### 3. Try it

Put the report in your folder (as `.txt`, `.md`, a doc, a PDF or a screenshot), then type **noro this** and name the file. If `/noro` is already taken by something else, use `/noro:noro`.

noro saves your first-run answers in `.noro/settings.yml` inside that folder.

[screenshot: Claude Code with "noro this weekly-report.md" typed in]

## Your first run

**Every run**, noro asks one thing: which format you want back.

- Slack or Teams message
- Email
- One-page doc
- Slide notes
- One-page visual
- Same as the input

**On the first run only**, it also asks:

- **Audience:** who reads it. Client, exec or CFO, or your internal team.
- **Reviewers:** who checks the draft before you see it. Pick any of media buyer, salesperson, cross-functional partner, statistics person and ADHD reader, or describe your own.
- **Watchouts:** on or off. When on, noro flags claims in your report that may not hold up, such as calling a trend on recent days whose conversions are still coming in. It flags them and leaves the decision to you.
- **Voice:**
  - detail: headline, standard or full
  - succinctness: tight or balanced
  - formality: casual, professional or formal

## What noro will ask you to confirm

- **Numbers read from a screenshot.** noro lists what it read and waits for your OK before rewriting.
- **New numbers.** If the rewrite needs a number the original didn't have, like a percent change, a script works it out, shows you the math, and you confirm it.

## What noro never does

- Add a claim that wasn't in your report
- Use a number you haven't confirmed
- Make the report longer
- Change a claim without telling you
- Put the word "noro" in your report

## Changing your answers

- **Claude.ai:** say "change my noro settings", or edit the settings block in your Project instructions or memory.
- **Claude Code:** say "change my noro settings", edit `.noro/settings.yml`, or delete it and noro asks again on the next run.

## If something goes wrong

- **Claude.ai ignores "noro this":** check that noro and **Code execution and file creation** are both switched on in Settings → Capabilities, then start a new chat.
- **The upload fails:** upload the `.zip` file, not a folder. The zip must have a `noro` folder inside it, which the release download already does.
- **Claude Code can't find noro:** type `/plugin`, open the **Errors** tab, and check the message there.

Still stuck? Open an issue at [github.com/noro-to/noro/issues](https://github.com/noro-to/noro/issues).
