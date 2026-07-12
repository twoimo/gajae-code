
- Worktree provisioning requires a git repository and can fail on branch/path collisions
- send-keys interactions can be timing-sensitive under load
- stale panes from prior runs can interfere until manually cleaned

## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.

## Handoff back to planning or persistence

When the team task-set completes OR the user requests return to planning/persistence, mark team ready for handoff so the skill tool's chain guard permits the transition:

```
gjc state team write --input '{"current_phase":"handoff"}' --json
```

The skill tool then dispatches `/skill:ralplan`, `/skill:deep-interview`, or `/skill:ultragoal` same-turn and runs `gjc state team handoff --to <ralplan|deep-interview|ultragoal> --json` in-process to atomically demote team, promote the callee, and sync both `.gjc/_session-{sessionid}/state/skill-active-state.json` files. You do not need to run the handoff verb yourself.
