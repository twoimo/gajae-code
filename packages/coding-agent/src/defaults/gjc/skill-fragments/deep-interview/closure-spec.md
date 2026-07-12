## Phase 4: Crystallize Spec

When ambiguity ≤ threshold (or hard cap / early exit):

**Before generating the spec, two gates must pass, in order:**

**4a. Closure / Acceptance Guard.** Even when ambiguity ≤ threshold, do not treat the math as completion. Run an independent readiness audit from the full main-session perspective (including explore findings, established facts, and triggers the scorer may not have fully weighed). Confirm every active topology component has goal/constraint/criteria coverage, no unresolved or disputed trigger remains on a path that matters, no disputed established fact lacks a `superseded_by` resolution, and no low-confidence auto-answer is standing in for user-confirmed truth above the clarity cap. If a material gap exists, explicitly override the gate to the user — "The math says ready, but I am not accepting it yet because {gap}" — and ask the single highest-impact follow-up, returning to Phase 2. Record any override in `state.closure_overrides`.

**4b. Restate gate.** Once closure passes, collapse the agreed answers into ONE sentence goal that covers every active component, and confirm it with a single `ask`: "If someone read only this line, would they reach the same outcome you have in mind?" Offer **Yes, crystallize**, **Adjust wording**, and **Missing scope**, plus free-text, applying `language.instruction` when present. Because this gate has options, it MUST go through `ask`: do not print the Restate question and options as assistant prose with `Question:`/`Options:` labels. If the Restate gate was already printed that way, immediately call `ask` with the same question/options before accepting or waiting for any answer. On "Adjust wording" / "Missing scope", collect the exact correction with one follow-up `ask`, route it back through Step 2c scoring and established-facts maintenance (a correction can change ambiguity), then re-run closure and ask the Restate gate again. Cap at two loops; if alignment is not reached, return to Phase 2 with a targeted question instead of forcing a goal line. Persist the confirmed line as `state.restated_goal`.

1. **Generate the specification** using opus model with the prompt-safe transcript. If the full interview transcript or initial context is too large, include the summary plus all concrete decisions, acceptance criteria, unresolved gaps, and ontology snapshots; never overflow the prompt with raw oversized context.
   - Apply `language.instruction` when present so user-facing prose in the spec preserves the session language; keep code identifiers, file paths, commands, JSON/settings keys, and quoted source text unchanged.
   - Apply the self-proofread once to newly generated spec prose before persistence, including generated natural-language table cells such as coverage notes, while preserving transcript answers, quoted/source text, code identifiers, file paths, commands, JSON/settings keys, table structure/fixed labels, and `.gjc/_session-{sessionid}/specs/deep-interview-{slug}.md` unchanged.
2. **Write the final spec through the workflow CLI**: persist the artifact at `.gjc/_session-{sessionid}/specs/deep-interview-{slug}.md`
   - Always use this exact final spec path. Prefer passing the spec markdown **inline** as the `--spec` value; only when it is too large to pass inline, stage it as a file in a system temp directory (`os.tmpdir()`/`$TMPDIR`, `/tmp`, `/var/tmp`) outside the project tree and pass that path — never write scratch specs to the repo root, the project tree, or `.gjc/`.
   - Use the native deep-interview write command with `--write --stage final --slug {slug} --spec <markdown-or-path> [--json]` for artifact and state persistence; direct `.gjc/` file edits are forbidden unless an explicit force override is active.
   - Persist the final `spec_path` in state when available so downstream skills and resumed sessions can pass the artifact path explicitly.
   - If the user preselected the deliberate ralplan path, use the native deep-interview write command with `--write --stage final --slug {slug} --spec <markdown-or-path> --deliberate [--json]` so the final spec is persisted before deep-interview hands off to ralplan.

Spec structure:

```markdown
# Deep Interview Spec: {title}

## Metadata
- Interview ID: {uuid}
- Rounds: {count}
- Final Ambiguity Score: {score}%
- Type: greenfield | brownfield
- Generated: {timestamp}
- Threshold: {threshold}
- Threshold Source: <resolvedThresholdSource>
- Initial Context Summarized: {yes|no}
- Status: {PASSED | BELOW_THRESHOLD_EARLY_EXIT}
- Auto-Researched Rounds: {auto_researched_rounds}
- Auto-Answered Rounds: {auto_answered_rounds}
- Architect Failures: {architect_failures}
- Lateral Reviews: {lateral_reviews count with milestones}
- Lateral Panel Failures: {lateral_panel_failures}
- Refined Rounds: {refined_rounds}
- Closure Overrides: {closure_overrides count, or none}
- Restated Goal: {restated_goal}

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | {s} | {w} | {s*w} |
| Constraint Clarity | {s} | {w} | {s*w} |
| Success Criteria | {s} | {w} | {s*w} |
| Context Clarity | {s} | {w} | {s*w} |
| **Total Clarity** | | | **{total}** |
| **Ambiguity** | | | **{1-total}** |

## Topology
{List every Round 0 confirmed top-level component. Active components must have coverage notes; deferred components must include the user-confirmed deferral reason and timestamp.}

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| {component.name} | {active|deferred} | {component.description} | {covered acceptance criteria or deferral reason} |

## Established Facts
{List stable confirmed decisions promoted into `state.established_facts`, including source round, evidence, and disputed status when any fact was contradicted.}

## Trigger Metadata
{Summarize per-round trigger metadata: trigger label/status, affected component/dimension, prior -> new ambiguity direction, evidence, contradicted established fact when relevant, and disputed/unresolved rationale when applicable.}

## Lateral Review Panel
{Summarize convened panels: round, milestone transition or pre-answer trigger, personas dispatched, and the concrete findings folded into questions. Note any lateral_panel_failures.}

## Goal
{crystal-clear goal statement derived from interview, covering every active topology component}

## Constraints
- {constraint 1}
- {constraint 2}
- ...

## Non-Goals
- {explicitly excluded scope 1}
- {explicitly excluded scope 2}

## Acceptance Criteria
- [ ] {testable criterion 1}
- [ ] {testable criterion 2}
- [ ] {testable criterion 3}
- ...

## Deferrals
{List user-confirmed topology deferrals and scoring/pacing deferrals, including Convergence Pacing when applicable: no min-round floor, score-drop cap, or dampening; bidirectional scoring is the pacing mechanism.}

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| {assumption} | {how it was questioned} | {what was decided} |

## Technical Context
{brownfield: relevant codebase findings from focused repo inspection, canonical role-agent fact-finding, and bounded trace summary when --trace was active}
{greenfield: technology choices and constraints, plus bounded trace findings when --trace was active and relevant}

## Ontology (Key Entities)
{Fill from the FINAL round's ontology extraction, not just crystallization-time generation}

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| {entity.name} | {entity.type} | {entity.fields} | {entity.relationships} |

## Ontology Convergence
{Show how entities stabilized across interview rounds using data from ontology_snapshots in state}

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | {n} | {n} | - | - | - |
| 2 | {n} | {new} | {changed} | {stable} | {ratio}% |
| ... | ... | ... | ... | ... | ... |
| {final} | {n} | {new} | {changed} | {stable} | {ratio}% |

## Interview Transcript
<details>
<summary>Full Q&A ({n} rounds)</summary>

### Round 1
**Q:** {question}
**A:** {answer}
**Ambiguity:** {score}% (Goal: {g}, Constraints: {c}, Criteria: {cr})

...
</details>
```

## Phase 5: Execution Bridge


After the spec is written, mark it `pending approval` and present execution options via the `ask` tool. Until the user selects an execution option, the deep-interview module MUST NOT run mutation-oriented shell commands, edit source files, commit, push, open PRs, invoke execution skills, or delegate implementation tasks:

**Question:** "Your spec is ready (ambiguity: {score}%). How would you like to proceed?"

**Options:**

1. **Refine with ralplan consensus (Recommended — default for almost all specs)**
   - Description: "Consensus-refine this spec with Planner/Architect/Critic, then stop for explicit execution approval. Maximum quality. Prefer this unless the spec is already implementation-ready and trivially simple."
   - Action: Only after the user selects this option, invoke `/skill:ralplan` with the spec file path as context. Ralplan is already the Planner → Architect → Critic consensus workflow, so no extra slash-skill flags are required or supported. When consensus completes and produces a plan in `.gjc/_session-{sessionid}/plans/`, stop with that plan marked `pending approval`; do not automatically invoke execution or any other execution skill.
   - Pipeline: `deep-interview spec → explicit approval to refine → ralplan → pending approval → separate execution approval`

2. **Execute with ultragoal (only when spec is already implementation-ready and really simple)**
   - Description: "Goal-tracked autonomous execution — drives the spec to completion with verification. Skip ralplan refinement only when the spec is concrete, low-risk, and trivially small."
   - Action: Invoke `/skill:ultragoal` with the spec file path as context only after the user explicitly selects this execution option. The spec replaces ultragoal planning input. Recommend this only when the spec needs no further planning; otherwise route through ralplan refinement first.

3. **Execute with team (only when implementation-ready, simple, AND tmux parallelization is required)**
   - Description: "N coordinated parallel agents in tmux — only when the spec is already implementation-ready and genuinely needs tmux-based interactive worker parallelization."
   - Action: Invoke `/skill:team` with the spec file path as the shared plan only after the user explicitly selects this option. Reserve this for the narrow case where the spec is simple/ready and tmux interactive parallel workers are actually needed; otherwise prefer ralplan refinement, then ultragoal.

4. **Refine further**
   - Description: "Continue interviewing to improve clarity (current: {score}%)"
   - Action: Return to Phase 2 interview loop.

**IMPORTANT:** On explicit execution selection, **MUST** use the chosen bundled GJC workflow skill entrypoint (`/skill:ralplan`, `/skill:ultragoal`, or `/skill:team`) inside the agent session. `gjc ralplan` is a native CLI that accepts the documented skill flags and seeds local `.gjc/_session-{sessionid}/state` receipts; agent sessions should still drive the consensus loop through `/skill:ralplan`. Implementation handoff defaults to `/skill:ultragoal`; `/skill:team` is reserved for when tmux-based interactive worker parallelization is genuinely required, and `gjc team` is a native tmux runtime command used only when the Team workflow explicitly requires the CLI runtime. Do NOT implement directly. The deep-interview agent is a requirements agent, not an execution agent. If oversized initial context was summarized, pass the spec and prompt-safe summary forward, not the raw oversized source material. Without explicit execution selection, stop with the spec marked `pending approval`.

