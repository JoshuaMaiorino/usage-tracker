# Cross-branch comparison

Three agents built this app independently from [`design.md`](../design.md) and the UI study in
[`mockups/`](../mockups/index.html). This is a
comparison of the results, written from the `Claude-Opus-5` branch, so read the "what we do better" half
knowing who wrote it. The defects it records in our own build are the part worth acting on.

This public edition preserves Claude's attribution and technical conclusions while
omitting personal account readings and local session details. The comparison table
summarizes behavior; numeric payload examples below are explicitly synthetic.

**Date:** 2026-09-08 · **Node:** 24.15.0

| Branch | Commit | Author |
|---|---|---|
| `Claude-Opus-5` | `41016e3` | Claude Opus 5 |
| `GPT-6` | `92e6787` | GPT-6 |
| `grok` | `f5e0592` | Grok |

## Method

The original review measured parser behavior as well as reading source. Each branch's
`lib/` was extracted to a scratch directory and its three parsers were run against the
same responses from `/api/oauth/usage`, `/backend-api/wham/usage` and
`/v1/billing?format=credits`, with identifying fields and tokens stripped. This public
edition does not reproduce those account readings. Test counts come from running each suite.

Since these endpoints are undocumented, results are only valid for the payload shapes served on the date
above and the sampled response shapes. A parser that looks worse here may simply not
have seen a particular shape.

## What each build preserves from the same response shapes

| | `Claude-Opus-5` | `GPT-6` | `grok` |
|---|---|---|---|
| Claude session / weekly | shown | shown | shown |
| Claude scoped weekly | shown | **missing** | shown |
| Claude plan detail | base tier | **base tier and multiplier** | base tier |
| Codex weekly | shown | shown | shown |
| Codex per-model limits | shown | shown | **missing** |
| Codex reported plan | preserved, title-cased | preserved | **mapped to a different tier** |
| Grok shared pool | shown | shown | shown |
| Grok product split | **missing** | shown, as account details | shown, as meters |
| Runtime dependencies | 0 | 1 (`npm install` required) | 0 |
| Tests | 72 | 63 | 14 |
| Source lines (`lib/` + `server.js` + `public/`) | 3,252 | 1,899 | 3,555 |

All three converged on the same architecture: a server-side singular scheduler, clients reading cache only,
last-good snapshots with backoff, and the mockup's exact design tokens. The differences are in the details.

## Defects in this branch, found by comparison

These are ours to fix. Listed worst-first by consequence, not by effort.

### 1. Credential writes are less safe than both other builds

`lib/credentials.js` does not `fsync` before renaming. Both other branches call `handle.sync()` first. A
crash between write and rename can leave a truncated credential file, which is a logout.

`GPT-6` goes further and is worth copying: it implements Claude Code's **actual** lock protocol — the
`.oauth_refresh.lock` directory inside the config dir plus the legacy sibling `<dir>.lock`, created with
`mkdir` (atomic), refreshed on a 5-second heartbeat to satisfy the CLI's 60-second stale check, never
stealing a lock it does not own, and validating that it still holds the same inode before writing. Our
in-process mutex only serializes *our own* refreshes; it does nothing about the real CLI refreshing
concurrently. The review notes anticipated exactly this: *"a lock helps only if the official CLI cooperates;
verify its actual protocol."* We did not verify it.

Our staleness check also compares `expiresAt` rather than file contents. If the CLI wrote a token whose
expiry is equal or lower, we would overwrite it. Both other branches compare the full original bytes before
renaming, which is strictly safer and no harder.

### 2. Grok `productUsage` is an array, and we only parse an object map

The response uses an array. This synthetic example illustrates its shape; these are
invented test values, not captured account usage:

```json
"productUsage": [
  { "product": "GrokImagine", "usagePercent": 21 },
  { "product": "GrokBuild",   "usagePercent": 13 },
  { "product": "GrokChat",    "usagePercent": 4 }
]
```

`normalizeGrok` guards with `!Array.isArray(breakdown)`, so the whole breakdown is dropped silently. The
Grok card has no "Also reported" section as a result. This is the failure mode the design warns about —
not a crash, just a quietly absent feature.

### 3. Grok's period is hardcoded to 7 days

We always emit `durationSeconds: 7 * DAY` and the label `Shared pool · 7 days`. The payload states the
period: `currentPeriod.type` can be `USAGE_PERIOD_TYPE_WEEKLY`, but
`USAGE_PERIOD_TYPE_MONTHLY` also exists and `GPT-6` handles it. A hardcoded weekly
label is only correct for the weekly shape.

### 4. Claude plan omits its multiplier

The credential format can carry `rateLimitTier` alongside `subscriptionType`.
For example, a synthetic fixture with `rateLimitTier: "default_claude_max_5x"`
and `subscriptionType: "max"` should show `Max 5x`, rather than a bare `Max`.
`design.md` asks for this level of detail; `GPT-6` reads the tier.

### 5. Grok prepaid balance is a `Cent` message, not a number

`prepaidBalance` uses a wrapped `Cent` value. A synthetic zero-balance example is
`{ "val": 0 }`, and `GPT-6` additionally handles an **omitted** `val` as a real zero
rather than as unknown. We look for a plain number and find nothing.

### 6. Codex credential files are not checked for auth mode

`~/.codex/auth.json` carries `auth_mode` and may carry `OPENAI_API_KEY`. `GPT-6` rejects API-key-mode files
as "not a subscription login". We read `tokens.access_token` regardless, so an API-key-mode file would fail
later with a confusing error instead of an honest one. The review notes made this point: *"a file's
existence does not establish a valid subscription login."*

## Things the other branches do better, worth adopting

Beyond the defects above:

- **`GPT-6`: a static route allowlist instead of path resolution.** Mapping `/app.js` → `app.js` in a
  `Map` means there is no traversal surface at all, rather than resolving a path and checking its prefix as
  `lib/guards.js` does. Ours is correct; theirs cannot be wrong.
- **`GPT-6`: injectable application factory.** `createApplication({ homeDir, providers, discovery, addresses, now })`
  lets them test the real HTTP layer end to end. We test extracted guard functions and never exercise
  `server.js` itself, because it self-starts on import.
- **`GPT-6`: per-provider due-time scheduling.** One `setTimeout` re-armed to the next due provider, so a
  backed-off provider retries exactly when its backoff expires instead of waiting for the next fixed tick.
  They also handle the `setTimeout` 2³¹−1 overflow for long `Retry-After` values.
- **`GPT-6`: `request.iterator({ destroyOnReturn: false })`** so an oversized body can still receive its 413
  instead of having the socket torn down first.
- **`GPT-6`: `lstat` + `isFile()` and a 1 MiB cap** on credential files, and `Intl.NumberFormat` for money.
- **`GPT-6`: client skips polling while `document.hidden`.**
- **`grok`: `structuredClone` of the original document** before mutating, so unknown fields survive by
  construction rather than by care.

## Things this branch does better, worth keeping

- **Claude's `limits[]` array.** Scoped weekly limits moved there; `GPT-6` still reads only the legacy
  `five_hour` / `seven_day_*` keys, so it misses named scoped restrictions, including
  exhausted-model scenarios. Keeping both the `limits[]` path and the legacy-key fallback is why ours reads both
  shapes.
- **Codex `additional_rate_limits`.** `grok` misses the per-model Codex windows completely.
- **Plan labels are never invented.** `grok` maps one distinct reported subscription tier to
  `Plus`, asserting a tier the API did not report. We title-case the reported string and otherwise leave it alone. The "never invent" rule in
  `AGENTS.md` covers labels, not just percentages.
- **Zero dependencies.** `GPT-6` added `qrcode-generator`, so a fresh clone needs `npm install` before
  `npm start`. The hand-rolled encoder in `lib/qr.js` is verified against the ISO/IEC 18004 worked example
  and the published format-information table.
- **Test coverage on the risky code.** `grok` has 14 tests and none covering cache/backoff or credential
  writes, which is where a bug costs the user something.
- **`grok`'s `copyFile` fallback is a trap worth not copying.** If `rename` fails it copies onto the live
  credential file, reintroducing the torn write that atomic replacement exists to prevent.

## One judgement call, recorded

`grok` renders the Grok product split as separate meters. That reads as three independent limits when it is
one pool broken down by product; a product breakdown is not a set of independent quotas. `GPT-6` puts it in
extras, which is more honest about what they are. When we fix defect 2, extras is the right home.

## Summary

`GPT-6` wrote the better engine — its credential-write path is the one to trust with a real Claude login,
and its test seams and scheduler are cleaner in less code. This branch wrote the better parsers and is
the only reviewed build that retained every sampled usage window. `grok` is the most elaborated UI on the
thinnest verification.
