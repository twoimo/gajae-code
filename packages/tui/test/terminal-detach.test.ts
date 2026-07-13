import { describe, expect, it, vi } from "bun:test";
import {
	createRawTerminalLease,
	emergencyRawTerminalRestore,
	type RawTerminalStdin,
	type WindowsConsoleDriver,
} from "@gajae-code/tui";
import { ProcessTerminal, type Terminal, type TerminalAppearance } from "@gajae-code/tui/terminal";
import { type Component, CURSOR_MARKER, TUI } from "@gajae-code/tui/tui";
// Bun gives this query-qualified URL a second ESM module record.
// @ts-expect-error TypeScript does not model Bun's query-qualified source URLs.
import * as duplicateRawTerminalLease from "../src/raw-terminal-lease.ts?duplicate-module";

class StaticComponent implements Component {
	#line: string;

	constructor(line: string) {
		this.#line = line;
	}

	setLine(line: string): void {
		this.#line = line;
	}

	invalidate(): void {}

	render(): string[] {
		return [this.#line];
	}
}

class DetachingTerminal implements Terminal {
	#writes: string[] = [];
	#available = true;
	#writeFailureAt: number | undefined;
	#hideCursorFails = false;

	constructor(writeFailureAt?: number) {
		this.#writeFailureAt = writeFailureAt;
	}

	get writes(): string[] {
		return [...this.#writes];
	}

	setHideCursorFails(fails: boolean): void {
		this.#hideCursorFails = fails;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}

	stop(): void {}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		if (!this.#available) {
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		}
		const nextWriteNumber = this.#writes.length + 1;
		if (this.#writeFailureAt !== undefined && nextWriteNumber >= this.#writeFailureAt) {
			this.#available = false;
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		}
		this.#writes.push(data);
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

	get available(): boolean {
		return this.#available;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		if (this.#hideCursorFails) {
			this.#available = false;
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		}
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}
}

async function settle(): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(25);
}
type ReadableFlowingState = boolean | null | undefined;

interface RawStdinOptions {
	restoreReadableFlowing?: boolean;
	beforeSetRawMode?: (mode: boolean) => void;
}

function createRawStdin(
	raw: boolean,
	flowing: ReadableFlowingState,
	paused: boolean,
	options: RawStdinOptions = {},
): {
	stdin: RawTerminalStdin;
	state: { raw: boolean; flowing: ReadableFlowingState; paused: boolean };
	calls: string[];
} {
	const state = { raw, flowing, paused };
	const calls: string[] = [];
	const stdin: RawTerminalStdin = {
		isTTY: true,
		get isRaw(): boolean {
			return state.raw;
		},
		setRawMode: (mode: boolean): void => {
			options.beforeSetRawMode?.(mode);
			calls.push(`raw:${mode}`);
			state.raw = mode;
		},
		get readableFlowing(): ReadableFlowingState {
			return state.flowing;
		},
		pause: (): void => {
			calls.push("pause");
			state.flowing = false;
			state.paused = true;
		},
		resume: (): void => {
			calls.push("resume");
			state.flowing = true;
			state.paused = false;
		},
	};
	if (options.restoreReadableFlowing) {
		stdin.restoreReadableFlowing = (stateToRestore: null | undefined): void => {
			calls.push(`restore-flow:${String(stateToRestore)}`);
			state.flowing = stateToRestore;
			state.paused = paused;
		};
	}
	return { stdin, state, calls };
}

function withStdoutProperty<T>(
	property: "isTTY" | "writable" | "destroyed" | "closed",
	value: boolean,
	run: () => T,
): T {
	const original = process.stdout[property];
	Object.defineProperty(process.stdout, property, { configurable: true, value });
	try {
		return run();
	} finally {
		Object.defineProperty(process.stdout, property, { configurable: true, value: original });
	}
}

describe("terminal detach handling", () => {
	it("swallows ProcessTerminal EIO writes and marks output unavailable", () => {
		const terminal = new ProcessTerminal();
		const originalIsTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw Object.assign(new Error("pty is gone"), { code: "EIO" });
		});

		try {
			expect(() => terminal.write("render frame")).not.toThrow();
			expect(terminal.available).toBe(false);
			expect(() => terminal.hideCursor()).not.toThrow();
			expect(writeSpy).toHaveBeenCalledTimes(1);
		} finally {
			writeSpy.mockRestore();
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
		}
	});

	it("marks ProcessTerminal unavailable when stdout emits an async EIO", () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

		try {
			withStdoutProperty("isTTY", true, () => {
				expect(() =>
					terminal.start(
						() => {},
						() => {},
					),
				).not.toThrow();
				expect(terminal.available).toBe(true);
				expect(() => {
					process.stdout.emit("error", Object.assign(new Error("pty is gone"), { code: "EIO" }));
				}).not.toThrow();
				expect(terminal.available).toBe(false);
				expect(() => terminal.write("after async error")).not.toThrow();
			});
		} finally {
			expect(() => terminal.stop()).not.toThrow();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
		}
	});
	it("keeps stdout error listener armed briefly after stop restore writes", async () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		await Bun.sleep(300);
		const beforeListeners = process.stdout.listenerCount("error");

		try {
			withStdoutProperty("isTTY", true, () => {
				terminal.start(
					() => {},
					() => {},
				);
				expect(process.stdout.listenerCount("error")).toBe(beforeListeners + 1);
				terminal.stop();
				expect(process.stdout.listenerCount("error")).toBe(beforeListeners + 1);
				expect(() => {
					process.stdout.emit("error", Object.assign(new Error("pty vanished after stop"), { code: "EIO" }));
				}).not.toThrow();
				expect(terminal.available).toBe(false);
			});
			await Bun.sleep(300);
			expect(process.stdout.listenerCount("error")).toBe(beforeListeners);
		} finally {
			terminal.stop();
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
			pauseSpy.mockRestore();
		}
	});

	it("marks ProcessTerminal unavailable when stdout is already closed", () => {
		const terminal = new ProcessTerminal();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		try {
			withStdoutProperty("isTTY", true, () => {
				withStdoutProperty("closed", true, () => {
					expect(() => terminal.write("render frame")).not.toThrow();
					expect(terminal.available).toBe(false);
					expect(writeSpy).not.toHaveBeenCalled();
				});
			});
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("stops render writes after a terminal write fails", async () => {
		const terminal = new DetachingTerminal(2);
		const tui = new TUI(terminal);
		const component = new StaticComponent("hello");
		tui.addChild(component);

		expect(() => tui.start()).not.toThrow();
		await settle();
		const writesAfterDetach = terminal.writes.length;
		expect(tui.terminalAvailable).toBe(false);

		component.setLine("after detach");
		expect(() => tui.requestRender(true)).not.toThrow();
		await settle();
		expect(terminal.writes.length).toBe(writesAfterDetach);
	});

	it("swallows cursor cleanup failures and suppresses later renders", async () => {
		const terminal = new DetachingTerminal();
		const tui = new TUI(terminal, true);
		const component = new StaticComponent(`${CURSOR_MARKER}hello`);
		tui.addChild(component);
		tui.start();
		await settle();
		const writesBeforeCursorFailure = terminal.writes.length;

		terminal.setHideCursorFails(true);
		component.setLine("hello");
		expect(() => tui.requestRender()).not.toThrow();
		await settle();
		expect(tui.terminalAvailable).toBe(false);

		component.setLine("after cursor failure");
		expect(() => tui.requestRender(true)).not.toThrow();
		await settle();
		expect(terminal.writes.length).toBe(writesBeforeCursorFailure);
	});
});

describe("raw terminal lease", () => {
	it("restores boolean flow snapshots and closes idempotently", () => {
		const cases = [
			{ flowing: true, paused: false, calls: ["raw:true", "resume", "resume", "raw:false"] },
			{ flowing: false, paused: true, calls: ["raw:true", "resume", "pause", "raw:false"] },
		] as const;
		for (const testCase of cases) {
			const { stdin, state, calls } = createRawStdin(false, testCase.flowing, testCase.paused);
			const lease = createRawTerminalLease({ stdin, platform: "linux" });

			expect(state).toEqual({ raw: true, flowing: true, paused: false });
			lease.close();
			lease.close();

			expect(state).toEqual({ raw: false, flowing: testCase.flowing, paused: testCase.paused });
			expect(calls).toEqual([...testCase.calls]);
		}
	});

	it("restores null and undefined flow snapshots through an explicit seam", () => {
		const cases: { flowing: null | undefined; label: string }[] = [
			{ flowing: null, label: "null" },
			{ flowing: undefined, label: "undefined" },
		];
		for (const testCase of cases) {
			const { stdin, state, calls } = createRawStdin(false, testCase.flowing, false, {
				restoreReadableFlowing: true,
			});
			const lease = createRawTerminalLease({ stdin, platform: "linux" });

			expect(state).toEqual({ raw: true, flowing: true, paused: false });
			lease.close();

			expect(state).toEqual({ raw: false, flowing: testCase.flowing, paused: false });
			expect(calls).toEqual(["raw:true", "resume", `restore-flow:${testCase.label}`, "raw:false"]);
		}
	});

	it("rejects null and undefined flow snapshots without a restoration seam", () => {
		for (const flowing of [null, undefined] as const) {
			const { stdin, state, calls } = createRawStdin(false, flowing, false);

			expect(() => createRawTerminalLease({ stdin, platform: "linux" })).toThrow(
				"requires restoreReadableFlowing support",
			);
			expect(state).toEqual({ raw: false, flowing, paused: false });
			expect(calls).toEqual([]);
		}
	});

	it("defers reentrant emergency cleanup until raw-mode enable commits", () => {
		let restoreRequested = true;
		const { stdin, state, calls } = createRawStdin(false, false, true, {
			beforeSetRawMode: (mode: boolean): void => {
				if (mode && restoreRequested) emergencyRawTerminalRestore();
			},
		});

		expect(() => createRawTerminalLease({ stdin, platform: "linux" })).toThrow(
			"Raw terminal input acquisition was interrupted",
		);
		expect(state).toEqual({ raw: false, flowing: false, paused: true });
		expect(calls).toEqual(["raw:true", "pause", "raw:false"]);

		restoreRequested = false;
		const successor = createRawTerminalLease({ stdin, platform: "linux" });
		successor.close();
	});

	it("shares a resource owner across duplicate module records while keeping resources independent", () => {
		const first = createRawStdin(false, false, true);
		const second = createRawStdin(false, false, true);
		const firstLease = createRawTerminalLease({ stdin: first.stdin, platform: "linux" });
		const secondLease = duplicateRawTerminalLease.createRawTerminalLease({
			stdin: second.stdin,
			platform: "linux",
		});

		expect(() => duplicateRawTerminalLease.createRawTerminalLease({ stdin: first.stdin, platform: "linux" })).toThrow(
			"Raw terminal input is already owned",
		);
		expect(() => createRawTerminalLease({ stdin: second.stdin, platform: "linux" })).toThrow(
			"Raw terminal input is already owned",
		);

		firstLease.close();
		expect(first.state).toEqual({ raw: false, flowing: false, paused: true });
		expect(second.state).toEqual({ raw: true, flowing: true, paused: false });

		const firstSuccessor = duplicateRawTerminalLease.createRawTerminalLease({
			stdin: first.stdin,
			platform: "linux",
		});
		firstSuccessor.close();
		secondLease.close();
		expect(second.state).toEqual({ raw: false, flowing: false, paused: true });
	});

	it("rolls back stdin and console mode when Windows VT adoption fails", () => {
		const { stdin, state, calls } = createRawStdin(false, false, true);
		let mode = 0x0011;
		let driverClosed = false;
		const modeWrites: number[] = [];
		const consoleDriver: WindowsConsoleDriver = {
			getInputMode: (): number => mode,
			setInputMode: (nextMode: number): boolean => {
				modeWrites.push(nextMode);
				if (nextMode === 0x0211) return false;
				mode = nextMode;
				return true;
			},
			close: (): void => {
				driverClosed = true;
			},
		};

		expect(() => createRawTerminalLease({ stdin, platform: "win32", consoleDriver })).toThrow(
			"Could not enable Windows virtual terminal input",
		);

		expect(state).toEqual({ raw: false, flowing: false, paused: true });
		expect(calls).toEqual(["raw:true", "pause", "raw:false"]);
		expect(mode).toBe(0x0011);
		expect(modeWrites).toEqual([0x0211, 0x0011]);
		expect(driverClosed).toBe(true);

		const successor = createRawTerminalLease({ stdin, platform: "linux" });
		successor.close();
	});

	it("enables Windows VT input and restores the original console mode", () => {
		const { stdin, state } = createRawStdin(false, false, true);
		let mode = 0x0011;
		let driverClosed = false;
		const modeWrites: number[] = [];
		const consoleDriver: WindowsConsoleDriver = {
			getInputMode: (): number => mode,
			setInputMode: (nextMode: number): boolean => {
				modeWrites.push(nextMode);
				mode = nextMode;
				return true;
			},
			close: (): void => {
				driverClosed = true;
			},
		};
		const originalSetRawMode = stdin.setRawMode!;
		stdin.setRawMode = (nextRaw: boolean): void => {
			originalSetRawMode(nextRaw);
			if (nextRaw) mode = 0x0001;
		};

		const lease = createRawTerminalLease({ stdin, platform: "win32", consoleDriver });
		expect(modeWrites).toEqual([0x0201]);

		lease.close();

		expect(state).toEqual({ raw: false, flowing: false, paused: true });
		expect(mode).toBe(0x0011);
		expect(modeWrites).toEqual([0x0201, 0x0011]);
		expect(driverClosed).toBe(true);
	});

	it("retries emergency restoration after a partial raw-mode close failure", () => {
		const { stdin, state } = createRawStdin(false, false, true);
		const setRawMode = stdin.setRawMode!;
		let rawRestoreFailures = 1;
		stdin.setRawMode = (mode: boolean): void => {
			if (!mode && rawRestoreFailures-- > 0) throw new Error("raw restore failed");
			setRawMode(mode);
		};

		const lease = createRawTerminalLease({ stdin, platform: "linux" });
		expect(() => lease.close()).toThrow("raw restore failed");

		emergencyRawTerminalRestore();

		expect(state).toEqual({ raw: false, flowing: false, paused: true });
		const successor = createRawTerminalLease({ stdin, platform: "linux" });
		successor.close();
	});

	it("retries emergency Windows console restoration after a close failure", () => {
		const { stdin, state } = createRawStdin(false, false, true);
		const originalConsoleMode = 0x0011;
		let mode = originalConsoleMode;
		let consoleRestoreFailures = 1;
		let driverClosed = false;
		const modeWrites: number[] = [];
		const consoleDriver: WindowsConsoleDriver = {
			getInputMode: (): number => mode,
			setInputMode: (nextMode: number): boolean => {
				modeWrites.push(nextMode);
				if (nextMode === originalConsoleMode && consoleRestoreFailures-- > 0) return false;
				mode = nextMode;
				return true;
			},
			close: (): void => {
				driverClosed = true;
			},
		};
		const setRawMode = stdin.setRawMode!;
		stdin.setRawMode = (nextRaw: boolean): void => {
			setRawMode(nextRaw);
			if (nextRaw) mode = 0x0001;
		};

		const lease = createRawTerminalLease({ stdin, platform: "win32", consoleDriver });
		expect(() => lease.close()).toThrow("Could not restore Windows console input mode");
		expect(state).toEqual({ raw: false, flowing: false, paused: true });
		expect(mode).toBe(0x0201);
		expect(driverClosed).toBe(false);

		emergencyRawTerminalRestore();
		emergencyRawTerminalRestore();

		expect(mode).toBe(originalConsoleMode);
		expect(modeWrites).toEqual([0x0201, originalConsoleMode, originalConsoleMode]);
		expect(driverClosed).toBe(true);
	});
});
