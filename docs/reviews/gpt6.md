# GPT-6 cross-branch review

Review date: September 8, 2026. Original comparison: GPT-6 `92e6787`,
Claude-Opus-5 `41016e3`, and grok `f5e0592`. Recorded from the conversation for
the combined build. Reviewers inspected source, opened each running dashboard,
ran the alternatives' fixture tests, and compared parsers with identical synthetic
or already committed redacted fixtures. No code changes were made during the review.
This public edition retains the review's attribution and technical conclusions while
omitting personal account readings. Exhausted-model examples describe synthetic fixtures.

## What the other builds did better

- Both alternatives understand Claude's canonical `limits[]` response and show
  named model allowances, including exhausted-model fixtures. GPT-6 omitted them while preserving the headline
  meters. This was the most consequential finding.
- Grok automatically expands model limits at 90% usage and uses an adaptive card
  grid. Both improve what is visible without extra interaction.
- Claude separates model restrictions, with a count, from account information.
- Grok tracks whether a login has previously been discovered, enabling new logins
  once while preserving deliberate opt-outs.
- Claude ranks likely home-network addresses and supplies PNG and Apple touch
  icons. Physical phone installation was not tested.
- Claude has useful safe operational diagnostics and slows repeated non-429 failures.
- Claude recovers a missing Codex account ID from the ID token and accepts relative
  reset timestamps. Both alternatives bound optional Grok metadata requests sooner.
- Both alternatives avoid runtime dependencies. This is a setup advantage, with the
  maintenance tradeoff of owning a QR encoder.

## What GPT-6 did better

- Richer, typed account details: Claude credit status and spending, Grok cent wrappers,
  actual currency formatting, reported product arrays and monthly periods. These
  benefited from the user's later requests, so the builds were not a controlled benchmark.
- Claude credential renewal interoperates with the verified official lock directories,
  checks for concurrent changes, preserves Windows ACLs, and uses synced atomic
  replacement. Codex still has documented cross-process race limitations.
- Two-minute per-provider gates survive manual refresh and toggles. Valid provider
  Retry-After instructions are honored in full, including very long delays.
- Nested Codex model and code-review limits are retained; API-only credentials are
  rejected during discovery instead of being presented as subscription logins.
- Expanded sections and keyboard focus survive polling; fetches time out, hidden
  tabs stop polling, and disconnected servers are reported visibly.
- Exact-origin validation, required CSRF tokens, a static file allowlist and actual
  HTTP integration tests protect the local application's settings and file boundary.

The recommendation was to borrow Claude's broader parsing and phone polish, plus
Grok's exhausted-limit visibility and discovery behavior, while retaining GPT-6's
credential safeguards, request gates and careful account formatting.
