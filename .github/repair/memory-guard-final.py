from __future__ import annotations

import re
from pathlib import Path


def block_end(text: str, open_brace: int) -> int:
    depth = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    i = open_brace
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if line_comment:
            if ch == "\n":
                line_comment = False
            i += 1
            continue
        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue
            i += 1
            continue
        if quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = None
            i += 1
            continue
        if ch == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue
        if ch in ('"', "'", "`"):
            quote = ch
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise RuntimeError("unterminated block")


def replace_named_block(text: str, marker: str, replacement: str) -> str:
    start = text.find(marker)
    if start < 0:
        if replacement.strip() in text:
            return text
        raise RuntimeError(f"missing marker: {marker}")
    open_brace = text.find("{", start)
    if open_brace < 0:
        raise RuntimeError(f"missing opening brace: {marker}")
    end = block_end(text, open_brace)
    return text[:start] + replacement + text[end + 1 :]


def replace_method_body(text: str, method_marker: str, body: str) -> tuple[str, str]:
    start = text.find(method_marker)
    if start < 0:
        raise RuntimeError(f"missing method: {method_marker}")
    open_brace = text.find("{", start)
    end = block_end(text, open_brace)
    signature = text[start:open_brace]
    return text[:open_brace] + "{\n" + body.rstrip() + "\n\t}" + text[end + 1 :], signature


# ---------------------------------------------------------------------------
# resource-gc.ts: keep Windows commit and RSS accounting in coherent domains,
# load the native probe lazily, preserve real parent RSS, and release latches.
# ---------------------------------------------------------------------------
resource_path = Path("packages/coding-agent/src/tools/resource-gc.ts")
resource = resource_path.read_text()
resource = resource.replace('import { probeWindowsJobMemory } from "@gajae-code/natives";\n', "")

# Permit an uncapped resource domain. resolveEffectiveMemoryLimit already
# represents an absent hard cap with null; the old Windows code erased that
# distinction by substituting physical RAM.
domain_start = resource.find("interface MemoryPressureDomain")
if domain_start < 0:
    domain_start = resource.find("type MemoryPressureDomain")
if domain_start < 0:
    raise RuntimeError("MemoryPressureDomain not found")
domain_open = resource.find("{", domain_start)
domain_end = block_end(resource, domain_open)
domain_block = resource[domain_start : domain_end + 1]
if "hardCapBytes: number | null" not in domain_block:
    domain_block_new = domain_block.replace("hardCapBytes: number;", "hardCapBytes: number | null;")
    if domain_block_new == domain_block:
        raise RuntimeError("MemoryPressureDomain hardCapBytes anchor mismatch")
    resource = resource[:domain_start] + domain_block_new + resource[domain_end + 1 :]

if '"windows_process_working_set"' not in resource:
    source_anchor = '"windows_process_job_limit"'
    if source_anchor not in resource:
        raise RuntimeError("memory pressure source union anchor mismatch")
    resource = resource.replace(source_anchor, source_anchor + ' | "windows_process_working_set"', 1)

windows_replacement = '''type WindowsJobSnapshotLike = {
\tkind?: unknown;
\tjobMemoryLimitBytes?: unknown;
\tjobMemoryUsedBytes?: unknown;
\tprocessMemoryLimitBytes?: unknown;
\tprocessPrivateUsageBytes?: unknown;
\tprocessWorkingSetBytes?: unknown;
};

let windowsJobMemoryProbeForTest: (() => unknown | Promise<unknown>) | undefined;

export function __setWindowsJobMemoryProbeForTest(
\tprobe: (() => unknown | Promise<unknown>) | undefined,
): void {
\twindowsJobMemoryProbeForTest = probe;
}

async function probeWindowsJobMemorySafely(): Promise<unknown> {
\tif (windowsJobMemoryProbeForTest) return await windowsJobMemoryProbeForTest();
\ttry {
\t\tconst natives = await import("@gajae-code/natives");
\t\treturn natives.probeWindowsJobMemory();
\t} catch {
\t\t// The memory guard is optional. A missing/unbuilt native addon must not
\t\t// prevent browser-tab and screenshot cleanup from loading or running.
\t\treturn undefined;
\t}
}

function validUsage(value: unknown): number | null {
\tconst number = Number(value);
\treturn Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function validLimit(value: unknown): number | null {
\tif (value === undefined || value === null) return null;
\tconst number = Number(value);
\treturn Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function __sampleWindowsJobMemoryForTest(
\tvalue: unknown,
\thostBytes: number,
\tparentRssBytes: number,
): MemoryPressureSnapshot | null {
\tconst result = value as WindowsJobSnapshotLike | undefined;
\tif (result?.kind !== "job_snapshot") return null;

\tconst domains: MemoryPressureDomain[] = [];
\tconst jobUsage = validUsage(result.jobMemoryUsedBytes);
\tif (jobUsage !== null) {
\t\tdomains.push({
\t\t\thardCapBytes: validLimit(result.jobMemoryLimitBytes),
\t\t\ttotalUsageBytes: jobUsage,
\t\t\tsource: "windows_job",
\t\t});
\t}

\tconst processCommitUsage = validUsage(result.processPrivateUsageBytes);
\tif (processCommitUsage !== null) {
\t\tdomains.push({
\t\t\thardCapBytes: validLimit(result.processMemoryLimitBytes),
\t\t\ttotalUsageBytes: processCommitUsage,
\t\t\tsource: "windows_process_job_limit",
\t\t});
\t}

\tconst workingSetBytes = validUsage(result.processWorkingSetBytes);
\tif (workingSetBytes !== null && Number.isSafeInteger(hostBytes) && hostBytes > 0) {
\t\tdomains.push({
\t\t\thardCapBytes: hostBytes,
\t\t\ttotalUsageBytes: workingSetBytes,
\t\t\tsource: "windows_process_working_set",
\t\t});
\t}
\tif (domains.length === 0) return null;

\t// The policy-aware selector below chooses the pressured domain. Pick a
\t// stable representative here only for the snapshot's compatibility fields.
\tconst representative = domains.find(domain => domain.hardCapBytes !== null) ?? domains[0]!;
\treturn {
\t\t...representative,
\t\tparentBytes: workingSetBytes ?? parentRssBytes,
\t\tdomains,
\t};
}

async function sampleWindowsJobMemory(
\thostBytes: number,
\tparentRssBytes: number,
): Promise<MemoryPressureSnapshot | null> {
\treturn __sampleWindowsJobMemoryForTest(await probeWindowsJobMemorySafely(), hostBytes, parentRssBytes);
}'''
resource = replace_named_block(resource, "function sampleWindowsJobMemory", windows_replacement)

resource = resource.replace(
    "const job = sampleWindowsJobMemory(hostBytes);",
    "const job = await sampleWindowsJobMemory(hostBytes, parentBytes);",
)
resource = resource.replace(
    "const job = sampleWindowsJobMemory(hostBytes, parentBytes);",
    "const job = await sampleWindowsJobMemory(hostBytes, parentBytes);",
)
if "await sampleWindowsJobMemory(hostBytes, parentBytes)" not in resource:
    raise RuntimeError("Windows sample call anchor mismatch")

selector_replacement = '''export function __selectMemoryPressureDomainForTest(
\tsnapshot: MemoryPressureSnapshot,
\tpolicyLimitBytes: number | null | undefined,
): MemoryPressureDomain {
\tconst domains = snapshot.domains?.length ? snapshot.domains : [snapshot];
\tconst normalizedPolicyLimit =
\t\tNumber.isSafeInteger(policyLimitBytes) && (policyLimitBytes ?? 0) > 0 ? policyLimitBytes! : null;
\tconst ratio = (domain: MemoryPressureDomain): number => {
\t\tconst effective = resolveEffectiveMemoryLimit({
\t\t\thardCapBytes: domain.hardCapBytes,
\t\t\tpolicyLimitBytes: normalizedPolicyLimit,
\t\t}).effectiveBytes;
\t\treturn effective === null ? Number.NEGATIVE_INFINITY : domain.totalUsageBytes / effective;
\t};
\tlet selected = domains[0]!;
\tlet selectedRatio = ratio(selected);
\tfor (const candidate of domains.slice(1)) {
\t\tconst candidateRatio = ratio(candidate);
\t\tif (candidateRatio > selectedRatio) {
\t\t\tselected = candidate;
\t\t\tselectedRatio = candidateRatio;
\t\t}
\t}
\treturn selected;
}'''
resource = replace_named_block(resource, "export function __selectMemoryPressureDomainForTest", selector_replacement)

old_null = "\t\tif (limit.effectiveBytes === null) continue;"
new_null = '''\t\tif (limit.effectiveBytes === null) {
\t\t\tmemoryGuardGcActive.delete(sessionId);
\t\t\tmemoryGuardRestartAboveSince.delete(sessionId);
\t\t\tmemoryGuardRestartCooldownUntil.delete(sessionId);
\t\t\tcontinue;
\t\t}'''
if old_null in resource:
    resource = resource.replace(old_null, new_null, 1)
elif new_null not in resource:
    raise RuntimeError("effectiveBytes null latch-release anchor mismatch")

reset_anchor = "\tmemoryGuardLastEvaluatedAt.clear();"
if "windowsJobMemoryProbeForTest = undefined;" not in resource:
    if reset_anchor not in resource:
        raise RuntimeError("resource GC reset anchor mismatch")
    resource = resource.replace(reset_anchor, reset_anchor + "\n\twindowsJobMemoryProbeForTest = undefined;", 1)

resource_path.write_text(resource)


# ---------------------------------------------------------------------------
# MemoryGuardHost: make the next timer correspond to the earliest individual
# registration deadline rather than waking forever at the global minimum.
# ---------------------------------------------------------------------------
host_path = Path("packages/coding-agent/src/runtime/memory-guard.ts")
host = host_path.read_text()
class_start = host.find("export class MemoryGuardHost")
if class_start < 0:
    raise RuntimeError("MemoryGuardHost class missing")
class_open = host.find("{", class_start)
class_end = block_end(host, class_open)
class_text = host[class_start : class_end + 1]

current_pos = class_text.find("#currentSweepIntervalMs")
if current_pos < 0:
    raise RuntimeError("#currentSweepIntervalMs missing")
current_open = class_text.find("{", current_pos)
current_end = block_end(class_text, current_open)
current_block = class_text[current_pos : current_end + 1]
map_match = re.search(r"this\.#([A-Za-z0-9_]+)\.(?:values|size|entries)\b", current_block)
if not map_match:
    raise RuntimeError("unable to identify interval registration map")
interval_map = map_match.group(1)

field_pattern = re.compile(rf"(^\s*#{re.escape(interval_map)}\s*=\s*new Map<[^;]+;)", re.MULTILINE)
field_match = field_pattern.search(class_text)
if not field_match:
    # Handle an explicitly typed map initialized on the same line.
    field_pattern = re.compile(rf"(^\s*#{re.escape(interval_map)}[^\n]+new Map[^\n]+$)", re.MULTILINE)
    field_match = field_pattern.search(class_text)
if not field_match:
    raise RuntimeError(f"interval map field #{interval_map} missing")
if "#nextDueAt" not in class_text:
    insertion = field_match.group(0) + "\n\t#nextDueAt = new Map<string, number>();"
    class_text = class_text[: field_match.start()] + insertion + class_text[field_match.end() :]

# Every registration/update that writes the interval also resets that owner's
# own deadline. This is deliberately based on the normalized value stored in
# the existing interval map, preserving all validation in the original code.
set_pattern = re.compile(rf"this\.#${{NO_MATCH}}")
set_pattern = re.compile(rf"this\.# {re.escape(interval_map)}", re.VERBOSE)
# Use a line-oriented form because the existing writes are single statements.
set_lines = re.compile(rf"(^\s*this\.#${{NO_MATCH}})", re.MULTILINE)
set_lines = re.compile(
    rf"^(?P<indent>\s*)this\.#${{NO_MATCH}}$", re.MULTILINE
)
# Python f-string escaping above is intentionally replaced with the real map.
set_lines = re.compile(
    rf"^(?P<indent>\s*)this\.#${{MAP}}$".replace("${MAP}", re.escape(interval_map)), re.MULTILINE
)
# Fall back to a direct statement matcher with balanced-enough single-line args.
statement_pattern = re.compile(
    rf"^(?P<indent>\s*)this\.#${{MAP}}\.set\((?P<owner>[^,]+),\s*(?P<value>.+)\);\s*$".replace(
        "${MAP}", re.escape(interval_map)
    ),
    re.MULTILINE,
)

def add_due(match: re.Match[str]) -> str:
    statement = match.group(0)
    owner = match.group("owner").strip()
    indent = match.group("indent")
    return (
        statement
        + f"\n{indent}this.#nextDueAt.set("
        + owner
        + f", this.#schedulerNow() + (this.#{interval_map}.get("
        + owner
        + ") ?? 0));"
    )

class_text, set_count = statement_pattern.subn(add_due, class_text)
if set_count == 0 and "this.#nextDueAt.set(" not in class_text:
    raise RuntimeError("no MemoryGuardHost interval writes found")

# Remove deadlines with registrations and on teardown.
delete_pattern = re.compile(
    rf"^(?P<indent>\s*)this\.#${{MAP}}\.delete\((?P<owner>[^)]+)\);\s*$".replace(
        "${MAP}", re.escape(interval_map)
    ),
    re.MULTILINE,
)
class_text = delete_pattern.sub(
    lambda m: m.group(0)
    + f"\n{m.group('indent')}this.#nextDueAt.delete({m.group('owner').strip()});",
    class_text,
)
clear_statement = f"this.#{interval_map}.clear();"
if clear_statement in class_text and "this.#nextDueAt.clear();" not in class_text:
    class_text = class_text.replace(clear_statement, clear_statement + "\n\t\tthis.#nextDueAt.clear();", 1)

empty_value = "null" if "return null" in current_block else "undefined"
new_current_body = f'''\t\tif (this.#{interval_map}.size === 0) return {empty_value};
\t\tconst now = this.#schedulerNow();
\t\tlet earliest = Number.POSITIVE_INFINITY;
\t\tfor (const [ownerId, intervalMs] of this.#{interval_map}) {{
\t\t\tlet deadline = this.#nextDueAt.get(ownerId);
\t\t\tif (deadline === undefined) {{
\t\t\t\tdeadline = now + intervalMs;
\t\t\t\tthis.#nextDueAt.set(ownerId, deadline);
\t\t\t}}
\t\t\tearliest = Math.min(earliest, deadline);
\t\t}}
\t\treturn Math.max(0, earliest - now);'''
# Replace body relative to class text.
method_absolute = class_text.find("#currentSweepIntervalMs")
method_open = class_text.find("{", method_absolute)
method_end = block_end(class_text, method_open)
class_text = class_text[:method_open] + "{\n" + new_current_body + "\n\t}" + class_text[method_end + 1 :]

helper = f'''\n\t#schedulerNow(): number {{
\t\treturn Date.now();
\t}}

\t#advanceDueRegistrations(now: number = this.#schedulerNow()): void {{
\t\tfor (const [ownerId, intervalMs] of this.#{interval_map}) {{
\t\t\tconst deadline = this.#nextDueAt.get(ownerId) ?? now;
\t\t\tif (deadline > now) continue;
\t\t\tconst elapsedIntervals = Math.floor((now - deadline) / intervalMs) + 1;
\t\t\tthis.#nextDueAt.set(ownerId, deadline + elapsedIntervals * intervalMs);
\t\t}}
\t}}
'''
if "#advanceDueRegistrations" not in class_text:
    insert_at = class_text.find("#currentSweepIntervalMs")
    class_text = class_text[:insert_at] + helper + "\n\t" + class_text[insert_at:]

# Advance only when a sweep actually acquires the serialization lock. Locate
# the awaited sweep callback in the class and insert immediately before it.
if "this.#advanceDueRegistrations();\n" not in class_text:
    sweep_line = re.search(r"^(?P<indent>\s*)await\s+this\.[^;\n]*sweep[^;\n]*;\s*$", class_text, re.MULTILINE)
    if not sweep_line:
        # Some versions name the callback run rather than sweep.
        sweep_line = re.search(r"^(?P<indent>\s*)await\s+this\.[^;\n]*run[^;\n]*;\s*$", class_text, re.MULTILINE)
    if not sweep_line:
        raise RuntimeError("MemoryGuardHost awaited sweep callback not found")
    class_text = (
        class_text[: sweep_line.start()]
        + sweep_line.group("indent")
        + "this.#advanceDueRegistrations();\n"
        + sweep_line.group(0)
        + class_text[sweep_line.end() :]
    )

host = host[:class_start] + class_text + host[class_end + 1 :]
host_path.write_text(host)


# ---------------------------------------------------------------------------
# Direct Windows-domain regressions.
# ---------------------------------------------------------------------------
test_path = Path("packages/coding-agent/test/tools/resource-gc-redteam.test.ts")
if not test_path.exists():
    test_path = Path("packages/coding-agent/test/tools/resource-gc.test.ts")
tests = test_path.read_text()
import_match = re.search(
    r'import\s*\{(?P<body>.*?)\}\s*from\s*["\'][^"\']*resource-gc["\'];',
    tests,
    re.DOTALL,
)
if not import_match:
    raise RuntimeError("resource-gc test import block missing")
for symbol in ("__sampleWindowsJobMemoryForTest", "__selectMemoryPressureDomainForTest"):
    if symbol not in import_match.group("body"):
        body = import_match.group("body").rstrip() + f",\n\t{symbol}\n"
        tests = tests[: import_match.start("body")] + body + tests[import_match.end("body") :]
        import_match = re.search(
            r'import\s*\{(?P<body>.*?)\}\s*from\s*["\'][^"\']*resource-gc["\'];',
            tests,
            re.DOTALL,
        )

windows_tests = r'''

describe("Windows memory-domain accounting", () => {
	const GIB = 1024 ** 3;

	it("keeps uncapped Job commit charge policy-only even above physical RAM", () => {
		const snapshot = __sampleWindowsJobMemoryForTest(
			{
				kind: "job_snapshot",
				jobMemoryLimitBytes: null,
				jobMemoryUsedBytes: 24 * GIB,
				processMemoryLimitBytes: null,
				processPrivateUsageBytes: 12 * GIB,
				processWorkingSetBytes: 4 * GIB,
			},
			16 * GIB,
			3 * GIB,
		);
		expect(snapshot).not.toBeNull();
		const job = snapshot!.domains!.find(domain => domain.source === "windows_job");
		expect(job).toMatchObject({ hardCapBytes: null, totalUsageBytes: 24 * GIB });
		expect(snapshot!.parentBytes).toBe(4 * GIB);
		expect(__selectMemoryPressureDomainForTest(snapshot!, 32 * GIB).source).toBe("windows_job");
	});

	it("uses working set only for the physical-RAM RSS domain", () => {
		const snapshot = __sampleWindowsJobMemoryForTest(
			{
				kind: "job_snapshot",
				jobMemoryLimitBytes: 40 * GIB,
				jobMemoryUsedBytes: 20 * GIB,
				processMemoryLimitBytes: 30 * GIB,
				processPrivateUsageBytes: 18 * GIB,
				processWorkingSetBytes: 6 * GIB,
			},
			16 * GIB,
			5 * GIB,
		);
		const rss = snapshot!.domains!.find(domain => domain.source === "windows_process_working_set");
		expect(rss).toEqual({
			hardCapBytes: 16 * GIB,
			totalUsageBytes: 6 * GIB,
			source: "windows_process_working_set",
		});
		expect(snapshot!.parentBytes).toBe(6 * GIB);
	});
});
'''
if 'describe("Windows memory-domain accounting"' not in tests:
    tests += windows_tests
test_path.write_text(tests)


# ---------------------------------------------------------------------------
# Scheduler cadence regressions, generated against the existing option names.
# ---------------------------------------------------------------------------
scheduler_test_path = Path("packages/coding-agent/test/runtime/memory-guard.test.ts")
scheduler_tests = scheduler_test_path.read_text()
if "per-registration due cadence" not in scheduler_tests:
    # Ensure afterEach is available for fake-timer cleanup.
    first_import = re.search(r'import\s*\{(?P<body>[^}]*)\}\s*from\s*["\']bun:test["\'];', scheduler_tests)
    if not first_import:
        raise RuntimeError("bun:test import missing in memory-guard.test.ts")
    body = first_import.group("body")
    for symbol in ("afterEach", "vi"):
        if not re.search(rf"\b{symbol}\b", body):
            body = body.rstrip() + f", {symbol}"
    scheduler_tests = (
        scheduler_tests[: first_import.start("body")] + body + scheduler_tests[first_import.end("body") :]
    )

    options_match = re.search(r"(?:export\s+)?interface\s+MemoryGuardHostOptions\s*\{(?P<body>.*?)\n\}", host, re.DOTALL)
    if not options_match:
        options_match = re.search(r"type\s+MemoryGuardHostOptions\s*=\s*\{(?P<body>.*?)\n\};", host, re.DOTALL)
    if not options_match:
        raise RuntimeError("MemoryGuardHostOptions missing")
    option_body = options_match.group("body")
    option_names = set(re.findall(r"^\s*([A-Za-z0-9_]+)\??\s*:", option_body, re.MULTILINE))
    sweep_key = next((name for name in option_names if "sweep" in name.lower()), None)
    if not sweep_key:
        raise RuntimeError("MemoryGuardHost sweep option missing")

    option_lines = [f"\t\t\t{sweep_key}: sweep,"]
    for name in sorted(option_names):
        lower = name.lower()
        if name == sweep_key:
            continue
        if "settimeout" in lower:
            option_lines.append(f"\t\t\t{name}: (callback, delay) => setTimeout(callback, delay),")
        elif "cleartimeout" in lower:
            option_lines.append(f"\t\t\t{name}: handle => clearTimeout(handle),")
        elif lower in {"now", "monotonicnow"} or lower.endswith("now"):
            option_lines.append(f"\t\t\t{name}: () => Date.now(),")
        elif "log" in lower:
            option_lines.append(f"\t\t\t{name}: () => {{}},")
    options_literal = "\n".join(option_lines)

    scheduler_tests += f'''

afterEach(() => {{
\tvi.useRealTimers();
}});

describe("MemoryGuardHost per-registration due cadence", () => {{
\tit("wakes at each registration's own deadline instead of the global minimum cadence", async () => {{
\t\tvi.useFakeTimers();
\t\tvi.setSystemTime(0);
\t\tconst sweep = vi.fn(async () => {{}});
\t\tconst host = new MemoryGuardHost({{
{options_literal}
\t\t}});
\t\thost.register("fast", 70);
\t\thost.register("slow", 200);
\t\tawait vi.advanceTimersByTimeAsync(69);
\t\texpect(sweep).toHaveBeenCalledTimes(0);
\t\tawait vi.advanceTimersByTimeAsync(1);
\t\texpect(sweep).toHaveBeenCalledTimes(1);
\t\tawait vi.advanceTimersByTimeAsync(70);
\t\texpect(sweep).toHaveBeenCalledTimes(2);
\t\tawait vi.advanceTimersByTimeAsync(60);
\t\texpect(sweep).toHaveBeenCalledTimes(3);
\t\tawait vi.advanceTimersByTimeAsync(10);
\t\texpect(sweep).toHaveBeenCalledTimes(4);
\t}});

\tit("updateInterval replaces only the updated owner's deadline", async () => {{
\t\tvi.useFakeTimers();
\t\tvi.setSystemTime(0);
\t\tconst sweep = vi.fn(async () => {{}});
\t\tconst host = new MemoryGuardHost({{
{options_literal}
\t\t}});
\t\thost.register("owner", 100);
\t\tawait vi.advanceTimersByTimeAsync(50);
\t\thost.updateInterval("owner", 300);
\t\tawait vi.advanceTimersByTimeAsync(299);
\t\texpect(sweep).toHaveBeenCalledTimes(0);
\t\tawait vi.advanceTimersByTimeAsync(1);
\t\texpect(sweep).toHaveBeenCalledTimes(1);
\t}});

\tit("defers a consumed deadline while a sweep owns the serialization lock", async () => {{
\t\tvi.useFakeTimers();
\t\tvi.setSystemTime(0);
\t\tconst release = Promise.withResolvers<void>();
\t\tconst sweep = vi.fn(async () => await release.promise);
\t\tconst host = new MemoryGuardHost({{
{options_literal}
\t\t}});
\t\thost.register("owner", 100);
\t\tawait vi.advanceTimersByTimeAsync(100);
\t\texpect(sweep).toHaveBeenCalledTimes(1);
\t\tawait vi.advanceTimersByTimeAsync(100);
\t\texpect(sweep).toHaveBeenCalledTimes(1);
\t\trelease.resolve();
\t\tawait Promise.resolve();
\t\tawait vi.advanceTimersByTimeAsync(0);
\t\texpect(sweep.mock.calls.length).toBeGreaterThanOrEqual(1);
\t}});
}});
'''
    scheduler_test_path.write_text(scheduler_tests)
