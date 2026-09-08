# Bake-off notes — Grok vs Claude Opus 5 vs GPT-6

Written after reading the `Claude-Opus-5` and `GPT-6` branches on 2026-09-08. This
Grok build is the one that listens on **3142** and shows a **Grok** badge in the
header.

All three apps are the same product: a local Node server, CLI-login discovery, and a
mockup-style dashboard. The differences are in how they treated undocumented payloads
and the credential files.

## Speed

Grok shipped a working dashboard first. Claude and GPT-6 spent more of that time on
locks, fixtures, and HTTP tests, which is why those pieces are stronger on their
branches.

Speed is a real win when you just want something on screen. The cost is follow-up
rounds the others mostly skipped — “is this real data?” and “where is Fable?” For a
bake-off both matter: this branch was comparable sooner; they were less likely to
miss a quota bar on the first parse.

## What they did better

**Claude Opus 5 got the live Claude shape right the first time.** Anthropic now puts
Fable in `limits[]` as `weekly_scoped`, not `seven_day_fable`. That branch reads
`limits[]` as the source of truth, treats `nimbus_quill`-style keys as decoys, and
groups session/weekly as primary vs model-scoped extras. This Grok build shipped the
older flat-key parser and only added Fable after it was noticed missing.

**GPT-6 is the most testable and the safest around credentials.** `createApplication()`
is injectable (fake home dir, fake fetch, fake clock). It has real HTTP tests: CSRF,
Origin, Host, “don’t leak tokens in JSON,” reject `homeDir` in POST. For Claude refresh
it uses the CLI’s actual directory lock (`~/.claude/.oauth_refresh.lock`) with a
heartbeat. For Grok it **refuses** to rotate tokens, because Node cannot join Grok’s OS
advisory lock — more conservative than this build’s OIDC refresh, which can still race
the real CLI.

**Claude’s scheduler is stricter.** One timer, plus a ~110s floor per provider so a
restart or a settings save cannot become a poll storm. This build has a 2-minute
manual floor and 3-minute poll, but not that extra “don’t hammer after boot” gate.

**GPT-6 is easier to run side-by-side.** `--port` and `npm run start:gpt6` (3166) were
designed in from the start. This build hardcoded 3140, then moved to 3142 when asked.

**Docs and extras.** Claude’s README is the clearest of the three (error table, LAN
warning, no-deps). GPT-6 wrote `docs/provider-notes.md` with the CLI versions it
actually inspected. Claude ships PNG home-screen icons. GPT-6 has a skip link, keeps
`<details>` open across refresh, and formats spend/credits as real money. Claude ranks
LAN IPs so `192.168.*` wins over Tailscale/`100.*` — this build’s first LAN URL was
the Tailscale address.

**GPT-6’s ChatGPT parser is pickier in a good way.** It labels Codex vs all-of-ChatGPT,
handles `additional_rate_limits` by name, and has a code-review window. It also treats
API-key Codex logins as “not a subscription,” which matches the design.

## What this Grok build did better

**Zero dependencies, including QR.** Claude also stayed dep-free; GPT-6 added
`qrcode-generator`. The LAN QR is generated in-process so a phone page never calls a
chart API.

**The mockup is in the repo and the CSS is close.** Claude did not keep `docs/mockups/`.
GPT-6 did. The dashboard on 3142 is the mockup’s type, color, and card layout, wired to
live meters.

**Once Fable was found, the UI treats a red extra as important.** Additional limits
auto-opens at ≥90%, so a 100% Fable bar is not buried. Claude puts it behind a
disclosure with a count; GPT-6’s live parser would not show Fable at all, because its
fixture is a fake `seven_day_fable` key.

**Dummy 0% buckets stay off the card.** A `nimbus_quill` window with `utilization: 0`
and no reset is not a real empty bar.

**Grok still refreshes when it can.** GPT-6’s “never write Grok creds” is safer. If the
access token is about to die and a refresh token exists, this build tries the OIDC
refresh so the card does not just say “run `grok login`.” That is a product tradeoff.

**Smaller surface.** Fewer files, no `npm ci`, no icon pipeline. For a “leave it
running locally” app that is an advantage.

## Short version

Claude won on understanding the live Claude payload and on product polish. GPT-6 won
on tests, CLI flags, and not logging you out of Claude/Grok. This Grok build won on
speed, mockup fidelity, no dependencies, and (after the fix) showing a spent Fable
window without making you hunt for it.
