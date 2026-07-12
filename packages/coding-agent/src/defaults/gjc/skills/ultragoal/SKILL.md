---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.

source: "forked from upstream ultragoal skill and rebranded for GJC"
---

# ultragoal workflow definition

This public workflow definition owns the stable invocation metadata and static fragment map. Runtime phase content is assembled only from the typed static manifest; fragments are internal, parent-scoped assets and are not slash-command discoverable.

## Fragment ownership

- `dispatcher`: `skill-fragments/ultragoal/dispatcher.md`
- `goal-planning`: `skill-fragments/ultragoal/goal-planning.md`
- `execution`: `skill-fragments/ultragoal/execution.md`
- `cleanup-review`: `skill-fragments/ultragoal/cleanup-review.md`
- `checkpoint`: `skill-fragments/ultragoal/checkpoint.md`
- `handoff`: `skill-fragments/ultragoal/handoff.md`

The dispatcher is always selected. A declared phase adds exactly its matching fragment. Internal hook fragments remain on-demand parent-scoped subskill fragments; they are not public skills.
