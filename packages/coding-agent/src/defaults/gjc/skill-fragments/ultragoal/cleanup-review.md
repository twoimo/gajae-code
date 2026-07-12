## Validation batches (aggregate-only)

Validation batches let several aggregate-mode goals that share one review/QA boundary defer their heavyweight architect + executor QA/red-team review to a single **final member**, while each non-final member still proves targeted verification and cleanup. Validation batches are **aggregate-only**, **explicit-only**, and **fail-closed**. They are created only through `--validation-batch-json`; there is no inference from brief prose and no per-story batching.

Batches and #1701 pipeline metadata/overlap are **mutually exclusive**: `--validation-batch-json` and `--goal-metadata-json` cannot be combined, and a goal may not carry both `validationBatch` and eligible `pipelineMetadata`. There is no batch/pipeline mixing.

Create a batch explicitly:

```sh
gjc ultragoal create-goals --brief-file <path> --validation-batch-json '[{"schemaVersion":1,"batchId":"VB001","memberIds":["G001","G002","G003"],"finalGoalId":"G003"}]'
```

Checkpoint contract summary — the full contract lives in the `pipeline-validation-contracts` fragment (`skill-fragments/ultragoal/pipeline-validation-contracts.md`); load it before checkpointing any batch member:

- **Non-final members** checkpoint `complete` with a single top-level `deferredToBatch` quality gate (kind `validation-batch-deferred`) proving targeted verification, an ai-slop-cleaner pass, a rerun iteration, and a cumulative-since-base change set — never `architectReview`, `executorQa`, or `validationBatchClose`; deferring never manufactures fake review approvals.
- **The final member** (`finalGoalId`) checkpoints `complete` with the normal full strict gate PLUS a top-level `validationBatchClose` proof covering all members; out-of-order close is rejected, close state is append-only proof on the final member only, and batch invalidation is fail-closed.

### Intra-goal validation-lane parallelism

Within a single goal (including a single-goal run or one validation-batch member), architect review and the executor QA/red-team lane MAY run in parallel, but only on the same **frozen post-cleaner change set**: run the ai-slop-cleaner to a zero-blocker pass and rerun verification first, then hand both lanes the identical frozen change-set summary. Parallel architect + executor QA/red-team lanes must **join before checkpoint** — neither lane may checkpoint independently. Fall back to **sequential** lanes when code is still changing, when the two lanes would see divergent snapshots, when the red-team lane depends on architect fixes, or when architect findings gate the QA scope.

## Use Ultragoal and Team together

Use ultragoal and team together for a durable Ultragoal story that benefits from one visible tmux worker session. Ultragoal remains leader-owned: `.gjc/_session-{sessionid}/ultragoal/goals.json` stores the story plan and `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl` stores checkpoints. Team is the single-worker tmux execution engine and returns task/evidence status to the leader.

The leader checkpoints Ultragoal from Team evidence plus the current-session GJC goal snapshot; durable state remains leader-owned in `goals.json` and `ledger.jsonl`:

```sh
gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .gjc/_session-{sessionid}/ultragoal and <id>>" --quality-gate-json <quality-gate-json-or-path>
```

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Workers must not run `gjc ultragoal checkpoint`; checkpoint authority stays with the leader after worker tasks are terminal. Team launch remains explicit; Ultragoal does not auto-launch Team and performs no hidden goal mutation.

## Internal Ultragoal sub-skill fragments

The completion-gate cleanup sweep is driven by `ai-slop-cleaner`, an internal Ultragoal sub-skill bundled as a `kind: "skill-fragment"` prompt with parent skill `ultragoal` (installed at `skill-fragments/ultragoal/ai-slop-cleaner.md`). It is analogous to deep-interview's auto-research fragment: loaded on demand for one specific hook, never a user-facing skill.

- It is not slash-command discoverable, has no public skill-listing entry, and is never resolvable through `skill://`.
- It is a read-only detector+reporter over the active story's changed files only: it never edits code, writes files, mutates `.gjc/`, checkpoints, calls goal tools, or spawns workflows.
- It classifies every finding as blocking or advisory across the full taxonomy (fallback-like masking vs. grounded, duplication, dead code, needless abstraction, boundary violations, UI/design slop, missing tests).
- The leader and a leader-spawned `executor` own all fixes; the cleaner reruns until zero blocking findings remain. Advisory findings live in the gate report only.
- Recursion guard: it must not spawn nested `ralplan`/`team`/`deep-interview`/`ultragoal`; broad or architectural findings are handed back to the leader as review blockers.

## Mandatory completion cleanup and review gate

An ultragoal story cannot be checkpointed `complete` until the active agent has run the quality gate. The gate is plan-first, contract-driven, and surface-based:

1. Run targeted implementation verification for the story.
2. Run the internal ai-slop-cleaner skill fragment as the cleanup sweep on the story's changed files only, so only clean code reaches the review and red-team lanes. It is a read-only detector that emits an `AI SLOP CLEANUP REPORT`; if there are no relevant edits it still runs and records a passed/no-op report. Every BLOCKING cleaner finding is a completion blocker: the leader spawns an `executor` to fix blocking findings only, then reruns the cleaner until blocking findings are zero. Advisory findings are included in the gate report only and are not written to the Ultragoal ledger. Carry the report through the existing `qualityGate.iteration.evidence` field; do not add a new top-level quality-gate key.
3. Rerun verification after the cleaner pass so reviewed evidence covers the cleaned code.
4. Delegate an `architect` review covering all three lanes:
   - architecture-side: system boundaries, layering, data/control flow, operational risks.
   - product-side: user-visible behavior, acceptance criteria, edge cases, regressions.
   - code-side: maintainability, tests, integration points, and unsafe shortcuts.
5. Delegate an `executor` QA/red-team lane to build and run the e2e/read-teaming QA suite appropriate for the story. This lane must try to break the change, not just confirm the happy path. It must start from the approved plan/spec/acceptance criteria, then user-facing contracts, and only then implementation code as supporting evidence. Plan/code mismatches are blockers, not items to paper over with implementation intent.
6. The executor QA/red-team lane must prove evidence by the real surface under test:
   - GUI/web surfaces require a valid automation transcript plus a non-uniform screenshot. Bare `inlineEvidence` text or typed receipts never prove live GUI/web execution.
   - CLI surfaces require runtime argv replay: `schemaVersion: 1`, `kind: "cli-replay"`, `replaySafe: true`, an allowlisted argv `command`, and replayed output validation. The complete field-by-field replay schema, command allowlist, and `replayExempt` audit contract are specified once in the "For CLI replay artifacts" paragraph below the quality-gate JSON; follow it exactly.
   - Native/desktop/tui surfaces require a structurally valid screenshot, PTY capture with terminal control codes, or app-automation transcript.
   - API/package surfaces require a real artifact file or typed receipt whose artifact `kind` contains one of `api`, `package`, `consumer`, `black-box`, or `test-report`; examples: `api-package-test-report`, `package-consumer-report`, `black-box-api-receipt`. Algorithm/math surfaces require a real artifact file or typed receipt whose artifact `kind` contains one of `property`, `boundary`, `edge`, `adversarial`, `failure`, `math`, `algorithm`, or `test-report`; examples: `property-test-report`, `algorithm-boundary-report`. Bare `inlineEvidence` text alone is not sufficient for any surface.
   - The mandatory **computer-use** red-team suite (`kill-switch-bypass`, `suspended-enforcement`, `permission-revoked`, …) is conditional, not universal: require it only when computer/desktop control is genuinely part of the product surface being dogfooded. For every other product type, prove the change through the matching live surface instead — browser-use automation for web/GUI, bash/CLI live invocation or argv replay for CLI, and real artifacts or typed receipts for API/package/algorithm/math. Editing docs, prompts, or skills that merely mention computer-use does not by itself make the computer-use suite applicable; pick the red-team surface that matches what the change actually ships.
7. The executor QA/red-team lane must report a matrix using `executorQa.contractCoverage`, `executorQa.surfaceEvidence`, `executorQa.adversarialCases`, and `executorQa.artifactRefs`. Not-applicable rows are allowed only in `contractCoverage` and `surfaceEvidence`; each `status: "not_applicable"` row requires `contractRef` plus `reason`. `adversarialCases` rows cannot be not-applicable.
8. Run a final code review pass and fold it into the strict quality gate. Clean means `architectReview.architectureStatus`, `architectReview.productStatus`, and `architectReview.codeStatus` are all `"CLEAR"`, `architectReview.recommendation` is `"APPROVE"`, executor QA statuses are `"passed"`, iteration is `"passed"` with `fullRerun: true`, every evidence field is non-empty, every required matrix row is present, and every blockers array is empty. `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, missing evidence, missing or shallow matrix rows, plan/code mismatches, or non-empty blockers are non-clean.
9. If any lane finds an issue, do **not** checkpoint `complete` and do **not** call `goal({"op":"complete"})`. Record durable blocker work instead:
   ```sh
   gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve verification blockers" --objective "<blocker-resolution objective>" --evidence "<architect/executor findings>"
   ```
10. Complete or steer through the blocker story, then rerun the full blocking verification loop. Repeat until all verifier lanes are clean.
11. Only after the loop is clean, checkpoint the story as complete with a structured quality gate. The checkpoint creates a receipt in `ledger.jsonl`; `goals.json.status` alone is not proof. In aggregate mode, the final aggregate receipt must exist before the agent calls `goal({"op":"complete"})` to reconcile the inline UX goal state.

While an Ultragoal run is active, the `ask` tool is blocked for all agents. Record unresolved review decisions as durable blockers with `gjc ultragoal record-review-blockers` instead of prompting interactively.

