import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseBlocks } from "./markdown.tsx";

describe("markdown renderer", () => {
	test("parses headings, paragraphs, unordered and ordered lists", () => {
		expect(parseBlocks("# Title\n\nhello\n\n- one\n- two\n\n1. first\n2. second")).toMatchObject([
			{ kind: "heading", level: 1, text: "Title" },
			{ kind: "paragraph", text: "hello" },
			{ kind: "list", ordered: false, items: ["one", "two"] },
			{ kind: "list", ordered: true, items: ["first", "second"] },
		]);
	});

	test("parses blockquotes and horizontal rules", () => {
		expect(parseBlocks("> quoted **text**\n> still quoted\n\n---")).toMatchObject([
			{ kind: "blockquote", text: "quoted **text**\nstill quoted" },
			{ kind: "hr" },
		]);
	});

	test("renders inline bold, italic, code, links, and fenced code", () => {
		const html = renderToStaticMarkup(
			createElement(Markdown, { text: '**bold** *ital* `code` [site](https://example.com)\n\n```ts\nconst x = 1;\n```' }),
		);

		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>ital</em>");
		expect(html).toContain("<code>code</code>");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('class="markdown__code"');
		expect(html).toContain("const x = 1;");
	});

	test("renders blockquote, hr, strikethrough, and nested inline", () => {
		const html = renderToStaticMarkup(createElement(Markdown, { text: "> **quoted `code`**\n\n---\n\n~~old **bold**~~" }));

		expect(html).toContain("<blockquote><strong>quoted <code>code</code></strong></blockquote>");
		expect(html).toContain("<hr/>");
		expect(html).toContain("<del>old <strong>bold</strong></del>");
	});

	test("escapes HTML and refuses unsafe links", () => {
		const html = renderToStaticMarkup(createElement(Markdown, { text: '<script>x</script> [bad](javascript:alert(1))' }));

		expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("<script>");
	});
});
