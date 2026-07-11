import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	formatIrcMessageBlock,
	type ParsedIrcMessage,
} from "@gajae-code/coding-agent/modes/utils/irc-message";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container } from "@gajae-code/tui";

const originalTimeZone = process.env.TZ;

beforeEach(async () => {
	process.env.TZ = "UTC";
	await initTheme();
});

afterEach(() => {
	if (originalTimeZone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimeZone;
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


describe("formatIrcMessageBlock", () => {
	it.each([
		["incoming", "incoming"],
		["autoreply", "autoreply"],
		["relay", "outgoing"],
	] as const)("maps %s messages to %s blocks", (kind, expectedKind) => {
		expect(formatIrcMessageBlock(message(kind, "hello"))).toEqual({
			sender: "alice",
			recipient: "bob",
			kind: expectedKind,
			time: "03:04",
			bodyLines: ["hello"],
		});
	});

	it("normalizes multiline tabs and preserves empty body lines", () => {
		const block = formatIrcMessageBlock({
			...message("incoming", "first\tline\n\nlast\tline"),
			from: "ali\tce",
			to: "bo\tb",
		});

		expect(block.sender).toBe("ali    ce");
		expect(block.recipient).toBe("bo    b");
		expect(block.bodyLines).toEqual(["first    line", "", "last    line"]);
	});

	it("returns no body lines for empty text", () => {
		expect(formatIrcMessageBlock(message("incoming", "")).bodyLines).toEqual([]);
	});

	it("uses local HH:mm with zero padding", () => {
		expect(formatIrcMessageBlock(message("incoming", "hello")).time).toBe("03:04");
	});

	it("renders the same content through the production inline and sidebar surfaces", () => {
		const parsed = {
			...message("relay", "first\tline\nsecond line"),
			from: "alice\tbot",
			to: "channel",
		};
		const chatContainer = new Container();
		const helpers = new UiHelpers({ chatContainer } as InteractiveModeContext);
		helpers.addRebuiltIrcObservationToChat(parsed);
		const inline = Bun.stripANSI(chatContainer.render(120).join("\n"));

		const ledger = new IrcObservationLedger();
		ledger.observe(parsed, false);
		const split = new IrcSplitViewComponent(new Container(), ledger, theme);
		split.setVisible(true);
		const sidebar = Bun.stripANSI(split.render(120).join("\n"));
		const block = formatIrcMessageBlock(parsed);

		for (const content of [block.sender, block.recipient, block.time, ...block.bodyLines]) {
			expect(inline).toContain(content);
			expect(sidebar).toContain(content);
		}
		expect(inline).toContain(`[IRC] ${block.sender} → ${block.recipient} · ${block.time}`);
	});

	it("uses a placeholder time for finite timestamps outside Date's range", () => {
		expect(formatIrcMessageBlock({ ...message("incoming", "hello"), timestamp: Number.MAX_VALUE }).time).toBe("--:--");
	});
});
