## Summary
Revision 7 is sound for the two reconciliation deltas. It makes full concurrent running turns a hard v1 requirement, elevates unsafe singleton state to a Phase 0 blocker with escalation and redesign rather than a silent one-active-turn fallback, and defines a coherent asymmetric validation boundary for Codex-core versus gjc/* methods.

## Analysis
Spec compliance: the plan states the hard concurrency requirement in the summary and RALPLAN-DR, keeps full concurrent running turns in scope, and explicitly excludes any v1 fallback that silently degrades to single-active-turn behavior (`stage-07-revision.md:4`, `:7`, `:23-25`). Phase 0 requires enumeration of every AgentSession process-global or singleton, assigns each resource to per-thread scoped, immutable shared read-only, or short non-blocking-safe serialization, and makes unresolved singleton hazards blockers requiring escalation and redesign (`:30-32`). The test gate is concrete: two threads must reach simultaneous running turns, stream independent item lifecycles, survive dispose/delete of one thread while the other continues, and prove no process-global ownership leak (`:34`, `:120-122`).

Architecture: the concurrency posture is credible at plan granularity because it does not assume AgentSession isolation and does not hide behind global serialization. The binding contract forbids serializing whole turns, model streams, tool execution, or command execution across threads; cross-thread operations are concurrent by default once shared resources pass the Phase 0 isolation contract (`:32`, `:37`). The risk is prominent in the risk table as a Phase 0 blocker requiring architecture redesign, and migration cannot begin until Phase 0A is green (`:122`, `:184`). Execution remains high-risk, but the risk is surfaced as a user-visible redesign/approval stop before Phase 1 rather than a latent execution landmine.

Unknown-field policy: the asymmetry is coherent and testable. Codex-core methods are lenient for interop while preserving hard rejects for invalid required types, missing identifiers, expectedTurnId conflicts, invalid JSON-RPC state, active-turn conflicts, empty commands, and unsupported fields whose omission would invert intent (`:52`). gjc/* methods are strict on unknown fields, casing, enum variants, and unsupported optional fields, preserving deterministic schema-driven automation (`:54`). The pinned method matrix enumerates accepted, projected, ignored, and rejected fields per method, and the conformance plus interop gates assert unsupported Codex-core fields are ignored while gjc unknown fields are rejected (`:57-80`, `:110`, `:122`, `:132`, `:160`).

## Root Cause
The prior ambiguity was allowing concurrency to be treated as best-effort and field validation to be uniform across two different protocol boundaries. Revision 7 fixes that root issue by making concurrency a Phase 0 architectural contract and by separating Codex-client compatibility from deterministic GJC extension validation.

## Findings
No severity-rated issues found. The two reconciliation deltas are architecturally sound at plan granularity.

## Recommendations
1. Approve the revised plan for these deltas.
2. During execution, treat any singleton that cannot satisfy the Phase 0 binding contract as a user-visible redesign blocker before Phase 1, never as a hidden serialization fallback. This is already reflected by the Phase 0 blocker, migration gate, and risk-table language.
3. Keep the asymmetric validators covered by both schema/sample-frame tests and live interop smoke so leniency never leaks into gjc/* methods and strictness never breaks Codex-core experimental-field tolerance.

## Architectural Status
`CLEAR`

## Code Review Recommendation
`APPROVE`

## Trade-offs
| Option | Benefit | Cost | Verdict |
|---|---|---|---|
| Full concurrency plus Phase 0 blocker escalation | Satisfies hard v1 requirement and prevents hidden data races or clobbering | High Phase 0 discovery and redesign risk | Sound and chosen |
| Single-active-turn fallback | Simpler implementation | Violates user requirement and masks singleton defects | Rejected |
| Codex-core lenient, gjc/* strict | Maximizes Codex interop while preserving GJC automation determinism | Requires asymmetric validators and explicit tests | Sound and chosen |
| Strict everywhere | Simpler validation model | Breaks real Codex clients carrying experimental fields | Rejected |
