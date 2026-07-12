# Architectural Review Handoff — 2026-07-10

Three parallel read-only architect reviews were run against `dev` @ `3f602807`.
All three lanes returned **BLOCK / REQUEST CHANGES**. This directory contains the
full findings for remediation in this worktree (branch `fix/arch-review-2026-07`).

| Lane | File | Findings | Verdict |
|---|---|---|---|
| Performance / binary size / RSS | `01-perf-binary-rss.md` | 18 (14 high, 4 medium) | BLOCK |
| Prompts / context / tools / harness | `02-prompts-context-tools-harness.md` | 20 (1 critical, 5 high, 12 medium, 2 low) | BLOCK |
| Package architecture / maintainability / Rust-port | `03-package-arch-rust.md` | 16 (3 high, 12 medium, 1 low) | BLOCK |

\* The `<soul>` deletion finding was **explicitly rejected by the owner** — see
the note at the top of `02-prompts-context-tools-harness.md`. Do NOT delete the
`<soul>` block; only precedence/reconciliation options are in scope.

## Cross-cutting top actions (owner-adjusted)

1. **Capability-metadata, fail-closed planning guards** — replace the tool-name
   allowlist in `agent-session.ts:4358` (code-level; independent of prompt text).
2. **Gate release tags on full CI for the tagged SHA**; generate version/platform/
   publish metadata from one manifest (`scripts/release.ts:330`, `ci.yml:362`).
3. **Split the native addon + compiled product boundary** — core vs optional
   shell/computer/image/AST. Drives the 39–192 MB artifacts and ~114 MB help RSS.
4. **Byte-bounded memory** — disk-backed session history, byte-weighted caches,
   bounded editor undo, unified retained-memory registry; bounded retry budget.
5. **Decompose `AgentSession` behind its facade**; extract `agent-wire`; split
   native procmgr out of `utils`; phase-split SKILL prompts (~15–20K tokens saved
   per invocation).

## Quick wins (small diffs, both lanes agree)

- `packages/tui/src/utils.ts:214-217` — `visibleWidths()` calls native batch and
  discards the result. Return it (after parity test) or delete the call.
- `packages/coding-agent/src/web/search/index.ts:184-188` — remove silent
  2020–2029 year rewriting.
- `packages/coding-agent/src/web/search/index.ts:278-303` — throw `ToolError`
  when all providers fail instead of returning `Error:` text as success.
- Move `src/task/token-log.test.ts` and `src/cli/fixture-report.test.ts` out of
  the published `src` tree.

## Open policy decisions (need owner input before implementing)

- **Dynamic-import policy**: `AGENTS.md:62-68` forbids dynamic imports, but
  `cli.ts:25-53` and provider/browser loading rely on them for cold-start. Either
  codify narrow exceptions with compile-smoke tests, or move to worker/process
  boundaries. Do not silently pick one.
- **`<soul>` precedence**: keep the block; decide whether it or the earlier
  safety/verification sections win on conflict, and encode that ordering.

## Verification expectations

Follow repo contract (`AGENTS.md`): targeted tests first, then `bun check`;
never `tsc`; run rebrand/default-surface gates after any workflow-definition
change; never commit unless asked.
