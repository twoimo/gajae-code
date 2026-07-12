import { dlopen, FFIType, ptr } from "bun:ffi";

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
interface AcquiringRawTerminalOwner {
	acquiring: true;
	cancelled: boolean;
	lease?: RawTerminalLease;
}

interface PoisonedRawTerminalOwner {
	lease: RawTerminalLease;
}

interface RestoringRawTerminalOwner {
	lease: RawTerminalLease;
	restoring: true;
}

let rawTerminalOwner:
	| RawTerminalLease
	| AcquiringRawTerminalOwner
	| PoisonedRawTerminalOwner
	| RestoringRawTerminalOwner
	| undefined;

/** Minimal stdin surface needed to temporarily own raw terminal input. */
export interface RawTerminalStdin {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => unknown;
	isPaused: () => boolean;
	readableFlowing?: boolean | null;
	pause: () => unknown;
	resume: () => unknown;
}

/** Injectable Windows console mode driver. */
export interface WindowsConsoleDriver {
	getInputMode(): number | undefined;
	setInputMode(mode: number): boolean;
	close(): void;
}

export interface RawTerminalLeaseOptions {
	stdin?: RawTerminalStdin;
	platform?: NodeJS.Platform;
	consoleDriver?: WindowsConsoleDriver;
}

/** Owns raw stdin until closed, restoring the exact state observed at acquisition. */
export interface RawTerminalLease {
	close(): void;
}

/**
 * Restore the process-wide raw-terminal owner after an interrupted acquisition
 * or failed rollback. Safe to call repeatedly; failed restoration remains
 * owned so a later emergency cleanup can retry it.
 */
export function emergencyRawTerminalRestore(): void {
	const owner = rawTerminalOwner;
	if (!owner || isRestoringRawTerminalOwner(owner)) return;
	if (isAcquiringRawTerminalOwner(owner)) {
		owner.cancelled = true;
		owner.lease?.close();
		return;
	}
	if (!isPoisonedRawTerminalOwner(owner)) {
		owner.close();
		return;
	}
	const restoringOwner: RestoringRawTerminalOwner = { lease: owner.lease, restoring: true };
	rawTerminalOwner = restoringOwner;
	try {
		owner.lease.close();
	} catch (error) {
		if (rawTerminalOwner === restoringOwner) rawTerminalOwner = owner;
		throw error;
	}
	if (rawTerminalOwner === restoringOwner) rawTerminalOwner = undefined;
}

/** A terminal capability could not be adopted without preserving its cause. */
export class RawTerminalCapabilityError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "RawTerminalCapabilityError";
	}
}

function createWindowsConsoleDriver(): WindowsConsoleDriver {
	let close: (() => void) | undefined;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
			GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
			SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
		});
		const driverClose = (): void => kernel32.close();
		close = driverClose;
		const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
		const mode = new Uint32Array(1);
		const modePtr = ptr(mode);
		const getInputMode = (): number | undefined => {
			if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) return undefined;
			return mode[0];
		};
		return {
			getInputMode,
			setInputMode: (value: number): boolean => kernel32.symbols.SetConsoleMode(handle, value),
			close: driverClose,
		};
	} catch (error) {
		try {
			close?.();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Could not adopt Windows console input mode");
		}
		throw new RawTerminalCapabilityError("Could not adopt Windows console input mode", error);
	}
}
function isAcquiringRawTerminalOwner(
	owner: RawTerminalLease | AcquiringRawTerminalOwner | PoisonedRawTerminalOwner | RestoringRawTerminalOwner,
): owner is AcquiringRawTerminalOwner {
	return typeof owner === "object" && "acquiring" in owner;
}
function isPoisonedRawTerminalOwner(
	owner: RawTerminalLease | AcquiringRawTerminalOwner | PoisonedRawTerminalOwner | RestoringRawTerminalOwner,
): owner is PoisonedRawTerminalOwner {
	return typeof owner === "object" && "lease" in owner && !("restoring" in owner);
}

function isRestoringRawTerminalOwner(
	owner: RawTerminalLease | AcquiringRawTerminalOwner | PoisonedRawTerminalOwner | RestoringRawTerminalOwner,
): owner is RestoringRawTerminalOwner {
	return typeof owner === "object" && "restoring" in owner;
}

function interruptedAcquisitionError(): RawTerminalCapabilityError {
	return new RawTerminalCapabilityError("Raw terminal input acquisition was interrupted by emergency restoration");
}

/**
 * Acquire raw terminal input and, on Windows, the VT input console mode needed
 * after raw mode resets the console flags. Acquisition is transactional: an
 * unavailable capability or failed mutation leaves stdin and console mode as
 * they were before this call.
 */
export function createRawTerminalLease(options: RawTerminalLeaseOptions = {}): RawTerminalLease {
	if (rawTerminalOwner && isAcquiringRawTerminalOwner(rawTerminalOwner))
		throw new Error("Raw terminal input is already owned");
	if (rawTerminalOwner) {
		if (!isPoisonedRawTerminalOwner(rawTerminalOwner)) throw new Error("Raw terminal input is already owned");
		const poisonedOwner = rawTerminalOwner;
		const recovery = { acquiring: true as const, cancelled: false };
		rawTerminalOwner = recovery;
		try {
			poisonedOwner.lease.close();
		} catch (error) {
			if (rawTerminalOwner === recovery) rawTerminalOwner = poisonedOwner;
			throw new RawTerminalCapabilityError("Could not restore previously owned raw terminal input", error);
		}
		if (rawTerminalOwner === recovery) rawTerminalOwner = undefined;
		if (recovery.cancelled) throw interruptedAcquisitionError();
	}
	const acquisition: AcquiringRawTerminalOwner = { acquiring: true, cancelled: false };
	rawTerminalOwner = acquisition;
	const stdin = options.stdin ?? process.stdin;
	const platform = options.platform ?? process.platform;
	let wasRaw: boolean;
	let wasFlowing: boolean | null | undefined;
	let wasPaused: boolean;
	try {
		if (!stdin.isTTY || typeof stdin.setRawMode !== "function")
			throw new RawTerminalCapabilityError("Raw terminal input requires a TTY with setRawMode support");
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		wasRaw = stdin.isRaw === true;
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		wasFlowing = stdin.readableFlowing;
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		wasPaused = stdin.isPaused();
		if (acquisition.cancelled) throw interruptedAcquisitionError();
	} catch (error) {
		if (rawTerminalOwner === acquisition) rawTerminalOwner = undefined;
		if (error instanceof RawTerminalCapabilityError) throw error;
		throw new RawTerminalCapabilityError("Could not inspect raw terminal input state", error);
	}
	let consoleDriver: WindowsConsoleDriver | undefined;
	let originalConsoleMode: number | undefined;
	try {
		if (platform === "win32") {
			consoleDriver = options.consoleDriver ?? createWindowsConsoleDriver();
			originalConsoleMode = consoleDriver.getInputMode();
			if (acquisition.cancelled) throw interruptedAcquisitionError();
			if (originalConsoleMode === undefined) {
				throw new RawTerminalCapabilityError("Raw terminal input requires a Windows console input mode");
			}
		}
	} catch (error) {
		const closeDriver = (): void => {
			consoleDriver?.close();
			if (rawTerminalOwner === acquisition) rawTerminalOwner = undefined;
		};
		try {
			closeDriver();
		} catch (closeError) {
			rawTerminalOwner = { lease: { close: closeDriver } };
			throw new AggregateError([error, closeError], "Could not adopt and close Windows console input mode");
		}
		if (error instanceof RawTerminalCapabilityError) throw error;
		throw new RawTerminalCapabilityError("Could not read Windows console input mode", error);
	}

	let rawRestored = false;
	let flowRestored = false;
	let consoleRestored = originalConsoleMode === undefined;
	let driverClosed = originalConsoleMode === undefined;
	let closed = false;
	let closing = false;
	const lease: RawTerminalLease = {
		close: (): void => {
			if (closed || closing) return;
			closing = true;
			const errors: unknown[] = [];
			const restore = (complete: () => void, operation: () => void): void => {
				try {
					operation();
					complete();
				} catch (error) {
					errors.push(error);
				}
			};
			const restoreFlow = (): void => {
				if (wasFlowing === true) stdin.resume();
				else if (wasFlowing === false || wasFlowing === null || wasPaused) stdin.pause();
				else stdin.resume();
			};
			if (!flowRestored) restore(() => (flowRestored = true), restoreFlow);
			if (!rawRestored)
				restore(
					() => (rawRestored = true),
					() => stdin.setRawMode!(wasRaw),
				);
			if (originalConsoleMode !== undefined) {
				if (rawRestored && !consoleRestored) {
					restore(
						() => (consoleRestored = true),
						() => {
							if (!consoleDriver!.setInputMode(originalConsoleMode!)) {
								throw new Error("Could not restore Windows console input mode");
							}
						},
					);
				}
				if (rawRestored && consoleRestored && !driverClosed)
					restore(
						() => (driverClosed = true),
						() => consoleDriver!.close(),
					);
			}
			closing = false;
			if (errors.length > 0)
				throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Could not restore raw terminal input");
			closed = true;
			if (rawTerminalOwner === lease) rawTerminalOwner = undefined;
		},
	};

	if (rawTerminalOwner !== acquisition || acquisition.cancelled) throw interruptedAcquisitionError();
	acquisition.lease = lease;
	try {
		stdin.setRawMode(true);
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		if (originalConsoleMode !== undefined) {
			let rawConsoleMode: number | undefined;
			try {
				rawConsoleMode = consoleDriver!.getInputMode();
			} catch (error) {
				throw new RawTerminalCapabilityError(
					"Could not read Windows console input mode after enabling raw input",
					error,
				);
			}
			if (acquisition.cancelled) throw interruptedAcquisitionError();
			if (rawConsoleMode === undefined)
				throw new RawTerminalCapabilityError("Could not read Windows console input mode after enabling raw input");
			const vtInputMode = rawConsoleMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
			if (vtInputMode !== rawConsoleMode) {
				if (!consoleDriver!.setInputMode(vtInputMode)) {
					throw new RawTerminalCapabilityError("Could not enable Windows virtual terminal input");
				}
				if (acquisition.cancelled) throw interruptedAcquisitionError();
			}
		}
		stdin.resume();
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		rawTerminalOwner = lease;
		return lease;
	} catch (error) {
		try {
			lease.close();
		} catch (restorationError) {
			rawTerminalOwner = { lease };
			throw new AggregateError([error, restorationError], "Could not acquire and restore raw terminal input");
		}
		rawTerminalOwner = undefined;
		throw error;
	}
}
