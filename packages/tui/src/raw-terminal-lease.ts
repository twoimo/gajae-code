import { dlopen, FFIType, ptr } from "bun:ffi";

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
const rawTerminalLeaseRegistrySymbol: unique symbol = Symbol.for("@gajae-code/tui/raw-terminal-lease.registry");

interface AcquiringRawTerminalOwner {
	acquiring: true;
	cancelled: boolean;
	mutationDepth: number;
	lease?: RawTerminalLease;
}

interface PoisonedRawTerminalOwner {
	lease: RawTerminalLease;
}

interface RestoringRawTerminalOwner {
	lease: RawTerminalLease;
	restoring: true;
}

type RawTerminalOwner =
	| RawTerminalLease
	| AcquiringRawTerminalOwner
	| PoisonedRawTerminalOwner
	| RestoringRawTerminalOwner;

interface RawTerminalLeaseRegistry {
	owners: Map<RawTerminalStdin, RawTerminalOwner>;
}

type GlobalWithRawTerminalLeaseRegistry = typeof globalThis & {
	[rawTerminalLeaseRegistrySymbol]?: RawTerminalLeaseRegistry;
};

/**
 * Minimal stdin surface needed to temporarily own raw terminal input.
 *
 * Boolean `readableFlowing` snapshots are restored with `resume()` or `pause()`.
 * A `null` or `undefined` snapshot is supported only when
 * `restoreReadableFlowing` is supplied, because Node's public pause/resume API
 * cannot recreate either state exactly.
 */
export interface RawTerminalStdin {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => unknown;
	readableFlowing?: boolean | null;
	/** Recreates a captured `null` or `undefined` flow state after lease close. */
	restoreReadableFlowing?: (state: null | undefined) => unknown;
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

/** Owns raw stdin until closed, restoring the supported state observed at acquisition. */
export interface RawTerminalLease {
	close(): void;
}

function getRawTerminalLeaseRegistry(): RawTerminalLeaseRegistry {
	const global = globalThis as GlobalWithRawTerminalLeaseRegistry;
	let registry = global[rawTerminalLeaseRegistrySymbol];
	if (!registry) {
		registry = { owners: new Map() };
		global[rawTerminalLeaseRegistrySymbol] = registry;
	}
	return registry;
}

function clearRawTerminalOwner(
	registry: RawTerminalLeaseRegistry,
	stdin: RawTerminalStdin,
	owner: RawTerminalOwner,
): void {
	if (registry.owners.get(stdin) === owner) registry.owners.delete(stdin);
}

/**
 * Restore all raw-terminal resources currently owned in this JavaScript realm.
 * If emergency restoration interrupts an in-flight external mutation, the
 * acquisition remains owned and completes its rollback after that mutation
 * returns. Failed restoration remains owned so a later call can retry it.
 */
export function emergencyRawTerminalRestore(): void {
	const registry = getRawTerminalLeaseRegistry();
	const errors: unknown[] = [];
	for (const [stdin, owner] of [...registry.owners]) {
		try {
			restoreRawTerminalOwner(registry, stdin, owner);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0)
		throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Could not restore raw terminal input");
}

function restoreRawTerminalOwner(
	registry: RawTerminalLeaseRegistry,
	stdin: RawTerminalStdin,
	owner: RawTerminalOwner,
): void {
	if (registry.owners.get(stdin) !== owner || isRestoringRawTerminalOwner(owner)) return;
	if (isAcquiringRawTerminalOwner(owner)) {
		owner.cancelled = true;
		if (owner.mutationDepth === 0) owner.lease?.close();
		return;
	}
	if (!isPoisonedRawTerminalOwner(owner)) {
		owner.close();
		return;
	}
	const restoringOwner: RestoringRawTerminalOwner = { lease: owner.lease, restoring: true };
	registry.owners.set(stdin, restoringOwner);
	try {
		owner.lease.close();
	} catch (error) {
		if (registry.owners.get(stdin) === restoringOwner) registry.owners.set(stdin, owner);
		throw error;
	}
	clearRawTerminalOwner(registry, stdin, restoringOwner);
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

function isAcquiringRawTerminalOwner(owner: RawTerminalOwner): owner is AcquiringRawTerminalOwner {
	return typeof owner === "object" && "acquiring" in owner;
}

function isPoisonedRawTerminalOwner(owner: RawTerminalOwner): owner is PoisonedRawTerminalOwner {
	return typeof owner === "object" && "lease" in owner && !("restoring" in owner);
}

function isRestoringRawTerminalOwner(owner: RawTerminalOwner): owner is RestoringRawTerminalOwner {
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
	const stdin: RawTerminalStdin = options.stdin ?? process.stdin;
	const platform = options.platform ?? process.platform;
	const registry = getRawTerminalLeaseRegistry();
	const currentOwner = registry.owners.get(stdin);
	if (currentOwner && isAcquiringRawTerminalOwner(currentOwner))
		throw new Error("Raw terminal input is already owned");
	if (currentOwner) {
		if (!isPoisonedRawTerminalOwner(currentOwner)) throw new Error("Raw terminal input is already owned");
		const recovery: AcquiringRawTerminalOwner = { acquiring: true, cancelled: false, mutationDepth: 0 };
		registry.owners.set(stdin, recovery);
		try {
			currentOwner.lease.close();
		} catch (error) {
			if (registry.owners.get(stdin) === recovery) registry.owners.set(stdin, currentOwner);
			throw new RawTerminalCapabilityError("Could not restore previously owned raw terminal input", error);
		}
		clearRawTerminalOwner(registry, stdin, recovery);
		if (recovery.cancelled) throw interruptedAcquisitionError();
	}

	const acquisition: AcquiringRawTerminalOwner = { acquiring: true, cancelled: false, mutationDepth: 0 };
	registry.owners.set(stdin, acquisition);
	let wasRaw: boolean;
	let wasFlowing: boolean | null | undefined;
	try {
		if (!stdin.isTTY || typeof stdin.setRawMode !== "function")
			throw new RawTerminalCapabilityError("Raw terminal input requires a TTY with setRawMode support");
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		wasRaw = stdin.isRaw === true;
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		wasFlowing = stdin.readableFlowing;
		if (wasFlowing !== true && wasFlowing !== false && typeof stdin.restoreReadableFlowing !== "function") {
			throw new RawTerminalCapabilityError(
				"Raw terminal input requires restoreReadableFlowing support for a null or undefined readableFlowing state",
			);
		}
		if (acquisition.cancelled) throw interruptedAcquisitionError();
	} catch (error) {
		clearRawTerminalOwner(registry, stdin, acquisition);
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
			clearRawTerminalOwner(registry, stdin, acquisition);
		};
		try {
			closeDriver();
		} catch (closeError) {
			registry.owners.set(stdin, { lease: { close: closeDriver } });
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
				else if (wasFlowing === false) stdin.pause();
				else stdin.restoreReadableFlowing!(wasFlowing);
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
			clearRawTerminalOwner(registry, stdin, lease);
		},
	};

	acquisition.lease = lease;
	const mutate = (operation: () => void): void => {
		acquisition.mutationDepth++;
		try {
			operation();
		} finally {
			acquisition.mutationDepth--;
		}
	};
	try {
		mutate(() => stdin.setRawMode!(true));
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
				let vtInputEnabled = false;
				mutate(() => {
					vtInputEnabled = consoleDriver!.setInputMode(vtInputMode);
				});
				if (!vtInputEnabled) {
					throw new RawTerminalCapabilityError("Could not enable Windows virtual terminal input");
				}
				if (acquisition.cancelled) throw interruptedAcquisitionError();
			}
		}
		mutate(() => stdin.resume());
		if (acquisition.cancelled) throw interruptedAcquisitionError();
		if (registry.owners.get(stdin) !== acquisition) throw interruptedAcquisitionError();
		registry.owners.set(stdin, lease);
		return lease;
	} catch (error) {
		try {
			lease.close();
		} catch (restorationError) {
			if (registry.owners.get(stdin) === acquisition) registry.owners.set(stdin, { lease });
			throw new AggregateError([error, restorationError], "Could not acquire and restore raw terminal input");
		}
		clearRawTerminalOwner(registry, stdin, acquisition);
		throw error;
	}
}
