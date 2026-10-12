# Intake

Ask only what the request and the saved settings leave open. Ask it all in one message with defaults in brackets, so "defaults" is a full answer. What the user says this run beats saved settings, which beat the defaults.

## Every run: the output format

Slack/Teams, email, one-page doc, slide notes, one-page visual, or same as input. Default: same as input. Skip the question when the request names a format ("make this a Slack update").

## First run, then saved

| Setting | Options | Default |
| --- | --- | --- |
| audience | client, exec-cfo, internal | client |
| reviewers | media-buyer, salesperson, cross-functional-partner, statistics-person, adhd-reader, or the user's own | client: media-buyer, cross-functional-partner. exec-cfo: salesperson, adhd-reader. internal: media-buyer, statistics-person |
| watchouts | on, off | on |
| detail | headline, standard, full | standard |
| succinctness | tight, balanced | tight |
| formality | casual, professional, formal | professional |

Watchouts flag doubtful claims to the writer and stay out of the report. v0.1 rules are written for Google Ads first. What each dial changes: `voice.md`.

## The first-run message

> Before I rewrite this, five choices. Reply "defaults" to take the ones in brackets.
> 1. Output: Slack/Teams, email, one-page doc, slide notes, one-page visual, or same as input? [same as input]
> 2. Reader: client, exec/CFO or internal? [client]
> 3. Reviewers who read the draft before you do: media-buyer, salesperson, cross-functional-partner, statistics-person, adhd-reader, or your own? [media-buyer, cross-functional-partner]
> 4. Watchouts, flags on doubtful claims sent to you and kept out of the report: on or off? [on]
> 5. Voice: detail headline/standard/full [standard], succinctness tight/balanced [tight], formality casual/professional/formal [professional]

## Later runs: the one-line recap

> Settings: client · media-buyer, cross-functional-partner · watchouts on · standard, tight, professional. Output? [same as input]

The user changes a setting for one run by saying so ("for the CFO this time"). Saying "change my noro settings" reruns these questions and saves the new answers.

## The settings block

```yaml
# noro settings
audience: client          # client | exec-cfo | internal
reviewers: [media-buyer, cross-functional-partner]
watchouts: on             # on | off
detail: standard          # headline | standard | full
succinctness: tight       # tight | balanced
formality: professional   # casual | professional | formal
```

## Saving

Save the block to `.noro/settings.yml` in the working folder and read it at the start of every run. The user's own reviewers live in `.noro/personas/<id>.md`.
