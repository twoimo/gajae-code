import { describe, expect, test } from "bun:test";
import {
	CANONICAL_SKILLS,
	checkSkillPromptTokenContracts,
	baselinePath,
	corpusPath,
	DISPATCHER_TOKEN_BUDGET,
	estimateSkillPromptTokens,
	isSkillPromptTokenBaseline,
	isSkillPromptTokenCorpus,
	MINIMUM_SAVINGS,
	NORMALIZED_SENTINELS,
	normalizeSkillPrompt,
	readBaseline,
	readCorpus,
} from "./measure-skill-prompt-tokens";

describe("skill prompt token measurement", () => {
	test("ships valid frozen baseline and corpus schemas for every canonical workflow", async () => {
		const [baseline, corpus] = await Promise.all([readBaseline(), readCorpus()]);
		expect(isSkillPromptTokenBaseline(baseline)).toBe(true);
		expect(isSkillPromptTokenCorpus(corpus)).toBe(true);
		expect(Object.keys(baseline.skills)).toEqual(CANONICAL_SKILLS.map(skill => skill.id));
		expect(corpus.cases.map(entry => `${entry.skill}:${entry.kind}`)).toEqual(
			CANONICAL_SKILLS.flatMap(skill => [`${skill.id}:dispatcher`, `${skill.id}:phase`]),
		);
		for (const entry of corpus.cases) {
			expect(entry.measurement.estimatedTokens).toBe(Math.ceil(entry.measurement.chars / 4));
			expect(entry.expectedFragmentIds).toHaveLength(entry.kind === "dispatcher" ? 1 : 2);
		}
	});

	test("normalizes volatile values idempotently with fixed non-empty sentinels", () => {
		const prompt = [
			"User: inspect the current request",
			"Path: /Users/example/project",
			"Timestamp: 2026-07-11T12:34:56.789Z",
			"session-019f52e3-79e8-7000-a966-24b1ffea4905 uses 019f52e3-79e8-7000-a966-24b1ffea4905 on 2026-07-11",
		].join("\n");
		const normalized = normalizeSkillPrompt(prompt);
		expect(normalized).toContain(NORMALIZED_SENTINELS.userArgs);
		expect(normalized).toContain(NORMALIZED_SENTINELS.sessionId);
		expect(normalized).toContain(NORMALIZED_SENTINELS.uuid);
		expect(normalized).toContain(NORMALIZED_SENTINELS.date);
		expect(normalized).toContain(NORMALIZED_SENTINELS.absolutePath);
		expect(normalized).toContain(NORMALIZED_SENTINELS.timestamp);
		expect(normalizeSkillPrompt(normalized)).toBe(normalized);
	});

	test("estimates exactly ceiling characters divided by four", () => {
		expect(estimateSkillPromptTokens("")).toBe(0);
		expect(estimateSkillPromptTokens("1234")).toBe(1);
		expect(estimateSkillPromptTokens("12345")).toBe(2);
	});

	test("reassembles the checked corpus deterministically and enforces dispatcher and savings contracts", async () => {
		const [baselineBefore, corpusBefore] = await Promise.all([Bun.file(baselinePath).text(), Bun.file(corpusPath).text()]);
		const result = await checkSkillPromptTokenContracts();
		expect(await Bun.file(baselinePath).text()).toBe(baselineBefore);
		expect(await Bun.file(corpusPath).text()).toBe(corpusBefore);
		for (const skill of CANONICAL_SKILLS) {
			expect(result.dispatcherTokens[skill.id]).toBeLessThanOrEqual(DISPATCHER_TOKEN_BUDGET);
			expect(result.savings[skill.id]).toBeGreaterThanOrEqual(MINIMUM_SAVINGS[skill.id]);
		}
	});
});
