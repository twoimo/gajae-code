# Lane 1 — Performance / Binary Size / RSS Review

Verdict: **BLOCK / REQUEST CHANGES** — 18 findings. Reviewed at `dev` @ `3f602807` (2026-07-10).

## Summary

GJC's core performance posture is blocked for long-running and memory-constrained use. Documented compiled `--help` RSS baseline is about **114 MB even after minification**, native addon artifacts range from **38.8 MB to 191.9 MB**, synchronous full-catalog and repository discovery runs before first render, session loading is whole-file, and several retained structures grow proportional — or in the editor's case quadratically — to accumulated content.

The top recommendation is not another micro-optimization pass. GJC needs three architectural controls: **partition the native/compiled product**, **remove complete-data discovery from startup**, and **enforce byte-based retention budgets with viewport/disk-backed history**. Existing mitigations (minification, chat-child collapsing, cold-spill compaction, streaming Markdown throttling, native text helpers) are useful but do not bound the dominant costs.

## Root Cause: complete-product and complete-history residency

- One compiled executable and one native cdylib contain nearly every feature.
- Startup constructs complete registries and repository context before presenting the UI.
- Sessions preserve complete append-only metadata in RAM.
- Rendering constructs complete transcript line arrays before applying a differential terminal update.
- Caches are usually bounded by entry count, not retained bytes.
- Memory protection samples only selected subsystems, so no layer has an authoritative total.

## Key claims / measurements

- Native addon artifacts in `packages/natives/native/`: 38.8 MB darwin-arm64, 105.3 MB win32-x64-baseline, 112.3 MB darwin-x64-baseline, 184.6/184.8 MB linux-x64 variants, 191.9 MB linux-arm64. `crates/pi-natives/Cargo.toml:12-43` links the entire capability set into one cdylib.
- `packages/coding-agent/scripts/compile-args.ts:60-67` records measured `--help` RSS reduction from 302 MB → ~114 MB after minification. 114 MB for help remains a signal the compile boundary is too broad.
- Release x64 binaries correctly embed only the baseline native variant (`scripts/ci-release-build-binaries.ts:108-116`) — the problem is monolithic addon size, not accidental dual embedding.
- Embedded assets: `packages/ai/src/models.json` is 1.6 MB / 80,604 lines; ~181 KB bundled workflow definitions; ~179 KB primary prompts; 1.2 MB `docs-index.generated.ts`; 115 KB HTML export template; ~34 KB browser stealth scripts.
- Rust release profile already good: `Cargo.toml:18-27` opt-level=3, fat LTO, codegen-units=1; `dist` keeps unwinding but only strips debuginfo.
- Policy contradiction: `AGENTS.md:62-68` forbids dynamic imports while `cli.ts:25-53`, mode dispatch, browser loading, and `packages/ai/src/providers/register-builtins.ts` use them for laziness.

## Findings

### F1. HIGH — Split the monolithic native addon into feature-scoped artifacts
**Evidence:** `crates/pi-natives/Cargo.toml:12-43`; artifact sizes above.
`pi-natives` links clipboard/Wayland, image codecs, syntect syntaxes, PTY/shell, AST, grep, HTML conversion, notifications, Tokio and more into one cdylib — the dominant binary-size driver (40–190 MB per platform), plus extraction/page-cache/code-signing cost.
**Fix:** Split a small core addon (TUI text/hash/grep primitives) from optional shell/computer/image/AST/highlighting capabilities, or ship feature-scoped optional platform packages. Add per-target `cargo bloat`/`llvm-size` reports and release size gates.

### F2. HIGH — Partition the whole-product Bun compile
**Evidence:** `packages/coding-agent/scripts/compile-args.ts:18-74`.
The compile includes CLI, stats/browser/eval workers, native loader, Telegram daemon, Handlebars, plus models.json, docs index, prompts, export assets, generated stats client. ~114 MB RSS for trivial invocations.
**Fix:** Move optional daemons/workers/dashboard/export/docs packs into companion executables or separately installed resources. If one-file deployment stays mandatory, define core/full product variants and enforce compressed/uncompressed binary + `--help` RSS budgets in CI.

### F3. MEDIUM — Strip symbols from the shipped native `dist` profile after validation
**Evidence:** `Cargo.toml:18-27`; `.github/actions/build-native/action.yml:83-89`.
`profile.dist` overrides `strip=true` with `strip="debuginfo"`, retaining the symbol table on a 100–190 MB cdylib. Unwinding is required by the N-API `catch_unwind` contract; symbol retention is a separate decision.
**Fix:** Test `strip="symbols"`/`true` while keeping `panic="unwind"`; verify N-API exports, backtraces, crash diagnostics. Also compare `opt-level=2` and `s/z` for cold modules.

### F4. HIGH — Defer full model-catalog parsing and indexing
**Evidence:** `packages/coding-agent/src/config/model-registry.ts:1048-1059`, `:1191-1196`; `packages/ai/src/models.ts:25-31`; models.json 1.6 MB / 80,604 lines.
Registry constructor synchronously loads all models, applies policies, builds indexes; `runRootCommand` creates it before export handling and first render. Full JSON parse + thousands of model objects/maps on every launch.
**Fix:** Generate a compact provider/header index, load only provider IDs and minimal selectors initially, hydrate the selected provider on demand. Move no-model paths before registry construction.

### F5. HIGH — Separate tool metadata from optional implementations
**Evidence:** `packages/coding-agent/src/tools/index.ts:1-70`; `packages/coding-agent/src/sdk.ts:1-153`; `packages/coding-agent/src/tools/browser/launch.ts:1-22`.
The tool barrel imports every implementation + prompt/dependency graph. `--no-tools` or a narrow allowlist doesn't prevent module loading. Browser support statically imports `@puppeteer/browsers` and 14 stealth scripts. `agent-session.ts` (~421 KB) and `session-manager.ts` (~166 KB) are also on the eager path.
**Fix:** Lightweight registry of names/schemas/factory descriptors; heavy implementations behind worker/service entrypoints or an explicitly approved compile-safe lazy boundary. Disabled tools must not evaluate their dependencies.

### F6. MEDIUM — Resolve the dynamic-import policy contradiction
**Evidence:** `AGENTS.md:62-68`; `packages/coding-agent/src/cli.ts:25-53`.
Contract forbids dynamic imports; current startup relies on them. Enforcing the rule regresses cold-start; adding more lazy boundaries violates policy.
**Fix:** Document narrow exceptions with compile-smoke tests, or adopt process/worker boundaries and generated static metadata. Product-level decision — do not leave maintainers choosing between policy and performance.

### F7. HIGH — Move workspace scanning out of the first-render gate
**Evidence:** `packages/coding-agent/src/sdk.ts:927-955`, `:1160-1195`.
Workspace-tree discovery is awaited with a 5,000 ms deadline before tool/session construction; large/slow repos can block first frame the full deadline.
**Fix:** Render the TUI shell immediately, use a small initial context budget, atomically refresh system prompt/tool context when discovery finishes. Cache by repository identity + invalidation revision.

### F8. HIGH — Stream session JSONL instead of whole-file loading
**Evidence:** `packages/coding-agent/src/session/session-manager.ts:950-962`, `:2931-2952`.
Resume reads the complete session as one string, parses the complete entry array, then residentizes/indexes. Peak memory ≈ raw JSONL + parsed graph + transformed entries + indexes; scales with file size, not active-branch size.
**Fix:** Incremental byte-stream parsing, header-first validation, build indexes as records arrive, materialize only active path + recent display window; keep historical branch bodies disk-backed.

### F9. HIGH — Avoid full old-session materialization during switching
**Evidence:** `packages/coding-agent/src/session/agent-session.ts:10620-10631`; `session-manager.ts:2873-2891`.
Switching materializes all current entries for rollback, builds old display context, copies queues, then fully loads the target — peak RSS can approach old canonical + old materialized + new raw/parsed simultaneously.
**Fix:** Load target into a temporary manager, swap after validation; keep rollback as a lightweight manager/path/revision reference; rematerialize only on actual rollback.

### F10. HIGH — Bound SessionManager metadata after compaction
**Evidence:** `session-manager.ts:2697-2746`, `:3822-3843`, `:4194-4269`.
Every record stays in `#fileEntries` and `#byId` forever. Cold-spill replaces heavy content but keeps entry objects/indexes; emergency checks count only compacted agent state. Compaction bounds provider-visible payload, not process memory.
**Fix:** Archived/paged compacted segments with a small branch index; keep only active path + recent display metadata + labels resident; page historical branches for export/tree navigation.

### F11. HIGH — Replace retained serialized "hashes" with compact digests/revisions
**Evidence:** `packages/agent/src/agent-loop.ts:349-411` (esp. 370-411).
`messageHashes` are full `JSON.stringify` results, rebuilt across the entire message list each model step and retained alongside normalized arrays. O(history bytes × steps) CPU + ~another serialized copy of history live; base64-heavy messages magnify both.
**Fix:** Fixed-size hashes, revision counters on messages/tool schemas, incremental append-only suffix hashing.

### F12. HIGH — Replace full-document editor snapshots with a bounded edit log
**Evidence:** `packages/tui/src/components/editor.ts:2213-2217`.
Every meaningful edit pushes `structuredClone(this.#state)` into an unbounded undo stack until submit/`setText`. O(N²) copied text; severe GC/latency for long drafts (1 MB draft edited char-by-char is pathological).
**Fix:** Operation deltas or persistent line structures, coalesce adjacent inserts/deletes, enforce entry AND byte limits. Large paste = one undo op backed by the paste/blob store.

### F13. HIGH — Make differential rendering viewport-bounded
**Evidence:** `packages/tui/src/tui.ts:1645-1703`, `:388-409`; `packages/coding-agent/src/modes/utils/ui-helpers.ts:55-143`.
Each frame renders/flattens the whole component tree, retains full `previousRaw`/`previousLines`, scans the off-screen prefix. The 400-child cap doesn't cap lines/bytes — a few huge messages make every 16 ms frame O(total transcript lines).
**Fix:** Cached component heights + viewport line index; render only dirty/visible components plus overscan; collapse/spill history by rendered line/byte budgets.

### F14. HIGH — Include all TUI/session retained memory in emergency budgets
**Evidence:** `packages/coding-agent/src/modes/interactive-mode.ts:402-405`; `agent-session.ts:7844-7873`; `packages/agent/src/compaction/compaction.ts:279-372`.
Retained-memory sample includes only Markdown cache bytes + chat-child count. Excludes renderer line arrays/maps, component caches, images, editor undo, kill ring, session-manager metadata. The 128 MB floor can miss real growth; fallback heap threshold up to 1.5 GiB is too late.
**Fix:** Byte gauge + hard local budget for every long-lived cache; aggregate renderer/editor/image/session-index/external/native memory; sample RSS/external in addition to `heapUsed`.

### F15. HIGH — Use byte-weighted Markdown caches
**Evidence:** `packages/tui/src/components/markdown.ts:42-66`, `:99-113`, `:315-334`.
Caps are entry-based (256 renders / 128 parses / 512 highlight blocks); highlight keys embed full code blocks up to 200 KB → 100+ MB possible in keys alone. `getRenderCacheRetainedBytes()` omits keys and parse token trees.
**Fix:** `lru-cache` `maxSize`/`sizeCalculation`, hash keys with source verification, one shared session byte budget; count keys/tokens/output lines in telemetry.

### F16. MEDIUM — Return the native batched width result
**Evidence:** `packages/tui/src/utils.ts:214-217`; `crates/pi-natives/src/text.rs:1414-1423`.
`visibleWidths()` calls the native batch, discards its result, then recomputes each width in JS — paying JS→Rust conversion + UTF-16 encoding + width scan, then repeating in JS on the renderer hot path.
**Fix:** Return `visibleWidthsNative(lines)` after parity tests, or delete the native call if Bun benchmarks faster; make the perf gate measure wall-clock/allocations rather than FFI-call count.

### F17. MEDIUM — Bounded top-K glob selection; remove duplicate sorting
**Evidence:** `packages/coding-agent/src/tools/find.ts:337-356`; `crates/pi-natives/src/glob.rs:119-210` (early-break only when sorting disabled: `:153-158`).
`sortByMtime=true` forces full candidate collection + native sort before truncation; streamed callbacks clone entries; JS then sorts the returned result again while its comment incorrectly claims native early termination.
**Fix:** K-sized min-heap of newest matches in Rust; avoid duplicate full records; delete the JS sort.

### F18. HIGH — Stop retaining image payloads in cache keys and duplicate maps
**Evidence:** `packages/coding-agent/src/modes/components/assistant-message.ts:72-80`, `:114-152`, `:247-270`; `packages/tui/src/components/image.ts:27-43`, `:68-141`.
Image payloads retained in original maps, converted maps, child-cache keys containing complete base64, `refetch` closures, and cached terminal escape sequences — multiple copies live until chat-child collapse. A few screenshots can add tens/hundreds of MB.
**Fix:** Content hash/blob-reference keys; centralize payload ownership in the blob store; image components retain only a reference + byte-budgeted protocol cache.

## Remediation priorities

1. **Hard product/memory boundaries:** split pi-natives core vs optional (F1); core/full compiled variants or companion executables (F2); authoritative retained-memory registry (F14).
2. **Cold-start critical path:** no-model paths before ModelRegistry (F4); metadata-only tool registry (F5); TUI shell before workspace scan (F7); release benchmarks for `--help` RSS, first frame, warm start, large-repo start.
3. **Disk-backed history + viewport rendering:** streamed JSONL (F8); archived compacted segments (F10); transactional session switch (F9); viewport line index (F13); byte-bounded caches (F15).
4. **Hot-path duplication:** visibleWidths (F16); digests instead of serialized strings (F11); top-K glob (F17); editor undo log (F12); image payload ownership (F18).

## Measurement gates to add

- Binary bytes + compressed release artifact bytes per target; extracted native addon bytes per target/capability.
- Compiled `--help` RSS and wall time; time to first TUI frame on empty/medium/large repositories.
- Resume/switch peak RSS for 10 MB, 100 MB, and deeply branched sessions.
- 10,000-token streaming frame p50/p95/p99 and allocations/frame.
- One-hour RSS slope with repeated compaction, images, tool output, session branching.
- Editor latency/RSS while typing and undoing a 1 MB draft.

## Executive summary

**Verdict: BLOCK.** Top three optimizations:
1. Split the native addon and whole-product compile boundary (dominates 39–192 MB artifacts and ~114 MB help RSS).
2. Remove full model/tool/workspace discovery from first render (provider sharding, metadata-only tool registries, async project-context completion).
3. Make memory byte-bounded and history disk/viewport-backed (session metadata, editor undo, full-transcript rendering, Markdown/image duplication, emergency accounting).
