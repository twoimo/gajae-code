import { beforeAll, describe, expect, it } from "bun:test";
import { formatKeyHint } from "@gajae-code/coding-agent/config/keybindings";
import { QueuePaneComponent } from "@gajae-code/coding-agent/modes/components/queue-pane";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("QueuePaneComponent", () => {
	it("renders Darwin controls and forwards selection, edit, remove, move, and close", () => {
		const deleted: string[] = [];
		const edited: string[] = [];
		const moved: Array<{ id: string; direction: string }> = [];
		let closed = false;
		const pane = new QueuePaneComponent(
			[
				{ id: "steer:1", text: "interrupt", mode: "steer", label: "Steer" },
				{ id: "followUp:2", text: "later", mode: "followUp", label: "Queued" },
			],
			{
				formatKeyHint: key => formatKeyHint(key, { platform: "darwin" }),
				onSelect: entry => edited.push(entry.id),
				onDelete: entry => deleted.push(entry.id),
				onMove: (entry, _index, direction) => moved.push({ id: entry.id, direction }),
				onClose: () => {
					closed = true;
				},
			},
		);

		const rendered = pane.render(160).join("\n");
		expect(rendered).toContain("Message queue");
		expect(rendered).toContain("⌥↑/⌥↓ select");
		expect(rendered).toContain("↩ edit");
		expect(rendered).toContain("⌦ remove");
		expect(rendered).toContain("⌃↑/⌃↓ move");
		expect(rendered).toContain("⎋ close");

		pane.handleInput("\x1b[1;3B");
		pane.handleInput("\x1b[1;5A");
		pane.handleInput("\n");
		pane.handleInput("\x1b[3~");
		pane.handleInput("\x1b");

		expect(moved).toEqual([{ id: "followUp:2", direction: "up" }]);
		expect(edited).toEqual(["followUp:2"]);
		expect(deleted).toEqual(["followUp:2"]);
		expect(closed).toBe(true);
	});
	it("uses effective selector confirm and cancel bindings", () => {
		const edited: string[] = [];
		let closed = false;
		const pane = new QueuePaneComponent([{ id: "steer:1", text: "interrupt", mode: "steer", label: "Steer" }], {
			formatKeyHint: key => formatKeyHint(key, { platform: "darwin" }),
			formatSelectAction: action => (action === "tui.select.confirm" ? "⌃E" : "⌃X"),
			matchesSelectAction: (keyData, action) =>
				action === "tui.select.confirm" ? keyData === "\x05" : keyData === "\x18",
			onSelect: entry => edited.push(entry.id),
			onDelete: () => {},
			onMove: () => {},
			onClose: () => {
				closed = true;
			},
		});

		const rendered = pane.render(160).join("\n");
		expect(rendered).toContain("⌃E edit");
		expect(rendered).toContain("⌃X close");
		pane.handleInput("\x05");
		pane.handleInput("\x18");
		expect(edited).toContain("steer:1");
		expect(closed).toBe(true);
	});

	it("renders textual controls off Darwin", () => {
		const pane = new QueuePaneComponent([{ id: "steer:1", text: "interrupt", mode: "steer", label: "Steer" }], {
			formatKeyHint: key => formatKeyHint(key, { platform: "linux" }),
			onSelect: () => {},
			onDelete: () => {},
			onMove: () => {},
			onClose: () => {},
		});

		const rendered = pane.render(160).join("\n");
		expect(rendered).toContain("Alt+Up/Alt+Down select");
		expect(rendered).toContain("Enter edit");
		expect(rendered).toContain("Delete remove");
		expect(rendered).toContain("Ctrl+Up/Ctrl+Down move");
		expect(rendered).toContain("Esc close");
	});
});
