   ```
   gjc state ralplan write --input '{"current_phase":"handoff"}' --json
   ```

   The skill tool then dispatches the execution skill same-turn and runs `gjc state ralplan handoff --to <team|ultragoal> --json` in-process to atomically demote ralplan, promote the callee, and sync `.gjc/_session-{sessionid}/state/skill-active-state.json`. You do not need to run the handoff verb yourself.

> **Important:** Architect and Critic MAY run in the same parallel batch only for the plan-only Critic lane after Planner persistence. Any Architect-dependent Critic pass MUST remain sequential: await Architect before issuing Critic, then apply the same review join gate before consensus.


Follow this ralplan-internal consensus workflow for consensus mode details.

