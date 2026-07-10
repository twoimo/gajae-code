# GJC GUI production-readiness report (first-time-user hardening)

Final handoff for the ultragoal run executing the approved consensus plan
(`ralplan` run `019f441e-42da-7000-a8b1-2770d0522ada`, stage-02 revision):
make `packages/gjc-gui` production-ready from a first-time/non-expert user's
perspective, GUI-only, under the `docs/gui-tui-parity-matrix.md` scope freeze.

## PRD summary

### Problem

The GUI had strong parity primitives but a first-time user could hit terse
labels, protocol jargon ("thread", "app-server"), technical connection
errors, disabled "soon" controls, an enabled no-op Inspect action, and no
deterministic product-flow test harness.

### Goals (all delivered)

- Deterministic app/test host before UX hardening (injectable `createApp`).
- A new user can complete a first prompt in scratch or project-folder mode
  without documentation.
- Failure/deferred states are clear, recoverable, and token-safe.
- No visible control is a no-op or unexplained dead end.
- Screenshot/e2e evidence only from DESIGN-conformant surfaces with
  synthetic/redacted fixtures.

### Non-goals (unchanged)

- No backend protocol expansion: no new app-server methods, DTOs, schemas,
  wrappers, or notifications. `deferred-needs-new-api` parity rows stay
  deferred; `excluded-terminal-only` rows stay excluded.
- No credential/provider auth handling, no TUI replay/shell emulation,
  no visual redesign away from `DESIGN.md`.

### User-confirmed decisions

1. Deferred features render as **disabled rows with plain rationale**
   (discoverable roadmap), not hidden.
2. User-facing jargon renamed ("thread" → chat/session, scratch `/tmp` →
   "scratch chat"); code keeps protocol naming.
3. Test-host-first sequencing (harness before UX polish).

## Data-classification policy

`src/app/redaction-logic.ts` is the display-side SSOT (`DATA_CLASS_POLICIES`):
per-class display/export/screenshot policies (show/truncate/mask/omit/
synthetic-only) for public copy, local paths, endpoint/transport metadata,
host-URI URLs/content, workflow-gate context/schema, tool args/output/error,
transcript text, copy/dump export, plugin settings, and screenshots.
Key invariants, all regression-tested:

- High-confidence secret fields (token, api_key/apikey, access/refresh token,
  client_secret, x-api-key, secret, authorization, password) are redacted in
  assignments, query params, auth schemes (Bearer/Basic/Digest), and quoted
  JSON values; generic `key=value`, prose, and code references survive.
- Host-URI approvals keep **raw** content for the server round-trip and render
  only a redacted `contentPreview`.
- Copy/Dump exports are redaction-only (no truncation) and add no credentials.
- Home directories never leak usernames: POSIX and Windows paths redact to
  `~` before basename in thread labels, titles, recents, and confirmations.
- GUI redaction is defense-in-depth for display; the app-server owns
  authoritative redaction.

## Story → implementation map

| Story (plan) | Goal | Key files | Tests | Screenshots |
|---|---|---|---|---|
| 0+1 test host & logic extraction | G001 | `main.tsx` (createApp/AppHostDeps), `connection-state-logic.ts`, `directory-logic.ts`, `first-run-logic.ts`, `action-state-logic.ts` | `app-host.test.ts`, `*-logic.test.ts` | — |
| 2+3+4 first-run, failures, redaction | G002 | `main.tsx`, `redaction-logic.ts`, `transcript.ts`, `transcript-export-logic.ts`, `model-panel.tsx` | `redaction-logic.test.ts`, `connection-state-logic.test.ts`, `transcript-export-logic.test.ts` | first-run, connection-detail |
| 5+6+7 states, discoverability, dead-ends | G003 | `main.tsx` (help/glossary, hints), `command-palette.*`, `extensibility-*`, `model-panel.*`, `session-actions.*`, `styles.css` | `command-palette.test.ts`, `extensibility-logic.test.ts`, `app-host.test.ts` | help overlay |
| 8+9 transcript readability, session polish | G004 | `main.tsx` (transcriptStatusPresentation), `session-actions*`, `directory-logic.ts`, `styles.css` | `session-actions.test.ts`, `markdown.test.ts`, `app-host.test.ts` | — |
| 10+11 accessibility, showcase, harness | G005 | `main.tsx` (HelpGlossary trap), `extensibility-panel.tsx` (tab aria), `accessibility-contrast.test.ts`, `src/showcase/*`, `src/harness/*`, `harness.html`, `vite.config.ts` | `accessibility-contrast.test.ts`, `src/harness/main.test.tsx` | 19 captures: app 1280/760/360, showcase full-page, 10 harness flows |
| 12 docs handoff | G006 | this file | — | — |

Screenshot set and automation transcript were captured with real headless
Chromium against `vite preview` (app, showcase, and the mocked product
harness); session-local copies lived under `/tmp/g005-screenshots/` and
`/tmp/g005-browser-automation-transcript.json` during the run, referenced by
the durable ultragoal ledger receipts.

## Evidence harness

- `harness.html` / `src/harness/main.tsx` render the **real product App**
  with a mocked app-server client (27 methods) and scenario controls:
  `?scenario=happy|server-unavailable|token-rejected|inspect-error`.
- Serve with `bun --cwd=packages/gjc-gui run build` then
  `bun --cwd=packages/gjc-gui run preview`; open `/harness.html`.
  Showcase state matrix: `/showcase.html`.
- All fixtures synthetic (`/projects/demo-app`, `synthetic-token`,
  `gajae://` URIs); no real usernames, paths, tokens, or hostnames.

## Role roster and quality gates (for future runs)

- Executor lanes implement bounded slices; architect reviews architecture/
  product/code; a read-only cleaner sweep blocks slop (fallback masking,
  over-redaction, dead code, jargon, DESIGN drift, missing tests); an
  executor QA/red-team lane must break the change on the real surface.
- Completion gate per story: cleaner zero blocking findings → architect
  CLEAR/APPROVE + QA passed on the frozen change set → full verification
  rerun (`bun --cwd=packages/gjc-gui run check && run test && run build`,
  biome on changed files) → checkpoint with structured quality gate.

## Verification (final state)

- `bun --cwd=packages/gjc-gui run check` — pass (tsc).
- `bun --cwd=packages/gjc-gui run test` — pass: 108 tests / 366 expects
  across 14 files (all `src/app/*.test.ts` + `src/harness/*.test.tsx`).
- `bun --cwd=packages/gjc-gui run build` — pass; multi-page dist
  (`index.html`, `showcase.html`, `harness.html`).
- `bun --cwd=packages/gjc-app-server-client run check` / `run test` — pass
  (7 tests); package unchanged, generated client used as-is.
- `bun run check:schemas` — **not run**: no schema/protocol/generated files
  changed in this run (GUI package + docs only), so the schema check is not
  applicable; recorded here as the explicit not-run justification.
- WCAG AA: 13 token pairs with computed ratios in
  `accessibility-contrast.test.ts`; independent recomputation matched within
  0.003.

## Remaining deferred rows (unchanged classification)

Settings, theme runtime, goal, fast, export, todos read/list/status, jobs,
context, usage, agents, monitors, tree, provider add/login/logout, memory,
rename, move, btw, contribute-pr, retry, persistent history/search, model
catalog/thinking, compaction summary read, and plugin/skill/extension
mutations remain
`deferred-needs-new-api` per `docs/gui-tui-parity-matrix.md`; the GUI now
explains each with plain-language disabled rows. Unblocking any of them
requires native strict schema-registered `gjc/*` contracts and a
token-safety design, per the parity matrix decision rule.
