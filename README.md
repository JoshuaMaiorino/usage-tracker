# Usage Tracker

Local dashboard for **Claude**, **ChatGPT / Codex**, and **Grok** subscription usage meters.

Leave it open on your PC, or open it on your phone on the same Wi-Fi, to see which AI still has headroom before you pick an agent.

The app runs only on your machine. It reads the CLI logins already on this computer and shows the same kind of bars as each product's Usage page.

## Status

Design is in [`docs/design.md`](docs/design.md). The app itself is not built yet.

## Requirements (planned)

- Node.js 20+
- At least one of: Claude Code, Codex / ChatGPT, or Grok Build logged in on this machine

## Run (once implemented)

```bash
npm start
```

Then open [http://127.0.0.1:3140](http://127.0.0.1:3140).

## For coding agents

Grok (and other agents) read [`AGENTS.md`](AGENTS.md) at the repo root. That is the project instruction file — not a second copy of the design doc.

Optional later, only if needed:

| Path | When to add it |
|---|---|
| `.grok/config.toml` | Project MCP servers, plugins, or permission rules |
| `.grok/skills/` | Repo-specific repeatable procedures |
| `.grok/rules/*.md` | Extra rules split out of `AGENTS.md` |
| `CLAUDE.md` | Only if you also use Claude Code and want a Claude-specific twin |

Personal overrides belong in `CLAUDE.local.md` or `~/.grok/` — those stay gitignored / out of the repo.

## License

Private / unpublished unless you add one.
