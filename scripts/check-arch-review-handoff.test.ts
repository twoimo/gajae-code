import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	checkArchReviewHandoff,
	checkHandoffContents,
	parseFindingHeadings,
	parseReadmeFindingRows,
} from "./check-arch-review-handoff";

const repoRoot = path.join(import.meta.dir, "..");

const matchingReadme = `
| Lane | File | Findings | Verdict |
|---|---|---|---|
| Performance | \`01-perf-binary-rss.md\` | 2 (1 high, 1 medium) | BLOCK |
| Prompts | \`02-prompts-context-tools-harness.md\` | 2 (1 critical, 1 low) | BLOCK |
| Architecture | \`03-package-arch-rust.md\` | 2 (2 medium) | BLOCK |
`;

const matchingLanes = {
	"01-perf-binary-rss.md": "### F1. HIGH — First\n### F2. MEDIUM — Second\n",
	"02-prompts-context-tools-harness.md": "### F1. CRITICAL → adjusted\n### F2. LOW — Second\n",
	"03-package-arch-rust.md": "### F1. MEDIUM — First\n### F2. MEDIUM — Second\n",
};

describe("architecture review handoff checker", () => {
	test("passes on the current corrected handoff files", async () => {
		await expect(checkArchReviewHandoff(repoRoot)).resolves.toEqual([]);
	});

	test("reports README and itemized-heading aggregate differences", () => {
		const readme = matchingReadme.replace("2 (1 high, 1 medium)", "2 (2 high)");

		expect(checkHandoffContents(readme, matchingLanes)).toEqual([
			"01-perf-binary-rss.md: README has 2 (2 high), itemized headings have 2 (1 high, 1 medium).",
		]);
	});

	test("parses CRLF, owner-adjustment suffixes, and lane-three bold headings while ignoring malformed headings", () => {
		const content = [
			"### F1. CRITICAL → owner-adjusted — Resolve conflict",
			"### F2. HIGH — Valid",
			"### F3. MEDIUM",
			"### Low",
			"**F4. Lane-three format**",
			"#### F5. HIGH — Wrong heading level",
			"### F6 HIGH — Missing period",
			"### F7. HIGHEST — Unknown severity",
			"text ### F8. HIGH — Not line-started",
		].join("\r\n");

		expect(parseFindingHeadings(content)).toEqual({
			total: 4,
			severities: { critical: 1, high: 1, medium: 1, low: 1 },
		});
	});

	test("parses README severity counts independent of ordering and omitted zero severities", () => {
		const rows = parseReadmeFindingRows(
			"| Lane | `lane.md` | 3 (2 low, 1 critical) | BLOCK |\n",
		);

		expect(rows.get("lane.md")).toEqual({
			file: "lane.md",
			total: 3,
			severities: { critical: 1, high: 0, medium: 0, low: 2 },
		});
	});
});
