## Complete goals

Loop until `gjc ultragoal status` reports all goals complete:

1. Run `gjc ultragoal complete-goals`.
2. Read the printed handoff.
3. Call `goal({"op":"get"})`.
4. If no active GJC goal exists, call `goal({"op":"create","objective":"<printed payload objective>"})` with the printed payload. In aggregate mode, if the same aggregate objective is already active, continue the current GJC story without creating a new GJC goal. If `goal({"op":"get"})` shows a stale dropped goal (status `"dropped"`) and a new aggregate must start, no extra cleanup is needed — `goal({"op":"create"})` succeeds directly. If a previous aggregate is still active and you genuinely need a fresh start in the same session, call `goal({"op":"drop"})` first, then `goal({"op":"create"})`.
5. Complete the current GJC story only.
6. Run a completion audit against the story objective and real artifacts/tests.
7. Before any `--status complete` checkpoint, run the mandatory final cleanup/review gate below. In aggregate mode, do **not** call `goal({"op":"complete"})` for intermediate stories; checkpoint each story while the aggregate objective is still `active`. On the final story, create the final aggregate receipt first; only after that receipt exists may `goal({"op":"complete"})` run.
8. Checkpoint the durable ledger. Complete checkpoints require `--quality-gate-json` only:
   `gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --quality-gate-json <quality-gate-json-or-path>`
   A successful complete checkpoint is story completion, not automatic run completion. Read the checkpoint output: when it prints `Next ultragoal goal: <id>`, continue that active story under the same aggregate GJC goal; when it prints `All ultragoal goals are complete`, the durable run is terminal. `gjc ultragoal complete-goals` remains the supported manual next-story command if continuation output was missed.
9. If blocked or failed, checkpoint failure:
   `gjc ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
10. For legacy per-story completed-goal blockers, preserve the non-terminal blocker with:
   `gjc ultragoal checkpoint --goal-id <id> --status blocked --evidence "<completed legacy GJC goal blocks goal create in this thread>"`
11. Resume failed goals with `gjc ultragoal complete-goals --retry-failed`.

## Blocker triage and pause discipline

An active Ultragoal run must not give up on a blocker by pausing the goal and asking the user. Classify every blocker before deciding what to do, and default to `resolvable` when unsure:

- **`resolvable`** — anything the agent can act on: failing tests, missing implementation, a dependency to install, an ambiguous-but-inferable detail, investigation. **Never pause.** Exhaust autonomous resolution first: investigate, `gjc ultragoal steer --kind add_subgoal --title "Investigate blocker" --objective "..." --evidence "..." --rationale "..."`, delegate an `executor`, or preserve the blocker durably with `gjc ultragoal checkpoint --status blocked` / `gjc ultragoal record-review-blockers` and keep scheduling the next goal.
- **`human_blocked`** — only the user can act: credentials/secrets, a manual or physical step, an external approval/decision, access the agent lacks. Pause is the last resort and is gated.

`goal({"op":"pause"})` is **blocked at runtime** while an Ultragoal run is active unless the latest durable ledger event classifies the current blocker as `human_blocked`. To pause, record the classification immediately before pausing and cite the human-only dependency as evidence:

```sh
gjc ultragoal classify-blocker --classification human_blocked --evidence "<the specific human-only dependency>" [--goal-id <id>]
```

Recording `--classification resolvable` is an audit note only; it never authorizes a pause. The `ask` tool stays blocked during active runs regardless of classification — record unresolved decisions as durable blockers instead of prompting.

## Dynamic steering

Use `gjc ultragoal steer` when real findings or blockers prove the current story decomposition should change while the aggregate objective and constraints stay fixed. Steering is explicit-only and evidence-backed; broad natural-language requests are rejected instead of guessed.

Allowed mutation kinds are:

- `add_subgoal`
- `split_subgoal`
- `reorder_pending`
- `revise_pending_wording`
- `annotate_ledger`
- `mark_blocked_superseded`

Examples:

```sh
gjc ultragoal steer --kind add_subgoal --title "Investigate blocker" --objective "Validate the blocker and report evidence." --evidence "log/test output" --rationale "The blocker changes the safe execution order." --json
gjc ultragoal steer --kind split_subgoal --goal-id G002 --replacements-json '[{"title":"Fix parser","objective":"Resolve parser blocker."},{"title":"Verify parser","objective":"Run focused parser verification."}]' --evidence "Implementation split found two separable risks" --rationale "Splitting keeps each sub-goal independently verifiable." --json
gjc ultragoal steer --kind reorder_pending --order-json '["G003","G002"]' --evidence "Dependency order changed after investigation" --rationale "G003 must land before G002 can proceed safely." --json
gjc ultragoal steer --kind revise_pending_wording --goal-id G002 --title "Clarify blocker story" --evidence "The current title hides the actual blocker" --rationale "Clear wording keeps the ledger auditable." --json
gjc ultragoal steer --kind annotate_ledger --evidence "User changed release ordering at runtime" --rationale "The aggregate objective is unchanged, but the execution history needs an audit note." --json
gjc ultragoal steer --kind mark_blocked_superseded --goal-id G004 --evidence "The blocked work is no longer required because replacement evidence covers it" --rationale "No replacement sub-goal is needed; superseding only the blocked sub-goal unblocks final completion without changing the aggregate objective." --json
```

`--directive-json` and UserPromptSubmit structured steering are planned/deferred routing surfaces, not part of the native typed `--kind` CLI path described above.

Steering invariants:

- Do not edit the aggregate goal objective, original brief constraints, quality gates, or completion status. The aggregate objective is a stable pointer to `.gjc/_session-{sessionid}/ultragoal/goals.json` and `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl`, not an enumeration of initial goal ids.
- Do not hard-delete goals, auto-complete work, weaken verification, or silently mutate `.gjc/_session-{sessionid}/ultragoal`.
- Accepted and rejected attempts append structured audit entries to `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl`.
- Superseded goals remain in `goals.json` with steering metadata and are skipped for scheduling.
- Blocked goals without replacements are skipped for scheduling but still block final completion until later explicit steering replaces or supersedes them.

UserPromptSubmit structured steering directives are a planned/deferred routing surface. Normal prose does not mutate state.

## Role-agent delegation guidance

Ultragoal execution should use GJC's bundled role-agent roster when a durable story is large enough to benefit from delegation:

- Use `executor` for bounded implementation, refactoring, and fix slices.
- Use `planner` for story sequencing or handoff refinement when execution uncovers a missing plan branch.
- Use `architect` for read-only architecture and code-review lanes, including `CLEAR` / `WATCH` / `BLOCK` status.
- Use `critic` for read-only plan or handoff critique before execution proceeds.

### Mandatory implementation delegation on big scope

When a story's implementation scope is **big enough**, the Ultragoal leader MUST delegate the implementation to one or more `executor` subagents instead of writing the code inline itself. This is a hard requirement, not a preference: solo inline implementation of a big-scope story is a gate violation, and the completion cleanup/review gate must treat missing delegation on a big-scope story as a blocker.

A story's implementation scope is **big enough** to force delegation when any of the following hold:

- It spans **3+ files** or **2+ cleanly separable surfaces/modules** that can be implemented against bounded, independent acceptance criteria.
- It is estimated at **~200+ lines of net implementation change**, or is otherwise large enough that a single inline pass would crowd out the leader's checkpoint/verification duties.
- It decomposes into **independent slices** that can proceed in parallel without shared-file contention.
- The leader has already made **2+ inline edit passes** on the same story and implementation is still materially incomplete.

Forced-delegation rules:

- Split the story into cleanly separable slices, give each `executor` bounded targets and explicit acceptance criteria, and keep checkpoint/goal-state ownership in the leader.
- Prefer **parallel** `executor` subagents for independent slices; sequence only slices with a real dependency.
- If a big-scope story cannot be cleanly split, record the reason as a durable ledger note and delegate the whole implementation to a single `executor` rather than doing it inline; the leader still owns verification.
- Small, atomic, single-file changes below these thresholds stay with the leader — do not over-delegate trivial work.
- After integrating delegated slices, run `architect` / `critic` review lanes; worker agents never mutate `.gjc/_session-{sessionid}/ultragoal` or call goal tools.

When delegating with native subagents, an await timeout only limits the leader's wait. It is not subagent failure evidence and must not be used as a cancellation reason; inspect or continue independent work, and cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong.

If an Ultragoal request has no approved plan or consensus artifact, run `ralplan` first and preserve its PRD, test spec, role roster, and verification guidance in the Ultragoal ledger. Do not silently substitute ad-hoc execution for missing planning.

The Ultragoal leader owns `.gjc/_session-{sessionid}/ultragoal/goals.json` and `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl`. Role agents return implementation/review evidence; they do not checkpoint Ultragoal or mutate goal state.

### Native executor parallelism contract

Native subagent parallelism is a contract for bounded `executor` delegation, not a runtime scheduler and not a Team-mode rule:

- **MUST use native `executor` parallelism** when a story meets the big-scope delegation threshold above and decomposes into independent implementation slices that can be bounded by per-slice coordination contracts.
- **SHOULD prefer parallel `executor` subagents** for independent files/surfaces, and sequence only real dependencies, unsafe shared-file overlap, sub-threshold trivial work, or work that lacks a safe contract.
- Worker agents **MUST NOT mutate `.gjc/_session-{sessionid}/ultragoal`**, call goal tools, make checkpoint decisions, own integration, or own final verification. The Ultragoal leader keeps those responsibilities.

Before workers start, each per-slice coordination contract MUST name the target files/surfaces, independence assumptions, allowed coordination channel, conflict-escalation rule, expected evidence, and terminal status. Conflict or assignment changes remain leader-owned and must be auditable through durable ledger evidence.

For failed, timed-out, or contract-violating slices, record durable ledger evidence; preserve successful terminal slices only when safe; and reassign, retry, or collapse the invalid work to serial execution under an updated contract. Completion after parallel work still requires terminal worker evidence, leader integration, targeted verification, and the existing cleaner + architect + executor QA/red-team gate before checkpoint complete.

### Runtime-backed pipelined scheduling

Sequential execution remains the default. Ultragoal may use runtime-backed pipelined scheduling only when `goals.json` metadata proves original-plan independence and disjoint target files/surfaces for the prior and next goals. This is a leader-owned Ultragoal runtime contract, not hidden Team scheduling and not a substitute for the native executor parallelism contract above.

Pipeline metadata is explicit-only: create eligible goals with `gjc ultragoal create-goals --goal-metadata-json '<json>'` or the equivalent runtime `createUltragoalPlan({ goalMetadata })` input. Brief-only or missing metadata remains valid but non-eligible and falls back to ordinary sequential scheduling. The initial pipeline contract is **aggregate mode only**; per-story mode remains sequential until a separate UX/state contract exists.

The full lifecycle commands (`start-pipeline-overlap`, `join-pipeline-overlap`, `rebaseline-pipeline-overlap`) and the fail-closed overlap rules — at most one eligible next goal per join window, G(N) remains active until a clean join, quarantine and re-baseline on dirty joins or lost handles, complete checkpoints fail closed on open overlaps or unattributable change-set paths — are specified in the internal `pipeline-validation-contracts` fragment (`skill-fragments/ultragoal/pipeline-validation-contracts.md`). Load that fragment before operating an overlap; the runtime enforces its rules verbatim.

Team remains explicit and separate: Team is not auto-launched, not a hidden pipeline scheduler, and never owns Ultragoal goals, checkpoints, or ledger state.

