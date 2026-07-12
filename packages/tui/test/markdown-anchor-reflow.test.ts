import { describe, expect, it } from "bun:test";
import { Container, Markdown, type ViewportRowMetadata } from "@gajae-code/tui";
import { defaultMarkdownTheme } from "./test-themes";

function semanticMarkdown(text: string, width: number) {
	const container = new Container();
	const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
	container.addChild(markdown);
	container.setViewportRowSource(markdown, { id: "markdown:document" });
	return container.renderRowsWithMetadata(width, 0, container.getLogicalRowCount(width));
}

function semanticRows(window: ReturnType<typeof semanticMarkdown>): ViewportRowMetadata[] {
	return window.metadata.filter((item): item is ViewportRowMetadata => item?.sourceId === "markdown:document");
}

describe("markdown bounded semantic metadata", () => {
	it("keeps topology-stable source spans across reflow", () => {
		const document = [
			"- short stable list item",
			"- a long sibling that wraps repeatedly at narrow widths and must not steal the first item span",
			"",
			"| header | value |",
			"| --- | --- |",
			"| stable row | another long value that reflows independently |",
		].join("\n");
		const wide = semanticRows(semanticMarkdown(document, 80));
		const narrow = semanticRows(semanticMarkdown(document, 18));
		expect(wide).not.toHaveLength(0);
		expect(narrow).not.toHaveLength(0);
		const selected = wide[0]!;
		expect(
			narrow.some(
				row =>
					row.graphemeStart !== undefined &&
					row.graphemeEnd !== undefined &&
					row.graphemeStart <= selected.graphemeStart! &&
					selected.graphemeStart! < row.graphemeEnd,
			),
		).toBe(true);
	});

	it("returns a page-sized window with metadata aligned to every emitted row", () => {
		const document = Array.from(
			{ length: 40 },
			(_value, index) => `- entry ${index} with Korean 가나다라마바사🙂 text`,
		).join("\n");
		const container = new Container();
		const markdown = new Markdown(document, 0, 0, defaultMarkdownTheme);
		container.addChild(markdown);
		container.setViewportRowSource(markdown, { id: "markdown:page" });
		const start = 10;
		const end = 16;
		const window = container.renderRowsWithMetadata(20, start, end);
		expect(window.lines).toHaveLength(end - start);
		expect(window.metadata).toHaveLength(window.lines.length);
		expect(window.metadata.some(item => item?.sourceId === "markdown:page")).toBe(true);
	});
});
