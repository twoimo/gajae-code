## Current Runtime Behavior (As Implemented)

`gjc team` currently performs:

1. Parse args (`N`, `agent-type`, task), default to 3 workers, and cap workers at 20.
2. Non-dry-run: detect the current tmux leader context with `display-message -p "#S:#I #{pane_id}"` before creating state or worktrees.
3. Initialize team state:
   - `.gjc/_session-{sessionid}/state/team/<team>/config.json`
   - `.gjc/_session-{sessionid}/state/team/<team>/manifest.v2.json`
   - `.gjc/_session-{sessionid}/state/team/<team>/tasks/task-*.json` (one per explicit lane section, otherwise one worker-owned compatibility task per worker)
   - `.gjc/_session-{sessionid}/state/team/<team>/mailbox/worker-1.json`
   - `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/status.json`
   - `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/lifecycle.json`
   - `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/heartbeat.json`
4. Resolve the worker command from `GJC_TEAM_WORKER_COMMAND` or the active `gjc` entrypoint.
5. Split the current tmux window like GJC team: worker 1 is split horizontally to the right of the leader, workers 2..N are vertically stacked in the right column, then `select-layout main-vertical` and `main-pane-width` keep leader-left/worker-right at roughly 50/50.
6. Launch the worker with:
   - `GJC_TEAM_NAME=<team>`
   - `GJC_TEAM_WORKER_ID=worker-1`
   - `GJC_TEAM_STATE_ROOT=<leader-cwd>/.gjc/_session-{sessionid}/state/team`
   - optional `GJC_TEAM_WORKTREE_PATH=<path>` when worktree mode is active
7. Automatically integrate worker worktree commits during leader monitoring:
   - dirty worker worktrees are auto-checkpointed before integration
   - clean-ahead worker history is merged into the leader with a runtime merge commit
   - diverged worker history is cherry-picked into the leader
   - idle/done/failed worker worktrees are cross-rebased onto the updated leader after integration; working workers are skipped
   - conflicts are aborted, recorded, and reported to the leader mailbox without falsely advancing `last_integrated_head`
8. Store pane/target/integration/lifecycle evidence in config/manifest/snapshot: `tmux_session`, `tmux_session_name`, `tmux_target`, leader pane id, worker pane ids, `worker_lifecycle_by_id`, and `integration_by_worker`.
9. Return control to the leader; follow-up uses `status`, `resume`, `shutdown`, and `gjc team api`.

Important:

- Leader remains in the existing left pane.
- Worker panes are independent full GJC worker CLI sessions on the right side of a leader-left/worker-right split.
- Worker CLI selection is teammate-only: `GJC_TEAM_WORKER_CLI` and `GJC_TEAM_WORKER_CLI_MAP` accept only `auto` or `gjc`; legacy/provider values such as `codex`, `claude`, or `gemini` are rejected before launch.
- The worker may run in a dedicated git worktree (`gjc team --worktree[=<name>]`) while sharing the team state root.
- `shutdown` kills only the recorded worker pane after confirming it still belongs to the stored tmux target and is not the leader pane. It never kills the tmux session.

