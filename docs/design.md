# AI Usage Tracker — local subscription meters

A tiny local web app you leave open on the PC (or open on your phone on the same Wi-Fi) that shows **Claude / ChatGPT / Grok subscription usage meters** — the same bars as each product's Usage page — so you can pick which agent still has headroom.

**Status:** design only. Implementation has not started.

## Goal

One glanceable page:

- **Claude** first, then **ChatGPT/Codex**, then **Grok**
- Progress bars + % used + time until reset
- Setup is "I found these logins on this PC — Enable all"
- Runs only on your machine. No cloud, no accounts, no API keys to paste

Credential files the app will look for (Windows paths; `~` equivalents on macOS/Linux):

| Provider | Local credential | What it represents |
|---|---|---|
| Claude | `%USERPROFILE%\.claude\.credentials.json` | Claude Code / claude.ai subscription login |
| ChatGPT / Codex | `%USERPROFILE%\.codex\auth.json` | Codex CLI / ChatGPT login |
| Grok | `%USERPROFILE%\.grok\auth.json` | Grok Build / SuperGrok login |

## Why this approach (not official APIs, not cookies)

Consumer Usage pages are **not** the Console/API billing APIs.

- Anthropic Admin Usage API = org API spend. Unavailable for individual Max plans.
- OpenAI Usage API = API tokens, not ChatGPT Plus/Pro/Codex quota.
- xAI Management API = prepaid API credits, not SuperGrok weekly pool.

The official CLIs already call undocumented usage endpoints with the login you already have. Those are the same numbers the Usage pages show (Claude 5h/7d is shared with claude.ai; Grok weekly pool is shared across Chat/Imagine/Voice/Build; Codex `/wham/usage` is what ChatGPT coding usage uses).

We **read local CLI credentials and call those same endpoints**. Tokens never leave this machine except to the provider that issued them.

Cookie-scraping and browser extensions are out of scope. They are fragile and worse on phones.

## What you will see

Three provider cards, always in Claude → GPT → Grok order.

**Claude** (matches claude.ai Settings → Usage)

- Session window (5 hours)
- Weekly window (7 days)
- Extra model-scoped weekly bars when the API returns them (e.g. Fable)
- Extra usage $ if enabled
- Plan label (Pro / Max 5x / Max 20x / …)

**ChatGPT / Codex** (matches Codex / ChatGPT coding usage)

- Primary window (usually 5h; duration taken from the response, not assumed)
- Weekly window when present
- Extra named limits when present
- Credits / banked reset-credits count (display only — we do not redeem)
- Plan type (Plus / Pro / …)

**Grok** (matches grok.com Settings → Usage)

- Shared weekly pool % used
- Reset timestamp
- Product breakdown if the billing payload includes it
- Extra / prepaid credits if present
- Plan name when the settings endpoint returns it

Each card also shows: last successful fetch, a human countdown ("resets in 2h 14m"), and honest empty/error states ("not logged in on this PC", "token expired — run `claude auth login`", "provider returned 429 — backing off").

Color: green < 70%, amber 70–90%, red ≥ 90% or limit reached.

Auto-refresh every **3 minutes**. Claude's `/api/oauth/usage` rate-limits aggressively if polled too often; we cache last-good snapshots and back off on 429.

## Easy setup

On first load, the server **scans** for the three credential files.

Settings page:

```
Accounts on this PC
  [x] Claude    Max 20x   found
  [x] ChatGPT   ChatGPT   found
  [x] Grok      SuperGrok found (or "logged in")

  [ Enable all ]
```

Missing logins show a one-line hint (`claude auth login`, `codex login`, `grok login`) instead of a form. No cookie paste, no API key field in v1.

Enabled set is stored in `data/config.json` (gitignored). Default: enable every detected account.

## Architecture

Keep it a small Node app. No React, no database.

```
usage-tracker/
  package.json
  server.js              # HTTP server, LAN bind, static + /api
  lib/
    config.js            # read/write data/config.json
    discover.js          # find local CLI logins (no token values in logs)
    providers/
      claude.js          # creds + refresh + GET /api/oauth/usage
      chatgpt.js         # creds + GET /backend-api/wham/usage
      grok.js            # creds + GET /v1/billing?format=credits
    normalize.js         # common { id, name, plan, windows[], extras }
    cache.js             # last-good snapshot + 429 backoff
  public/
    index.html           # dashboard
    settings.html        # or a settings panel on the same page
    app.js
    styles.css
    manifest.webmanifest # Add to Home Screen on phone
    icons...
  data/                  # gitignored
    config.json
  README.md
```

- **Node 20+** (Node 24 is fine). Native `http` + a few files, or `express` if it stays smaller. Prefer zero deps if the fetch/static work stays simple; `express` is fine if it keeps the code shorter.
- Server fetches usage (browser cannot call these endpoints because of CORS).
- Dashboard is a PWA: installable on phone, dark, large type, works as an always-on window on the PC.

### Endpoints the server exposes

| Route | Purpose |
|---|---|
| `GET /` | Dashboard |
| `GET /api/accounts` | Discovery: which logins exist, enabled flags, no secrets |
| `POST /api/accounts` | Enable/disable providers (`{ enableAll: true }` or per-id) |
| `GET /api/usage` | Normalized snapshots for enabled providers (from cache, refresh if stale) |
| `POST /api/usage/refresh` | Force refresh (still respects 429 backoff) |
| `GET /api/meta` | Port, bind mode, LAN URL for the phone |

### Bind / phone access

- Default listen: `127.0.0.1:3140`
- Settings toggle: **Allow phones on this Wi-Fi** → bind `0.0.0.0:3140` and show `http://<lan-ip>:3140` plus a QR code
- Phone only works while this PC is on the same network. That is the local-only tradeoff. No hosted deploy in v1.

Start: `npm start`. README will also cover leaving the window open (browser, or pin a shortcut).

## Provider fetch details

### Claude

1. Read `claudeAiOauth.accessToken` from `.credentials.json`.
2. If `expiresAt` is near/past, refresh:
   - `POST https://platform.claude.com/v1/oauth/token`
   - public Claude Code client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
   - write rotated tokens back to `.credentials.json` (same as Claude Code / ccusage).
3. `GET https://api.anthropic.com/api/oauth/usage`
   - `Authorization: Bearer <token>`
   - `anthropic-beta: oauth-2025-04-20`
   - `anthropic-version: 2023-06-01`
4. Map `five_hour`, `seven_day`, optional model windows, `extra_usage`.

### ChatGPT / Codex

1. Read `tokens.access_token` (and optional `account_id`) from `auth.json`.
2. `GET https://chatgpt.com/backend-api/wham/usage`
   - `Authorization: Bearer <token>`
   - `ChatGPT-Account-Id` when present
   - `OpenAI-Beta: codex-1`
3. Identify windows by **duration** (`limit_window_seconds`), not by primary/secondary position (Codex has returned weekly-only shapes).
4. If `rate_limit_reset_credits.available_count > 0`, also GET `.../wham/rate-limit-reset-credits` for expiry display only.

Codex token refresh: if the usage call returns 401, attempt the ChatGPT OAuth refresh using `tokens.refresh_token` and write back to `auth.json`. If refresh fails, show "run `codex login`".

### Grok

1. Read `~/.grok/auth.json`. Prefer the `https://auth.x.ai::<client-id>` entry, else `https://accounts.x.ai/sign-in`. Token is the `key` field.
2. `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
   - `Authorization: Bearer <key>`
   - `x-xai-token-auth: xai-grok-cli`
   - `Accept: application/json`
3. `%` from `config.creditUsagePercent`, else `onDemandUsed / onDemandCap`. Reset from `config.currentPeriod.end` or `config.billingPeriodEnd`.
4. Best-effort plan name: `GET .../v1/settings` → `subscription_tier_display`.
5. If the token is expired and a `refresh_token` exists, refresh via the OIDC issuer in the auth entry; otherwise tell the user to run `grok login`.

Parsers must be **defensive**: unknown fields ignored, missing windows omitted, HTTP/parse failures become a card error with last-good data if we have it.

## UI

Single dark page, no chrome beyond a title, last-updated, and a gear.

- Desktop: three cards in a row (stack on narrow)
- Each meter is a labeled bar + % + reset countdown
- Clicking a card can expand extra windows / product split
- Settings overlay: account checkboxes, Enable all, LAN toggle, refresh interval (default 3 min, min 2 min)
- PWA manifest so iOS/Android can Add to Home Screen
- No login wall

Do not display tokens. Emails can be shown as the account subtitle if present (Grok has email; Claude/Codex may not).

## Security (local, still not sloppy)

- Tokens only in memory for the outgoing provider request. Never in `/api/*` JSON, never in logs.
- `data/` gitignored. Do not commit credentials.
- Default bind localhost. LAN bind is opt-in.
- We do not write anything except: rotated tokens back into the CLI files we refreshed, and `data/config.json`.

## Out of scope for v1

- Official Console/API spend (different product)
- Cookie paste / browser profile scraping
- Redeeming reset tokens
- Other vendors (Cursor, Copilot, Gemini) — structure providers so a later one is one file
- Electron/Tauri wrapper (a browser window is enough)
- Auth on the dashboard itself
- History charts / SQLite
- Running as a phone-only app with no PC

## Verification

After implementation:

1. `npm start` → open `http://127.0.0.1:3140`
2. Settings shows all three accounts found; Enable all works
3. Claude card shows 5h + 7d percentages (live against the logged-in plan)
4. ChatGPT card shows at least one window or a clear error
5. Grok card shows weekly % or a clear error
6. Disable one account → it disappears; re-enable restores it
7. Force refresh updates `last updated`
8. Missing-credential path: temporarily rename a creds file in a test, confirm honest empty state (restore after)
9. LAN: enable "phones on this Wi-Fi", confirm LAN URL is shown; if a phone is available, open it there
10. Confirm `/api/usage` and `/api/accounts` never include access tokens

Live provider calls can fail if an endpoint moved. Treat a well-formed error card as a pass for that provider; do not fake percentages.

## Implementation order

1. Scaffold Node server + static dashboard shell (empty cards)
2. Discovery + settings (Enable all) with no network calls
3. Claude provider (highest priority)
4. ChatGPT / Codex provider
5. Grok provider
6. Cache, 429 backoff, auto-refresh, last-good
7. Token refresh for Claude (required — tokens last ~1h), then Codex/Grok as needed
8. LAN bind + QR / URL, PWA manifest
9. Polish meters, empty/error states, README

## Key decisions

1. **Local CLI logins, not API keys** — matches "click all accounts" and the actual Usage-page meters.
2. **Tiny Node + static HTML** — no extra runtime; works on PC and phone browsers.
3. **PC is the hub** — phone is a viewer over LAN. Keeps it local and simple.
4. **3-minute poll + last-good cache** — Claude rate-limits the usage endpoint.
5. **Windows identified by duration/name, not array position** — provider payloads shuffle.
6. **v1 is three providers only** — Claude, GPT, Grok, in that order.
