# GPT-6 build verification

Verified September 8, 2026 on Windows with Node 24.15.0. The production build follows
the original `docs/mockups/` visual reference, without its sample-data controls.

- Node test runner: 55 tests pass. No live credentials are used by tests.
- JavaScript syntax checks pass; no build step is required.
- Desktop (1440px) and mobile (390px) browser checks pass, with no browser errors or
  horizontal overflow. Dark and light themes, settings dialog, account opt-out and
  restore, persistence across reload, and pending LAN-restart messaging were checked.
- Synthetic browser scenarios confirm stale Claude meters are retained after 429,
  expired Codex login shows its login command without meters, and unsupported Grok
  responses display an error without a numeric estimate.
- Live startup discovered all three supported CLI logins. Claude, ChatGPT/Codex,
  and Grok each returned normalized usage successfully. Codex's general allowance
  was weekly-only and was labeled as weekly. Live readings were not copied to fixtures.
- LAN binding, metadata, and generated QR responses are covered by integration tests.
  A separate physical phone was not available for a network-reachability check.

The comparison instance uses `http://127.0.0.1:3146`; `npm start` normally uses port
3140. Provider renewal limitations are recorded in [provider-notes.md](provider-notes.md).
