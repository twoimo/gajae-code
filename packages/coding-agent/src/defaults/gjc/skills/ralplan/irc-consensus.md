# Ralplan IRC Consensus Protocol

Internal ralplan fragment, loaded only after a validated `--irc` activation. It is parent-scoped to `ralplan`, never user-discoverable, and never available through `skill://`.

## Activation and whole-run degradation

Before any IRC pass, validate the IRC activation and run metadata. This runtime latch is **automatic and permanent**: activation or fragment failures immediately force fresh-spawn legacy roles for the whole run. `ralplan_activation_degrade` exists solely for a pre-pass failure observed by an already-running main prompt; it is not a recovery option for activation, fragment, or pass-bound failures. Once a pass has started, report a resume failure, deliberation-receipt write failure, timeout, attachment failure, or transport failure through `irc` `ralplan_report_failure` with the identical `runId`, `stageN`, and `cursorGeneration`. Do not use `ralplan_activation_degrade` for a pass-bound failure.


A degradation is permanent for the whole run: continue every remaining Planner, Architect, and Critic step with fresh-spawn legacy roles, do not resume an IRC role, and do not call coordinator pass operations again. The no-`--irc` path is the same fresh-spawn legacy workflow and must retain its existing behavior.

## Pass admission and independent review

Start a pass only with its authoritative `runId`, `stageN`, and `cursorGeneration`. Bind Planner, Architect, and Critic to that exact pass. A registered process is not sufficient: all three must have attached sessions before deliberation can begin. Then Critic must send a required direct message to Planner; delivery acknowledgement of that Critic → Planner message opens deliberation. Architect traffic, an attempted send, or a transcript observation does not satisfy this gate.

Prompt every reviewer as an independent reviewer. The Critic prompt must explicitly say: **“Review the Planner artifact independently. Do not assume the Architect’s conclusions are correct; identify your own evidence and objections before considering any Architect message.”** Durable first-write role metadata is machine-derived only from the `--<role>-id` and `--<role>-resumable` flags. Evidence-body cache content separately records run, pass, turn, role, subagent id, provider, model, and mode; those fields are not writer flags.


## Deliberation and awaited replies

IRC messages are deliberation, not a consensus vote. An awaited reply is delivered through the parent `respondAsBackground` side channel. It is asymmetric: no sender or receiver gate may assume mutual incorporation merely because a reply was awaited. Before the finalization boundary, send all needed review messages; where a bounded follow-up is necessary, resume or steer the applicable role with the new message and record that follow-up before finalization.

The relay transcript is diagnostic context only. It is not an artifact receipt, may arrive out of order, and cannot authorize a plan, revision, consensus, finalization, or approval. Durable `gjc ralplan --write` receipts and their path/sha256 are the sole authority. If Planner makes a substantive revision after an Architect or Critic receipt, that receipt no longer covers the Planner artifact: persist replacement review receipts for the changed Planner artifact before the review join gate.

## Deliberation boundary and cache evidence

After `irc` `ralplan_pass_end` returns deliberation markdown, persist the deliberation receipt first. Only after that durable write succeeds, call `irc` `ralplan_deliberation_receipt_recorded` with the identical `runId`, `stageN`, and `cursorGeneration`; it emits the boundary `ask` hook. Never invoke or consume that hook while a pass is active, and never ask before the deliberation receipt exists.

For cache evidence, preserve raw production-shaped token-log turn records keyed by run, mode, role, subagent, pass, turn, provider, and model, with an explicit attempt identity and ordinal. Select the first three declared attempt slots before matching modes; an unmatched slot or duplicate/undeclared retry ordinal is disqualifying evidence and must be rendered, never backfilled by a later favorable pair. Compare only matched second-pass Architect and Critic turns. For each comparable turn, cache hit rate is `cacheRead / (input + cacheRead)` and is `null` when the denominator is zero. Render the raw matched evidence with run, role, subagent, provider, and model keys for the ADR stage.