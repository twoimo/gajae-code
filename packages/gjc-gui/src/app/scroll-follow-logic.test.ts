import { describe, expect, test } from "bun:test";
import { shouldStickToBottom } from "./scroll-follow-logic";

describe("scroll follow logic", () => {
	test("sticks near the bottom within threshold", () => {
		expect(shouldStickToBottom(920, 500, 1450, 72)).toBe(true);
	});

	test("does not stick when user scrolled up", () => {
		expect(shouldStickToBottom(700, 500, 1450, 72)).toBe(false);
	});
});
