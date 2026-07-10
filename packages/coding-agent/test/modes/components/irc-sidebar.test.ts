import { afterEach, describe, expect, it } from "bun:test";
import { type IrcSidebarTheme, IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { type Component, Image, ImageProtocol, isTerminalGraphicsFallbackActive, TERMINAL } from "@gajae-code/tui";

const sidebarTheme = {
	fg: (_color: "dim", text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const mutableTerminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const originalProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	mutableTerminal.imageProtocol = originalProtocol;
});

class TestPane implements Component {
	widths: number[] = [];
	constructor(private readonly lines: string | string[]) {}

	render(width: number): string[] {
		this.widths.push(width);
		return typeof this.lines === "string" ? [this.lines] : this.lines;
	}
	invalidate(): void {}
}

function addRecord(ledger: IrcObservationLedger, text: string): void {
	ledger.observe(
		{
			observationId: text,
			kind: "incoming",
			from: "alice",
			to: "bob",
			text,
			timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
		},
		false,
	);
}

describe("IrcSplitViewComponent", () => {
	it("delegates hidden rendering at full width", () => {
		const pane = new TestPane("transcript");
		const split = new IrcSplitViewComponent(pane, new IrcObservationLedger(), sidebarTheme);

		expect(split.render(80)).toEqual(["transcript"]);
		expect(pane.widths).toEqual([80]);
	});

	it("renders all ledger records with UTC metadata and indented continuations", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "first line\nsecond line");
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const rendered = Bun.stripANSI(split.render(70).join("\n"));
		expect(rendered).toContain("[03:04:05] alice→bob first line");
		expect(rendered).toMatch(/\n[^\n]*\|\s+second line/u);
	});

	it("shows records captured before opening the sidebar", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "backfill");
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);

		split.setVisible(true);
		expect(Bun.stripANSI(split.render(80).join("\n"))).toContain("backfill");
	});

	it("tail-aligns short IRC history with a longer transcript", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "latest IRC line");
		const split = new IrcSplitViewComponent(new TestPane(["older", "newer", "live tail"]), ledger, sidebarTheme);
		split.setVisible(true);

		const lines = Bun.stripANSI(split.render(80).join("\n")).split("\n");
		expect(lines[0]).not.toContain("latest IRC line");
		expect(lines.at(-1)).toContain("latest IRC line");
	});

	it("suppresses terminal graphics only while visible and restores full width when hidden", () => {
		const pane: Component = {
			render: () => [isTerminalGraphicsFallbackActive() ? "[image hidden]" : "\x1bPqSIXEL\x1b\\"],
			invalidate: () => {},
		};
		const split = new IrcSplitViewComponent(pane, new IrcObservationLedger(), sidebarTheme);

		expect(split.render(80).join("\n")).toContain("\x1bPqSIXEL\x1b\\");
		split.setVisible(true);
		expect(split.render(80).join("\n")).not.toContain("\x1bPqSIXEL\x1b\\");
		split.setVisible(false);
		expect(split.render(80).join("\n")).toContain("\x1bPqSIXEL\x1b\\");
	});

	it("recomputes both panes on resize", () => {
		const pane = new TestPane("left");
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "right");
		const split = new IrcSplitViewComponent(pane, ledger, sidebarTheme);
		split.setVisible(true);

		const wide = split.render(80);
		const narrow = split.render(40);
		expect(pane.widths).toEqual([40, 20]);
		expect(wide.every(line => Bun.stripANSI(line).length <= 80)).toBe(true);
		expect(narrow.every(line => Bun.stripANSI(line).length <= 40)).toBe(true);
	});

	it("replaces tabs in IRC labels and text before wrapping", () => {
		const ledger = new IrcObservationLedger();
		ledger.observe(
			{
				observationId: "tabs",
				kind: "incoming",
				from: "ali\tce",
				to: "bo\tb",
				text: "message\twith tabs",
				timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
			},
			false,
		);
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const lines = split.render(60).map(line => Bun.stripANSI(line));
		expect(lines.every(line => line.length <= 60)).toBe(true);
		expect(lines.join("\n")).not.toContain("\t");
	});

	it("renders kitty images in the left pane while the sidebar is visible", () => {
		mutableTerminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_ONE_PIXEL_PNG },
			{ widthPx: 100, heightPx: 100 },
		);
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "peer message");
		const split = new IrcSplitViewComponent(image, ledger, sidebarTheme);

		split.setVisible(true);
		const visible = split.render(80).join("\n");
		expect(visible).toContain("\x1b_G");
		expect(Bun.stripANSI(visible)).toContain("peer message");

		split.setVisible(false);
		expect(split.render(80).join("\n")).toContain("\x1b_G");
	});

	it("keeps sixel suppressed in the visible split even with kitty permission active", () => {
		mutableTerminal.imageProtocol = ImageProtocol.Sixel;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_ONE_PIXEL_PNG },
			{ widthPx: 100, heightPx: 100 },
		);
		const split = new IrcSplitViewComponent(image, new IrcObservationLedger(), sidebarTheme);

		split.setVisible(true);
		const visible = split.render(80).join("\n");
		expect(visible).not.toContain("\x1bP");
		expect(Bun.stripANSI(visible)).toContain("[image/png");
	});

	it("resolves an injected theme accessor on every render", () => {
		let currentTheme: IrcSidebarTheme = {
			fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
			boxSharp: { vertical: "│" },
		};
		const split = new IrcSplitViewComponent(new TestPane("left"), new IrcObservationLedger(), () => currentTheme);
		split.setVisible(true);

		expect(split.render(80).join("\n")).toContain("\x1b[31m │ \x1b[0m");
		currentTheme = {
			fg: (_color, text) => `\x1b[32m${text}\x1b[0m`,
			boxSharp: { vertical: "║" },
		};
		expect(split.render(80).join("\n")).toContain("\x1b[32m ║ \x1b[0m");
	});
});
