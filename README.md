# Usage Tracker

A local dashboard for **Claude**, **ChatGPT / Codex**, and **Grok** subscription usage. Built on the
`GPT-6` comparison branch, following the [HTML mockup](docs/mockups/index.html).

Dark by default, with a light theme, responsive cards, reset countdowns, expandable extra limits, and
local account discovery. Missing logins, expired sessions, rate limits, and unsupported responses have
explicit states; no usage numbers are fabricated.

## Run

Install Node.js **20 or newer** (`.nvmrc` selects Node 24 for development), then:

```sh
npm ci
npm run start:gpt6
```

Open [http://127.0.0.1:3166](http://127.0.0.1:3166). This comparison launch uses its own port and the
header identifies this build as **GPT-6**. Keep the terminal running while using the dashboard.
There is no build step, database, cloud service, or API-key setup. The only dependency generates phone QR
codes locally; the dashboard has no third-party browser requests.

`npm start` retains the standard port 3140. To choose another port:

```sh
node server.js --port 3167
```

## Accounts and settings

The first launch enables every supported CLI login found on this PC:

| Provider | Credential file under your home directory | Login command |
| --- | --- | --- |
| Claude | `.claude/.credentials.json` | `claude auth login` |
| ChatGPT / Codex | `.codex/auth.json` | `codex login` |
| Grok | `.grok/auth.json` | `grok login` |

Log in through the corresponding CLI, then use **Settings → Rescan** and select the account. **Select
found accounts → Save settings** enables all discovered logins. API-key-only credentials are not
subscription logins. Claude Keychain-only credentials on macOS are reported as unsupported.

Settings persist in gitignored `data/config.json`. Turning an account off hides its card and stops its
scheduled requests; rescanning respects saved choices. Use **Refresh usage** to request an update.
All viewers share one server schedule, normally every three minutes. Manual requests also respect a
two-minute minimum and provider backoff. Viewing the dashboard never multiplies provider requests.

On a failed update, the last successful meters remain visible with a stale label and their original
timestamp. A passed reset time does not reset the displayed usage to zero. ChatGPT's card displays
**Codex coding usage**, which does not represent every ChatGPT message limit.

Every card has expandable **Account details**, including exact local reset dates. Claude shows
usage-credit status and spending, with spending limits and balances when supplied. Grok shows purchased
Extra Usage Credits and reported product usage; legacy on-demand accounts can also show spending and
their cap. ChatGPT retains its model limits, credit balance, and banked resets. Missing values stay omitted,
while a reported zero remains visible.

## Phone view

Enable **Allow phones on this Wi-Fi**, save, then restart the server. Reopen Settings for the local
network URL and QR code. The PC must remain on, the phone must reach the same network, and the firewall
must allow the selected port. Disabling phone access also takes effect after a restart.

Anyone who can reach this network address can view usage and change settings; the dashboard has no login.
The default binding is localhost only. A manifest provides an app-style browser shortcut; full installation
or offline behavior is not guaranteed over plain LAN HTTP. The dashboard needs the running local server.

## Provider support and credentials

These are undocumented **consumer subscription endpoints**, not API billing APIs. An endpoint or payload
change may require a provider adapter update. [Provider notes](docs/provider-notes.md) record the verified
CLI versions, sources, refresh handling, and current limitations.

Claude tokens renew with a five-minute margin using the installed CLI's official refresh-lock protocol.
Codex retries authentication once with its OAuth refresh token when needed. Renewed credentials preserve
unknown fields, are checked against concurrent changes, and are replaced atomically. Grok's native lock
cannot be safely acquired with Node core; if its session needs renewal, the dashboard asks you to run
`grok login`. No token is sent to the browser or included in provider error messages.

Only config and rotated credential files persist. Temporary atomic-write files and official Claude
locks are cleaned up. This app never creates credential backups. Comparison builds can run on separate
ports; each build has its own refresh cache, and CLI refresh coordination is provider-dependent.

## Verify

```sh
npm test
npm run check
```

Tests use Node's built-in runner, synthetic redacted response fixtures, and temporary credential
directories. They cover parsers, weekly-only Codex windows, zero and missing values, stale snapshots,
429 backoff, refresh gates, credential-write races, account persistence, and HTTP request protection.
They do not call live providers or modify your real CLI login files.

For a live check, run the app and open Settings, verify discovered accounts, and inspect the cards.
Provider errors verify error handling, not a successful live integration. LAN tests on this PC do not
prove a separate phone can reach it.

## Architecture

`discover.js` finds logins → `config.js` selects accounts → provider adapters fetch and renew credentials
→ `normalize.js` validates usage → `cache.js` owns one refresh schedule → `server.js` serves cached JSON
and the static dashboard. See [the design](docs/design.md) and [agent instructions](AGENTS.md).

| Route | Purpose |
| --- | --- |
| `GET /api/accounts` | Safe discovery metadata, settings, and same-origin mutation token |
| `POST /api/accounts` | Enable all or update account, interval, and LAN settings |
| `GET /api/usage` | Cached normalized snapshots; no outbound requests |
| `POST /api/usage/refresh` | Coalesced refresh, still subject to minimum interval and backoff |
| `GET /api/meta` | Active binding, phone URL, and pending restart status |
| `GET /api/qr.svg` | Locally generated QR code when phone access is active |

POST requests require JSON, a same-origin `Origin` when supplied, and `X-Usage-Token` from discovery.
Every route validates `Host`; no permissive CORS headers are sent. Only allowlisted public files are served.

The default Git branch is `main`; references to `master` mean `main`.
