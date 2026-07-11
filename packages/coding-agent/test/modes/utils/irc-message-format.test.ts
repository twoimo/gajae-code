import { beforeEach, describe, expect, it } from "bun:test";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { formatIrcMessageBlock, type ParsedIrcMessage } from "@gajae-code/coding-agent/modes/utils/irc-message";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container } from "@gajae-code/tui";

beforeEach(async () => {
	await initTheme();
});

function message(kind: ParsedIrcMessage["kind"], text: string): ParsedIrcMessage {
	return {
		observationId: `${kind}:${text}`,
		from: "alice",
		to: "bob",
		kind,
		text,
		timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
	};
}

function localTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

describe("formatIrcMessageBlock", () => {
	it.each([
		["incoming", "incoming"],
		["autoreply", "autoreply"],
		["relay", "outgoing"],
	] as const)("maps %s messages to %s blocks", (kind, expectedKind) => {
		const block = formatIrcMessageBlock(message(kind, "hello"));
		expect(Object.keys(block)).toEqual(["sender", "recipient", "kind", "time", "bodyLines"]);
		expect(block).toEqual({
			sender: "alice",
			recipient: "bob",
			kind: expectedKind,
			time: localTime(Date.parse("2026-01-02T03:04:05.000Z")),
			bodyLines: ["hello"],
		});
	});

	it("normalizes identity controls without altering body line semantics", () => {
		const block = formatIrcMessageBlock({
			...message("incoming", "first\tline\n\nlast\tline"),
			from: "ali\r\n\t\u2028ce\x1b[31m\u009b31m\u202e👩🏽‍💻\x1b]0;title\x07",
			to: "bo\n\u061C\u200F\u2066b\u2069",
		});

		expect(block.sender).toBe("ali ce👩🏽‍💻");
		expect(block.recipient).toBe("bo b");
		expect(block.sender).not.toMatch(/[\x00-\x1F\x7F-\x9F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/);
		expect(block.recipient).not.toMatch(/[\x00-\x1F\x7F-\x9F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/);
		expect(block.bodyLines).toEqual(["first    line", "", "last    line"]);
	});

	it("returns no body lines for empty text", () => {
		expect(formatIrcMessageBlock(message("incoming", "")).bodyLines).toEqual([]);
	});

	it("uses local HH:mm with zero padding without depending on the process timezone", () => {
		const parsed = message("incoming", "hello");
		expect(formatIrcMessageBlock(parsed).time).toBe(localTime(parsed.timestamp));
	});

	it.each([
		"incoming",
		"autoreply",
		"relay",
	] as const)("renders exact formatter content in inline and sidebar %s surfaces", kind => {
		const parsed = {
			...message(kind, "first\tline\nsecond line"),
			from: "alice\r\n[IRC] forged\u202e👩🏽‍💻",
			to: "channel\t\u2066target",
		};
		const chatContainer = new Container();
		const helpers = new UiHelpers({ chatContainer } as InteractiveModeContext);
		helpers.addRebuiltIrcObservationToChat(parsed);
		const inline = Bun.stripANSI(chatContainer.render(120).join("\n"));

		const ledger = new IrcObservationLedger();
		ledger.observe(parsed, false);
		const split = new IrcSplitViewComponent(new Container(), ledger, theme);
		split.setVisible(true);
		const sidebar = Bun.stripANSI(split.render(200).join("\n"));
		const block = formatIrcMessageBlock(parsed);
		const header = `[IRC] ${block.sender} → ${block.recipient} · ${block.time}`;

		for (const content of [block.sender, block.recipient, block.time, ...block.bodyLines]) {
			expect(inline).toContain(content);
			expect(sidebar).toContain(content);
		}
		expect(inline).toContain(header);
		expect(inline.match(/ → /g)).toHaveLength(1);
		expect(inline.match(/ · /g)).toHaveLength(1);
		expect(inline).not.toContain("\n[IRC] forged");
	});

	it("uses a placeholder time for finite timestamps outside Date's range", () => {
		expect(formatIrcMessageBlock({ ...message("incoming", "hello"), timestamp: Number.MAX_VALUE }).time).toBe(
			"--:--",
		);
	});
});
