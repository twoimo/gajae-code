from __future__ import annotations

from pathlib import Path

path = Path("packages/coding-agent/test/tools/resource-gc-redteam.test.ts")
text = path.read_text()

settings_import = 'import { Settings } from "../../src/config/settings";\n'
limit_import = 'import { resolveEffectiveMemoryLimit } from "../../src/runtime/memory-limit";\n'
if limit_import not in text:
    if settings_import not in text:
        raise SystemExit("settings import anchor missing")
    text = text.replace(settings_import, settings_import + limit_import, 1)

import_anchor = "\t__resetResourceGcForTest,\n"
seam = "\t__sampleWindowsJobMemoryForTest,\n\t__selectMemoryPressureDomainForTest,\n"
if "__sampleWindowsJobMemoryForTest" not in text:
    if import_anchor not in text:
        raise SystemExit("resource-gc import anchor missing")
    text = text.replace(import_anchor, import_anchor + seam, 1)

marker = '\tit("never evicts ownerless tabs under RSS pressure and warns once", async () => {'
tests = '''\tit("keeps uncapped Windows Job commit charge separate from physical RAM", () => {
\t\tconst gib = 1024 ** 3;
\t\tconst hostBytes = 16 * gib;
\t\tconst parentBytes = 2 * gib;
\t\tconst snapshot = __sampleWindowsJobMemoryForTest(hostBytes, parentBytes, {
\t\t\tkind: "job_snapshot",
\t\t\tplatform: "win32",
\t\t\tisInJob: true,
\t\t\tjobMemoryUsedBytes: String(20 * gib),
\t\t\tpeakJobMemoryUsedBytes: String(21 * gib),
\t\t\tprocessPrivateUsageBytes: String(20 * gib),
\t\t\tprocessWorkingSetBytes: String(parentBytes),
\t\t\tpeakProcessWorkingSetBytes: String(3 * gib),
\t\t});

\t\texpect(snapshot).not.toBeNull();
\t\texpect(snapshot?.parentBytes).toBe(parentBytes);
\t\texpect(snapshot?.domains).toContainEqual({
\t\t\thardCapBytes: Number.MAX_SAFE_INTEGER,
\t\t\ttotalUsageBytes: 20 * gib,
\t\t\tsource: "windows_job",
\t\t});
\t\texpect(snapshot?.domains).toContainEqual({
\t\t\thardCapBytes: hostBytes,
\t\t\ttotalUsageBytes: parentBytes,
\t\t\tsource: "windows_process_job_limit",
\t\t});
\t});

\tit("does not clamp a Windows commit-domain policy cap to physical RAM", () => {
\t\tconst gib = 1024 ** 3;
\t\tconst hostBytes = 16 * gib;
\t\tconst policyLimitBytes = 24 * gib;
\t\tconst snapshot = __sampleWindowsJobMemoryForTest(hostBytes, 2 * gib, {
\t\t\tkind: "job_snapshot",
\t\t\tplatform: "win32",
\t\t\tisInJob: true,
\t\t\tjobMemoryUsedBytes: String(20 * gib),
\t\t\tpeakJobMemoryUsedBytes: String(21 * gib),
\t\t\tprocessPrivateUsageBytes: String(20 * gib),
\t\t\tprocessWorkingSetBytes: String(2 * gib),
\t\t\tpeakProcessWorkingSetBytes: String(3 * gib),
\t\t});
\t\texpect(snapshot).not.toBeNull();
\t\tconst pressure = __selectMemoryPressureDomainForTest(snapshot!, policyLimitBytes);
\t\tconst limit = resolveEffectiveMemoryLimit({
\t\t\thardCapBytes: pressure.hardCapBytes,
\t\t\tpolicyLimitBytes,
\t\t});

\t\texpect(pressure.source).toBe("windows_job");
\t\texpect(pressure.totalUsageBytes).toBe(20 * gib);
\t\texpect(limit.effectiveBytes).toBe(policyLimitBytes);
\t\texpect(limit.effectiveBytes).toBeGreaterThan(hostBytes);
\t\tconst usageRatio = pressure.totalUsageBytes / limit.effectiveBytes!;
\t\texpect(usageRatio).toBeCloseTo(20 / 24, 8);
\t\texpect(usageRatio).toBeLessThan(1);
\t});

'''
if "keeps uncapped Windows Job commit charge separate from physical RAM" not in text:
    if text.count(marker) != 1:
        raise SystemExit("memory regression insertion anchor missing")
    text = text.replace(marker, tests + marker, 1)

path.write_text(text)
