      - If open items exist, confirm the open assumptions and conflicts **one at a time** with the `ask` tool, weakest/highest-impact first, polishing intent. If any confirmation reveals that the plan diverges from user intent, route the consolidated correction back into the re-review loop (step 5b Planner revision) and re-run Architect + Critic before returning here. Cap at the same 5-iteration ceiling.
      - If the plan is crystal clear (no open assumptions or prior-context conflicts), skip straight to the step 8 final-options `ask` instead of inventing filler questions.
      - For every confirmed open item, embed the resolved outcome into the final plan under an **## Intent Reconciliation** section so the `pending approval` artifact records each decision; record any item the user explicitly defers as an open confirmation under that same section.
   d. Persist the reconciliation with `gjc ralplan --write --stage post-interview --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`, then return the receipt/path plus a compact status (reconciled-clean / reconciled-with-revision / open-confirmations-pending) instead of pasting the full body.
7. On reconciliation completion, re-check the review join gate (Critic `OKAY` plus Architect `CLEAR`/`APPROVE` for the same Planner artifact/pass), mark the plan `pending approval` unless explicit execution approval has already been captured, persist the ADR/final plan via `gjc ralplan --write --stage final --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT`, and do not directly edit `.gjc/_session-{sessionid}/plans`. Final plan must include ADR (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups) and, when present, the **## Intent Reconciliation** section.
8. **Always** present the finalized plan via the `ask` tool (regardless of `--interactive`) with `workflowGate: { stage: "ralplan", kind: "approval" }` on the final question so RPC/headless clients receive a `ralplan`/`approval` workflow gate, not a deep-interview question gate. Use these options:
   - **Refine further** — re-run the consensus loop / request changes, then return here
   - **Approve execution via ultragoal (Recommended)** — goal-tracked autonomous execution
   - **Approve execution via team** — only when tmux-based interactive worker parallelization is required
   - **Stop here** — keep the plan as `pending approval` and make no further changes

   Always include a free-text option. Do not stop with plain text and no `ask`; the post-interview gate's terminal action is this `ask`.
9. On approval: invoke `/skill:ultragoal` for execution by default; invoke `/skill:team` only when the user explicitly needs tmux-based interactive worker parallelization. On **Refine further**, return to the step 5 re-review loop. On **Stop here**, leave the `pending approval` artifact and stop. Never implement directly.

   Before invoking `/skill:team` or `/skill:ultragoal`, mark ralplan ready for handoff so the skill tool's chain guard permits the transition:

