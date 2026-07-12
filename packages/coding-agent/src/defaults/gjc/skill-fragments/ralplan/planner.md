
Ralplan is planning only. It may inspect context and draft plan/spec/proposal artifacts, but those remain `pending approval` until explicit current-turn or structured-UI execution approval. Before that approval, do not mutate product source, run mutation-oriented shell, commit, push, open PRs, invoke execution skills, or delegate implementation.

For corrupt, tampered, unreadable, or stale current-session ralplan state, run `gjc state clear --force --mode ralplan` scoped by `--session-id`, command payload, or `GJC_SESSION_ID`; it clears only ralplan state for that session.

Persist planning artifacts and handoffs through the ralplan CLI writer, never direct `.gjc/` edits:
Direct `write`, `edit`, or `ast_edit` calls against `.gjc/_session-{sessionid}/specs`, `.gjc/_session-{sessionid}/plans`, `.gjc/_session-{sessionid}/state`, or any other `.gjc/` path are forbidden unless an explicit force override is active.

```bash
gjc ralplan --write --stage <type> --stage_n <N> --artifact "markdown file path or markdown string"
# restricted role agents use:
gjc ralplan --write --stage <type> --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT
```

Use stages `planner`, `architect`, `critic`, `revision`, `post-interview`, `adr`, or `final`; increment `--stage_n` each consensus pass. The writer accepts inline markdown, an artifact path prepared outside `.gjc/`, or `--artifact-env GJC_RALPLAN_ARTIFACT`, persists `stage-<NN>-<stage>.md` plus `index.jsonl` under `.gjc/_session-{sessionid}/plans/ralplan/<run-id>/`, and copies `final` to `pending-approval.md`. Ralplan mutation blocking is enforced in code; use temp directories (`os.tmpdir()`/`$TMPDIR`, `/tmp`, `/var/tmp`) only for oversized scratch artifacts, never the repo or `.gjc/`.

Restricted read-only role agents (`planner`, `architect`, `critic`) must pass markdown through `GJC_RALPLAN_ARTIFACT` with `--artifact-env GJC_RALPLAN_ARTIFACT`; their restricted bash environment disables artifact file-path ingestion.

RECEIPT-ONLY guideline: role agents (`planner`, `architect`, and `critic`) persist durable outputs via `gjc ralplan --write` and return ONLY the receipt fields (`run_id`, `path`, `sha256`) plus verdict/status routing fields; include `stage` and `stage_n` when available, and never return the full persisted body.

This skill runs GJC planning in consensus mode for the provided arguments.

The consensus workflow:
