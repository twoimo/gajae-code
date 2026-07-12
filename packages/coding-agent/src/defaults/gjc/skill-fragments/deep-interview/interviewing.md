## Phase 2: Interview Loop

Repeat until `ambiguity ≤ threshold` OR user exits early:

### Step 2a: Generate Next Question

Build the question generation prompt with:
- The prompt-safe initial-context summary (if one was created), otherwise the user's original idea
- Prior Q&A rounds trimmed or summarized to fit the prompt budget while preserving decisions, constraints, unresolved gaps, and ontology changes
- Current clarity scores per dimension (which is weakest?)
- Lateral-review panel findings (if convened this round -- see Phase 3)
- Brownfield codebase context (if applicable), summarized to cited paths/symbols/patterns instead of raw dumps
- Bounded trace summary (when `--trace` is active): project hints, relevant paths, and findings only; cite paths instead of raw content
- Locked topology from Round 0, including active components, deferred components, prior per-component scores, and `last_targeted_component_id`

- `language` from active state when present; apply `language.instruction` to all natural-language user-facing question text, rationale, and options

If any prompt input is too large, summarize it first and then continue from the summary. Do not ask the next question, score ambiguity, or hand off to execution from an over-budget raw transcript.

**Question targeting strategy:**
- Identify the active component + dimension pair with the LOWEST clarity score across the locked topology
- When N > 1 active components are tied or similarly weak, rotate targeting across active components rather than asking repeatedly about the last targeted component; update `topology.last_targeted_component_id` after each question
- Generate a question that specifically improves that component's weakest dimension
- State, in one sentence before the question, why this component/dimension pair is now the bottleneck to reducing ambiguity
- Questions should expose ASSUMPTIONS, not gather feature lists
- **Facts vs decisions:** answer factual questions (current stack, versions, existing patterns, external API limits) from explore/research and present them as cited confirmations; route every *decision* (goals, scope, tradeoffs, desired behavior for new work) to the user. When unsure which a question is, treat it as a decision and ask.
- If the scope is still conceptually fuzzy (entities keep shifting, the user is naming symptoms, or the core noun is unstable), switch to an ontology-style question that asks what the thing fundamentally IS before returning to feature/detail questions
- **Dialectic rhythm guard:** increment `state.auto_answer_streak` when a round is resolved without direct user judgment (an accepted auto-research candidate or an auto-answer); reset it to 0 on any direct, refined, or cited-confirmation answer from the user. If the streak reaches 3, route the next question directly to the user even if it looks auto-answerable, then reset. The interview is with the human, not the codebase.

**Question styles by dimension:**
| Dimension | Question Style | Example |
|-----------|---------------|---------|
| Goal Clarity | "What exactly happens when...?" | "When you say 'manage tasks', what specific action does a user take first?" |
| Constraint Clarity | "What are the boundaries?" | "Should this work offline, or is internet connectivity assumed?" |
| Success Criteria | "How do we know it works?" | "If I showed you the finished product, what would make you say 'yes, that's it'?" |
| Context Clarity (brownfield) | "How does this fit?" | "I found JWT auth middleware in `src/auth/` (pattern: passport + JWT). Should this feature extend that path or intentionally diverge from it?" |
| Scope-fuzzy / ontology stress | "What IS the core thing here?" | "You have named Tasks, Projects, and Workspaces across the last rounds. Which one is the core entity, and which are supporting views or containers?" |

### Step 2a′: Auto-Research Greenfield Questions

When the next question is for a greenfield interview and is tagged `research: true`, load `auto-research-greenfield.md` as an internal `kind: "skill-fragment"` prompt for a fork-context architect before Step 2b. Pass only the tagged question, locked topology summary, prompt-safe initial idea, trimmed prior decisions/gaps, and relevant constraints. The architect must return 2-3 ranked candidates with rationale, confidence, and fallback notes. Validate the shape before use; if valid, incorporate the candidates as concise answer options or context for the single user-facing question and append the round number to `auto_researched_rounds`. If invalid or unavailable, fall back silently to the normal generated question and increment `architect_failures`.

Auto-research must never add a public skill entrypoint, never be slash-command/discoverable, never register a `skill://` handler, and never alter the one-question-per-round rule.

### Step 2b: Ask the Question

Use the `ask` tool with the generated question. When a question has options, you MUST call `ask` and must not print `Question:`/`Options:` blocks as assistant prose. If you already printed a question/options block as prose, your next action is to call `ask` with the same question/options, not to wait for a typed answer. Before rendering the prompt/options, apply `language.instruction` from state when present so the entire user-facing question remains in the preserved session language. Present it clearly with the current ambiguity context:

```
Round {n} | Component: {target_component_name} | Targeting: {weakest_dimension} | Why now: {one_sentence_targeting_rationale} | Ambiguity: {score}%

{question}
```

Options should include contextually relevant choices plus free-text, translated/localized according to `language.instruction` when present.

After applying `language.instruction` to the visible question, options, and generated rationale, apply the self-proofread once to new prose only; preserve only the Round/Component/Targeting/Ambiguity line structure, fixed labels, numeric ambiguity value, component/target identifiers, and `deepInterview.*` metadata keys. Do not exempt generated natural-language rationale such as Why now.

When calling `ask`, SHOULD include optional structured metadata so the runtime can record the round without manual state writes: `deepInterview.round_id?`, `deepInterview.round`, `deepInterview.component`, `deepInterview.dimension`, and `deepInterview.ambiguity`. Keep this metadata aligned with the visible Round/Component/Targeting/Ambiguity line; if metadata cannot be supplied, the legacy formatted question text remains the fallback.

If the `ask` tool returns `clarificationQuestion`, treat it as a non-answer about the displayed choices. Answer the clarification briefly from the current interview context, then call `ask` again with the exact original question, options, and `deepInterview.*` metadata. A clarification bypasses Step 2b′ auto-answer, Step 2b″ free-text refine, Step 2c ambiguity scoring, Step 2d progress reporting, and Step 2e state updates; it must not be recorded as a round answer. This does not violate the one-question-per-round rule because the round remains unresolved until the user submits a real listed option or `Other` answer.

### Step 2b′: Auto-Answer Opted-Out Questions

After the `ask` tool resolves and before ambiguity scoring, if the user opts out of answering the current question or explicitly asks the agent to decide, load `auto-answer-uncertain.md` as an internal `kind: "skill-fragment"` prompt for a fork-context architect. Pass the opted-out question, prompt-safe transcript summary, locked topology, current scores/gaps, and any auto-research candidates used for the round. The architect must return exactly one decisive answer with rationale, confidence, and explicit uncertainty. Validate the response shape before using it; if valid, record it as the tentative answer for scoring, append the round number to `auto_answered_rounds`, and mark the transcript answer as architect-assisted.

Auto-answer has a clarity cap: unless the architect confidence is `high` and uncertainty is negligible, no dimension score improved solely by the auto-answer may exceed `0.85`. If the auto-answer would make ambiguity cross the resolved threshold, ask the user for threshold-crossing confirmation before Phase 4: present the tentative assumption and require explicit confirmation, revision, or continued questioning. On architect failure or invalid response, continue with the user's opt-out as an unresolved gap, increment `architect_failures`, and do not block the interview.

### Step 2b″: Refine Free-Text Answers

When the user's answer is free-text that carries reasoning, constraints, or scope decisions, do not forward it to scoring as a lossy one-line label. First structure it into a compact interpretation using the canonical sections — **Decision**, **Reasoning**, **Constraints (user-stated)**, **Out of scope (user-stated)**, and **Codebase context (verified)** (omit empty sections) — then confirm with exactly one `ask` that nothing is lost or misrepresented. Apply `language.instruction` when present.

Offer options such as **Send as-is**, **Add a constraint**, **Mark something out of scope**, **Add context**, and **Rewrite**, plus free-text. If the user picks anything other than "Send as-is", collect the exact missing text with one follow-up `ask` (never infer it from the option label), fold it into the structured interpretation, and re-confirm. Do not advance to scoring while the user is still saying something is missing.

Skip Refine for short answers with no attached reasoning (e.g. "Yes" / "No" / a single proper noun), for pre-built option picks where the structure is already explicit, for auto-confirmed code/brownfield facts, and for architect auto-answers (already structured by Step 2b′). A refined answer counts as direct user judgment: record the round in `refined_rounds` and reset `auto_answer_streak` to 0. Feed the confirmed structured interpretation — not the raw free text — into Step 2c scoring and established-facts maintenance.

### Step 2c: Score Ambiguity

After receiving the user's answer, score clarity across all dimensions.

If the round used an auto-answer, include the architect answer, rationale, confidence, and uncertainty in the scoring prompt. Apply the Step 2b′ clarity cap mechanically before calculating ambiguity, and treat any low-confidence or insufficient-context auto-answer as an unresolved gap rather than user-confirmed truth.

Before scoring, compare the new answer against `state.established_facts`. Treat established facts as durable confirmed decisions with source-round evidence; do not score an answer in isolation from facts that the interview has already stabilized.

Ambiguity is BIDIRECTIONAL and NON-MONOTONIC. A later answer can increase ambiguity when it invalidates, weakens, or expands prior understanding; convergence is not assumed to be a one-way decrease.

Ambiguity-raising triggers:
- **A direct contradiction**: the answer contradicts an established fact.
- **B internal inconsistency**: two requirements that cannot co-hold are now present.
- **C low-quality/evasive**: the answer avoids, hand-waves, or fails to resolve the targeted gap.
- **D scope expansion**: the answer adds a component, entity, constraint, deliverable, or integration not already covered or explicitly deferred.

Use **mechanism A** for every ambiguity rise: a trigger LOWERS the affected component/dimension clarity score, and the existing weighted formula raises ambiguity. There is **no separate penalty term**; ambiguity remains bounded by the same greenfield/brownfield formula.

**Deterministic ambiguity floor (runtime-enforced).** The runtime independently computes a code-level floor from persisted state and clamps every reported ambiguity to `max(reported, floor)` at write time — the scorer cannot under-report below what code can objectively measure:

- `+0.10` per established fact marked `disputed` that has no `superseded_by` resolution (contradiction pressure)
- `+0.05` per active topology component whose goal/constraints/criteria clarity is still unscored (gap pressure — persist `topology.components[].clarity_scores` every round or the floor blocks convergence)
- `+0.05 × (auto-answered rounds / scored rounds)` (assumption dilution)

Cooperate with the floor rather than fight it:
- Replacing an already-scored answer for the same round (a retraction/pivot) automatically marks that round's established facts as disputed; ambiguity rises mechanically even when no trigger is reported. Treat a floor-driven rise as trigger evidence and score the affected dimensions accordingly.
- A disputed fact keeps the floor at or above `0.10` — above the default threshold — so convergence is blocked until the dispute is resolved: either the user re-confirms the original fact (set `disputed: false`) or the superseding decision is recorded as a new established fact and the old fact gets `superseded_by: <new fact id>`. Never delete the contradicted fact.
- When the effective score was clamped upward, the persisted round carries `reported_ambiguity` (your raw score) and `ambiguity_floor`; report the floor and its dominant cause in the Step 2d table instead of pretending the raw score held.

The rise is SILENT: no modal, no forced-resolution step, and no dedicated conflict UI. Surface it through the normal per-round report and by targeting the next question at the affected component/dimension.

Structured scorer output is required. Include `triggers`, `trigger_status`, `affected_component`, `affected_dimension`, `prior_dimension_score`, `new_dimension_score`, `prior_ambiguity`, `new_ambiguity`, `evidence`, `contradicted_established_fact` when relevant, and `disputed_unresolved_rationale` when applicable.

Established-facts maintenance: promote stable confirmed decisions into `state.established_facts` with source/evidence; when a new answer contradicts an established fact, mark the fact disputed and preserve the contradicted fact instead of deleting it. When the user later confirms the new direction, record the superseding decision as a new established fact and set `superseded_by: <new fact id>` on the disputed fact — that is the only way to release the deterministic floor pressure while keeping the audit trail.

TRANSITION VALIDATION: if a trigger is present, the affected dimension must not improve and overall ambiguity must rise vs the prior scored round, unless the trigger is explicitly marked disputed or unresolved with rationale.

Convergence Pacing deferral: do not add a min-round floor, score-drop cap, confidence dampening, or other explicit pacing brake. Bidirectional scoring is the pacing mechanism.

**Scoring prompt** (use opus model, temperature 0.1 for consistency):

```
Given the following interview transcript for a {greenfield|brownfield} project, score clarity on each dimension from 0.0 to 1.0. If the initial context or transcript was summarized for prompt safety, score from that summary plus the preserved round decisions/gaps; do not re-expand raw oversized context. Honor the locked Round 0 topology: score every active component independently and never drop confirmed sibling components just because one component is already clear.

Original idea or prompt-safe initial-context summary: {idea_or_initial_context_summary}

Transcript or prompt-safe transcript summary:
{all rounds Q&A or summarized transcript}

Locked topology:
{state.topology.components and state.topology.deferrals}

Established facts:
{state.established_facts}

Trace summary:
{state.trace_summary if --trace was active, else "not requested"}

Score each active component on each dimension, then provide the overall dimension scores as the minimum or coverage-weighted weakest score across active components. Deferred components are excluded from ambiguity math but must remain listed in topology and the final spec.

Score each dimension:
1. Goal Clarity (0.0-1.0): Is the primary objective unambiguous? Can you state it in one sentence without qualifiers? Can you name the key entities (nouns) and their relationships (verbs) without ambiguity?
2. Constraint Clarity (0.0-1.0): Are the boundaries, limitations, and non-goals clear?
3. Success Criteria Clarity (0.0-1.0): Could you write a test that verifies success? Are acceptance criteria concrete?
{4. Context Clarity (0.0-1.0): [brownfield only] Do we understand the existing system well enough to modify it safely? Do the identified entities map cleanly to existing codebase structures?}

For each dimension provide:
- score: float (0.0-1.0)
- justification: one sentence explaining the score
- gap: what's still unclear (if score < 0.9)

Also identify:
- weakest_component_id: the active component with the lowest clarity after applying rotation across components when N > 1
- weakest_dimension: the single lowest-confidence dimension for that component this round
- weakest_dimension_rationale: one sentence explaining why this component/dimension pair is the highest-leverage target for the next question
- component_scores: object keyed by component id, with per-dimension scores and gaps
- structured_scorer_output: object containing triggers, trigger_status, affected_component, affected_dimension, prior_dimension_score, new_dimension_score, prior_ambiguity, new_ambiguity, evidence, contradicted_established_fact when relevant, and disputed_unresolved_rationale when applicable

5. Ontology Extraction: Identify all key entities (nouns) discussed in the transcript.

{If round > 1, inject: "Previous round's entities: {prior_entities_json from state.ontology_snapshots[-1]}. REUSE these entity names where the concept is the same. Only introduce new names for genuinely new concepts."}

For each entity provide:
- name: string (the entity name, e.g., "User", "Order", "PaymentMethod")
- type: string (e.g., "core domain", "supporting", "external system")
- fields: string[] (key attributes mentioned)
- relationships: string[] (e.g., "User has many Orders")

Respond as JSON. Include an additional "ontology" key containing the entities array alongside the dimension scores.
```

**Calculate ambiguity:**

Greenfield: `ambiguity = 1 - (goal × 0.40 + constraints × 0.30 + criteria × 0.30)`
Brownfield: `ambiguity = 1 - (goal × 0.35 + constraints × 0.25 + criteria × 0.25 + context × 0.15)`

**Calculate ontology stability:**

**Round 1 special case:** For the first round, skip stability comparison. All entities are "new". Set stability_ratio = N/A. If any round produces zero entities, set stability_ratio = N/A (avoids division by zero).

For rounds 2+, compare with the previous round's entity list:
- `stable_entities`: entities present in both rounds with the same name
- `changed_entities`: entities with different names but the same type AND >50% field overlap (treated as renamed, not new+removed)
- `new_entities`: entities in this round not matched by name or fuzzy-match to any previous entity
- `removed_entities`: entities in the previous round not matched to any current entity
- `stability_ratio`: (stable + changed) / total_entities (0.0 to 1.0, where 1.0 = fully converged)

This formula counts renamed entities (changed) toward stability. Renamed entities indicate the concept persists even if the name shifted — this is convergence, not instability. Two entities with different names but the same `type` and >50% field overlap should be classified as "changed" (renamed), not as one removed and one added.

**Show your work:** Before reporting stability numbers, briefly list which entities were matched (by name or fuzzy) and which are new/removed. This lets the user sanity-check the matching.

Store the ontology snapshot (entities + stability_ratio + matching_reasoning) in `state.ontology_snapshots[]`.

### Step 2d: Report Progress

After scoring, show the user their progress:

```
Round {n} complete.

| Dimension | Score | Weight | Weighted | Gap |
|-----------|-------|--------|----------|-----|
| Goal | {s} | {w} | {s*w} | {gap or "Clear"} |
| Constraints | {s} | {w} | {s*w} | {gap or "Clear"} |
| Success Criteria | {s} | {w} | {s*w} | {gap or "Clear"} |
| Context (brownfield) | {s} | {w} | {s*w} | {gap or "Clear"} |
| **Ambiguity** | | | **{prior_score}% -> {score}% {up|down|flat}** | {if up: trigger name such as "A direct contradiction"} |
| **Floor** (only when clamped) | | | **{floor}%** | {dominant cause: disputed fact / unscored component / auto-answer dilution} |

**Topology:** Targeted {target_component_name} | Active: {active_component_count} | Deferred: {deferred_component_count} | Next rotation after: {last_targeted_component_id}

**Ontology:** {entity_count} entities | Stability: {stability_ratio} | New: {new} | Changed: {changed} | Stable: {stable}
**Milestone:** {prior_milestone} → {current_milestone}{milestone_transition ? " — lateral panel convened" : ""}

**Next target:** {target_component_name} / {weakest_dimension} — {weakest_dimension_rationale}

{score <= threshold ? "Clarity threshold met! Ready to proceed." : "Focusing next question on: {weakest_dimension}"}

```

Apply `language.instruction` when present before showing this progress report so status text, gaps, and next-target phrasing stay in the preserved session language.

Then apply the self-proofread once to narrative status text, generated prose cells, gaps, and next-target phrasing; preserve only table structure, fixed status labels, scores, weights, component ids, and trigger tokens.

### Step 2e: Update State

Update state in two phases. The `ask` answer is first recorded by the runtime as an `answered` shell. Scoring then enriches the same round record to `scored` with global scores, per-component `topology.components[].clarity_scores`, `topology.components[].weakest_dimension`, trigger metadata, established-facts changes, ontology snapshot, `topology.last_targeted_component_id`, `auto_researched_rounds`, `auto_answered_rounds`, and `architect_failures`. When `deepInterview` ask metadata is present, no manual per-round `gjc state write` is required for the answer shell; only scoring enrichment/state maintenance remains. When metadata is absent, use the legacy `gjc state write` path to persist the new round and never patch `.gjc/_session-{sessionid}/state` directly unless an explicit force override is active.
Also recompute and persist `ambiguity_milestone` each round (detect band transitions for the Phase 3 panel), and persist `auto_answer_streak`, `refined_rounds`, `lateral_reviews`, and `lateral_panel_failures` alongside the existing fields.

### Step 2f: Check Soft Limits

- **Round 3+**: Allow early exit if user says "enough", "let's go", "build it"
- **Round 10**: Show soft warning: "We're at 10 rounds. Current ambiguity: {score}%. Continue or proceed with current clarity?"
- **Round 100**: Hard cap: "Maximum interview rounds reached. Proceeding with current clarity level ({score}%)."

## Phase 3: Lateral Review Panel (milestone-triggered)

The interview convenes a short multi-persona panel at **ambiguity-milestone transitions** instead of at fixed round numbers. Define milestone bands from the round's ambiguity score:

| Band | Ambiguity |
|------|-----------|
| `initial` | > 0.60 |
| `progress` | 0.60 ≥ a > 0.30 |
| `refined` | 0.30 ≥ a > threshold |
| `ready` | ≤ threshold |

A transition occurs whenever the band changes versus the prior scored round — in either direction, since bidirectional scoring can move the band back up. On a transition, and also before synthesizing any agent-supplied answer (auto-research candidates, an auto-answer, or a code/brownfield auto-confirm that carries real interpretation), convene the panel before generating or asking the next question.

**Personas (run in parallel, independent context):** dispatch `researcher`, `contrarian`, and `simplifier` as parallel fork-context subagents through the `lateral-review-panel.md` fragment, each with its own copy of the prompt-safe context so no persona anchors on another's framing. Add the `architect` persona when the round changed system shape — scope expansion, a new component or integration (trigger D), or any change to ownership or architecture. Each persona is a read-only architect: no edits, no `.gjc/` mutation, no execution.

**Folding findings:** validate each persona response, then fold only concrete, user-safe findings into the next single user-facing question — as 2-3 ranked answer options or one recommended draft. The panel never adds a second question, never mutates requirements on its own, and never marks the interview complete. The one-question-per-round rule stays intact.

**Persona lenses:**
- `researcher` — surfaces external facts, prior art, and unknowns the interview depends on.
- `contrarian` — challenges the core assumption: "What if the opposite were true? Is this constraint real or habitual?"
- `simplifier` — probes whether complexity can be removed: "What is the simplest version that is still valuable?"
- `architect` — checks system shape, ownership, and integration impact when scope changed.

**Ontology escalation:** if ambiguity stalls (same score ±0.05 for 3 rounds) or stays > 0.30 after 8 rounds, instruct the panel (especially `contrarian` + `architect`) to ask "What IS this, really?" — identify the core entity versus supporting views from the latest ontology snapshot before returning to feature questions.

**Bookkeeping:** record each convened panel in `state.lateral_reviews` (round, milestone transition or pre-answer trigger, personas dispatched, findings folded). On panel spawn or validation failure, fall back silently to the normal generated question and increment `lateral_panel_failures`; do not expose tool noise unless it changes the next user-facing question. The panel is a prompt-budgeted assist layer — summarize oversized context before dispatch.

