## Preconditions

Before running `$team`, confirm:

1. `tmux` installed (`tmux -V`)
2. Current leader session is inside tmux (`$TMUX` is set)
3. `gjc` command resolves to the intended install/build
4. If running repo-local `node bin/gjc.js ...`, run `npm run build` after `src` changes
5. Check HUD pane count in the leader window and avoid duplicate `hud --watch` panes before split

Suggested preflight:

```bash
tmux list-panes -F '#{pane_id}\t#{pane_start_command}' | rg 'hud --watch' || true
```

If duplicates exist, remove extras before `gjc team` to prevent HUD ending up in worker stack.

## Pre-context Intake Gate

Before launching `gjc team`, require a grounded context snapshot:

1. Derive a task slug from the request.
2. Reuse the latest relevant snapshot in `.gjc/context/{slug}-*.md` when available.
3. If none exists, create `.gjc/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) with:
   - task statement
   - desired outcome
   - known facts/evidence
   - constraints
   - unknowns/open questions
   - likely codebase touchpoints
4. If ambiguity remains high, gather brownfield facts with focused repo inspection or a canonical read-only role agent first, then run `$deep-interview --quick <task>` before team launch.
5. If current correctness depends on official docs, version-aware framework guidance, best practices, or external dependency behavior, gather evidence before or alongside worker launch using supported surfaces only: focused repo inspection for local facts, `planner` for broad context mapping/sequencing, `architect` for architecture or external-doc-risk assessment, and direct web/search tools when configured.

Do not start the worker pane until this gate is satisfied; if forced to proceed quickly, state explicit scope/risk limitations in the launch report.

For simple read-only brownfield lookups during intake, use narrow repo inspection first; for broader mapping, delegate to `planner` or `architect` with a concrete fact-finding assignment.

## Follow-up Staffing Contract

When `$team` is used as a follow-up mode from ralplan, carry forward the approved plan's explicit **available-agent-types roster** and convert it into concrete staffing guidance before launch:

- keep worker-role choices inside the known roster
- state that GJC team launches the requested worker count and role allocation
- state the suggested reasoning level for each lane when available
- explain why each lane exists (delivery, verification, specialist support)
- include an explicit launch hint (`gjc team "<task>"` / `$team "<task>"`) for the coordinated worker run; mention `$ultragoal` as the default durable follow-up/ledger path; mention a later separate Single-owner execution follow-up only when explicitly requested or genuinely needed as a fallback
- if the ideal role is unavailable, choose the closest role from the roster and say so
- For multi-worker follow-up execution, do not pass an inline "Split lanes: A..., B..." sentence as the whole team task. `gjc team` rejects ambiguous inline lane splits because they previously caused every worker to receive the same broad task. Use explicit markdown lane sections instead:
  ```md
  ### Lane A — Delivery
  Implement delivery-only changes and evidence.

  ### Lane B — Verification
  Add focused tests and smoke evidence.
  ```
  Explicit `### Lane <id> — <title>` sections are converted into distinct worker-owned initial tasks.

