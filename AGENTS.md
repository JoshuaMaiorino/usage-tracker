# Usage Tracker — agent instructions

Canonical instruction file for AI coding agents in this repo. Claude Code, Codex, and Grok all read this
file (Claude Code via the `@AGENTS.md` pointer in `CLAUDE.md`). Edit this file only — do not fork per-tool copies.

Local Node dashboard for Claude, ChatGPT/Codex, and Grok **subscription usage meters**. Design: [`docs/design.md`](docs/design.md).

## Project state

The public `main` branch contains the Combined edition from GPT-6, Claude and Grok. `docs/combined.md` records
the integration decisions and links all three reviews. `docs/design.md` remains the authoritative spec;
`docs/mockups/` is the original visual reference. Native Node HTTP serves the dashboard in `public/`.
Provider support and credential refresh limitations are recorded in `docs/provider-notes.md`.

## Why this approach

Consumer subscription meters are not exposed by any official billing API — Anthropic's Admin Usage API,
OpenAI's Usage API, and xAI's Management API all report *API spend*, not Pro/Max/Plus/SuperGrok quota. So the
server reads the OAuth tokens the official CLIs already stored on this machine and calls the same undocumented
endpoints those CLIs use. This is why the server (not the browser) makes provider calls — CORS — and why
credential discovery replaces any API-key entry form.

Those endpoints are undocumented and can change without notice; the error-state design absorbs that.

## Stack

- Node 20+, ESM (`"type": "module"`)
- No React, no database, no cloud
- Zero or few dependencies; native `http` unless Express is clearly smaller
- Dashboard is static HTML/CSS/JS in `public/`

## Data flow

`discover.js` finds CLI credential files → `config.js` gates which are enabled (`data/config.json`) → each
`providers/*.js` refreshes its token if needed and fetches → `normalize.js` flattens to
`{ id, name, plan, windows[], extras }` → `cache.js` holds last-good snapshots → `/api/usage` serves the
normalized shape to `public/app.js`.

## Product rules

- Provider order is always Claude → ChatGPT → Grok
- v1 is those three providers only; add a later vendor as one file under `lib/providers/`
- Setup is local CLI login discovery, not API keys or cookie paste
- Default bind `127.0.0.1:3140`; LAN bind is opt-in; the dashboard itself has no auth
- Poll every 3 minutes (2 min floor); cache last-good snapshots; back off on 429 — Claude's
  `/api/oauth/usage` rate-limits aggressively
- Identify usage windows by duration/name, not array position — Codex has returned weekly-only shapes
- Never invent usage percentages; show an error card if a provider fails
- Parsers stay defensive: ignore unknown fields, omit missing windows, keep showing last-good data on failure
- Bar colors: green <70%, amber 70–90%, red ≥90%

## Secrets

- Read CLI creds from `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.grok/auth.json`
  (`%USERPROFILE%\` equivalents on Windows)
- Tokens stay in memory for the outbound provider request only
- Never put tokens in `/api/*` JSON, logs, commits, or the UI
- `data/` is gitignored; do not commit `data/config.json`
- Writing rotated tokens back into those CLI files is allowed (same as the official CLIs). Claude access
  tokens last ~1h, so refresh is mandatory, not optional — but a refresh bug can log the user out of
  Claude Code, since this app shares mutable state with the real CLI
- Rotated CLI tokens and `data/config.json` are the only persistent runtime outputs. Atomic replacement
  may use temporary files in the destination directory, cleaned up after the write. Token refresh may
  temporarily acquire the official CLI's lock directories and heartbeat files using its verified protocol;
  remove only locks acquired by this operation. Do not create credential backups or app-owned lockfiles.

## Out of scope for v1

Console/API spend, cookie paste / browser profile scraping, redeeming Codex reset credits, other vendors
(Cursor, Copilot, Gemini), Electron/Tauri wrapper, dashboard auth, history charts / SQLite.

## Git

The default branch is **`main`**. There is no `master` branch. If a request, issue, or another agent refers to
"master" — branch off master, merge to master, compare against master — that means `main`. Do not create a
`master` branch to satisfy it; retarget to `main` and say so.

This repo is also used through git worktrees, so more than one agent session can be active at once. Branch
state can change underneath you mid-task (a `master` → `main` rename already happened once). Re-check
`git worktree list` and `git rev-parse --verify main` rather than trusting a branch name you read earlier.

## Commands

```bash
npm ci       # one dependency: local QR code generation
npm start    # node server.js, default 127.0.0.1:3140
npm run start:combined # combined build at 127.0.0.1:3170; header identifies Combined
npm test     # Node's built-in test runner; synthetic providers and temporary credential files
npm run check
```

No build step or linter is required. Keep the near-zero-dependency posture. Tests must never rename or
modify real CLI credential files. Inject a temporary home directory and provider fetch functions instead.

## Docs vs this file

- `README.md` — humans
- `docs/design.md` — architecture and endpoint details
- `AGENTS.md` — what an agent should do in this repo
- `CLAUDE.md` — pointer to this file, so Claude Code picks it up
