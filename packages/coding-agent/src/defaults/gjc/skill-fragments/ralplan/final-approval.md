### Persisted Planner (consensus loop)

The Planner is a **same-session persisted subagent**: launched detached once, awaited before review fan-out, then **resumed** with consolidated Architect + Critic challenge and enrichment on each re-review pass. Architect and Critic are fresh independent spawns each pass; Critic may run in parallel only when plan-only and tied to the same Planner receipt/path/sha/stage_n. Do NOT modify the subagent control surface; use existing `subagent` resume/steer controls only.

**Persistence boundary:** same-parent, active-session continuity only. Resumability requires retained subagent resume metadata and a persistent parent session (in-memory parent yields `resumable:false`), not just `.gjc` run-state. A terminal subagent can still resume when its retained descriptor points at a saved subagent session; after process restart, missing metadata, or failed/unavailable resume, use fresh Planner fallback.

**Resume routing table** (per re-review pass, when resuming the persisted Planner id):

| Resume outcome | Action |
|---|---|
| `running` | `steer`/inject the consolidated feedback to the same id, then await — do NOT fresh-spawn |
| `queued` | retain/update the queued message or await the same id — do NOT fresh-spawn just because it is queued |
| `context_unavailable`, `not_found`, `no_runner`, `resume_failed` | fresh Planner spawn for that pass; record the fallback metadata. `not_found` should only mean same-session resume metadata is unavailable, not merely that a terminal live job was evicted. |
| terminal (`completed`/`failed`/`cancelled`) + revision message | resume the same id when context is available; otherwise use the fresh fallback above |

**Recording persisted-Planner metadata** (audit/routing only — never claim `subagent list` proves resumability, since the snapshot does not expose `resumable`). Ride these optional flags on the normal `--write` for the planner/revision stage of the pass:

```
gjc ralplan --write --stage revision --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT \
  --planner-id <id> --planner-resumable <true|false> \
  --fallback-reason <context_unavailable|not_found|no_runner|resume_failed|process_restart|missing_record> \
  --fallback-attempted-id <id> --fallback-stage-n <N> \
  --fallback-receipt-path <fresh-planner-stage-artifact-path> --json
```

Set `--planner-resumable true` only when the parent session is provably persistent; set/record `false` after an observed `context_unavailable`; otherwise omit it (unknown). Fallback flags are recorded only when a fresh-spawn fallback actually occurs: a fallback record requires `--fallback-reason` **together with** `--fallback-attempted-id` and `--fallback-stage-n` (the failed id and the pass it failed on), while `--fallback-receipt-path` (the fresh Planner's stage artifact) is optional.

