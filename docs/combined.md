# Combined edition integration

The **Combined edition** is released on `main` as a fresh public snapshot of the
local `combined` build. That build started from GPT-6 `92e6787` and integrated
selected behavior from Claude-Opus-5 `84792e7` and grok `c71a228`; the resulting
local snapshot was `dd656a1`. These IDs record development provenance, not commits
included in this public repository's fresh history. The original local comparison
branches remain intact.

The dashboard identifies itself as **Combined**, credits all three contributors,
and has a dedicated launch command: `npm run start:combined` (port 3170).

## Review inputs

- [Claude's review](reviews/claude.md), adapted from `84792e7`.
- [Grok's review](reviews/grok.md), adapted from `c71a228`.
- [GPT-6's review](reviews/gpt6.md), adapted from the development conversation.

These are historical assessments by their respective authors, including subjective
preferences and observations from different moments. The reviews were sanitized for
public distribution: personal account readings and local session details were removed,
while attribution and technical conclusions were retained. They are not verbatim copies.
The integration decisions below
use the actual code and regression fixtures. For example, the zero-dependency claims
are factual, but they do not require replacing a tested QR library with another encoder.

## Integrated behavior

| Contribution | Combined behavior |
| --- | --- |
| Claude's canonical Claude parser | Reads named `limits[]` windows, including Fable, with legacy fallback; preserves real zeroes and excludes legacy placeholder model buckets. |
| Claude's additional Codex compatibility | Supports relative reset times and an ID-token account-ID fallback; retains GPT-6's explicit subscription auth-mode validation. |
| Grok's urgent-limit disclosure | Opens model restrictions at 90% and when newly exhausted, while respecting a user's closure through unchanged updates. |
| Claude's card organization | Model limits with a count and account details have separate disclosures. |
| Grok's adaptive layout | Cards fill the available grid space when fewer providers are enabled and stack on narrow screens. |
| Grok's discovery history | Newly discovered supported logins enable once; saved opt-outs survive rescans and restarts. Legacy configs preserve every stored choice because historical intent cannot be inferred. |
| Claude's phone polish | Likely home-network IPv4 addresses rank ahead of VPN/CGNAT addresses. PNG app icons and an Apple touch icon complement the existing SVG. |
| Claude's operational diagnostics | Production logs contain only allowlisted refresh events, provider IDs, timestamps and safe error codes; no raw error or response logging. |
| Claude's non-429 backoff | Login/setup failures retry no sooner than five minutes; repeated transient failures back off while retaining last-good meters. |
| Both alternatives' optional lookup bounds | Optional Codex reset-expiry and Grok plan metadata have an eight-second timeout; their failure does not discard the main usage result. |

## Foundation retained

GPT-6 supplies the native HTTP application factory, strict request and static-file
boundaries, two-minute provider gate, full Retry-After handling, independently timed
provider retries, and in-memory last-good cache. Its credential renewal path retains
the verified Claude locks, heartbeat, concurrent-change checks, permission preservation
and atomic writes. The Combined edition does not adopt the other builds' Grok token
rotation or copy-over-live-file fallbacks.

The richer Claude/Grok currency and credit details, Grok product usage arrays and
period labels, and nested Codex model/code-review limits remain. Grok product usage
stays in account details: it is a breakdown of one allowance, not independent quotas.
Reported plan labels are preserved instead of guessing a different subscription tier.

The frontend retains the skip link, visible connection errors, request timeouts,
hidden-tab polling pause, exact reset dates, preserved disclosures and keyboard focus.

## Deliberate tradeoffs

- Keep the single pinned local QR dependency. Both other builds' zero-dependency
  encoders are interesting, but another QR implementation adds maintenance without
  improving the dashboard's usage behavior. There are still no third-party browser calls.
- Keep the compact normalization module and injectable HTTP application instead of
  combining three separate module organizations. A larger architecture refactor would
  add integration risk without resolving an observed defect.
- Do not automatically renew Grok until its native advisory-lock protocol can be
  honored safely. Follow the official CLI login guidance when renewal is needed.
- LAN address ranking is a heuristic. It cannot prove which network a phone uses,
  and plain HTTP does not guarantee full PWA installation or offline operation.
- Separate comparison ports do not isolate shared CLI credential files or provider
  quotas. Use one dashboard for normal operation; retained Codex race limitations are
  described in [provider-notes.md](provider-notes.md).

Verification results are recorded in [verification.md](verification.md).
