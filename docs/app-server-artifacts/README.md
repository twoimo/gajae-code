# App-server planning artifacts (bundled)

Copied from the original session (`019f1c30`) so this branch is self-contained.
Pipeline: deep-interview → ralplan consensus → ultragoal execution.

## Spec (deep-interview)
- `deep-interview-spec.md` — crystallized requirements spec (13 rounds, 6% ambiguity): goal, topology, established facts, constraints, non-goals, acceptance criteria, ontology.

## Plan (ralplan consensus)
Authoritative plan = `ralplan/stage-07-revision.md` (the final revised plan body) and `ralplan/pending-approval.md` / `ralplan/stage-10-final.md` (final with ADR + Intent Reconciliation).
Consensus trail:
- `stage-01-planner.md` — initial plan + RALPLAN-DR
- `stage-02-architect.md` (WATCH/REQUEST CHANGES) → `stage-03-critic.md` (ITERATE)
- `stage-04-revision.md` — revision 4 (folds in must-fix items)
- `stage-05-architect.md` (CLEAR/APPROVE) → `stage-06-critic.md` (OKAY)
- reconciliation → `stage-07-revision.md` (revision 7: hard concurrency + lenient/strict field policy)
- `stage-08-architect.md` (CLEAR/APPROVE) → `stage-09-critic.md` (OKAY)
- `stage-10-final.md` / `pending-approval.md` — final plan (ADR + Intent Reconciliation)

## Execution (ultragoal)
- `ultragoal-brief.md` — the 10-phase brief (G001–G010).
- `ultragoal-goals.json` — story states (G001 review_blocked, G002–G011 blocked with per-story evidence).
- `ultragoal-ledger.jsonl` — full slice-by-slice audit trail (every implementation slice, the parallel executor batches, the live-turn milestones, and the migration to this worktree).

> These are point-in-time snapshots. The live ultragoal state still lives in the original repo at
> `.gjc/_session-019f1c30-3754-7000-b634-75d54f2dc70c/` if you want to `resume` there; a fresh session in
> this worktree can instead treat `../pending-approval.md` (stage-07/10) as the plan of record.
