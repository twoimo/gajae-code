The native `checkpoint --status complete` command rejects missing or shallow gates. `--quality-gate-json` must include:

```json
{
  "architectReview": {
    "architectureStatus": "CLEAR",
    "productStatus": "CLEAR",
    "codeStatus": "CLEAR",
    "recommendation": "APPROVE",
    "evidence": "architect review synthesis across architecture/product/code",
    "commands": ["architect review command or agent evidence id"],
    "blockers": []
  },
  "executorQa": {
    "status": "passed",
    "e2eStatus": "passed",
    "redTeamStatus": "passed",
    "evidence": "executor-built e2e and red-team QA commands/results",
    "e2eCommands": ["bun test:e2e"],
    "redTeamCommands": ["bun test:red-team"],
    "artifactRefs": [
      { "id": "<ref-id>", "kind": "<surface-appropriate kind; see step 6>", "path": "artifacts/<file>", "description": "live-surface evidence" }
    ],
    "contractCoverage": [
      { "id": "<id>", "contractRef": "<approved contract id>", "obligation": "<required behavior>", "status": "covered", "surfaceEvidenceRefs": ["<surface-id>"], "adversarialCaseRefs": ["<case-id>"] }
    ],
    "surfaceEvidence": [
      { "id": "<surface-id>", "contractRef": "<surface under test>", "surface": "gui|web|cli|api|package|algorithm|math|native|desktop|tui", "invocation": "<real invocation>", "verdict": "passed", "artifactRefs": ["<ref-id>"] }
    ],
    "adversarialCases": [
      { "id": "<case-id>", "contractRef": "<approved contract id>", "scenario": "<boundary/adversarial input>", "expectedBehavior": "<required handling>", "verdict": "passed", "artifactRefs": ["<ref-id>"] }
    ],
    "blockers": []
  },
  "iteration": {
    "status": "passed",
    "evidence": "blockers absent or resolved and the full loop was rerun cleanly",
    "fullRerun": true,
    "rerunCommands": ["bun test:e2e", "bun test:red-team"],
    "blockers": []
  }
}
```

Provide one `artifactRefs` entry per live surface actually exercised, using the surface-appropriate `kind` and evidence rules from steps 6–7 above; the CLI rejects missing or shallow gates. `status: "not_applicable"` rows are allowed only in `contractCoverage` and `surfaceEvidence` and each requires `contractRef` plus `reason`.

For CLI replay artifacts, the JSON at `path` must be an object like `{"schemaVersion":1,"kind":"cli-replay","replaySafe":true,"command":["bun","-e","console.log(\"ultragoal-cli-ok\")"],"cwd":".","env":{"LC_ALL":"C"},"timeoutMs":30000,"expectedExitCode":0,"recordedStdout":"ultragoal-cli-ok\n","recordedStderr":"","invariants":[{"type":"substring","value":"ultragoal-cli-ok"},{"type":"not-substring","value":"error"}]}`. Accepted replay fields are `command` (string array), optional `cwd`, safe `env`, `timeoutMs`, `expectedExitCode`, `recordedStdout`, `recordedStderr`, `normalization`, and `invariants`. The conservative command allowlist is intentionally small: `bun --version`, `node --version`, deterministic `bun/node -e "console.log(...)"`, `npm|pnpm|yarn --version`, `npm|pnpm|yarn list`, read-only `git status|rev-parse|merge-base|diff|show|log` with safe args, and `gjc read|status`. `env` must contain only safe deterministic variables, never credentials or machine/user-specific secrets. `normalization` is optional and, when provided, must be exactly the string `"default"` (the built-in normalizer already strips ANSI codes, normalizes line endings, scrubs paths, and trims trailing whitespace); object-shaped normalization is rejected. Invariants may be substring, regex, or not-substring checks; when present, they replace exact `recordedStdout` equality — without `invariants`, replayed normalized stdout must match `recordedStdout` exactly. Unsafe, non-deterministic, credentialed, interactive, or otherwise unallowlisted commands require audited `replayExempt` metadata with exact fields `reasonCode`, `reason`, `approvedBy`, and `fallbackArtifactRefs` plus a structurally valid same-surface fallback artifact. `reason` must be substantive and audited, and `approvedBy` must identify the verifier. Allowed `reasonCode` values are exactly `unsafe_side_effect`, `requires_credentials`, `requires_network`, `non_deterministic_external`, `destructive`, `interactive_only`, and `platform_unavailable`.

## Review mode

`gjc ultragoal review` runs the same hardened gate against an already implemented PR, branch, or worktree. Use `--pr <number>` for a PR, `--branch <ref>` for a branch diff, omit both for the current worktree, and pass `--spec <path>` when a real contract exists. `--mode review-only` emits the verdict/findings without creating fix work; `--mode review-start` records review blockers for follow-up. Review mode validates the same `executorQa` shape and live-surface artifacts as `checkpoint --status complete`. A thin or derived-only contract can never clean-pass: the verdict is capped at `inconclusive: weak-contract` until a supplied spec or equivalent strong acceptance criteria are available.

Receipts are freshness-scoped:
- Per-goal receipts remain fresh for their target goal unless that goal, its blocker metadata, or its supersession metadata changes.
- Normal later `goal_started` or clean receipt-backed `goal_checkpointed` events for other goals do not stale older per-goal receipts.
- Appending required goals or changing final required-goal state stales final aggregate receipts. Final aggregate completion requires a fresh final aggregate receipt proving no incomplete, blocked, or `review_blocked` required goals remain.
- Deferred per-goal receipts (validation-batch members) are incomplete until a matching fresh batch-close receipt exists on the batch's `finalGoalId`; a story-scope query for a deferred member stays blocked until that close, and mutating a member after close stales the batch-close and final aggregate receipts.

