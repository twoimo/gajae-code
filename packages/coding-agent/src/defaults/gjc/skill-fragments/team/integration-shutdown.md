## Ultragoal bridge ownership

Workers provide task status and verification evidence only. They do not own Ultragoal goal state, create worker ledgers, mutate `.gjc/_session-{sessionid}/ultragoal`, auto-launch Team from Ultragoal, or perform hidden GJC goal mutation. Workers must not run `gjc ultragoal checkpoint`; checkpoint authority stays with the leader after worker tasks are terminal. Ultragoal does not auto-launch Team and performs no hidden goal mutation. The leader uses terminal Team evidence plus the current-session active GJC goal snapshot and strict quality gate for the durable Ultragoal completion record.
## Environment Knobs

Useful runtime env vars:

- `GJC_TMUX_COMMAND` / `GJC_TEAM_TMUX_COMMAND`
  - tmux binary/name override (default `tmux` on POSIX, `psmux` / `pmux` / `tmux` on native Windows when one of those resolves on PATH). `GJC_TMUX_COMMAND` applies to every GJC tmux flow; `GJC_TEAM_TMUX_COMMAND` is honored as an alias by the team path. Both resolve through the same resolver, so the team leader and `gjc session ...` always target the same multiplexer. These values are executable path/name overrides, not shell command lines; do not include flags such as `psmux -L <namespace>` in the env var.
  - Native Windows psmux support: psmux is the supported tmux-compatible multiplexer for native Windows `gjc --tmux`, `gjc session`, and `gjc team`. Psmux can be exposed as `psmux.exe` or as its `tmux.exe`/`pmux.exe` aliases. GJC probes `psmux` / `pmux` / `tmux` on Windows PATH, picks the first that resolves, and treats that binary as the multiplexer. Worker commands on Windows are emitted with PowerShell-safe `$env:VAR = 'value';` assignments so psmux's ConPTY panes inherit `GJC_TEAM_*` correctly.
  - Multiplexer detection knobs (Windows): `GJC_PSMUX_COMMAND` forces a wrapper to be treated as psmux, `GJC_PSMUX_DETECTION=off` skips detection, `GJC_PSMUX_FORCE_DETECT=1` re-probes every call. The mouse / set-clipboard / mode-style UX profile is filtered out for psmux; the `@gjc-profile` ownership tag and branch / project / session identity markers still round-trip and are required for `gjc session` and `gjc team`.
  - Windows psmux namespace boundary: psmux `-c <path>` cwd/start-directory flags do not isolate the server namespace; psmux uses the tmux-compatible global `-L <namespace>` flag for isolated server instances. GJC does not currently expose structured runtime `-L` support, because launch, `gjc session`, and `gjc team` must all carry the same namespace prefix together. If you need isolated psmux servers, start `psmux -L <namespace>` yourself before `gjc --tmux` and let GJC attach to it; do not pass `-L` through `GJC_TMUX_COMMAND`.
- `GJC_TEAM_WORKER_COMMAND`
  - worker command override (default resolves to active GJC entrypoint or `gjc`)
- `GJC_TEAM_STATE_ROOT`
  - team state root override (default `<cwd>/.gjc/_session-{sessionid}/state/team`)

## Failure Modes and Diagnosis

Operator note (important for GJC panes):
- Manual Enter injection (`tmux send-keys ... C-m`) can appear to "do nothing" when a worker is actively processing; Enter may be queued by the pane/task flow.
- This is not necessarily a runtime bug. Confirm worker/team state before diagnosing worker failure.
- Avoid repeated blind Enter spam; it can create noisy duplicate submits once the pane becomes idle.

### Common failures

- **Outside tmux:** non-dry-run launch fails before team state or worktrees are created. Start `gjc team` from an attached tmux leader pane.
- **Split failure:** startup records a failed phase if state was already initialized, rolls back created worktrees, and never kills the leader tmux session.
- **Worker API ENOENT:** team state is missing or `GJC_TEAM_STATE_ROOT` points somewhere else. Check `.gjc/_session-{sessionid}/state/team/<team>/` before assuming worker failure.
- **Stale pane on shutdown:** shutdown only kills a recorded worker pane when it still belongs to the stored `tmux_target` and is not the leader pane. Stale panes outside that target require manual inspection.
- **Integration conflict:** `gjc team monitor <team>` / `resume` aborts the failing merge, cherry-pick, or worker rebase; `gjc team status <team>` is read-only inspection. Inspect `.gjc/_session-{sessionid}/state/team/<team>/integration-report.md`, `.gjc/_session-{sessionid}/state/team/<team>/events.jsonl`, `.gjc/_session-{sessionid}/state/team/<team>/mailbox/leader-fixed.json`, and `.gjc/_session-{sessionid}/reports/team-commit-hygiene/<team>.ledger.json`.

### Safe Manual Intervention (last resort)

Use only after checking `gjc team status <team>` and state evidence:

1. Inspect team files:
   - `.gjc/_session-{sessionid}/state/team/<team>/config.json`
   - `.gjc/_session-{sessionid}/state/team/<team>/tasks/task-1.json`
   - `.gjc/_session-{sessionid}/state/team/<team>/mailbox/worker-1.json`
2. Use supported team surfaces before manual pane intervention:
   - `gjc team status <team>` for current recorded state
   - `gjc team monitor <team>` when a live monitor/update loop is needed
   - `gjc team api <team>` only for documented programmatic operations
3. If the recorded worker pane is stuck in an interactive state, safely return to idle prompt first:
   - optional interrupt `C-c` or escape flow (CLI-specific) once, then re-check `gjc team status <team>` and relevant state files
4. Send one concise trigger only when runtime/state checks show manual prompt input is needed:
   - `tmux send-keys -t %<worker-pane> "continue current task; report status" C-m`
5. Re-check task state, worker mailbox, and `gjc team status <team>`.

### Shutdown reports success but stale worker panes remain

Cause:
- The stale pane was not the recorded worker pane, no longer belonged to the stored `tmux_target`, or came from a previous failed run.

Fix:
- Manually inspect panes before cleanup and kill only verified stale worker panes.

## Clean-Slate Recovery

Run from leader pane:

```bash
# 1) Inspect panes
tmux list-panes -F '#{pane_id}	#{pane_current_command}	#{pane_start_command}'

# 2) Kill verified stale worker panes only (examples)
tmux kill-pane -t %450
tmux kill-pane -t %451

# 3) Shut down recorded team state/workers through the supported team runtime
# Replace <team-name> with the team from `gjc team list` / `gjc team status`.
gjc team shutdown <team-name>

# 4) Retry
gjc team executor "fresh retry"
```

Guidelines:

- Do not kill the leader pane.
- Do not kill HUD panes unless intentionally restarting HUD.
- Prefer `gjc team shutdown <team>` for recorded active workers; use manual pane cleanup only for verified stale panes.

## Required Reporting During Execution

When operating this skill, provide concrete progress evidence:

1. Team started line (`Team started: <name>`)
2. tmux target and worker pane id
3. task state from read-only `gjc team status <team>`, mutating `gjc team monitor <team>`, or `.gjc/_session-{sessionid}/state/team/<team>/tasks/task-1.json`
4. shutdown outcome (`phase=complete`, worker status `stopped`) when the run is terminal; incomplete shutdowns must report `phase=cancelled`/`failed`, and integration-blocked shutdowns must report `phase=awaiting_integration`

Do not claim success without file/pane evidence.
Do not claim clean completion if shutdown occurred with `in_progress>0`.
Use `gjc team status <team>` and `gjc team monitor <team>` as the supported operator aids for status inspection; keep raw state-file or pane evidence available for manual intervention and proof.

## Programmatic Team Orchestration

Use the `gjc team ...` CLI as the supported team-launch surface. For automation, drive the same CLI flow from scripts or supervising agents rather than relying on a separate runtime integration runner.

### Supported current surfaces

- **`gjc team ...` CLI** — Primary method for interactive or automated team orchestration. Use this when you want direct tmux-pane visibility or a scriptable launch path.
- **`gjc team status <team>`** — Read current team/task/worker state.
- **`gjc team monitor <team>`** — Follow live progress through the supported runtime surface.
- **`gjc team shutdown <team>`** — Stop recorded active workers and move the team toward terminal state.
- **`gjc team api <team>`** — Use only for documented programmatic operations exposed by the team runtime.
- **Team state files** — Inspect `.gjc/_session-{sessionid}/state/team/<team>/` when you need status, task, or mailbox evidence after launch.

### Cleanup distinction

Use `gjc team shutdown <team>` for recorded active workers. After shutdown reports a terminal state and required evidence is preserved, use supported `gjc state ...` session/mode cleanup commands only when you are intentionally clearing state; do not delete team state by hand during an active run. Use manual tmux/session cleanup only for verified stale panes that are not handled by the documented shutdown flow.

### Automation example

```
1. gjc team executor "fix bugs"
2. gjc team status <team-name>
3. gjc team shutdown <team-name>
4. Clean up the finished team state for <team-name>
```

## Limitations
