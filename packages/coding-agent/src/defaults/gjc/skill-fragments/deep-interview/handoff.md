### Phase 5b: Handoff before chain

Before invoking `/skill:ralplan`, `/skill:team`, or `/skill:ultragoal`, the final spec must already be persisted through the native deep-interview write command. For ordinary user-selected handoff, mark deep-interview ready for the skill tool's chain guard:

```
gjc state deep-interview write --input '{"current_phase":"handoff"}' --json
```

For a preselected deliberate ralplan path, prefer the single sanctioned bridge command instead:

```
gjc \
deep-interview --write --stage final --slug {slug} --spec <markdown-or-path> --deliberate --json
```

That command persists `.gjc/_session-{sessionid}/specs/deep-interview-{slug}.md`, seeds ralplan in deliberate mode, and performs the safe deep-interview → ralplan state handoff. Skipping spec persistence leaves the Phase 5 chain blocked by design.

### Approval-Gated Refinement Path (Recommended)

```
Stage 1: Deep Interview          Stage 2: ralplan consensus       Stage 3: Separate approval
┌─────────────────────┐    ┌───────────────────────────┐    ┌──────────────────────┐
│ Socratic Q&A        │    │ Planner creates plan      │    │ User chooses if/how  │
│ Ambiguity scoring   │───>│ Architect reviews         │───>│ execution proceeds   │
│ Lateral panel       │    │ Critic validates          │    │ via ultragoal (default) │
│ Spec crystallization│    │ Loop until consensus      │    │ no auto-handoff      │
│ Gate: ≤<resolvedThresholdPercent> ambiguity│    │ ADR + RALPLAN-DR summary  │    │                      │
└─────────────────────┘    └───────────────────────────┘    └──────────────────────┘
Output: spec.md            Output: consensus-plan.md        Output: pending approval
```

**Why 3 stages?** Each stage provides a different quality gate:
1. **Deep Interview** gates on *clarity* — does the user know what they want?
2. **ralplan consensus** gates on *feasibility* — is the approach architecturally sound?
3. **Separate approval** gates on *consent* — does the user explicitly choose an execution path?

Skipping any stage is possible but reduces quality assurance:
- Skip Stage 1 → execution may build the wrong thing (vague requirements)
- Skip Stage 2 → execution may plan poorly (no Architect/Critic challenge)
- Skip Stage 3 → no execution (just a refined plan), by design

</Steps>

<Tool_Usage>
- Use the `ask` tool for each interview question — provides clickable UI with contextual options
- For any option-bearing question, call `ask`; never print `Question:`/`Options:` blocks as assistant prose. If such a block was already printed, call `ask` with the same question/options as the very next action instead of waiting for a typed/prose answer
- Preserve the GJC `ask` tool path for native interaction; do not introduce parallel structured-question transport into this skill
- Use `read/search/find exploration or a bounded read-only planner/architect subagent` for brownfield codebase exploration (run BEFORE asking user about codebase)
- Use opus model (temperature 0.1) for ambiguity scoring — consistency is critical
- Round 0 topology confirmation happens before ambiguity scoring; Phase 2 scoring must honor locked topology and rotate targeting across active components when more than one is present
- Use `gjc state write` / `gjc state read` for interview state persistence; the initial and subsequent deep-interview state payloads must include `threshold_source` alongside `threshold`; do not edit `.gjc/_session-{sessionid}/state` directly without force override.
- Use the GJC workflow CLI to save the final spec at `.gjc/_session-{sessionid}/specs/deep-interview-{slug}.md` exactly; do not use `write`, `edit`, or `ast_edit` directly on `.gjc/` paths without force override.
- Use public GJC workflow entrypoints to bridge to ralplan, ultragoal, or team only after explicit execution approval — never implement directly. Implementation handoff defaults to ultragoal; reserve team for when tmux-based interactive worker parallelization is genuinely required.
- The lateral-review panel spawns read-only persona subagents (Task tool) in parallel with independent context; it is an assist layer, never an executor and never the completion authority
- Apply the Refine gate (Step 2b″), the Dialectic Rhythm Guard (Step 2a), and the Closure + Restate gates (Phase 4) through the `ask` tool, preserving `language.instruction` for each; if any of these gates has options, the assistant must call `ask` and must not print `Question:`/`Options:` blocks as assistant prose
- Use internal fragment auto-modes only at their documented hooks: `auto-research-greenfield.md` between Step 2a and 2b for greenfield `research: true` questions, `auto-answer-uncertain.md` as Step 2b′ after `ask` resolves and before scoring, and `lateral-review-panel.md` for the Phase 3 panel personas at ambiguity-milestone transitions and before synthesizing agent-supplied answers.
- Fragment auto-modes are loaded on demand as `kind: "skill-fragment"`; they are not public workflow skills, not slash-command/discoverable, and not `skill://` registrations.
</Tool_Usage>

<Examples>
<Good>
Targeting weakest dimension:
```
Scores: Goal=0.9, Constraints=0.4, Criteria=0.7
Next question targets Constraints (lowest at 0.4):
"You mentioned this should 'work on mobile'. Does that mean a native app,
a responsive web app, or a PWA? And are there specific devices or OS versions
you need to support?"
```
Why good: Identifies weakest dimension, explains why it is now the bottleneck, asks a specific question to improve it, and doesn't batch multiple topics.
</Good>

<Good>
Gathering codebase facts before asking:
```
[runs focused repo inspection or asks a canonical role agent: "find authentication implementation"]
[receives: "Auth is in src/auth/ using JWT with passport.js"]

Question: "I found JWT authentication with passport.js in `src/auth/` (pattern match from repo inspection).
For this new feature, should we extend the existing auth middleware or create
a separate authentication flow?"
```
Why good: Explored first, cited the repo evidence that triggered the question, then asked an informed confirmation question. Never asks the user what the code already reveals.
</Good>

<Good>
Lateral panel — contrarian persona:
```
Round 5 | Targeting: Constraints | Lateral panel: progress→refined (contrarian) | Ambiguity: 42%

You've said this needs to support 10,000 concurrent users. What if it only
needed to handle 100? Would the architecture change fundamentally, or is
the 10K number an assumption rather than a measured requirement?
```
Why good: The lateral panel's contrarian persona challenges a specific assumption (scale requirement) that could dramatically simplify the solution.
</Good>

<Good>
Early exit with warning:
```
User: "That's enough, just build it"
System: "Current ambiguity is 35% (threshold: <resolvedThresholdPercent>). Areas still unclear:
  - Success Criteria: 0.5 (How do we verify the search ranking algorithm works correctly?)
  - Constraints: 0.6 (No performance targets defined yet)

Proceeding may require rework. Continue anyway?"
  [Yes, proceed] [Ask 2-3 more questions] [Cancel]
```
Why good: Respects user's desire to stop but transparently shows the risk.
</Good>

<Good>
Ontology stabilization — ask, then watch it converge:
```
Round 6 | Targeting: Goal Clarity | Why now: the core entity is still unstable across rounds, so feature questions would compound ambiguity | Ambiguity: 38%

"Across the last rounds you've described this as a workflow, an inbox, and a planner. Which one is the core thing this product IS, and which are supporting views?"

→ Round 7 entities: User, Task, Project (stability: 67%)
→ Round 8 entities: User, Task, Project, Tag (stability: 100% — all 4 stable across 2 rounds)
```
Why good: An ontology-style question stabilizes the core noun before drilling into features; the stability ratio then climbing to 100% across consecutive rounds is the mathematical signal that the domain model has converged.
</Good>

<Bad>
Batching multiple questions:
```
"What's the target audience? And what tech stack? And how should auth work?
Also, what's the deployment target?"
```
Why bad: Four questions at once — causes shallow answers and makes scoring inaccurate.
</Bad>

<Bad>
Proceeding despite high ambiguity:
```
"Ambiguity is at 45% but we've done 5 rounds, so let's start building."
```
Why bad: 45% ambiguity means nearly half the requirements are unclear. The mathematical gate exists to prevent exactly this.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- **Hard cap at 100 rounds**: Proceed with whatever clarity exists, noting the risk
- **Soft warning at 10 rounds**: Offer to continue or proceed
- **Early exit (round 3+)**: Allow with warning if ambiguity > threshold
- **User says "stop", "cancel", "abort"**: Stop immediately, save state for resume
- **Ambiguity stalls** (same score +-0.05 for 3 rounds): Activate Ontologist mode to reframe
- **All dimensions at 0.9+**: Skip to spec generation even if not at round minimum
- **Codebase exploration fails**: Proceed as greenfield, note the limitation
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Phase 0 ran before anything: threshold resolved and first line emitted as `Deep Interview threshold: <resolvedThresholdPercent> (source: <resolvedThresholdSource>)`; state and spec metadata record both `threshold` and `threshold_source`
- [ ] `language.instruction` preserved across announcements, questions, options, progress reports, and spec prose when present
- [ ] User-facing natural-language prose, including generated prose clauses/cells inside round lines or tables, was silently self-proofread once according to `language.instruction`, while code/paths/commands/keys/table or round structure/fixed labels/status tokens/quotes/threshold markers/fixed paths remained unchanged
- [ ] Oversized initial context/history summarized before scoring, question generation, spec generation, or handoff
- [ ] Round 0 topology gate completed before scoring; `topology.confirmed_at` persisted
- [ ] Ambiguity scored and displayed every round, naming the weakest component/dimension target (rotating across active components when N > 1)
- [ ] Lateral panel convened at milestone transitions (and before synthesizing agent-supplied answers) with parallel read-only personas
- [ ] Free-text answers passed the Refine gate; dialectic rhythm guard forced a user question after 3 agent-resolved answers; any auto-answer threshold crossing explicitly confirmed
- [ ] Closure / Acceptance Guard and the one-sentence Restate gate both passed before crystallization
- [ ] Interview reached ambiguity ≤ threshold OR an explicit early exit with warning
- [ ] Spec persisted to `.gjc/_session-{sessionid}/specs/deep-interview-{slug}.md` exactly via the GJC CLI (no direct `.gjc/` edits without force override), covering every active topology component plus goal/constraints/acceptance criteria/clarity/ontology/transcript
- [ ] Spec metadata includes the auto/lateral counters (`auto_researched_rounds`, `auto_answered_rounds`, `lateral_reviews`, `refined_rounds`, `architect_failures`, `lateral_panel_failures`)
- [ ] Execution bridge presented via `ask`; execution invoked only after explicit approval through a public workflow entrypoint (never direct implementation); state cleaned up after handoff
</Final_Checklist>

<Advanced>
## Configuration

Optional settings in `.gjc/settings.json`:

```json
{
  "gjc": {
    "deepInterview": {
      "ambiguityThreshold": <resolvedThreshold>,
      "maxRounds": 100,
      "softWarningRounds": 10,
      "minRoundsBeforeExit": 3,
      "enableChallengeAgents": true,
      "autoExecuteOnComplete": false,
      "defaultExecutionMode": null,
      "scoringModel": "opus"
    }
  }
}
```

## Resume

If interrupted, run `/skill:deep-interview` again. The skill resumes from GJC workflow state via `gjc state read`; do not read or edit `.gjc/_session-{sessionid}/state` files directly unless an explicit force override is active.

## Integration with staged team routing

When team receives a vague input (no file paths, function names, or concrete anchors), it can redirect to deep-interview:

```
User: "team build me a thing"
Team routing: "Your request is quite open-ended. Would you like to run a deep interview first to clarify requirements?"
  [Yes, interview first] [No, expand directly]
```

If the user chooses interview, team routing invokes `/skill:deep-interview`. When the interview completes and the user selects an execution path (ultragoal by default, or team when tmux-based interactive parallelization is required), the spec becomes Phase 0 output and the chosen workflow proceeds from the approved spec.

## Approval-Gated Pipeline: deep-interview → ralplan → pending approval

See the Phase 5b "Approval-Gated Refinement Path" diagram for the full flow. In short: interview → spec at `.gjc/_session-{sessionid}/specs/deep-interview-{slug}.md` → user selects "Refine with ralplan consensus" → `/skill:ralplan` (Planner/Architect/Critic consensus, plan written to `.gjc/_session-{sessionid}/plans/`) → stop at `pending approval`. Execution is always a separate approval-gated step; deep-interview and ralplan never auto-invoke ultragoal or team just because a spec or plan exists.

## Integration with Ralplan Gate

The ralplan pre-approval gate already redirects vague prompts to planning. Deep interview can serve as an alternative redirect target for prompts that are too vague even for ralplan:

```
Vague prompt → ralplan gate → deep-interview (if extremely vague) → ralplan (with clear spec) → pending approval → explicitly approved execution
```

## Brownfield vs Greenfield Weights

See "Calculate ambiguity" in Step 2c for the weighted formulas. Brownfield adds a 15% Context Clarity dimension (Goal/Constraint/Criteria become 35/25/25) because safely modifying existing code requires understanding the system being changed.

## Lateral Review Panel

See Phase 3 for the full persona set (researcher/contrarian/simplifier, plus architect on scope change), the milestone bands, and the parallel independent-context dispatch.

## Ambiguity Score Interpretation

| Score Range | Meaning | Action |
|-------------|---------|--------|
| 0.0 - 0.1 | Crystal clear | Proceed immediately |
| At or below the resolved threshold | Clear enough | Proceed |
| Above the resolved threshold with minor gaps | Some gaps | Continue interviewing |
| Moderate ambiguity | Significant gaps | Focus on weakest dimensions |
| High ambiguity | Very unclear | May need reframing (panel ontology escalation) |
| Extreme ambiguity | Almost nothing known | Early stages, keep going |
</Advanced>

Task: Use the user request appended after this skill as the final `User:` line.
