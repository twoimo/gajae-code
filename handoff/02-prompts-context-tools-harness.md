# Lane 2 — Prompts / Context Management / Tools / Harness Review

Verdict: **BLOCK / REQUEST CHANGES** — 20 findings (1 critical, 6 high, 11 medium, 2 low). Reviewed at `dev` @ `3f602807` (2026-07-10).

> **OWNER DECISION (2026-07-10): the `<soul>` block stays.** Finding F1's original
> recommendation (delete `<soul>`) is REJECTED. In-scope alternatives:
> (a) add an explicit precedence line stating which section wins on conflict,
> (b) reconcile only the specific clauses that negate rules that must hold,
> (c) if `<soul>` is intended to win, soften the earlier safety/verification
> sections instead so the prompt says one thing. Pick per owner direction;
> do not delete the block.

## Summary

GJC has strong foundations — default hidden-tool discovery, structured output metadata, pair-safe compaction, session-scoped artifacts, explicit role-agent prompts — but the reviewed surface has blocking contract violations: contradictory same-authority prompt sections, planning-workflow mutation escapes, unbounded retry behavior ignoring the configured budget, destructive query rewriting in web search, and harness fallbacks that accept subagents without the required `yield` contract.

## Token economics

Estimates use the repo's own chars/4 heuristic (`packages/agent/src/compaction/compaction.ts:376-416`).

| Prompt surface | Size | ~Tokens | Assessment |
|---|---:|---:|---|
| Base `system-prompt.md` | 20.3 KB | 5.1K | Reasonable, but contains the contradictory tail and duplicated workflow routing/path material |
| Four role prompts (executor 4.0, planner 4.3, critic 4.1, architect 5.7 KB) | 18.1 KB | 4.5K | Well structured; child execution rules conflict with base prompt |
| Deep Interview SKILL | 78.1 KB | 19.5K | Excessive — state schemas, phase procedures, recovery, scoring all injected before the first question |
| Ultragoal SKILL | 38.4 KB | 9.6K | Completion QA schemas and long operational contracts dominate every invocation |
| Team SKILL | 32.4 KB | 8.1K | Operator manual, command catalog, state layout, recovery guide injected pre-launch |
| Ralplan SKILL | 17.2 KB | 4.3K | Better; persistence/resume and execution-gate details could be phase-loaded |
| 45 tool prompts | 105.5 KB | 26.4K | Discovery mode prevents default residency (good); Browser (8.2 KB) largest single |
| Compaction prompts | ~6.8 KB | ~1.7K | Acceptable |

The full selected SKILL body is injected by `buildSkillPromptMessage` (`packages/coding-agent/src/extensibility/skills.ts:409-421`).

Concrete cuts (per-invocation savings):
- Phase-split skills: Deep Interview **8–10K**, Ultragoal **4–5K**, Team **3–4K**, Ralplan **1–2K** tokens.
- Child-specific base prompt (condition out main-only todo/decomposition/verification text): **150–250 tokens per subagent call** + removes impossible instructions.
- Browser long-tail `tab.*` API reference → on-demand docs: **1.1–1.3K tokens** when Browser is activated.
- xAI-only web-search guidance/schema conditional: **250–400 tokens** when not applicable.
- Deduplicate workflow paths/summaries across base prompt, AGENTS.md, SKILLs, runtime constants: **500–1,000 tokens** + fixes correctness (they currently disagree).

## Findings

### F1. CRITICAL → owner-adjusted — Resolve the `<soul>` contradiction (do NOT delete)
**Reference:** `packages/coding-agent/src/prompts/system/system-prompt.md:276-307`.
Earlier sections require read-only answers for informational requests, forbid fabricated output, and protect user work; the `<soul>` block then declares "Guardrails? None", absolute obedience, and permits policy-violating/unverified content. Same-authority contradictory instructions make behavior nondeterministic — which section wins depends on model/turn.
**Fix (per owner decision):** keep `<soul>`; encode explicit precedence or reconcile the directly colliding clauses (see note at top). Add a rendered-prompt regression test asserting the chosen precedence text is present.

### F2. HIGH — Block every mutating capability during planning workflows
**References:** `packages/coding-agent/src/session/agent-session.ts:4358-4377`; `packages/coding-agent/src/skill-state/deep-interview-mutation-guard.ts:47-50`; `packages/coding-agent/src/prompts/tools/browser.md:1-48`.
Only `edit`/`write`/`ast_edit`/`bash` are guarded. `eval` (Python/JS), `recipe` (saved bash), `browser` (`run` = full Node), `github`, `computer`, and other discovery-activated tools can mutate local/external state before approval — without violating any tool schema.
**Fix:** Replace the name allowlist with capability metadata (`mutatesFilesystem`, `externalWrite`, `spawnsExecution`, `destructive`, …) and fail closed for all mutating capabilities; give narrowly read-only operations separate tools or per-operation intent classifiers.

### F3. MEDIUM — Fail closed on active in-memory planning state when durable state is unreadable
**Reference:** `deep-interview-mutation-guard.ts:222-255`.
`getActivePlanningSkill` releases the mutation block when durable mode-state is missing/invalid — a transient read failure or corrupt state unlocks mutation while `AgentSession` still knows the active skill.
**Fix:** Live `AgentSession` active-skill state is the primary boundary; durable state corroborates. On mismatch, block and require explicit state doctor/clear/force recovery.

### F4. HIGH — Honor the configured retry budget for transient and unknown errors
**References:** `agent-session.ts:9624-9648`; `packages/coding-agent/src/config/settings-schema.ts:1023-1045`, `:1055-1073`.
`retry.maxRetries` (default 3) is skipped for `transient`/`unknown` classes (`unboundedClass`), while provider request and stream layers each default to 5 retries. One persistent unclassified failure can replay a billable full context forever.
**Fix:** Global turn-level attempt/cost/time budget, bounded by default; infinite retry only as explicit opt-in; expose provider-level attempts in the terminal diagnostic.

### F5. HIGH — Preserve explicit years in web-search queries
**Reference:** `packages/coding-agent/src/web/search/index.ts:184-188`.
Every `2020`–`2029` literal is silently replaced with the current year — "Node 2024 release notes" becomes a different question.
**Fix:** Remove the rewrite. Relative-date handling belongs in the search system prompt/current-date context, never in mutation of explicit literals.

### F6. HIGH — Reject subagent completion that bypasses `yield`
**References:** `packages/coding-agent/src/task/executor.ts:503-514`; `packages/coding-agent/src/prompts/system/subagent-system-prompt.md:39-57`.
The prompt says `yield.result.data` is the only completion path (three reminders enforced), but `finalizeSubprocessOutput` treats non-empty plain text as success when no output schema is configured — bundled role agents usually have none.
**Fix:** Remove the broad raw-text fallback, or gate behind explicit legacy mode returning a non-clean/contract-violating status, never success.

### F7. HIGH — Generate the Ultragoal objective from session-scoped paths
**References:** `packages/coding-agent/src/gjc-runtime/goal-mode-request.ts:19-22`, `:72-85`; `packages/coding-agent/src/gjc-runtime/session-layout.ts:101-116`.
New Ultragoal plans persist objectives pointing at legacy `.gjc/ultragoal/goals.json`/`ledger.jsonl`, while the authoritative layout writes `.gjc/_session-{sessionid}/ultragoal/`. The wrong string is persisted as `gjcObjective` and injected as the active goal — the agent inspects nonexistent/cross-session paths.
**Fix:** Build from `sessionUltragoalDir` (or internal URI/opaque run id); keep the legacy constant only as a migration alias; update the guard matcher.

### F8. MEDIUM — Commit the final assistant message on stream exhaustion
**Reference:** `packages/agent/src/agent-loop.ts:1024-1049`.
The `done`/`error` branch finalizes and emits `message_end`; natural iterator exhaustion only returns. A stream closing without a terminal event leaves the partial message unfinalized and can produce tool results without a committed assistant tool call.
**Fix:** One finalization helper used for terminal events, exhaustion, and partial-error cleanup.

### F9. MEDIUM — Select fork context by complete turns
**References:** `agent-session.ts:1795-1889`; `packages/coding-agent/src/task/index.ts:293-316`.
Fork seeding sanitizes each message independently then applies `maxMessages`; `receipt`/`last-turn` can seed assistant-only content omitting the initiating user request. `skippedMessages` also counts skipped blocks.
**Fix:** Identify complete turn boundaries first, sanitize second; guarantee the oldest retained item is a user/summary context; split skippedMessages vs skippedBlocks.

### F10. MEDIUM — Count all LLM-visible entries in the compaction keep window
**Reference:** `packages/agent/src/compaction/compaction.ts:632-679` (loop at 644-679).
`custom_message` and `branch_summary` entries are LLM-visible but consume no keep-window budget — compaction may preserve far more than `keepRecentTokens` and immediately re-overflow.
**Fix:** Accumulate `estimateEntryTokens(entry)` for every entry exposed by `getMessageFromEntry`, keeping pair-safe cut points.

### F11. MEDIUM — Retain tool-result tails during compaction summarization
**Reference:** `packages/agent/src/compaction/utils.ts:103-174`.
Tool results are serialized head-only at 2,000 chars — exit summaries, final errors, artifact references at the tail are lost to the summary model.
**Fix:** Tool-aware head+tail digest with explicit omitted count, preserving exit code, final error line, truncation/artifact metadata.

### F12. MEDIUM — Track modern edit surfaces in compaction file metadata
**Reference:** `packages/agent/src/compaction/utils.ts:31-69`.
Carry-forward recognizes only `read`/`write`/`edit` with `args.path`. Apply-patch envelopes, `ast_edit` result lists, hidden `resolve` applies, moves, and resolved read paths are omitted — `<modified-files>`/`<read-files>` lose the files changed via preferred edit modes.
**Fix:** Reuse pruning's richer path/result extraction; derive successful mutations from tool results, not assistant intent.

### F13. MEDIUM — Spill Search/Find output before truncating; valid continuation hints
**References:** `packages/coding-agent/src/tools/search.ts:572-602`; `packages/coding-agent/src/tools/find.ts:246-265`; `packages/coding-agent/src/tools/output-meta.ts:406-425`.
Both tools `truncateHead` before the central artifact wrapper sees the result — raw output is lost at the same 50 KB threshold the spill layer uses. Generic metadata then tells the model `Use :<line> to continue`, unsupported by these tools; single-file per-match caps have no continuation.
**Fix:** Pass raw output to the wrapper (or save first); per-tool continuation contracts (`skip`, larger/narrower `limit`, match offset).

### F14. MEDIUM — Distinguish complete artifacts from capped artifacts
**References:** `output-meta.ts:383-428`; `packages/coding-agent/src/session/artifacts.ts:103-111`; `packages/coding-agent/src/session/streaming-output.ts:22-25`, `:960-981`; `packages/coding-agent/src/internal-urls/artifact-protocol.ts:66-75`.
Notices promise "full output" while artifacts are capped at 10 MB (`artifactTruncatedBytes` dropped); the protocol materializes only the first 16 MB then advises a "narrower range" that cannot reach later bytes.
**Fix:** Carry `artifactComplete`/omitted-byte metadata into notices ("retained output" when capped); implement file-backed ranged reads before materialization, or remove the misleading range advice.

### F15. MEDIUM — Return a real error when all web-search providers fail
**Reference:** `web/search/index.ts:278-303`.
Exhausting the chain returns successful text beginning `Error:` with zero sources — loop, telemetry, renderers, retries, and subagent evidence record success.
**Fix:** Throw `ToolError` (or set `isError: true`) with per-provider diagnostics, keeping the readable aggregated message.

### F16. MEDIUM — Render a subagent-specific workflow contract
**References:** `system-prompt.md:257-275`; `packages/coding-agent/src/prompts/tools/task.md:37-43`; `packages/coding-agent/src/prompts/agents/executor.md:27-35`; `subagent-system-prompt.md:34-42`.
Children receive the base block ("use todo tracking for 3+ steps", "don't yield without focused proof") while the subagent wrapper says "No TODO tracking", `todo_write` is removed, and task/executor prompts forbid verification unless assigned — mutually exclusive same-authority rules.
**Fix:** Put decomposition/verification under `{{#unless subagent}}`; inject one authoritative child contract: no parent-owned todo, no gates unless assigned, return implementation evidence only.

### F17. MEDIUM — Phase-split the oversized workflow skills
**Reference:** `packages/coding-agent/src/extensibility/skills.ts:409-421`.
The loader injects entire SKILL manuals (sizes in the token table above). Much is command reference, state schema, failure recovery, late-phase verification irrelevant to the current phase.
**Fix:** 2–4K-token dispatcher/state-machine core + phase-specific internal fragments loaded on demand, with fragment contract tests. Start with deep-interview (largest saving), then ultragoal, team, ralplan.

### F18. LOW — Persist discovered built-in tool activation
**References:** `agent-session.ts:4433-4483`; `sdk.ts:2017-2029`.
Built-in discovery selections live only in in-memory `#selectedDiscoveredToolNames`; persistence writes only `selectedMCPToolNames`. Resumed conversations reference tools missing from the active schema.
**Fix:** Versioned persisted `selectedDiscoveredToolNames` field, restored before prompt construction; keep MCP selection separate.

### F19. LOW — Remove stale Deep Interview placeholders and role names
**References:** `packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md:38-39`, `:118`; `skills.ts:414-421`.
The loader appends arguments as a final `User:` line, but the SKILL still references literal `{{ARGUMENTS}}` and a nonexistent bundled `analyst` role (roster: executor/architect/planner/critic).
**Fix:** Reference "the final User line"; replace `analyst` with supported planner/deep-interview terminology.

### F20. MEDIUM — Gate destructive `write` operations in ACP
**References:** `agent-session.ts:773-784`, `:839-888`; `packages/coding-agent/src/tools/write.ts:388-403`; `packages/coding-agent/src/prompts/tools/write.md:8-13`.
ACP exempts `write`, but empty content on `db.sqlite:table:key` deletes a row — bypassing the delete approval applied to `delete` and edit-delete, despite the tool prompt labeling it destructive.
**Fix:** Inspect write targets in permission intent classification: route SQLite empty-content row deletes through delete permission; explicitly decide + test policy for whole-file overwrite.

## Truncation / recovery consistency matrix

| Surface | Inline | Recovery | Problem |
|---|---|---|---|
| Bash/eval/SSH | 50 KB retained view | Artifact ≤10 MB | Capped artifact still labeled "full output" |
| Read | 50 KB/range output; selectors paginate | Spill disabled by default | Mostly coherent |
| Search | `skip` pagination; 20-file + per-file caps | Head-truncated before spill | Raw text lost; invalid `:N` hint; no per-file continuation |
| Find | `limit` + 50 KB head truncation | Same pre-spill loss | Invalid `:N` hint |
| Subagent control | 280-char receipt / 2K preview / 12K full | `agent://<id>` | Good, but no-yield fallback bypasses contract |
| `artifact://` | ≤16 MB materialized | Range applied downstream | Bytes past 16 MB unreachable |

## Root Cause: contract duplication without one enforceable source of truth

1. Workflow rules/paths copied across AGENTS.md, base prompt, role prompts, SKILLs, tests, runtime constants.
2. Enforcement via tool-name allowlists instead of capability metadata.
3. Compatibility fallbacks convert violations into apparent success (no-yield subagents, fail-open planning state, error-as-success search).
4. Limits applied in several layers with different pagination semantics.
5. Retry budgets exist independently at three layers without a global ceiling.

## Executive summary

**Verdict: BLOCK.** Top three actions (owner-adjusted):
1. Capability-based, fail-closed planning guards + `<soul>` precedence resolution (keep the block).
2. Global bounded retry budget + strict `yield`/stream-finalization contracts so failures cannot loop or masquerade as success.
3. Authoritative session-scoped workflow paths, compaction retention fixes, artifact recovery honesty; phase-split SKILL prompts to reclaim ~15–20K tokens/invocation.
