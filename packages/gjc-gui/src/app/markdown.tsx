import type { ReactNode } from "react";

export function Markdown({ text }: { text: string }): ReactNode {
	return <>{parseBlocks(text).map((block, index) => renderBlock(block, index))}</>;
}

type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "paragraph"; text: string }
	| { kind: "blockquote"; text: string }
	| { kind: "hr" }
	| { kind: "code"; code: string; lang?: string }
	| { kind: "table"; headers: string[]; rows: string[][] }
	| { kind: "list"; ordered: boolean; items: ListItem[] };

type ListItem = { text: string; depth: number; children: ListItem[] };

export function parseBlocks(text: string): Block[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	let quote: string[] = [];
	let fence: { lang?: string; lines: string[] } | undefined;
	let list: { ordered: boolean; items: ListItem[] } | undefined;

	const flushParagraph = () => {
		if (!paragraph.length) return;
		blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
		paragraph = [];
	};
	const flushQuote = () => {
		if (!quote.length) return;
		blocks.push({ kind: "blockquote", text: quote.join("\n") });
		quote = [];
	};
	const flushList = () => {
		if (!list) return;
		blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
		list = undefined;
	};
	const parseTableRow = (line: string): string[] | undefined => {
		const trimmed = line.trim();
		if (!trimmed.includes("|")) return undefined;
		const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
		const cells = (body.endsWith("|") ? body.slice(0, -1) : body).split("|").map(cell => cell.trim());
		return cells.length > 1 ? cells : undefined;
	};
	const isTableSeparator = (line: string, width: number): boolean => {
		const cells = parseTableRow(line);
		return Boolean(cells && cells.length === width && cells.every(cell => /^:?-{3,}:?$/.test(cell)));
	};
	const parseListItems = (entries: Array<{ depth: number; text: string }>, minDepth = 0): ListItem[] => {
		const items: ListItem[] = [];
		while (entries.length > 0) {
			const entry = entries[0];
			if (!entry || entry.depth < minDepth) break;
			if (entry.depth > minDepth) {
				const parent = items.at(-1);
				if (!parent) break;
				parent.children.push(...parseListItems(entries, entry.depth));
				continue;
			}
			entries.shift();
			const item: ListItem = { text: entry.text, depth: entry.depth, children: [] };
			while (entries[0] && entries[0].depth > entry.depth) item.children.push(...parseListItems(entries, entries[0].depth));
			items.push(item);
		}
		return items;
	};
	const flushFlow = () => {
		flushParagraph();
		flushQuote();
		flushList();
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const fenceMatch = line.match(/^```\s*([^`]*)\s*$/);
		if (fence) {
			if (fenceMatch) {
				blocks.push({ kind: "code", code: fence.lines.join("\n"), lang: fence.lang });
				fence = undefined;
			} else {
				fence.lines.push(line);
			}
			continue;
		}
		if (fenceMatch) {
			flushFlow();
			fence = { lang: fenceMatch[1]?.trim() || undefined, lines: [] };
			continue;
		}
		if (!line.trim()) {
			flushFlow();
			continue;
		}
		const tableHeader = parseTableRow(line);
		if (tableHeader && isTableSeparator(lines[index + 1] ?? "", tableHeader.length)) {
			flushFlow();
			index += 2;
			const rows: string[][] = [];
			while (index < lines.length) {
				const row = parseTableRow(lines[index] ?? "");
				if (!row || row.length !== tableHeader.length) break;
				rows.push(row);
				index += 1;
			}
			index -= 1;
			blocks.push({ kind: "table", headers: tableHeader, rows });
			continue;
		}
		if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushFlow();
			blocks.push({ kind: "hr" });
			continue;
		}
		const quoteMatch = line.match(/^\s*>\s?(.*)$/);
		if (quoteMatch) {
			flushParagraph();
			flushList();
			quote.push(quoteMatch[1]);
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			flushFlow();
			blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
			continue;
		}
		const unordered = line.match(/^(\s*)-\s+(.+)$/);
		const ordered = line.match(/^(\s*)\d+\.\s+(.+)$/);
		if (unordered || ordered) {
			flushParagraph();
			flushQuote();
			const nextOrdered = Boolean(ordered);
			if (!list || list.ordered !== nextOrdered) flushList();
			list ??= { ordered: nextOrdered, items: [] };
			const entries = [...list.items.flatMap(flattenListItem), { depth: (ordered?.[1] ?? unordered?.[1] ?? "").replace(/\t/g, "    ").length, text: (ordered?.[2] ?? unordered?.[2] ?? "").trim() }];
			list.items = parseListItems(entries);
			continue;
		}
		flushQuote();
		flushList();
		paragraph.push(line);
	}
	if (fence) blocks.push({ kind: "code", code: fence.lines.join("\n"), lang: fence.lang });
	flushFlow();
	return blocks;
}

function renderBlock(block: Block, key: number): ReactNode {
	if (block.kind === "code") {
		return (
			<pre className="markdown__code" key={key} data-lang={block.lang}>
				<code>{block.code}</code>
			</pre>
		);
	}
	if (block.kind === "heading") {
		const Tag = `h${Math.min(block.level, 3)}` as "h1" | "h2" | "h3";
		return <Tag key={key}>{renderInline(block.text)}</Tag>;
	}
	if (block.kind === "list") {
		const Tag = block.ordered ? "ol" : "ul";
		return <Tag key={key}>{block.items.map((item, index) => renderListItem(item, index, Tag))}</Tag>;
	}
	if (block.kind === "table") {
		return <table className="markdown__table" key={key}><thead><tr>{block.headers.map((cell, index) => <th key={index}>{renderInline(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}</tr>)}</tbody></table>;
	}
	if (block.kind === "blockquote") return <blockquote key={key}>{renderInline(block.text)}</blockquote>;
	if (block.kind === "hr") return <hr key={key} />;
	return <p key={key}>{renderInline(block.text)}</p>;
}

function flattenListItem(item: ListItem): Array<{ depth: number; text: string }> {
	return [{ depth: item.depth, text: item.text }, ...item.children.flatMap(child => flattenListItem(child))];
}

function renderListItem(item: ListItem, key: number, Tag: "ol" | "ul"): ReactNode {
	return <li key={key}>{renderInline(item.text)}{item.children.length > 0 ? <Tag>{item.children.map((child, index) => renderListItem(child, index, Tag))}</Tag> : null}</li>;
}

function renderInline(text: string): ReactNode[] {
	return renderInlineRange(text, 0, text.length, 0).nodes;
}

function renderInlineRange(text: string, start: number, end: number, seed: number): { nodes: ReactNode[]; key: number } {
	const nodes: ReactNode[] = [];
	let index = start;
	let key = seed;
	while (index < end) {
		const marker = nextInlineMarker(text, index, end);
		if (!marker) {
			nodes.push(text.slice(index, end));
			break;
		}
		if (marker.start > index) nodes.push(text.slice(index, marker.start));
		const currentKey = key++;
		if (marker.kind === "code") nodes.push(<code key={currentKey}>{text.slice(marker.start + 1, marker.end - 1)}</code>);
		else if (marker.kind === "strong") nodes.push(<strong key={currentKey}>{renderInlineRange(text, marker.start + 2, marker.end - 2, key).nodes}</strong>);
		else if (marker.kind === "strike") nodes.push(<del key={currentKey}>{renderInlineRange(text, marker.start + 2, marker.end - 2, key).nodes}</del>);
		else if (marker.kind === "em") nodes.push(<em key={currentKey}>{renderInlineRange(text, marker.start + 1, marker.end - 1, key).nodes}</em>);
		else nodes.push(renderLink(text.slice(marker.start, marker.end), currentKey));
		index = marker.end;
	}
	return { nodes, key };
}

type InlineMarker = { kind: "code" | "strong" | "em" | "strike" | "link"; start: number; end: number };

function nextInlineMarker(text: string, start: number, end: number): InlineMarker | undefined {
	for (let index = start; index < end; index += 1) {
		const char = text[index];
		if (char === "`") {
			const close = text.indexOf("`", index + 1);
			if (close > index + 1 && close < end) return { kind: "code", start: index, end: close + 1 };
		}
		if (text.startsWith("**", index)) {
			const close = text.indexOf("**", index + 2);
			if (close > index + 2 && close < end) return { kind: "strong", start: index, end: close + 2 };
		}
		if (text.startsWith("~~", index)) {
			const close = text.indexOf("~~", index + 2);
			if (close > index + 2 && close < end) return { kind: "strike", start: index, end: close + 2 };
		}
		if (char === "*") {
			const close = text.indexOf("*", index + 1);
			if (close > index + 1 && close < end) return { kind: "em", start: index, end: close + 1 };
		}
		if (char === "[") {
			const labelEnd = text.indexOf("](", index + 1);
			const hrefEnd = labelEnd >= 0 ? text.indexOf(")", labelEnd + 2) : -1;
			if (labelEnd > index + 1 && hrefEnd > labelEnd + 2 && hrefEnd < end) return { kind: "link", start: index, end: hrefEnd + 1 };
		}
	}
	return undefined;
}

function renderLink(token: string, key: number): ReactNode {
	const match = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
	if (!match) return token;
	const href = safeHref(match[2]);
	if (!href) return match[1];
	return (
		<a href={href} target="_blank" rel="noreferrer noopener" key={key}>
			{renderInline(match[1])}
		</a>
	);
}

function safeHref(href: string): string | undefined {
	try {
		const url = new URL(href);
		if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return href;
	} catch {
		return undefined;
	}
	return undefined;
}
