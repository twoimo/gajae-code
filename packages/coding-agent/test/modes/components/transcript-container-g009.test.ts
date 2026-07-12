import { describe, expect, test } from "bun:test";
import type { Component, ViewportRowComponent } from "@gajae-code/tui";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";

function row(label: string, renders: { count: number }): ViewportRowComponent {
	return {
		rowCountIsWidthInvariant: true,
		getLogicalRowCount: () => 1,
		renderRows: (_width: number, start: number, end: number) => {
			renders.count++;
			return start === 0 && end > 0 ? [label] : [];
		},
		render: () => {
			throw new Error("row provider must not fall back to render()");
		},
		invalidate: () => {},
	};
}

describe("TranscriptContainer viewport rows", () => {
	test("indexes a large transcript once and renders only its requested row window", () => {
		const transcript = new TranscriptContainer();
		const renders = { count: 0 };
		for (let index = 0; index < 100_000; index++) transcript.addChild(row(`row ${index}`, renders));
		expect(transcript.getDirtyRanges()).toEqual([{ start: 0, end: 100_000 }]);

		expect(transcript.getLogicalRowCount(80)).toBe(100_000);
		renders.count = 0;
		expect(transcript.renderRows(80, 99_980, 100_000)).toEqual(
			Array.from({ length: 20 }, (_value, index) => `row ${99_980 + index}`),
		);
		expect(renders.count).toBe(20);
	});

	test("uses stable identities and revisions and reports only changed message rows", () => {
		const transcript = new TranscriptContainer();
		const first = { value: "first" };
		const second = { value: "second" };
		const firstComponent: Component = { render: () => [first.value], invalidate: () => {} };
		const secondComponent: Component = { render: () => [second.value], invalidate: () => {} };
		transcript.addChild(firstComponent);
		transcript.addChild(secondComponent);
		const initial = transcript.renderRowsWithMetadata(80, 1, 2).metadata[0];
		const identity = initial?.identity;
		const revision = initial?.revision;

		transcript.getDirtyRanges();

		second.value = "updated";
		transcript.markChildDirty(secondComponent);

		const updated = transcript.renderRowsWithMetadata(80, 1, 2).metadata[0];
		expect(updated?.identity).toBe(identity);
		expect(updated?.revision).toBe(((revision as number) ?? 0) + 1);
		expect(transcript.getDirtyRanges()).toEqual([{ start: 1, end: 2 }]);
	});
});
