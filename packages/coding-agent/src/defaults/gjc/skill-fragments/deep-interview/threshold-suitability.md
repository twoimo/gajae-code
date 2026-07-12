## Phase 0: Resolve Ambiguity Threshold (blocking prerequisite)

Complete this phase before Phase 1, before brownfield exploration, before GJC state persistence, before Round 0, and before any ambiguity scoring. Do not continue if the resolved threshold and source are unknown.

1. **Prefer pre-resolved native state**:
   - First inspect active deep-interview state with `gjc state deep-interview read --json`.
   - If state contains a finite numeric `threshold` and a non-empty `threshold_source`, use those values, set `<resolvedThreshold>`, `<resolvedThresholdPercent>`, and `<resolvedThresholdSource>`, and skip optional settings-file reads. This is the normal `/skill:deep-interview` path because the native hook already resolved settings quietly before loading the skill.
2. **Only if native state lacks a resolved threshold, read threshold settings in runtime precedence order**:
   - YAML config first: read the **single** modern config path the environment selects — `$GJC_CODING_AGENT_DIR/config.yml` when `GJC_CODING_AGENT_DIR` is set, else `$GJC_CONFIG_DIR/agent/config.yml` when `GJC_CONFIG_DIR` is set, else `~/.gjc/agent/config.yml`. Do not cascade through the other YAML locations when the selected one is absent or invalid.
   - Then JSON settings: project settings `./.gjc/settings.json`, then user settings `[$GJC_CONFIG_DIR|~/.gjc]/settings.json`.
   - Read `gjc.deepInterview.ambiguityThreshold` only from files that are known to exist; optional config/settings-file absence is expected and must not be surfaced as failed `Read` calls.
   - Do not probe arbitrary ancestor candidates such as `../../.gjc/settings.json`; use the current project `.gjc/settings.json` and user settings only.
3. **Resolve threshold and source**:
   - Use the first valid configured value in the precedence order above; otherwise use the mode default when a resolution flag was passed: `--quick` = `0.6`, `--standard` = `0.5`, `--deep` = `0.35`; with no resolution flag, use the base default `0.05`.
   - Set these run variables exactly: `<resolvedThreshold>`, `<resolvedThresholdPercent>`, and `<resolvedThresholdSource>` (for example `GJC_CODING_AGENT_DIR/config.yml`, `$GJC_CONFIG_DIR/agent/config.yml`, `~/.gjc/agent/config.yml`, `./.gjc/settings.json`, `[$GJC_CONFIG_DIR|~/.gjc]/settings.json`, or the selected mode default).
4. **Emit the required first line to the user before any other interview announcement**:

```
Deep Interview threshold: <resolvedThresholdPercent> (source: <resolvedThresholdSource>)
```

5. **Carry threshold source forward mechanically**:
   - Substitute `<resolvedThreshold>`, `<resolvedThresholdPercent>`, and `<resolvedThresholdSource>` throughout the remaining instructions before continuing.
   - Include `threshold_source` in the first `gjc state write` payload and preserve it on later state updates; do not edit `.gjc/_session-{sessionid}/state` files directly unless an explicit force override is active.
   - Include both threshold and source in the final spec metadata.
- Read any `language` object from active deep-interview state and carry `language.instruction` forward mechanically. If absent, default to English unless the final `User:` line makes another user/session language obvious or the user explicitly requests another language. Do not add language-specific special cases.

## Phase 0.5: Suitability Gate

Run this gate after the Phase 0 threshold marker and before Phase 1, brownfield exploration, `gjc state write`, Round 0, ambiguity scoring, or spec writing.

If the user request appended after this skill as the final `User:` line is already clear, bounded, low-risk, and asks for a quick fix, single change, known file/symbol edit, explicit command, or direct answer:

1. **Stop deep-interview immediately**:
   - First inspect current-session state with `gjc state read --mode deep-interview --json` (include `--session-id <current-session-id>` when available).
   - Clear through `gjc state clear --force --mode deep-interview --json` only when the state is a newly seeded empty interview: no recorded `rounds`, no `spec_path`, no `handoff_from`, no final/pending spec, and no user-confirmed topology.
   - If state already contains rounds, a spec path, handoff metadata, pending approval, or confirmed topology, do not clear it. Preserve the active interview and ask the user whether to continue, cancel, or explicitly clear the workflow.
   - Do not initialize deep-interview state.
   - Do not run Round 0.
   - Do not write a pending-approval spec.
   - Do not hand off to `ralplan`, `ultragoal`, `team`, or a role agent.
2. **Return the request to direct implementation**:
   - Say briefly that deep-interview is unnecessary because the request is already clear and small.
   - State the direct implementation path the normal coding agent should take.
   - If the user explicitly insists on deep-interview anyway, continue to Phase 1.

This gate exists to prevent deep-interview from making easy problems harder. A small verification need does not make a request interview-worthy.

## Phase 0.75: Optional Trace Pre-Step

Run this phase only when the active deep-interview state or invocation indicates `--trace` / `state.trace.enabled === true`. It is a pre-interview research step, not an implementation phase.

1. Read the native trace summary from active deep-interview state (`trace`, `state.trace`, or `state.trace_summary`). The native seed must have produced this summary before any interview question.
2. Treat the summary as compact evidence: project hints, relevant paths, and path-level findings only. Do not expand it by dumping raw files, raw logs, or unbounded command output.
3. Store or preserve it under `state.trace_summary` and fold it into `codebase_context` with citations to the summarized paths.
4. Use trace findings to influence Round 0 topology, Phase 2 question targeting, requirement wording, acceptance criteria, and final Technical Context. Normal no-trace interviews must behave exactly as before.
5. If `--trace` was requested but no valid bounded summary exists, increment `architect_failures` or record an internal audit note, then continue with the normal no-trace path without surfacing tool noise.

