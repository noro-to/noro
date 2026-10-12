# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue, pull request or discussion.

1. Go to the [Security tab](https://github.com/noro-to/noro/security) of this repository.
2. Click **Report a vulnerability** and fill in the form. This opens a private advisory that only you and the maintainers can see.

If you can't use GitHub, email [SECURITY CONTACT EMAIL] (a placeholder: there is no security address yet, so for now the private advisory above is the only channel).

Include what you can:

- the affected version (from `npm ls -g @noro-to/noro`, the image tag or the commit), install method (npm, Docker, checkout, plugin, MCP) and OS
- the steps to reproduce, or a proof of concept
- what an attacker could do with it

Don't include real exports, reports, client names or API keys. Use the files in `fixtures/` or made-up data.

## What to expect

- We'll acknowledge your report within 5 working days.
- We'll keep you updated as we confirm and fix the problem, and agree a disclosure date with you. We aim to release a fix within 90 days.
- We publish fixes as a GitHub security advisory and a release note, and credit you unless you'd rather we didn't.

noro is maintained by volunteers. There's no bug bounty.

## Supported versions

Security fixes go into the latest release. Please upgrade before reporting:

```bash
npm i -g @noro-to/noro@latest
docker pull ghcr.io/noro-to/noro:latest
```

## Scope

In scope:

- the noro CLI, MCP server, plugins and skill in this repository
- the npm package `@noro-to/noro` and the image `ghcr.io/noro-to/noro`
- anything that makes noro send data the [privacy notes](PRIVACY.md) say it doesn't send, leak an API key, or run code from an export, report, adapter or persona file
- the website noro.to

Out of scope:

- vulnerabilities in model providers, vendor CLIs (Claude Code, Codex) or AI agent hosts. Report those to the vendor
- a model writing misleading text that still passes noro's checks. Open a normal issue with the "Slop slipped through" template
- problems that need an attacker who already controls your machine or your `.env` file

## Safe harbor

We won't pursue or support legal action against anyone who researches and reports a vulnerability in good faith under this policy: testing only against your own installs and accounts, avoiding harm to other people's data and services, and giving us reasonable time to fix the problem before you disclose it.
