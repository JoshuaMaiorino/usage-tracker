# Provider verification and limits

Implementation review: September 8, 2026. These adapters implement the undocumented
endpoints in [the design](design.md). They have been tested with synthetic, redacted
fixtures and injected HTTP responses. A separate live smoke check on September 8,
2026 returned successful readings from all three local accounts: two Claude windows,
three Codex windows (including a weekly-only general allowance), and one Grok pool.
Real tokens and response bodies were not recorded in fixtures or logs. Renewal and
concurrent-write behavior were verified with temporary synthetic credential files.

## Observed CLI versions

The local `--version` commands reported Claude Code **2.1.263** and Grok
**1.0.13 (5e9a58528b76)**. The installed official `@openai/codex` package is
**0.153.3**. The separate `@vibe-kit/grok-cli` npm package is a different product;
its API-key authentication is not used by this app. Version inspection did not
read or print local credentials.

## Claude

The installed Claude binary confirms the public client ID and
`https://platform.claude.com/v1/oauth/token` endpoint from the design. Its refresh
request sends JSON containing `grant_type`, `refresh_token`, `client_id`, and the
stored scopes. The app preserves those scopes when available and updates expiry
from the returned `expires_in`, with a five-minute refresh margin.

The same binary exposes the current official cross-process locking protocol:
`~/.claude/.oauth_refresh.lock` and the legacy sibling `~/.claude.lock` are
directory locks, with a 60-second stale threshold and a five-second heartbeat.
The adapter acquires both before reading the refresh token again, maintains the
heartbeat, checks lock identity before refreshing/saving, and removes only locks
it acquired. It never breaks an existing or stale lock. This is intentionally
conservative: an abandoned lock is reported as busy until the CLI resolves it.
This protocol may need updating when Claude Code changes it.

File-based Claude credentials are supported. A missing file on macOS explicitly
mentions that the login may instead be in Keychain; this app does not extract it.

## ChatGPT / Codex

The [official Codex authentication implementation](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)
confirms the public client ID `app_EMoamEEZ73f0CkXaXp7hrann`, JSON refresh exchange
at `https://auth.openai.com/oauth/token`, and optional rotated access, refresh, and
ID tokens. This app refreshes only after a usage request returns 401, then retries
usage once. It rereads the credential file first so a CLI refresh can satisfy the
retry without another OAuth exchange. API-key and other non-ChatGPT auth modes
are treated as unsupported subscription logins.

The inspected Codex source coordinates refreshes in-process. No interoperable
cross-process OAuth lock was established. The app serializes its own refreshes,
rereads after the exchange, preserves a CLI winner, and compares the complete
file immediately before atomic replacement. These checks cannot eliminate the
remaining cross-process check/write race or simultaneous refresh-token exchange.
Avoid running multiple dashboard instances against the same credentials. A
concurrent Codex login/refresh can still require signing in again.

These meters describe **Codex coding usage**, not all ChatGPT messages. Reset
credits are display-only, and failure of the optional expiry lookup leaves the
main usage result available.

## Grok

The [official authentication model](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/auth/model.rs)
confirms issuer-scoped credentials, `key`, `refresh_token`, `expires_at`, and the
legacy `https://accounts.x.ai/sign-in` entry. Only first-party xAI scopes and the
legacy entry are accepted; arbitrary credential issuers never select a network
destination. Missing plan metadata remains unknown.

The [official credential storage implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/auth/storage.rs)
uses an OS advisory lock on `auth.json.lock`, with holder information and a
heartbeat. A file's existence does not tell whether that lock is held. Node core
cannot participate portably in this protocol, so the app **does not rotate Grok
tokens or modify its lock**. Valid credentials can fetch billing and best-effort
settings. On expiry, open Grok to let the official CLI renew the login, or run
`grok login`. A 401 causes one reread and a retry only if the CLI changed the token.

The live billing response supplied a recognized pool percentage and the settings
lookup returned SuperGrok. The shared-pool interpretation follows the design; it
was not compared against the separate grok.com settings page. A recognized returned
percentage or same-unit used/cap ratio is displayed; missing fields produce an
unsupported-format error rather than an invented meter.

## Credential and request handling

Only normalized usage and allowlisted discovery metadata reach the HTTP API.
Tokens are read per operation and are not cached in the usage snapshots. Requests
use fixed HTTPS destinations, disallow redirects, and have a 30-second timeout.
Upstream error bodies and raw network/filesystem errors are never passed to the
UI or logged. A 429 preserves `Retry-After` for the scheduler.

Rotations clone the entire credential document to preserve unknown fields. They
incorporate intervening metadata edits when token identity is unchanged, and
prefer the CLI when its tokens change. Atomic replacement uses a temporary file
in the same directory, syncs and closes it, and compares the original again
before rename. Unix permissions never widen; on Windows a hidden, noninteractive
PowerShell operation copies the source ACL to the empty temporary file before
writing credential contents. A failure prevents replacement. No credential
backup or permanent app-owned lock is created.

Run `node --test test/providers.test.js` for fixture-based adapter, discovery,
refresh, lock-contention, concurrent-change, error-redaction, and cleanup checks.
