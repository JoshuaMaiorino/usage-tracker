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

It is the single source of truth for all three tools. Codex and Grok read `AGENTS.md` natively; Claude Code reads [`CLAUDE.md`](CLAUDE.md), which is a short stub that imports `AGENTS.md` via `@AGENTS.md`. Add new guidance to `AGENTS.md` only — a full second copy in `CLAUDE.md` would make Grok load the same rules twice, since Grok reads both filenames.

The default branch is `main`; there is no `master`. References to "master" mean `main`.

Optional later, only if needed:

| Path | When to add it |
|---|---|
| `.grok/config.toml` | Project MCP servers, plugins, or permission rules |
| `.grok/skills/` | Repo-specific repeatable procedures |
| `.grok/rules/*.md` | Extra rules split out of `AGENTS.md` |
| `CLAUDE.md` | Already present — a pointer to `AGENTS.md`, not a twin. Leave it as a stub |

Personal overrides belong in `CLAUDE.local.md` or `~/.grok/` — those stay gitignored / out of the repo.

## License

Private / unpublished unless you add one.
