---
name: team
description: Multi-worker GJC tmux team orchestration

source: "forked from upstream team skill and rebranded for GJC"
---

# team workflow definition

This public workflow definition owns the stable invocation metadata and static fragment map. Runtime phase content is assembled only from the typed static manifest; fragments are internal, parent-scoped assets and are not slash-command discoverable.

## Fragment ownership

- `dispatcher`: `skill-fragments/team/dispatcher.md`
- `preflight-intake`: `skill-fragments/team/preflight-intake.md`
- `starting`: `skill-fragments/team/starting.md`
- `running-monitoring`: `skill-fragments/team/running-monitoring.md`
- `integration-shutdown`: `skill-fragments/team/integration-shutdown.md`
- `terminal`: `skill-fragments/team/terminal.md`

The dispatcher is always selected. A declared phase adds exactly its matching fragment. Internal hook fragments remain on-demand parent-scoped subskill fragments; they are not public skills.
