# Lane 3 — Package Architecture / Maintainability / Rust-Refactoring Review

Verdict: **BLOCK / REQUEST CHANGES** — 16 findings (3 high, 12 medium, 1 low). Reviewed at `dev` @ `3f602807` (2026-07-10).

## Summary

The monorepo has a coherent dependency direction and no TypeScript package cycle, but several boundaries are too porous: `utils` eagerly introduces the native runtime, `coding-agent` is a public god-package, and session/workflow orchestration concentrates in files of 4,000–11,600 lines. Release safety is the highest operational concern: **a tag can publish before the exact commit has passed the full test suite.**

Recommended direction: not wholesale package proliferation or wholesale Rust migration. Establish a small number of enforceable domain boundaries, generate release/native metadata from one manifest, and retain Rust for measured coarse-grained hot paths while eliminating duplicate execution and silent fallbacks.

## Dependency graph (source-level, inspected)

```text
native platform shims
        ↑
     natives
      ↑   ↑
   utils  tui
    ↑ ↑    ↑
   ai │    │
    ↑ │    │
 agent-core│
      ↑    │
      coding-agent ← stats (stats → ai, utils)
           ↑
       gajae-code

bridge-client   (independent; duplicates the agent-wire contract)
```

- `utils -> natives`: `packages/utils/src/procmgr.ts:3`, `packages/utils/src/ptree.ts:10` — the key semantic inversion: importing pure AI utilities transitively evaluates the native addon.
- `packages/agent/package.json:35-38` declares `natives` with no matching source import (remove).
- No direct package import cycle found.
- TS graph is NOT encoded as project references: root `tsconfig.json:2-7` references one aggregate; `packages/tsconfig.workspace.json:31-39` broadly includes everything.
- Cargo `members = ["crates/*"]` (`Cargo.toml:305-315`) excludes vendored brush crates and the stale `crates/git-daemon` placeholder; patch table at `Cargo.toml:348-358` points at the excluded brush trees.

## Coding-agent concentration (~999 TS source files)

| Hotspot | Size | Extraction signal |
|---|---:|---|
| `src/session/agent-session.ts` | 11,606 lines / 421 KB | Turn lifecycle, events, persistence, retry, compaction, MCP/tool discovery, model/session state, streaming safety, workflows, subprocess cleanup |
| `src/gjc-runtime/team-runtime.ts` | 4,709 lines / 172 KB | Scheduling, state, tmux/worktrees, validation, receipts, rendering |
| `src/gjc-runtime/ultragoal-runtime.ts` | >4,300 lines / 212 KB | Goal planning, persistence, migrations, review evidence, CLI |
| `src/session/session-manager.ts` | 4,326 lines / 166 KB | Storage, branching, indexes, migration, lifecycle |
| `src/modes/interactive/interactive-mode.ts` | 2,725 lines / 94 KB | App composition, input/render, lifecycle |
| `src/sdk.ts` | 2,559 lines / 98 KB | Broad SDK facade |
| `src/config/model-registry.ts` | ~105 KB | Model metadata/registry |
| `src/config/settings-schema.ts` | ~102 KB | Config surface |
| `src/notifications/telegram-daemon.ts` | ~104 KB | Daemon lifecycle + transport + domain |
| `src/modes/shared/mcp/coordinator.ts` | ~91 KB | MCP coordination |

Extraction order: shared protocol → session coordinators → workflow core → notification daemon boundary → app/TUI controllers. Do NOT publish every tool as a package; subsystem-owned directories/interfaces first.

## Findings

### High

**F1. Native process management leaks through the shared utils root** — `packages/utils/src/index.ts:15-21`; `procmgr.ts:3`; `ptree.ts:10`.
ESM re-export deps evaluate with the barrel, so `ai → utils → natives` becomes a runtime path; provider library unusable on unsupported native platforms.
**Fix:** Move process modules to a native-dependent boundary or non-eager entrypoint; remove the unused `natives` dep from `packages/agent`.

**F2. `AgentSession` is an 11,606-line god object** — `agent-session.ts:1158-1165` (class start).
**Fix:** Keep the facade; extract turn-lifecycle, persistence, retry/compaction, tool registry/discovery, workflow-context, and resource-lifecycle coordinators with isolated state and contract tests.

**F3. Release tags can publish before the exact commit passes full tests** — `scripts/release.ts:330-359`; tag jobs skip check/test in `.github/workflows/ci.yml:362-369`.
`release.ts` runs `bun run check` but not the full suite, tags and pushes immediately, then watches CI; `release_binary` accepts a skipped check. Recovery = force-moving a public tag.
**Fix:** Push the release commit, wait for required CI on that SHA, then create an immutable tag; tag publication depends on full test/check for that exact SHA.

### Medium

**F4. TS package DAG not compiler-enforced** — `tsconfig.json:2-7`, `packages/tsconfig.workspace.json:31-39`. Make package tsconfigs composite with references matching the manifest graph.

**F5. Workflow engines are CLI-package monoliths** — `team-runtime.ts:29-47`, `ultragoal-runtime.ts:1-40`. Introduce workflow-core contracts with persistence/clock/process/git ports; CLI parses args and renders typed results only.

**F6. coding-agent export map publishes internal topology** — `packages/coding-agent/package.json:95-105` (`./*` + hundreds of deep exports); `src/index.ts:1-50`. Define a small stable SDK/extension API; classify deep internals as private.

**F7. Bridge protocol contracts duplicated** — `packages/bridge-client/src/commands.ts:1-48` vs server registry `packages/coding-agent/src/modes/shared/agent-wire/scopes.ts:1-80`. SDK returns `Promise<unknown>`; conformance enforced by a cross-package source-import test. **Fix:** transport-neutral `@gajae-code/agent-wire` leaf package (protocol versions, command/response/event types, runtime schemas) consumed by both.

**F8. `pi-natives` is an excessively broad internal facade** — `crates/pi-natives/src/lib.rs:20-50`; `crates/pi-natives/Cargo.toml:13-50`. Split internal Rust rlibs (`pi-text`, `pi-search`, `pi-terminal`, `pi-computer`) while keeping ONE thin N-API/npm facade — do not multiply npm platform matrices.

**F9. Batched native width work discarded** — `packages/tui/src/utils.ts:214-216`. Same as perf-lane F16; return the native batch output after parity verification, or remove the call.

**F10. Required native edit paths silently fall back to TS** — `packages/coding-agent/src/edit/diff.ts:92-103`; `packages/coding-agent/src/edit/modes/replace.ts:39-55`. Addon defects become invisible slowdowns; two production implementations must stay equivalent. **Fix:** TS as differential test oracle; production native failure explicit/logged and narrowly bounded.

**F11. Native platform metadata manually duplicated** — `packages/natives/native/loader-state.js:31-39`; plus `packages/natives/package.json:57-63`, `scripts/ci-release-publish.ts:45-62`, `scripts/ci-release-build-binaries.ts:17-61`, workflow matrices. **Fix:** one checked-in platform manifest generating shims, loader maps, CI matrices, artifact prefixes, release targets.

**F12. Version sync omits Cargo and native sentinel truths** — `scripts/check-public-version-sync.ts:94-145`; separately rewritten by `scripts/release.ts:250-288`. **Fix:** one canonical version contract generating/checking every version-bearing surface (Cargo workspace version, all sentinel occurrences, catalog entries, platform shims).

**F13. PR affected-test mapping can run zero tests for production changes** — `scripts/ci-dev-affected.ts:572-588`; contract asserted at `scripts/ci-dev-affected.test.ts:361-364`. Source maps to tests by exact basename only; `agent-session.ts` has many `agent-session-*.test.ts` but no exact match → a PR can merge with no tests. **Fix:** ownership map/import graph; unmapped production changes default to owning-package sharded tests.

**F14. Brush vendoring lacks provenance and patch inventory** — `crates/brush-core-vendored/Cargo.toml:1-16`; local `ChildSessionAction` patch at `src/commands.rs:951-980`, documented only in `packages/coding-agent/test/agent-session-bash-detach.test.ts:384-397`. Both vendored trees keep independent lockfiles. **Fix:** manifest with upstream repo/tag/commit, import method, file hashes, patch series; scripted refresh/verify.

**F15. insane-search verifier doesn't verify pinned content** — `packages/coding-agent/scripts/verify-insane-vendor.ts:70-100`. Validates manifest shape/required files/forbidden patterns but not bytes against the pinned commit `4930634…`. **Fix:** hash manifest or upstream archive digest; verify every included byte; local changes as explicit patches.

### Low

**F16. Tests inside published `src` tree** — `packages/coding-agent/package.json:79-93`; `src/task/token-log.test.ts`, `src/cli/fixture-report.test.ts`. Move to `test/`; add a pack assertion that no `*.test.*` is published.

## Rust-port candidate table

| Candidate | Benefit | Cost / risk | Verdict |
|---|---|---|---|
| ANSI strip/width/wrap/truncate | High for long TUI frames; single Unicode/ANSI impl | N-API string conversion dominates tiny calls | **Keep in Rust, batch; fix discarded `visibleWidths` result** |
| Line diff, fuzzy edit, hashline | High on edit hot paths; Rust impls + differential tests exist | Dual TS fallback semantics | **Complete Rust ownership; TS = test oracle only** |
| Grep/glob/workspace scan/AST | High for large repos, parallel FS traversal | Large JS result graphs can erase gains | **Keep in Rust; coarse query/result contracts; benchmark serialization** |
| Syntax highlighting, HTML→MD | Medium-high; already Rust | Binary size, startup | **Keep, coarse document calls** |
| PTY/process tree/shell | High correctness/platform value | Native lifecycle load-bearing | **Keep in Rust; move TS ownership out of pure `utils`** |
| Exact model tokenization | Low: provider usage is authoritative | ~50 MB vocab tables, RSS, drift | **Do NOT reintroduce** — heuristic is deliberate (`packages/agent/src/compaction/compaction.ts:391-428`; enforced by `packages/agent/test/compaction-no-native-tokenizer.test.ts:1-38`) |
| BM25 tool-discovery scoring | Low at current corpus size | FFI setup > scoring work | **Keep in TS until profiling proves scale** |
| Apply-patch/envelope/config parsers | Low-medium | Control-flow/error-message sensitive, not CPU-bound | **Keep in TS**; port only a measured kernel if ever |
| Workflow/session state machines | Low perf value | Very high rewrite + N-API lifecycle complexity | **Do not port**; refactor TS boundaries first |
| Image resize/encoding | Medium; Bun ops already native-backed | Another byte boundary, addon size | **Keep orchestration in TS/Bun** unless codec/copy bottleneck measured |

Native packaging: prefer internal Rust rlibs + one npm/N-API distribution facade. Splitting the addon into multiple npm platform matrices multiplies the most fragile release surface.

## Tradeoffs (reviewer-recommended options)

| Decision | Preferred |
|---|---|
| Native packaging | One N-API facade over internal rlibs (not multiple npm addons) |
| Session decomposition | Internal coordinators behind `AgentSession` first (not immediate published packages) |
| Native failure behavior | Explicit failure + differential test oracle (not silent TS fallback) |
| Test selection | Ownership map/import graph with conservative fallback (not basename heuristic) |

## Executive summary

**Verdict: BLOCK.** The package DAG is acyclic, but ownership is not: pure utilities load natives, session/workflow runtimes are monoliths, and release publication isn't gated on full CI for the tagged SHA.

Top three structural actions:
1. Split `agent-wire`, pure/native utilities, session coordinators, and workflow core behind narrow public contracts.
2. Generate all version/platform/publish metadata from one manifest; tag only after full CI passes on the release SHA.
3. Keep only measured coarse hot paths in Rust, remove redundant/silent TS execution, make vendored/native provenance reproducible.
