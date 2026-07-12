## Pre-Execution Gate

Execution skills (`ultragoal`, `team`) implement bounded work; they are not scope-discovery lanes. Vague execution requests such as `team improve the app` are routed through ralplan so scope, acceptance criteria, consensus, and verification exist before code changes.

**Passes the gate** (specific enough for direct execution): file paths, issue/PR numbers, named symbols, explicit tests, numbered steps, acceptance criteria, error references, code blocks, or escape prefixes (`force:` / `!`). Examples: `team fix src/hooks/bridge.ts`, `team implement #42`, `team add validation to processKeywordDetector`, `team do:\n1. Add input validation\n2. Write tests`.

**Gated — redirected to ralplan**: `team fix this`, `team build the app`, `team improve performance`, `team add authentication`, `team make it better`.

Gate auto-pass signals: file path, issue/PR number, camelCase/PascalCase/snake_case symbol, test runner, numbered steps, acceptance criteria, error reference, code block, or escape prefix. If it fires on a well-specified prompt, add one concrete anchor; if you intentionally bypass, prefix `force:` or `!`.

On consensus approval, choose:
- **ultragoal**: goal-tracked autonomous execution with verification (recommended default)
- **team**: tmux-based coordinated workers only when interactive worker parallelization is required

A redirected request proceeds only through the structured approval option or an explicit execution-skill choice; `just do it` / `skip planning` alone leaves the plan `pending approval`.
