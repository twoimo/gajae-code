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
	it("gives effective selector bindings precedence over fixed queue controls", () => {
		const edited: string[] = [];
		const deleted: string[] = [];
		const moved: string[] = [];
		let closed = false;
		const pane = new QueuePaneComponent([{ id: "steer:1", text: "interrupt", mode: "steer", label: "Steer" }], {
			formatKeyHint: key => formatKeyHint(key, { platform: "darwin" }),
			formatSelectAction: action => (action === "tui.select.confirm" ? "⌃↑" : "⌦"),
			matchesSelectAction: (keyData, action) =>
				action === "tui.select.confirm" ? keyData === "\x1b[1;5A" : keyData === "\x1b[3~",
			onSelect: entry => edited.push(entry.id),
			onDelete: entry => deleted.push(entry.id),
			onMove: entry => moved.push(entry.id),
			onClose: () => {
				closed = true;
			},
		});

		const rendered = pane.render(160).join("\n");
		expect(rendered).toContain("⌃↑ edit");
		expect(rendered).toContain("⌦ close");
		pane.handleInput("\n");
		pane.handleInput("\x1b");
		expect(edited).toEqual([]);
		expect(closed).toBe(false);
		pane.handleInput("\x1b[1;5A");
		pane.handleInput("\x1b[3~");
		expect(edited).toEqual(["steer:1"]);
		expect(closed).toBe(true);
		expect(moved).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it("renders disabled effective confirm and cancel actions without fixed fallbacks", () => {
		const pane = new QueuePaneComponent([{ id: "steer:1", text: "interrupt", mode: "steer", label: "Steer" }], {
			formatKeyHint: key => formatKeyHint(key, { platform: "darwin" }),
			formatSelectAction: () => "",
			matchesSelectAction: () => false,
			onSelect: () => {},
			onDelete: () => {},
			onMove: () => {},
			onClose: () => {},
		});
		const rendered = pane.render(160).join("\n");
		expect(rendered).toContain("Disabled edit");
		expect(rendered).toContain("Disabled close");
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
