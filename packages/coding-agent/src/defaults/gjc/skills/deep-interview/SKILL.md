---
name: deep-interview
description: Socratic deep interview with mathematical ambiguity gating before explicit execution approval
argument-hint: "[--trace] [--quick|--standard|--deep] <idea or vague description>"
pipeline: [deep-interview, ralplan]
handoff-policy: approval-required
handoff: .gjc/_session-{sessionid}/specs/deep-interview-{slug}.md
level: 3

source: "forked from upstream deep-interview skill and rebranded for GJC"
---

# deep-interview workflow definition

This public workflow definition owns the stable invocation metadata and static fragment map. Runtime phase content is assembled only from the typed static manifest; fragments are internal, parent-scoped assets and are not slash-command discoverable.

## Fragment ownership

- `dispatcher`: `skill-fragments/deep-interview/dispatcher.md`
- `threshold-suitability`: `skill-fragments/deep-interview/threshold-suitability.md`
- `initialize-topology`: `skill-fragments/deep-interview/initialize-topology.md`
- `interviewing`: `skill-fragments/deep-interview/interviewing.md`
- `closure-spec`: `skill-fragments/deep-interview/closure-spec.md`
- `handoff`: `skill-fragments/deep-interview/handoff.md`

The dispatcher is always selected. A declared phase adds exactly its matching fragment. Internal hook fragments remain on-demand parent-scoped subskill fragments; they are not public skills.
