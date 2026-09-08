# Usage Tracker — agent instructions

Local Node dashboard for Claude, ChatGPT/Codex, and Grok **subscription usage meters**. Design: [`docs/design.md`](docs/design.md).

## Stack

- Node 20+, ESM (`"type": "module"`)
- No React, no database, no cloud
- Zero or few dependencies; native `http` unless Express is clearly smaller
- Dashboard is static HTML/CSS/JS in `public/`

## Product rules

- Provider order is always Claude → ChatGPT → Grok
- v1 is those three providers only; add a later vendor as one file under `lib/providers/`
- Setup is local CLI login discovery, not API keys or cookie paste
- Default bind `127.0.0.1:3140`; LAN bind is opt-in
- Poll every 3 minutes; cache last-good snapshots; back off on 429
- Identify usage windows by duration/name, not array position
- Never invent usage percentages; show an error card if a provider fails

## Secrets

- Read CLI creds from `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.grok/auth.json`
- Tokens stay in memory for the outbound provider request only
- Never put tokens in `/api/*` JSON, logs, commits, or the UI
- `data/` is gitignored; do not commit `data/config.json`
- Writing rotated tokens back into those CLI files is allowed (same as the official CLIs)

## Commands

```bash
npm start    # node server.js — not implemented yet
```

## Docs vs this file

- `README.md` — humans
- `docs/design.md` — architecture and endpoint details
- `AGENTS.md` — what an agent should do in this repo
