# Plan review and prototype notes

Review date: 2026-09-08. [design.md](design.md) remains the authoritative plan.
These are recommendations and unresolved questions, not implemented capabilities.

The small Node server, static UI, and provider adapters fit this project well. Keep the existing provider
order and implementation sequence. The next useful milestone is discovery plus an honest empty dashboard.

## Resolve before connecting real accounts

1. **Verify provider assumptions.** Record installed CLI versions, source/observation dates, auth modes,
   refresh behavior, and redacted response fixtures. This review did not access credentials or validate the
   undocumented endpoints. In particular, verify that Grok billing credits represent the consumer shared
   pool. Label Codex usage clearly rather than implying it covers all ChatGPT usage. A file's existence
   does not establish a valid subscription login; absent plan metadata means unknown.
2. **Make safe refresh an implementation gate.** Preserve unknown JSON fields and file permissions;
   serialize in-process refreshes, re-read on authentication failure, and retry authentication at most once.
   Re-reading before writing still leaves a check/write race. A lock helps only if the official CLI cooperates;
   verify its actual protocol. If safe rotation cannot be established, report that limitation instead of
   shipping unsafe credential writes. This must be settled before automatic renewal is enabled.
3. **Clarify permitted writes.** Atomic replacement needs temporary files in the destination directory, but
   the current rule names only final credential/config files. Document that narrow exception in AGENTS.md
   when implementing it. Persistent credential backups and app-owned lockfiles are not currently authorized
   runtime outputs. This review removes the conflicting backup advice without expanding the policy.

Node cautions against concurrent file modifications; that supports serialization but does not provide a
cross-process OAuth transaction. See [Node filesystem documentation](https://nodejs.org/api/fs.html).

## Make the data contract precise

Keep `windows[]` and add provider-level `status`, `lastSuccessAt`, `lastAttemptAt`, `nextRetryAt`, and a
safe structured error `{ code, message }`. Use absolute timestamps.

| Situation | Display |
|---|---|
| Waiting for first result | Loading, without numeric meters |
| Valid numeric zero | 0% used, a valid empty bar |
| Missing, null, non-finite, or invalid value | Omit meter; never coerce to zero |
| Response has no recognized windows | Usage unavailable / unsupported format |
| Failure after success | Last-good meters, stale label, last-success time, and error |
| Failure before any success | Error card without meters |
| Reset passed without a new reading | “Reset time passed; awaiting update”; never zero the usage locally |
| Disabled provider | Hide card and stop scheduling its work |

Identify windows by duration plus scope/name; different model windows can share a duration. Specify
percentages **used**. Validate ratio denominators and units before calculating usage. Clamp only the visual
bar if a valid value exceeds 100%; do not silently rewrite the reported number. Optional plan/credit lookup
failures should not discard otherwise valid usage results.

## Scheduling and settings

- Keep the implementation order, but include a conservative request gate with the first provider; do not
  leave unrestricted calls in place until the later cache milestone.
- Share one in-flight request/refresh per provider across all viewers. Apply the two-minute floor to manual
  refresh. Honor valid `Retry-After` values, with capped exponential backoff and jitter as fallback. Set request
  timeouts and let other providers complete independently.
- Resolve whether `GET /api/usage` reads cache or triggers a coalesced refresh. Prefer cache reads plus one
  server scheduler, as the existing notes propose. Report suppressed manual refresh and the next allowed
  time; never advance `lastSuccessAt` for failures or suppressed requests.
- Enable detected supported logins on first run; later discovery must respect saved opt-outs. Distinguish
  missing, unreadable, malformed, and unsupported credential stores without exposing raw errors or secrets.
- Define the settings API for interval/bind mode; the current POST contract only describes account flags.
  A restart-required bind change is simpler than silent rebinding. Validate config and allowlist provider IDs.

## Local server and phone boundaries

Host checks and absent CORS headers do not fully protect write routes. Validate Origin on browser mutations,
require JSON, reject cross-origin requests, cap request bodies, and serve only the static public directory.
Consider a same-origin request token for mutations; this is request protection, not dashboard accounts.
Never let API input select arbitrary credential paths or token issuers.

LAN mode has no authentication: anyone who can reach it may see usage and use exposed controls. Say this
beside the toggle. Describe plain LAN HTTP as a phone view or browser shortcut, not guaranteed offline or
installable PWA support. [MDN's Service Worker documentation](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
confirms the secure-context requirement and localhost exception. HTTPS provisioning is beyond these mockups.

## Verification improvements

Use Node's built-in test runner when implementation begins. Prioritize fixtures for weekly-only Codex,
additional model windows, zero/missing values, malformed responses, 401, 429, and stale-cache retention.
Inject a clock and fetch function for scheduler tests. Use temporary fixture credential files for read/write
failures and race cases; replace the plan's suggestion to rename real credentials with an injectable
credential-root test. Live provider calls are a separate opt-in smoke check.

A well-formed error card passes error handling only; it does not establish that integration works.
The Node declarations are compatible: 20+ is the stated minimum and `.nvmrc` selects 24 for development.

## HTML mockups

Open [mockups/index.html](mockups/index.html) directly in a browser. No install or server is needed.

- **Dashboard:** three provider cards, labeled meters, reset text, expandable model details.
- **First launch:** simulated discovered accounts and a missing Grok login.
- **Error states:** Claude stale after 429, Codex requiring login, Grok format error without meters.
- **Settings:** sample account toggles, interval and LAN previews.
- **Appearance:** dark by default; circle button switches to light. Cards stack on small screens.

All values, plans, login states, and reset countdowns are fictional frozen examples. No network requests,
credential reads, or persistence occur. Settings reset on reload; refresh acknowledges the sample snapshot.
This is a UI study, not application scaffolding. `npm start` still awaits `server.js`.
