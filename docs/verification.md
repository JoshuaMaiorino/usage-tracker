# Combined build verification

Verified September 8, 2026 on Windows with Node 24.15.0. The combined build uses
GPT-6's application foundation and integrates the reviewed Claude and Grok improvements.
See [combined.md](combined.md) for the source commits, reviews and integration choices.
This public record omits personal account readings and local session details.

## Automated checks

- **99 Node tests pass**, using synthetic providers, controlled clocks and temporary
  credential/config directories. No automated tests access real CLI logins or live providers.
- JavaScript syntax checks and `git diff --check` pass. No build step is required.
- The canonical Claude fixture deliberately conflicts with legacy values and includes
  Fable at 100%, proving canonical precedence and retention of the scoped restriction.
- The combined parser also reads Claude's original committed fixture correctly:
  session, weekly and Fable windows all survive normalization.
- Coverage includes relative Codex resets, account-ID fallback, money/credit units,
  Grok product arrays, eight-second optional deadlines, stalled body reads and error
  cancellation that cannot erase a known 429 Retry-After instruction.
- Cache tests cover two-minute gates, full Retry-After, five-minute login-error delays,
  transient backoff/recovery, independent pending providers, and sanitized diagnostics.
- Config/HTTP tests cover conservative migration, new login discovery, retained opt-outs,
  concurrent saves/rescans, private-field rejection, actual request guards, oversized
  bodies, static icon/module routes, LAN metadata and QR generation.
- UI state tests cover 90%/100% escalation, deliberate closure, new allowance cycles,
  and settings patches that preserve other viewers' untouched choices.

## Browser and live check

- The combined server runs with `npm run start:combined` at
  `http://127.0.0.1:3170`. The header, browser title and manifest identify **Combined**;
  the footer credits GPT-6, Claude and Grok.
- All three live providers returned successful readings. Scoped restrictions, reported
  plan labels and shared allowances were retained. Exact account readings are not
  included in this public record; exhausted-limit behavior is covered by the synthetic
  checks described below.
- Desktop (1440px), mobile (390px) and narrow mobile (320px) layouts were inspected
  in a browser. No horizontal overflow or browser errors were detected. Expanded
  model/account sections and the light-theme settings dialog fit the narrow viewport.
- The LAN QR loaded successfully, and saved settings persisted. Physical phone reachability/installation
  was not tested; local HTTP still does not guarantee full PWA installation.
- Browser interaction verification uses a separate fixture application with injected
  providers/discovery and temporary config, keeping test controls out of the real app.
- Synthetic browser checks passed for urgent-limit expansion and deliberate closure,
  reopening at exhaustion, account-detail/focus persistence, stale meters and first-failure
  error cards without meters. Settings rescans and timed discovery preserve unsaved
  opt-outs and interval choices while enabling new logins. Captured save requests contain
  only changed account flags; a simulated failed save keeps the dialog/edits for retry.
- The synthetic two-provider desktop layout fills two equal columns. Both mobile
  widths and the 320px settings dialog fit without horizontal scrolling in both themes.

The original local comparison branches remain unchanged. Multiple builds share the
official CLI credential files when run; existing renewal and concurrency limitations remain documented in
[provider-notes.md](provider-notes.md).
