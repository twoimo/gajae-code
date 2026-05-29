import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, ProcessTerminal, type Terminal, type TerminalAppearance, TUI } from "@gajae-code/tui";

const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

type StdoutWrite = typeof process.stdout.write;

class StaticComponent implements Component {
	#renderCount = 0;

	get renderCount(): number {
		return this.#renderCount;
	}

	invalidate(): void {}

	render(): string[] {
		this.#renderCount++;
		return ["content"];
	}
}

class DeadTerminal implements Terminal {
	get isDead(): boolean {
		return true;
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	start(): void {}

	stop(): void {}

	async drainInput(): Promise<void> {}

	write(): void {
		throw new Error("dead terminal write should be skipped");
	}

	moveBy(): void {
		throw new Error("dead terminal move should be skipped");
	}

	hideCursor(): void {
		throw new Error("dead terminal hide should be skipped");
	}

	showCursor(): void {
		throw new Error("dead terminal show should be skipped");
	}

	clearLine(): void {
		throw new Error("dead terminal clear should be skipped");
	}

	clearFromCursor(): void {
		throw new Error("dead terminal clear should be skipped");
	}

	clearScreen(): void {
		throw new Error("dead terminal clear should be skipped");
	}

	setTitle(): void {}

	setProgress(): void {}

	onAppearanceChange(): void {}
}

function restoreStdoutIsTty(): void {
	if (stdoutIsTtyDescriptor) {
		Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		return;
	}
	delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
}

describe("terminal write failure handling", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTty();
	});

	it("marks ProcessTerminal dead after synchronous stdout write failure", () => {
		const terminal = new ProcessTerminal();
		const eio = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw eio;
		}) as unknown as { mock: { calls: unknown[] } };

		expect(() => terminal.write("first")).not.toThrow();
		expect(terminal.isDead).toBe(true);

		expect(() => terminal.write("second")).not.toThrow();
		expect(write.mock.calls).toHaveLength(1);
	});

	it("marks ProcessTerminal dead after asynchronous stdout write callback failure", () => {
		const terminal = new ProcessTerminal();
		const eio = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
		vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: string | Uint8Array,
			callback?: (err?: Error | null) => void,
		) => {
			callback?.(eio);
			return false;
		}) as StdoutWrite);

		expect(() => terminal.write("frame")).not.toThrow();
		expect(terminal.isDead).toBe(true);
	});

	it("skips render and stop cleanup writes when the terminal is already dead", async () => {
		const terminal = new DeadTerminal();
		const tui = new TUI(terminal);
		const component = new StaticComponent();
		tui.addChild(component);

		tui.requestRender(true);
		await new Promise<void>(resolve => process.nextTick(resolve));

		expect(component.renderCount).toBe(0);
		expect(() => tui.stop()).not.toThrow();
	});
});
