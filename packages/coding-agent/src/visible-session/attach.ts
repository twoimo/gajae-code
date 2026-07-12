import { createRawTerminalLease, type RawTerminalLease } from "@gajae-code/tui";
import type { LocalControlClient } from "./control-client";
import { MAX_CONTROL_STREAM_BYTES, MAX_CONTROL_TERMINAL_DIMENSION, MAX_CONTROL_WRITE_BYTES } from "./control-protocol";
import type { VisibleSessionPublicStateReader } from "./public-state-reader";

import { DEFAULT_PUBLIC_LOG_CAP_BYTES } from "./state";

const DEFAULT_REPLAY_BYTES = MAX_CONTROL_STREAM_BYTES;
const DEFAULT_POLL_BYTES = MAX_CONTROL_STREAM_BYTES;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_PENDING_OUTPUT_BYTES = DEFAULT_PUBLIC_LOG_CAP_BYTES * 2;

const MAX_PENDING_INPUT_BYTES = MAX_CONTROL_WRITE_BYTES * 2;
const PAUSE_INPUT_AT_BYTES = MAX_CONTROL_WRITE_BYTES;
const RESUME_INPUT_AT_BYTES = Math.floor(PAUSE_INPUT_AT_BYTES / 2);
const MAX_LIVE_CONTROL_RECOVERY_ATTEMPTS = 3;
type AttachControl = Pick<LocalControlClient, "stream" | "write" | "resize">;
type AcceptedWriteCloseRequest = {
	reason: VisibleSessionAttachReason;
	error: Error | undefined;
	rejectOnSuccess: boolean;
};

type DataListener = (chunk: Uint8Array | string) => void;
type ErrorListener = (error: Error) => void;
type EndListener = () => void;
type ResizeListener = () => void;
export type VisibleSessionAttachTimer = NodeJS.Timeout | number;

export interface VisibleSessionAttachStdin {
	isTTY?: boolean;
	columns?: number;
	rows?: number;
	pause(): unknown;
	resume(): unknown;
	on(event: "data", listener: DataListener): unknown;
	on(event: "end", listener: EndListener): unknown;
	on(event: "error", listener: ErrorListener): unknown;
	removeListener(event: "data", listener: DataListener): unknown;
	removeListener(event: "end", listener: EndListener): unknown;
	removeListener(event: "error", listener: ErrorListener): unknown;
}

export interface VisibleSessionAttachStdout {
	columns?: number;
	rows?: number;
	write(bytes: Uint8Array): boolean;
	on(event: "drain", listener: EndListener): unknown;
	on(event: "error", listener: ErrorListener): unknown;
	removeListener(event: "drain", listener: EndListener): unknown;
	removeListener(event: "error", listener: ErrorListener): unknown;
}

export interface VisibleSessionAttachTerminal {
	on(event: "resize", listener: ResizeListener): unknown;
	removeListener(event: "resize", listener: ResizeListener): unknown;
	columns?: number;
	rows?: number;
}

export interface VisibleSessionAttachOptions {
	control: AttachControl;
	reader: Pick<VisibleSessionPublicStateReader, "read">;
	readOnly?: boolean;
	replayBytes?: number;
	pollBytes?: number;
	pollIntervalMs?: number;
	columns?: number;
	rows?: number;
	signal?: AbortSignal;
}

export interface VisibleSessionAttachDependencies {
	stdin?: VisibleSessionAttachStdin;
	stdout?: VisibleSessionAttachStdout;
	terminal?: VisibleSessionAttachTerminal;
	createRawTerminalLease?: () => RawTerminalLease;
	setTimeout?: (handler: () => void, milliseconds: number) => VisibleSessionAttachTimer;
	clearTimeout?: (timer: VisibleSessionAttachTimer) => void;
}

export type VisibleSessionAttachReason =
	| "detached"
	| "session-ended"
	| "control-disconnected"
	| "aborted"
	| "output-error";

export interface VisibleSessionAttachResult {
	reason: VisibleSessionAttachReason;
	bytesReplayed: number;
	bytesFollowed: number;
	initialReplayTruncated: boolean;
	liveTruncationCount: number;
}

function bounded(value: number | undefined, fallback: number, maximum: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
		throw new Error(`invalid_visible_session_attach_${name}`);
	return value;
}

function dimension(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_visible_session_attach_dimensions");
	if (value > MAX_CONTROL_TERMINAL_DIMENSION) throw new Error("invalid_visible_session_attach_dimensions");
	return value;
}

function bytes(chunk: Uint8Array | string): Uint8Array {
	return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}
function errorFrom(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(fallback, { cause: error });
}

/** Attach a local terminal to an already authenticated visible-session control stream. */
export async function runVisibleSessionAttach(
	options: VisibleSessionAttachOptions,
	dependencies: VisibleSessionAttachDependencies = {},
): Promise<VisibleSessionAttachResult> {
	const stdin = dependencies.stdin ?? (process.stdin as VisibleSessionAttachStdin);
	const stdout = dependencies.stdout ?? (process.stdout as VisibleSessionAttachStdout);
	const terminal = dependencies.terminal ?? (process.stdout as VisibleSessionAttachTerminal);
	const replayBytes = bounded(options.replayBytes, DEFAULT_REPLAY_BYTES, MAX_CONTROL_STREAM_BYTES, "replay_bytes");
	const pollBytes = bounded(options.pollBytes, DEFAULT_POLL_BYTES, MAX_CONTROL_STREAM_BYTES, "poll_bytes");
	const pollIntervalMs = bounded(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 60_000, "poll_interval_ms");
	const size = (): { columns: number; rows: number } => ({
		columns: dimension(options.columns ?? terminal.columns ?? stdout.columns, 80),
		rows: dimension(options.rows ?? terminal.rows ?? stdout.rows, 24),
	});

	if (!stdin.isTTY) throw new Error("Visible session attach requires a TTY");
	if (options.signal?.aborted)
		return {
			reason: "aborted",
			bytesReplayed: 0,
			bytesFollowed: 0,
			initialReplayTruncated: false,
			liveTruncationCount: 0,
		};

	// Validate configured/current dimensions before raw mode and listeners have side effects.
	const initialSize = options.readOnly ? undefined : size();
	const lease = (dependencies.createRawTerminalLease ?? createRawTerminalLease)();
	const setTimer =
		dependencies.setTimeout ??
		((handler: () => void, milliseconds: number): VisibleSessionAttachTimer => setTimeout(handler, milliseconds));
	const clearTimer = dependencies.clearTimeout ?? ((value: VisibleSessionAttachTimer): void => clearTimeout(value));
	let timer: VisibleSessionAttachTimer | undefined;
	let closed = false;
	let settling = false;
	let detaching = false;
	let cursor: number | null = null;
	let initial = true;
	let bytesReplayed = 0;
	let bytesFollowed = 0;
	let initialReplayTruncated = false;
	let liveTruncationCount = 0;
	let resizeInFlight = false;
	let pendingResize: { columns: number; rows: number } | undefined;
	let writes = Promise.resolve();
	let outputBackpressured = false;
	let pendingCloseReason: VisibleSessionAttachReason | undefined;
	let pendingCloseError: Error | undefined;
	let pendingCloseRejectOnSuccess = false;
	let polling = false;
	let pollPending = false;
	const pendingOutput: { bytes: Uint8Array; initial: boolean }[] = [];
	let pendingOutputBytes = 0;
	let pendingInputBytes = 0;
	let inputPaused = false;
	let stdinDataSetup = false;
	let stdinEndSetup = false;
	let stdinErrorSetup = false;
	let stdoutDrainSetup = false;
	let stdoutErrorSetup = false;
	let terminalResizeSetup = false;
	let signalAbortSetup = false;
	let streamRecoveryAttempts = 0;
	let resizeRecoveryAttempts = 0;
	let streamRecovering = false;
	let resizeRecovering = false;
	let writeFailure: Error | undefined;
	let writeFailureClassification = Promise.resolve();
	let acceptedWriteClose: AcceptedWriteCloseRequest | undefined;
	let acceptedWriteCloseQueued = false;
	const complete = Promise.withResolvers<VisibleSessionAttachReason>();

	const fence = (): void => {
		settling = true;
		pendingResize = undefined;
		if (timer !== undefined) {
			clearTimer(timer);
			timer = undefined;
		}
	};

	const cleanup = (reason: VisibleSessionAttachReason, error?: Error, rejectOnSuccess = false): void => {
		if (closed) return;
		closed = true;
		fence();
		const cleanupErrors: Error[] = [];
		const remove = (registered: boolean, handler: () => unknown): void => {
			if (!registered) return;
			try {
				handler();
			} catch (cleanupError) {
				cleanupErrors.push(errorFrom(cleanupError, "visible_session_attach_listener_cleanup_failed"));
			}
		};
		if (inputPaused) {
			try {
				stdin.resume();
				inputPaused = false;
			} catch (cleanupError) {
				cleanupErrors.push(errorFrom(cleanupError, "visible_session_attach_input_resume_failed"));
			}
		}
		remove(stdinDataSetup, () => stdin.removeListener("data", onData));
		remove(stdinEndSetup, () => stdin.removeListener("end", onEnd));
		remove(stdinErrorSetup, () => stdin.removeListener("error", onStdinError));
		remove(stdoutDrainSetup, () => stdout.removeListener("drain", onDrain));
		remove(stdoutErrorSetup, () => stdout.removeListener("error", onStdoutError));
		if (!options.readOnly) remove(terminalResizeSetup, () => terminal.removeListener("resize", onResize));
		if (options.signal) remove(signalAbortSetup, () => options.signal?.removeEventListener("abort", onAbort));
		try {
			lease.close();
		} catch (cleanupError) {
			cleanupErrors.push(errorFrom(cleanupError, "visible_session_attach_terminal_restore_failed"));
		}
		if (cleanupErrors.length > 0) {
			const errors = error ? [error, ...cleanupErrors] : cleanupErrors;
			complete.reject(
				errors.length === 1 ? errors[0] : new AggregateError(errors, "visible_session_attach_cleanup_failed"),
			);
			return;
		}
		if (error && rejectOnSuccess) {
			complete.reject(error);
			return;
		}
		complete.resolve(reason);
	};
	const cleanupError = (error: Error): void => cleanup("output-error", error, true);

	const onRecoverableControlFailure = (operation: "stream" | "resize", error: Error, retry: () => void): void => {
		if (closed || settling || detaching) return;
		if (operation === "stream") {
			if (streamRecovering) return;
			streamRecovering = true;
		} else {
			if (resizeRecovering) return;
			resizeRecovering = true;
		}
		const finishRecovery = (): void => {
			if (operation === "stream") streamRecovering = false;
			else resizeRecovering = false;
		};
		void Promise.resolve()
			.then(() => options.reader.read({ bytes: 1, lines: 1 }))
			.then(snapshot => {
				if (closed || settling || detaching) return;
				if (snapshot.final || snapshot.vanished) {
					finishRecovery();
					finishAfterAcceptedWrites("session-ended", error);
					return;
				}
				const attempts = operation === "stream" ? streamRecoveryAttempts : resizeRecoveryAttempts;
				if (attempts < MAX_LIVE_CONTROL_RECOVERY_ATTEMPTS) {
					if (operation === "stream") streamRecoveryAttempts++;
					else resizeRecoveryAttempts++;
					finishRecovery();
					retry();
					return;
				}
				finishRecovery();
				finishAfterAcceptedWrites("control-disconnected", error);
			})
			.catch(classificationError => {
				if (closed || settling || detaching) return;
				finishRecovery();
				finishAfterAcceptedWrites(
					"control-disconnected",
					new AggregateError(
						[error, errorFrom(classificationError, "visible_session_attach_state_classification_failed")],
						"visible_session_attach_control_classification_failed",
					),
					true,
				);
			});
	};

	const classifyWriteFailure = (error: Error): void => {
		writeFailureClassification = Promise.resolve()
			.then(() => options.reader.read({ bytes: 1, lines: 1 }))
			.then(() => {
				if (closed || detaching) return;
				finishAfterAcceptedWrites("control-disconnected", error);
			})
			.catch(classificationError => {
				if (closed || detaching) return;
				finishAfterAcceptedWrites(
					"control-disconnected",
					new AggregateError(
						[error, errorFrom(classificationError, "visible_session_attach_state_classification_failed")],
						"visible_session_attach_control_classification_failed",
					),
					true,
				);
			});
	};
	const updateAcceptedWriteClose = (
		reason: VisibleSessionAttachReason,
		error: Error | undefined,
		rejectOnSuccess: boolean,
	): void => {
		if (
			acceptedWriteClose === undefined ||
			(acceptedWriteClose.reason === "session-ended" && reason !== "session-ended") ||
			(!acceptedWriteClose.rejectOnSuccess && rejectOnSuccess)
		) {
			acceptedWriteClose = { reason, error, rejectOnSuccess };
		}
	};
	const finishAfterAcceptedWrites = (
		reason: VisibleSessionAttachReason,
		error?: Error,
		rejectOnSuccess = false,
	): void => {
		if (closed) return;
		fence();
		updateAcceptedWriteClose(reason, error, rejectOnSuccess);
		if (acceptedWriteCloseQueued) return;
		acceptedWriteCloseQueued = true;
		void writes.then(async () => {
			await writeFailureClassification;
			acceptedWriteCloseQueued = false;
			if (closed || detaching) return;
			const pending = acceptedWriteClose;
			acceptedWriteClose = undefined;
			if (!pending) return;
			finishAfterOutput(pending.reason, pending.error, pending.rejectOnSuccess);
		});
	};
	const updateInputBackpressure = (): void => {
		if (closed || settling || detaching) return;
		if (!inputPaused && pendingInputBytes >= PAUSE_INPUT_AT_BYTES) {
			inputPaused = true;
			stdin.pause();
			return;
		}
		if (inputPaused && pendingInputBytes <= RESUME_INPUT_AT_BYTES) {
			inputPaused = false;
			try {
				stdin.resume();
			} catch (error) {
				inputPaused = true;
				throw error;
			}
		}
	};
	const releaseInput = (length: number): void => {
		pendingInputBytes -= length;
		try {
			updateInputBackpressure();
		} catch (error) {
			cleanupError(errorFrom(error, "visible_session_attach_input_backpressure_failed"));
		}
	};
	const queueWrite = (payload: Uint8Array): void => {
		if (payload.length === 0 || closed || settling || detaching) return;
		if (payload.length > MAX_PENDING_INPUT_BYTES - pendingInputBytes) {
			cleanupError(new Error("visible_session_attach_input_queue_overflow"));
			return;
		}
		pendingInputBytes += payload.length;
		for (let offset = 0; offset < payload.length; offset += MAX_CONTROL_WRITE_BYTES) {
			const chunk = payload.subarray(offset, Math.min(offset + MAX_CONTROL_WRITE_BYTES, payload.length));
			writes = writes.then(async () => {
				try {
					if (!closed && !writeFailure) await options.control.write(chunk);
				} catch (error) {
					const failure = errorFrom(error, "visible_session_attach_control_write_failed");
					if (!writeFailure && !closed) {
						writeFailure = failure;
						if (detaching) finishAfterOutput("control-disconnected", failure);
						else classifyWriteFailure(failure);
					}
				} finally {
					releaseInput(chunk.length);
				}
			});
		}
		try {
			updateInputBackpressure();
		} catch (error) {
			cleanupError(errorFrom(error, "visible_session_attach_input_backpressure_failed"));
		}
	};

	const beginDetach = (): void => {
		if (closed || detaching) return;
		detaching = true;
		pendingResize = undefined;
		if (timer !== undefined) {
			clearTimer(timer);
			timer = undefined;
		}
		void writes.then(() => {
			if (!closed) cleanup("detached");
		});
	};
	const beginInputFailure = (error: Error): void => {
		if (closed || detaching) return;
		detaching = true;
		pendingResize = undefined;
		if (timer !== undefined) {
			clearTimer(timer);
			timer = undefined;
		}
		void writes.then(() => {
			if (!closed) cleanupError(error);
		});
	};

	const onData: DataListener = chunk => {
		if (closed || settling || detaching) return;
		const input = bytes(chunk);
		const detachAt = input.indexOf(0x1d);
		if (detachAt !== -1) {
			if (!options.readOnly) queueWrite(input.subarray(0, detachAt));
			beginDetach();
			return;
		}
		if (!options.readOnly) queueWrite(input);
	};
	const onEnd: EndListener = () => {
		if (!closed && !settling && !detaching) beginDetach();
	};
	const onStdinError: ErrorListener = error => {
		if (!closed && !settling && !detaching) beginInputFailure(error);
	};
	const onStdoutError: ErrorListener = error => cleanup("output-error", error);
	const onDrain: EndListener = () => {
		if (!outputBackpressured || closed) return;
		outputBackpressured = false;
		if (!flushOutput()) return;
		if (pendingCloseReason && pendingOutput.length === 0 && !outputBackpressured) {
			const reason = pendingCloseReason;
			const error = pendingCloseError;
			const rejectOnSuccess = pendingCloseRejectOnSuccess;
			pendingCloseReason = undefined;
			pendingCloseError = undefined;
			pendingCloseRejectOnSuccess = false;
			cleanup(reason, error, rejectOnSuccess);
		} else if (!settling && !outputBackpressured) poll();
	};
	const onAbort = (): void => cleanup("aborted");

	const sendResize = (): void => {
		if (closed || settling || detaching || options.readOnly || resizeInFlight || resizeRecovering || !pendingResize)
			return;
		const next = pendingResize;
		pendingResize = undefined;
		resizeInFlight = true;
		void Promise.resolve()
			.then(() => options.control.resize(next.columns, next.rows))
			.then(
				() => {
					resizeInFlight = false;
					resizeRecoveryAttempts = 0;
					sendResize();
				},
				error => {
					resizeInFlight = false;
					onRecoverableControlFailure(
						"resize",
						errorFrom(error, "visible_session_attach_control_resize_failed"),
						() => {
							if (!pendingResize) pendingResize = next;
							sendResize();
						},
					);
				},
			);
	};
	const onResize: ResizeListener = () => {
		if (closed || settling || detaching) return;
		try {
			pendingResize = size();
		} catch {
			cleanupError(new Error("invalid_visible_session_attach_dimensions"));
			return;
		}
		sendResize();
	};

	const enqueueOutput = (output: Uint8Array): boolean => {
		if (output.length === 0) return true;
		if (pendingOutputBytes + output.length > MAX_PENDING_OUTPUT_BYTES) {
			cleanupError(new Error("visible_session_attach_output_queue_overflow"));
			return false;
		}
		pendingOutput.push({ bytes: output, initial });
		pendingOutputBytes += output.length;
		return true;
	};
	const flushOutput = (): boolean => {
		try {
			while (!outputBackpressured && pendingOutput.length > 0) {
				const next = pendingOutput.shift();
				if (!next) break;
				pendingOutputBytes -= next.bytes.length;
				if (!stdout.write(next.bytes)) outputBackpressured = true;
				if (next.initial) bytesReplayed += next.bytes.length;
				else bytesFollowed += next.bytes.length;
			}
			return true;
		} catch (error) {
			cleanup("output-error", errorFrom(error, "visible_session_attach_stdout_write_failed"));
			return false;
		}
	};

	const finishAfterOutput = (reason: VisibleSessionAttachReason, error?: Error, rejectOnSuccess = false): void => {
		if (!flushOutput()) return;
		if (outputBackpressured || pendingOutput.length > 0) {
			pendingCloseReason = reason;
			pendingCloseError = error;
			pendingCloseRejectOnSuccess = rejectOnSuccess;
			return;
		}
		cleanup(reason, error, rejectOnSuccess);
	};
	const poll = (): void => {
		if (closed || settling || detaching || streamRecovering) return;
		pollPending = true;
		if (polling) return;
		polling = true;
		void (async () => {
			while (pollPending && !closed && !settling && !detaching) {
				pollPending = false;
				const requestedCursor = cursor;
				const limit = initial ? replayBytes : pollBytes;
				try {
					const result = await options.control.stream(requestedCursor, limit);
					if (closed || settling || detaching) return;
					streamRecoveryAttempts = 0;
					const cursorGap =
						requestedCursor === null ? result.startCursor > 0 : result.startCursor > requestedCursor;
					const outputStart =
						requestedCursor === null ? result.startCursor : Math.max(requestedCursor, result.startCursor);
					const outputOffset = outputStart - result.startCursor;
					const output =
						outputOffset < result.bytes.length ? result.bytes.subarray(outputOffset) : new Uint8Array();
					if (!enqueueOutput(output) || !flushOutput()) return;
					if (initial) initialReplayTruncated = result.truncated || cursorGap;
					else if (result.truncated || cursorGap) liveTruncationCount++;
					const nextCursor =
						requestedCursor === null ? result.endCursor : Math.max(requestedCursor, result.endCursor);
					const cursorAdvanced = requestedCursor === null || nextCursor > requestedCursor;
					cursor = nextCursor;
					initial = false;
					if (!result.running) {
						if (result.bytes.length >= limit && cursorAdvanced) {
							pollPending = true;
							continue;
						}
						finishAfterAcceptedWrites("session-ended");
						return;
					}
					if (!outputBackpressured)
						timer = setTimer(() => {
							timer = undefined;
							poll();
						}, pollIntervalMs);
				} catch (error) {
					onRecoverableControlFailure(
						"stream",
						errorFrom(error, "visible_session_attach_control_stream_failed"),
						poll,
					);
					return;
				}
			}
		})().finally(() => {
			polling = false;
			if (pollPending && !closed && !settling && !detaching) poll();
		});
	};

	try {
		stdinDataSetup = true;
		stdin.on("data", onData);
		stdinEndSetup = true;
		stdin.on("end", onEnd);
		stdinErrorSetup = true;
		stdin.on("error", onStdinError);
		stdoutDrainSetup = true;
		stdout.on("drain", onDrain);
		stdoutErrorSetup = true;
		stdout.on("error", onStdoutError);
		if (initialSize) {
			pendingResize = initialSize;
			terminalResizeSetup = true;
			terminal.on("resize", onResize);
		}
		if (options.signal) {
			signalAbortSetup = true;
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (!closed) {
			if (options.signal?.aborted) {
				cleanup("aborted");
			} else {
				if (initialSize) sendResize();
				poll();
			}
		}
	} catch (error) {
		cleanupError(errorFrom(error, "visible_session_attach_setup_failed"));
	}
	const reason = await complete.promise;
	return { reason, bytesReplayed, bytesFollowed, initialReplayTruncated, liveTruncationCount };
}
