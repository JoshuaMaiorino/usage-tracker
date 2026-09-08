# Provider fixtures

These are synthetic, redacted payloads based on the documented field contracts in `docs/design.md`.
They contain no captured account responses, tokens, email addresses, or real balances. Passing these
fixtures establishes parser behavior, not current availability of the undocumented provider endpoints.

Add sanitized regression fixtures when a provider changes its format; keep live smoke checks separate.

`claude-canonical.json` is a synthetic combined-build regression for the `limits[]` shape identified
in Claude's and Grok's reviews. Its conflicting canonical/legacy readings are intentional: they verify
which source takes precedence and ensure the named Fable restriction is not silently dropped.
