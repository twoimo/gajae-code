#!/usr/bin/env bun

import * as path from "node:path";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type SeverityCounts = Record<Severity, number>;

export interface LaneDefinition {
	file: string;
	label: string;
}

export const LANES: readonly LaneDefinition[] = [
	{ file: "01-perf-binary-rss.md", label: "Performance / binary size / RSS" },
	{ file: "02-prompts-context-tools-harness.md", label: "Prompts / context / tools / harness" },
	{ file: "03-package-arch-rust.md", label: "Package architecture / maintainability / Rust-port" },
] as const;

export interface FindingAggregate {
	total: number;
	severities: SeverityCounts;
}

export interface ReadmeFindingAggregate extends FindingAggregate {
	file: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const directFindingHeadingPattern = /^###\s+F(\d+)\.\s+(CRITICAL|HIGH|MEDIUM|LOW)\b.*$/i;
const severitySectionPattern = /^###\s+(CRITICAL|HIGH|MEDIUM|LOW)\s*$/i;
const sectionFindingPattern = /^\*\*F(\d+)\..*?\*\*/;

function emptySeverityCounts(): SeverityCounts {
	return { critical: 0, high: 0, medium: 0, low: 0 };
}

export function parseFindingHeadings(content: string): FindingAggregate {
	const severities = emptySeverityCounts();
	let total = 0;
	let sectionSeverity: Severity | undefined;

	for (const line of content.split(/\r?\n/)) {
		const directMatch = directFindingHeadingPattern.exec(line);
		if (directMatch) {
			const severity = directMatch[2]?.toLowerCase() as Severity;
			severities[severity]++;
			total++;
			continue;
		}

		const sectionMatch = severitySectionPattern.exec(line);
		if (sectionMatch) {
			sectionSeverity = sectionMatch[1]?.toLowerCase() as Severity;
			continue;
		}

		if (sectionSeverity && sectionFindingPattern.test(line)) {
			severities[sectionSeverity]++;
			total++;
		}
	}

	return { total, severities };
}

export function parseReadmeFindingRows(content: string): Map<string, ReadmeFindingAggregate> {
	const rows = new Map<string, ReadmeFindingAggregate>();

	for (const line of content.split(/\r?\n/)) {
		if (!line.startsWith("|")) continue;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map(cell => cell.trim());
		if (cells.length !== 4) continue;

		const file = /^`([^`]+\.md)`$/.exec(cells[1] ?? "")?.[1];
		const findings = /^(\d+)\s*\(([^)]+)\)$/.exec(cells[2] ?? "");
		if (!file || !findings) continue;

		const severities = emptySeverityCounts();
		for (const severityMatch of findings[2]?.matchAll(/(\d+)\s+(critical|high|medium|low)\b/gi) ?? []) {
			const severity = severityMatch[2]?.toLowerCase() as Severity | undefined;
			if (severity) severities[severity] += Number(severityMatch[1]);
		}

		rows.set(file, {
			file,
			total: Number(findings[1]),
			severities,
		});
	}

	return rows;
}

function formatAggregate(aggregate: FindingAggregate): string {
	const details = SEVERITIES.filter(severity => aggregate.severities[severity] > 0)
		.map(severity => `${aggregate.severities[severity]} ${severity}`)
		.join(", ");
	return `${aggregate.total} (${details})`;
}

export function checkHandoffContents(readme: string, laneContents: Readonly<Record<string, string>>): string[] {
	const errors: string[] = [];
	const readmeRows = parseReadmeFindingRows(readme);

	for (const lane of LANES) {
		const content = laneContents[lane.file];
		if (content === undefined) {
			errors.push(`${lane.file}: lane content is missing.`);
			continue;
		}

		const actual = parseFindingHeadings(content);
		const documented = readmeRows.get(lane.file);
		if (!documented) {
			errors.push(`handoff/README.md: missing parseable findings row for ${lane.file}.`);
			continue;
		}

		if (
			documented.total !== actual.total ||
			SEVERITIES.some(severity => documented.severities[severity] !== actual.severities[severity])
		) {
			errors.push(
				`${lane.file}: README has ${formatAggregate(documented)}, itemized headings have ${formatAggregate(actual)}.`,
			);
		}
	}

	return errors;
}

export async function checkArchReviewHandoff(root = repoRoot): Promise<string[]> {
	const handoffDir = path.join(root, "handoff");
	const readme = await Bun.file(path.join(handoffDir, "README.md")).text();
	const laneContents = Object.fromEntries(
		await Promise.all(
			LANES.map(async lane => [lane.file, await Bun.file(path.join(handoffDir, lane.file)).text()] as const),
		),
	);
	return checkHandoffContents(readme, laneContents);
}

if (import.meta.main) {
	const errors = await checkArchReviewHandoff();
	if (errors.length > 0) {
		console.error("Architecture review handoff findings check failed:");
		for (const error of errors) console.error(`- ${error}`);
		process.exit(1);
	}

	console.log("Architecture review handoff findings match the itemized headings.");
}
