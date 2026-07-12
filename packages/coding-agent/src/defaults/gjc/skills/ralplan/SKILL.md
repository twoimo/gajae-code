---
name: ralplan
description: Consensus planning entrypoint that auto-gates vague team/ultragoal requests before execution
argument-hint: "[--interactive] [--deliberate] [--architect openai-code] [--critic openai-code] <task description>"
level: 4

source: "forked from upstream ralplan skill and rebranded for GJC"
---

# ralplan workflow definition

This public workflow definition owns the stable invocation metadata and static fragment map. Runtime phase content is assembled only from the typed static manifest; fragments are internal, parent-scoped assets and are not slash-command discoverable.

## Fragment ownership

- `dispatcher`: `skill-fragments/ralplan/dispatcher.md`
- `planner`: `skill-fragments/ralplan/planner.md`
- `review`: `skill-fragments/ralplan/review.md`
- `revision`: `skill-fragments/ralplan/revision.md`
- `post-interview`: `skill-fragments/ralplan/post-interview.md`
- `final-approval`: `skill-fragments/ralplan/final-approval.md`
- `handoff`: `skill-fragments/ralplan/handoff.md`

The dispatcher is always selected. A declared phase adds exactly its matching fragment. Internal hook fragments remain on-demand parent-scoped subskill fragments; they are not public skills.
