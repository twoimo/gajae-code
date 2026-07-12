import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { runVisibleSessionAttach } from "./attach";
import type { ControlStreamResult } from "./control-client";
import { MAX_CONTROL_WRITE_BYTES } from "./control-protocol";

class Input extends EventEmitter {
	isTTY = true;
	pauseCalls = 0;
	resumeCalls = 0;

	pause(): void {
		this.pauseCalls++;
	}

	resume(): void {
		this.resumeCalls++;
	}
}

class Output extends EventEmitter {
	readonly chunks: Uint8Array[] = [];
	#acceptWrites = true;

	setAcceptWrites(accept: boolean): void {
		this.#acceptWrites = accept;
	}

	write(chunk: Uint8Array): boolean {
		this.chunks.push(Uint8Array.from(chunk));
		return this.#acceptWrites;
	}
}

function response(
	bytes: ArrayLike<number>,
	startCursor: number,
	running: boolean,
	truncated = false,
): ControlStreamResult {
	return {
		startCursor,
		endCursor: startCursor + bytes.length,
		bytes: Uint8Array.from(bytes),
		truncated,
		running,
	};
}

function reader(terminal = false) {
	return {
		read: async () => ({ final: terminal ? {} : null, vanished: null }),
	} as never;
}

function leaseCounter(): { closes: () => number; lease: () => { close(): void } } {
	let closes = 0;
	return { closes: () => closes, lease: () => ({ close: () => closes++ }) };
}

describe("runVisibleSessionAttach", () => {
	it("writes byte-exact bounded replay and follows monotonic cursors without overlapping polls", async () => {
		const input = new Input();
		const output = new Output();
		const lease = leaseCounter();
		const cursors: (number | null)[] = [];
		const firstStream = Promise.withResolvers<ControlStreamResult>();
		let active = 0;
		let maxActive = 0;
		const resultPromise = runVisibleSessionAttach(
			{
				control: {
					stream: async cursor => {
						cursors.push(cursor);
						active++;
						maxActive = Math.max(maxActive, active);
						if (cursors.length === 1) {
							const result = await firstStream.promise;
							active--;
							return result;
						}
						active--;
						return response([0x80], 9, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 1,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: lease.lease,
				setTimeout: handler => {
					queueMicrotask(handler);
					return 0 as never;
				},
				clearTimeout: () => undefined,
			},
		);
		await Promise.resolve();
		expect(cursors).toEqual([null]);
		expect(maxActive).toBe(1);
		firstStream.resolve(response([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff], 3, true, true));
		const result = await resultPromise;
		expect(result).toEqual({
			reason: "session-ended",
			bytesReplayed: 6,
			bytesFollowed: 1,
			initialReplayTruncated: true,
			liveTruncationCount: 0,
		});
		expect(cursors).toEqual([null, 9]);
		expect(maxActive).toBe(1);
		expect(output.chunks).toEqual([Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff]), Uint8Array.of(0x80)]);
		expect(lease.closes()).toBe(1);
	});
	it("records an explicit initial truncation flag without a cursor gap", async () => {
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([0x01], 0, false, true),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
			},
			{
				stdin: new Input(),
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
			},
		);
		expect(result).toMatchObject({
			initialReplayTruncated: true,
			liveTruncationCount: 0,
			reason: "session-ended",
		});
	});
	it("serializes a drain-triggered poll behind terminal backlog prefetch", async () => {
		const input = new Input();
		const output = new Output();
		output.setAcceptWrites(false);
		const cursors: (number | null)[] = [];
		const secondStream = Promise.withResolvers<ControlStreamResult>();
		let active = 0;
		let maxActive = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async cursor => {
						cursors.push(cursor);
						active++;
						maxActive = Math.max(maxActive, active);
						if (cursors.length === 2) {
							const result = await secondStream.promise;
							active--;
							return result;
						}
						active--;
						return cursors.length === 1 ? response([0x01], 0, false) : response([], 2, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				replayBytes: 1,
				pollBytes: 1,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		while (cursors.length < 2) await Bun.sleep(1);
		output.setAcceptWrites(true);
		output.emit("drain");
		secondStream.resolve(response([0x02], 1, false));
		expect(await attaching).toMatchObject({ bytesReplayed: 1, bytesFollowed: 1 });
		expect(cursors).toEqual([null, 1, 2]);
		expect(maxActive).toBe(1);
	});
	it("drains every full terminal backlog chunk and waits for stdout drain before resolving", async () => {
		const input = new Input();
		const output = new Output();
		output.setAcceptWrites(false);
		const cursors: (number | null)[] = [];
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async cursor => {
						cursors.push(cursor);
						return cursors.length === 1
							? response([0x01, 0x02], 0, false)
							: cursors.length === 2
								? response([0x03, 0x04], 2, false)
								: response([0x05], 4, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				replayBytes: 2,
				pollBytes: 2,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		while (output.chunks.length === 0) await Bun.sleep(1);
		await Bun.sleep(1);
		expect(cursors).toEqual([null, 2, 4]);
		output.setAcceptWrites(true);
		output.emit("drain");
		const result = await attaching;
		expect(result).toMatchObject({ bytesReplayed: 2, bytesFollowed: 3 });
		expect(cursors).toEqual([null, 2, 4]);
	});
	it("flushes terminal-prefetched output and does not infer truncation from confirmation failure", async () => {
		const input = new Input();
		const output = new Output();
		output.setAcceptWrites(false);
		let calls = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						calls++;
						if (calls === 1) return response([0x01, 0x02], 0, false);
						if (calls === 2) return response([0x03, 0x04], 2, false);
						throw new Error("owner closed");
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(true),
				replayBytes: 2,
				pollBytes: 2,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		while (calls < 3) await Bun.sleep(1);
		expect(output.chunks).toEqual([Uint8Array.of(0x01, 0x02)]);
		output.setAcceptWrites(true);
		output.emit("drain");
		expect(await attaching).toMatchObject({
			reason: "session-ended",
			bytesReplayed: 2,
			bytesFollowed: 2,
			liveTruncationCount: 0,
		});
		expect(output.chunks).toEqual([Uint8Array.of(0x01, 0x02), Uint8Array.of(0x03, 0x04)]);
	});
	it("counts each truncated live poll without changing monotonic cursor advancement", async () => {
		const input = new Input();
		const output = new Output();
		const cursors: (number | null)[] = [];
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async cursor => {
						cursors.push(cursor);
						return cursors.length === 1
							? response([0x01], 0, true)
							: cursors.length === 2
								? response([0x02], 1, true, true)
								: response([0x03], 2, false, true);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 1,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
				setTimeout: handler => {
					queueMicrotask(handler);
					return 0 as never;
				},
				clearTimeout: () => undefined,
			},
		);
		expect(result).toEqual({
			reason: "session-ended",
			bytesReplayed: 1,
			bytesFollowed: 2,
			initialReplayTruncated: false,
			liveTruncationCount: 2,
		});
		expect(cursors).toEqual([null, 1, 2]);
		expect(output.chunks).toEqual([Uint8Array.of(0x01), Uint8Array.of(0x02), Uint8Array.of(0x03)]);
	});

	it("reports no truncation evidence for an untruncated replay and live stream", async () => {
		const input = new Input();
		const output = new Output();
		const cursors: (number | null)[] = [];
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async cursor => {
						cursors.push(cursor);
						return cursors.length === 1 ? response([0x01], 0, true) : response([0x02], 1, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 1,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
				setTimeout: handler => {
					queueMicrotask(handler);
					return 0 as never;
				},
				clearTimeout: () => undefined,
			},
		);
		expect(result).toEqual({
			reason: "session-ended",
			bytesReplayed: 1,
			bytesFollowed: 1,
			initialReplayTruncated: false,
			liveTruncationCount: 0,
		});
		expect(cursors).toEqual([null, 1]);
		expect(output.chunks).toEqual([Uint8Array.of(0x01), Uint8Array.of(0x02)]);
	});
	it("derives truncation from initial and live cursor gaps even when flags are false", async () => {
		const input = new Input();
		const output = new Output();
		let calls = 0;
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						calls++;
						return calls === 1 ? response([0x01], 7, true) : response([0x02], 10, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 1,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
				setTimeout: handler => {
					queueMicrotask(handler);
					return 0 as never;
				},
				clearTimeout: () => undefined,
			},
		);
		expect(result).toMatchObject({ initialReplayTruncated: true, liveTruncationCount: 1 });
	});

	it("forwards Ctrl-C and bytes before Ctrl-], then detaches without canceling", async () => {
		const input = new Input();
		const output = new Output();
		const lease = leaseCounter();
		const writes: Uint8Array[] = [];
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async chunk => {
						writes.push(Uint8Array.from(chunk));
						return {} as never;
					},
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: lease.lease },
		);
		await Promise.resolve();
		input.emit("data", Uint8Array.of(0x61, 0x03));
		input.emit("data", Uint8Array.of(0x62, 0x1d, 0x63));
		expect(await attaching).toMatchObject({ reason: "detached" });
		expect(writes).toEqual([Uint8Array.of(0x61, 0x03), Uint8Array.of(0x62)]);
		expect(lease.closes()).toBe(1);
	});
	it("chunks an oversized paste and stops at Ctrl-] without losing prior Ctrl-C bytes", async () => {
		const input = new Input();
		const output = new Output();
		const writes: Uint8Array[] = [];
		const paste = new Uint8Array(MAX_CONTROL_WRITE_BYTES * 2 + 3);
		paste.fill(0x61);
		paste[1] = 0x03;
		paste[MAX_CONTROL_WRITE_BYTES + 1] = 0x1d;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async chunk => {
						writes.push(Uint8Array.from(chunk));
						return {} as never;
					},
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		await Promise.resolve();
		input.emit("data", paste);
		await attaching;
		expect(writes).toEqual([
			paste.subarray(0, MAX_CONTROL_WRITE_BYTES),
			paste.subarray(MAX_CONTROL_WRITE_BYTES, MAX_CONTROL_WRITE_BYTES + 1),
		]);
		expect(writes.every(chunk => chunk.length <= MAX_CONTROL_WRITE_BYTES)).toBe(true);
	});
	it("waits for pending accepted writes before resolving session-ended", async () => {
		const input = new Input();
		const output = new Output();
		const lease = leaseCounter();
		const streamStarted = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const stream = Promise.withResolvers<ControlStreamResult>();
		const write = Promise.withResolvers<void>();
		let writes = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						streamStarted.resolve();
						return stream.promise;
					},
					write: async () => {
						writes++;
						writeStarted.resolve();
						await write.promise;
						return {} as never;
					},
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: lease.lease,
			},
		);
		await streamStarted.promise;
		input.emit("data", Uint8Array.of(0x61));
		await writeStarted.promise;
		let settled = false;
		void attaching.then(() => {
			settled = true;
		});
		stream.resolve(response([0x01], 0, false));
		await Bun.sleep(0);
		expect(settled).toBe(false);
		input.emit("data", Uint8Array.of(0x62));
		await Bun.sleep(0);
		expect(writes).toBe(1);
		write.resolve();
		const result = await attaching;
		expect(result).toMatchObject({ reason: "session-ended" });
		expect(lease.closes()).toBe(1);
	});
	it("classifies a failing accepted write while session-ended and preserves restoration failures", async () => {
		const input = new Input();
		const output = new Output();
		const streamStarted = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const stream = Promise.withResolvers<ControlStreamResult>();
		const write = Promise.withResolvers<void>();
		const lease = leaseCounter();
		const writeFailure = new Error("control write failed");
		const classifierFailure = new Error("state unavailable");
		const restorationFailure = new Error("restore failed");
		let error: AggregateError | undefined;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						streamStarted.resolve();
						return stream.promise;
					},
					write: async () => {
						writeStarted.resolve();
						return write.promise as never;
					},
					resize: async () => ({}) as never,
				},
				reader: {
					read: async () => {
						throw classifierFailure;
					},
				},
				pollIntervalMs: 60_000,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => {
					const rawLease = lease.lease();
					return {
						close: () => {
							rawLease.close();
							throw restorationFailure;
						},
					};
				},
			},
		);
		await streamStarted.promise;
		input.emit("data", Uint8Array.of(0x61));
		await writeStarted.promise;
		stream.resolve(response([], 0, false));
		write.reject(writeFailure);
		try {
			await attaching;
		} catch (reason: unknown) {
			expect(reason).toBeInstanceOf(AggregateError);
			error = reason as AggregateError;
		}
		if (!error) throw new Error("expected attach to reject");
		expect(error.errors).toEqual([
			expect.objectContaining({
				message: "visible_session_attach_control_classification_failed",
			}),
			expect.objectContaining({ message: "restore failed" }),
		]);
		expect(lease.closes()).toBe(1);
	});
	it("waits for backpressured output while a session-end write settles", async () => {
		const input = new Input();
		const output = new Output();
		output.setAcceptWrites(false);
		const streamStarted = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const stream = Promise.withResolvers<ControlStreamResult>();
		const write = Promise.withResolvers<void>();
		const lease = leaseCounter();
		let writes = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						streamStarted.resolve();
						return stream.promise;
					},
					write: async () => {
						writes++;
						writeStarted.resolve();
						await write.promise;
						return {} as never;
					},
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: lease.lease,
			},
		);
		await streamStarted.promise;
		input.emit("data", Uint8Array.of(0x61));
		await writeStarted.promise;
		let settled = false;
		void attaching.then(() => {
			settled = true;
		});
		stream.resolve(response([0x01], 0, false));
		await Bun.sleep(0);
		expect(settled).toBe(false);
		output.setAcceptWrites(true);
		output.emit("drain");
		await Bun.sleep(0);
		expect(settled).toBe(false);
		write.resolve();
		expect(await attaching).toMatchObject({ reason: "session-ended" });
		expect(writes).toBe(1);
		expect(lease.closes()).toBe(1);
	});
	it("reports delivery uncertainty and fences queued paste chunks after a failed control write", async () => {
		const input = new Input();
		const output = new Output();
		let writes = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => {
						writes++;
						throw new Error("connection lost");
					},
					resize: async () => ({}) as never,
				},
				reader: reader(true),
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		await Promise.resolve();
		input.emit("data", new Uint8Array(MAX_CONTROL_WRITE_BYTES + 1));
		expect(await attaching).toMatchObject({ reason: "control-disconnected" });
		expect(writes).toBe(1);
	});
	it("preserves a failing accepted write across stream recovery, detach, end, and resize races", async () => {
		const input = new Input();
		const output = new Output();
		const terminal = new EventEmitter();
		const lease = leaseCounter();
		const failedWrite = Promise.withResolvers<void>();
		const readStarted = Promise.withResolvers<void>();
		const classification = Promise.withResolvers<{ final: null; vanished: null }>();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						throw new Error("endpoint unavailable");
					},
					write: async () => failedWrite.promise as never,
					resize: async () => ({}) as never,
				},
				reader: {
					read: () => {
						readStarted.resolve();
						return classification.promise;
					},
				} as never,
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal, createRawTerminalLease: lease.lease },
		);
		await readStarted.promise;
		input.emit("data", Uint8Array.of(0x61, 0x1d));
		input.emit("end");
		terminal.emit("resize");
		failedWrite.reject(new Error("lost"));
		expect(await attaching).toMatchObject({ reason: "control-disconnected" });
		expect(lease.closes()).toBe(1);
		classification.resolve({ final: null, vanished: null });
	});
	it("prioritizes Ctrl-] over stale stream and resize failures while accepted input drains", async () => {
		const input = new Input();
		const output = new Output();
		const terminal = new EventEmitter();
		const streamStarted = Promise.withResolvers<void>();
		const resizeStarted = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const stream = Promise.withResolvers<ControlStreamResult>();
		const resize = Promise.withResolvers<void>();
		const write = Promise.withResolvers<void>();
		const writes: Uint8Array[] = [];
		let stateReads = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						streamStarted.resolve();
						return stream.promise;
					},
					write: async chunk => {
						writes.push(Uint8Array.from(chunk));
						writeStarted.resolve();
						return write.promise as never;
					},
					resize: async () => {
						resizeStarted.resolve();
						return resize.promise as never;
					},
				},
				reader: {
					read: async () => {
						stateReads++;
						return { final: null, vanished: null };
					},
				} as never,
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal, createRawTerminalLease: () => ({ close() {} }) },
		);
		await Promise.all([streamStarted.promise, resizeStarted.promise]);
		input.emit("data", Uint8Array.of(0x61, 0x1d));
		await writeStarted.promise;
		stream.reject(new Error("stale stream failure"));
		resize.reject(new Error("stale resize failure"));
		write.resolve();
		expect(await attaching).toMatchObject({ reason: "detached" });
		expect(writes).toEqual([Uint8Array.of(0x61)]);
		expect(stateReads).toBe(0);
	});
	it("delivers accepted input through a recovered stream fault", async () => {
		const input = new Input();
		const output = new Output();
		const terminal = new EventEmitter();
		const readStarted = Promise.withResolvers<void>();
		const classification = Promise.withResolvers<{ final: null; vanished: null }>();
		const streamRetried = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const writes: Uint8Array[] = [];
		let streamCalls = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						streamCalls++;
						if (streamCalls === 1) throw new Error("endpoint unavailable");
						streamRetried.resolve();
						return response([], 0, true);
					},
					write: async chunk => {
						writes.push(Uint8Array.from(chunk));
						writeStarted.resolve();
						return {} as never;
					},
					resize: async () => ({}) as never,
				},
				reader: {
					read: () => {
						readStarted.resolve();
						return classification.promise;
					},
				} as never,
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal, createRawTerminalLease: () => ({ close() {} }) },
		);
		await readStarted.promise;
		input.emit("data", Uint8Array.of(0x61));
		await writeStarted.promise;
		classification.resolve({ final: null, vanished: null });
		await streamRetried.promise;
		input.emit("data", Uint8Array.of(0x1d));
		expect(await attaching).toMatchObject({ reason: "detached" });
		expect({ streamCalls, writes }).toEqual({ streamCalls: 2, writes: [Uint8Array.of(0x61)] });
	});
	it("skips stale stream bytes and emits only the unseen overlap suffix", async () => {
		const input = new Input();
		const output = new Output();
		let calls = 0;
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						calls++;
						return calls === 1 ? response([0x61, 0x62, 0x63], 3, true) : response([0x63, 0x64, 0x65], 5, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 1,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
				setTimeout: handler => {
					queueMicrotask(handler);
					return 0 as never;
				},
				clearTimeout: () => undefined,
			},
		);
		expect(result).toMatchObject({ bytesReplayed: 3, bytesFollowed: 2 });
		expect(output.chunks).toEqual([Uint8Array.of(0x61, 0x62, 0x63), Uint8Array.of(0x64, 0x65)]);
	});
	it("pauses polling for stdout drain and remains safe when the disconnected output errors", async () => {
		const input = new Input();
		const output = new Output();
		output.setAcceptWrites(false);
		let polls = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						polls++;
						return polls === 1 ? response([0x01], 0, true) : response([0x02], 1, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(polls).toBe(1);
		while (output.chunks.length === 0) await Bun.sleep(1);
		output.setAcceptWrites(true);
		output.emit("drain");
		expect(await attaching).toMatchObject({ reason: "session-ended" });
		expect(polls).toBe(2);

		const disconnectedOutput = new Output();
		disconnectedOutput.setAcceptWrites(false);
		const disconnected = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([0x03], 0, true),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{
				stdin: new Input(),
				stdout: disconnectedOutput,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
			},
		);
		await Promise.resolve();
		await Promise.resolve();
		while (disconnectedOutput.chunks.length === 0) await Bun.sleep(1);
		disconnectedOutput.emit("error", new Error("disconnected"));
		expect(await disconnected).toMatchObject({ reason: "output-error" });
	});
	it("rejects after cleanup when raw terminal restoration fails", async () => {
		const input = new Input();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, false),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
			},
			{
				stdin: input,
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({
					close: () => {
						throw new Error("restore failed");
					},
				}),
			},
		);
		await expect(attaching).rejects.toThrow("restore failed");
	});
	it("rejects invalid bounds and initial dimensions before acquiring a terminal lease", async () => {
		const input = new Input();
		const lease = leaseCounter();
		const options = {
			control: {
				stream: async () => response([], 0, false),
				write: async () => ({}) as never,
				resize: async () => ({}) as never,
			},
			reader: reader(),
		};
		for (const replayBytes of [0, -1, 1.5, 1_000_001]) {
			await expect(
				runVisibleSessionAttach(
					{ ...options, replayBytes },
					{
						stdin: input,
						stdout: new Output(),
						terminal: new EventEmitter(),
						createRawTerminalLease: lease.lease,
					},
				),
			).rejects.toThrow("invalid_visible_session_attach_replay_bytes");
		}
		await expect(
			runVisibleSessionAttach(
				{ ...options, columns: 0 },
				{ stdin: input, stdout: new Output(), terminal: new EventEmitter(), createRawTerminalLease: lease.lease },
			),
		).rejects.toThrow("invalid_visible_session_attach_dimensions");
		expect(lease.closes()).toBe(0);
	});
	it("routes an invalid dynamic resize through one-time cleanup", async () => {
		const input = new Input();
		const output = new Output();
		const terminal = new EventEmitter() as EventEmitter & { columns?: number; rows?: number };
		terminal.columns = 80;
		terminal.rows = 24;
		const lease = leaseCounter();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal, createRawTerminalLease: lease.lease },
		);
		await Promise.resolve();
		terminal.columns = 0;
		terminal.emit("resize");
		await expect(attaching).rejects.toThrow("invalid_visible_session_attach_dimensions");
		terminal.emit("resize");
		expect(lease.closes()).toBe(1);
	});
	it("aggregates terminal restoration failure with local stdin failure", async () => {
		const stdin = new Input();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{
				stdin,
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({
					close: () => {
						throw new Error("restore failed");
					},
				}),
			},
		);
		await Promise.resolve();
		stdin.emit("error", new Error("stdin failed"));
		try {
			await attaching;
			throw new Error("expected attach failure");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([
				expect.objectContaining({ message: "stdin failed" }),
				expect.objectContaining({ message: "restore failed" }),
			]);
		}
	});
	it("honors preflight and detaching-write aborts", async () => {
		const preAbort = new AbortController();
		preAbort.abort();
		expect(
			(
				await runVisibleSessionAttach(
					{
						control: {
							stream: async () => response([], 0, true),
							write: async () => ({}) as never,
							resize: async () => ({}) as never,
						},
						reader: reader(),
						signal: preAbort.signal,
					},
					{ stdin: new Input(), stdout: new Output(), terminal: new EventEmitter() },
				)
			).reason,
		).toBe("aborted");

		const input = new Input();
		const abort = new AbortController();
		const write = Promise.withResolvers<void>();
		const lease = leaseCounter();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => write.promise as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				signal: abort.signal,
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: new Output(), terminal: new EventEmitter(), createRawTerminalLease: lease.lease },
		);
		await Promise.resolve();
		input.emit("data", Uint8Array.of(0x61, 0x1d));
		await Promise.resolve();
		abort.abort();
		expect(await attaching).toMatchObject({ reason: "aborted" });
		expect(lease.closes()).toBe(1);
		write.reject(new Error("late write failure"));
	});
	it("rejects invalid poll bounds without acquiring a terminal lease", async () => {
		const input = new Input();
		const lease = leaseCounter();
		const options = {
			control: {
				stream: async () => response([], 0, false),
				write: async () => ({}) as never,
				resize: async () => ({}) as never,
			},
			reader: reader(),
		};
		for (const invalid of [0, -1, 1.5, 60_001]) {
			await expect(
				runVisibleSessionAttach(
					{ ...options, pollIntervalMs: invalid },
					{
						stdin: input,
						stdout: new Output(),
						terminal: new EventEmitter(),
						createRawTerminalLease: lease.lease,
					},
				),
			).rejects.toThrow("invalid_visible_session_attach_poll_interval_ms");
		}
		await expect(
			runVisibleSessionAttach(
				{ ...options, pollBytes: 0 },
				{ stdin: input, stdout: new Output(), terminal: new EventEmitter(), createRawTerminalLease: lease.lease },
			),
		).rejects.toThrow("invalid_visible_session_attach_poll_bytes");
		expect(lease.closes()).toBe(0);
	});

	it("read-only ignores input and never writes or resizes", async () => {
		const input = new Input();
		const output = new Output();
		let writes = 0;
		let resizes = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => {
						writes++;
						return {} as never;
					},
					resize: async () => {
						resizes++;
						return {} as never;
					},
				},
				reader: reader(),
				readOnly: true,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		await Promise.resolve();
		input.emit("data", Uint8Array.of(0x61, 0x03, 0x1d));
		expect(await attaching).toMatchObject({ reason: "detached" });
		expect({ writes, resizes }).toEqual({ writes: 0, resizes: 0 });
	});

	it("uses public terminal state only after a control failure", async () => {
		const input = new Input();
		const output = new Output();
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async () => Promise.reject(new Error("endpoint lost")),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(true),
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		expect(result.reason).toBe("session-ended");
	});
	it("retries only a bounded run of stream failures while public state confirms the owner remains live", async () => {
		const input = new Input();
		const output = new Output();
		let streamCalls = 0;
		let stateReads = 0;
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						streamCalls++;
						if (streamCalls === 1 || (streamCalls >= 3 && streamCalls <= 5))
							throw new Error("endpoint unavailable");
						return streamCalls === 2 ? response([], 0, true) : response([0x01], 0, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: {
					read: async () => {
						stateReads++;
						return { final: null, vanished: null };
					},
				} as never,
				pollIntervalMs: 1,
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
				setTimeout: handler => {
					queueMicrotask(handler);
					return 0 as never;
				},
				clearTimeout: () => undefined,
			},
		);
		expect(result).toMatchObject({ reason: "session-ended", bytesFollowed: 1 });
		expect({ streamCalls, stateReads }).toEqual({ streamCalls: 6, stateReads: 4 });
	});
	it("exhausts stream recovery separately when resize succeeds between stream failures", async () => {
		const input = new Input();
		const output = new Output();
		const terminal = new EventEmitter() as EventEmitter & { columns?: number; rows?: number };
		terminal.columns = 80;
		terminal.rows = 24;
		let streamCalls = 0;
		let resizeCalls = 0;
		let stateReads = 0;
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						streamCalls++;
						throw new Error("endpoint unavailable");
					},
					write: async () => ({}) as never,
					resize: async () => {
						resizeCalls++;
						return {} as never;
					},
				},
				reader: {
					read: async () => {
						stateReads++;
						terminal.emit("resize");
						await Bun.sleep(0);
						return { final: null, vanished: null };
					},
				} as never,
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal, createRawTerminalLease: () => ({ close() {} }) },
		);
		expect(result).toMatchObject({ reason: "control-disconnected" });
		expect({ streamCalls, stateReads }).toEqual({ streamCalls: 4, stateReads: 4 });
		expect(resizeCalls).toBeGreaterThanOrEqual(4);
	});
	it("honors local detach while classifying a transient control failure", async () => {
		const input = new Input();
		const output = new Output();
		const readStarted = Promise.withResolvers<void>();
		const classification = Promise.withResolvers<{ final: null; vanished: null }>();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						throw new Error("endpoint unavailable");
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: {
					read: async () => {
						readStarted.resolve();
						return classification.promise;
					},
				} as never,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		await readStarted.promise;
		input.emit("data", Uint8Array.of(0x1d));
		await expect(attaching).resolves.toMatchObject({ reason: "detached" });
		classification.resolve({ final: null, vanished: null });
		await Promise.resolve();
	});
	it("chunks astral string input serially by UTF-8 bytes across the control boundary", async () => {
		const input = new Input();
		const writes: Uint8Array[] = [];
		const firstWrite = Promise.withResolvers<void>();
		const paste = `${"a".repeat(MAX_CONTROL_WRITE_BYTES - 2)}😀z`;
		let activeWrites = 0;
		let maxActiveWrites = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async chunk => {
						activeWrites++;
						maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
						writes.push(Uint8Array.from(chunk));
						if (writes.length === 1) await firstWrite.promise;
						activeWrites--;
						return {} as never;
					},
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{
				stdin: input,
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
			},
		);
		await Promise.resolve();
		input.emit("data", paste);
		await Promise.resolve();
		expect({ writes: writes.length, maxActiveWrites }).toEqual({ writes: 1, maxActiveWrites: 1 });
		firstWrite.resolve();
		while (writes.length < 2) await Bun.sleep(1);
		input.emit("data", Uint8Array.of(0x1d));
		await attaching;
		expect(writes.every(chunk => chunk.length <= MAX_CONTROL_WRITE_BYTES)).toBe(true);
		expect(Buffer.concat(writes).equals(Buffer.from(paste))).toBe(true);
		expect(maxActiveWrites).toBe(1);
	});
	it("waits for each renewed stdout backpressure drain before terminal cleanup", async () => {
		const output = new Output();
		output.setAcceptWrites(false);
		const lease = leaseCounter();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async cursor => (cursor === null ? response([0x01], 0, false) : response([0x02], 1, false)),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				replayBytes: 1,
				pollBytes: 1,
			},
			{ stdin: new Input(), stdout: output, terminal: new EventEmitter(), createRawTerminalLease: lease.lease },
		);
		while (output.chunks.length < 1) await Bun.sleep(1);
		output.emit("drain");
		await Bun.sleep(1);
		expect(lease.closes()).toBe(0);
		expect(output.chunks).toEqual([Uint8Array.of(0x01), Uint8Array.of(0x02)]);
		output.setAcceptWrites(true);
		output.emit("drain");
		expect(await attaching).toMatchObject({ reason: "session-ended", bytesReplayed: 1, bytesFollowed: 1 });
		expect(lease.closes()).toBe(1);
	});
	it("settles after a full stale terminal page without repolling", async () => {
		const cursors: (number | null)[] = [];
		const result = await runVisibleSessionAttach(
			{
				control: {
					stream: async cursor => {
						cursors.push(cursor);
						return cursors.length === 1 ? response([0x01], 0, true) : response([0x01], 0, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				replayBytes: 1,
				pollBytes: 1,
				pollIntervalMs: 1,
			},
			{
				stdin: new Input(),
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({ close() {} }),
				setTimeout: handler => {
					queueMicrotask(handler);
					return 0 as never;
				},
				clearTimeout: () => undefined,
			},
		);
		expect(result).toMatchObject({ bytesReplayed: 1, bytesFollowed: 0 });
		expect(cursors).toEqual([null, 1]);
	});
	it("rejects overflowing pending output once after filling its cap", async () => {
		const output = new Output();
		output.setAcceptWrites(false);
		const lease = leaseCounter();
		let polls = 0;
		const page = new Uint8Array(8 * 1024);
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						polls++;
						return response(page, (polls - 1) * page.length, false);
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				replayBytes: page.length,
				pollBytes: page.length,
			},
			{ stdin: new Input(), stdout: output, terminal: new EventEmitter(), createRawTerminalLease: lease.lease },
		);
		await expect(attaching).rejects.toThrow("visible_session_attach_output_queue_overflow");
		expect({ polls, closes: lease.closes() }).toEqual({ polls: 18, closes: 1 });
	});
	it("aggregates stdout and control failures with terminal restoration failure", async () => {
		const stdoutFailure = new Error("stdout failed");
		const restorationFailure = new Error("restore failed");
		const output = new Output();
		output.write = () => {
			throw stdoutFailure;
		};
		const stdoutAttaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([0x01], 0, false),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
			},
			{
				stdin: new Input(),
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({
					close: () => {
						throw restorationFailure;
					},
				}),
			},
		);
		await expect(stdoutAttaching).rejects.toMatchObject({ errors: [stdoutFailure, restorationFailure] });

		const controlFailure = new Error("control failed");
		const controlAttaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => {
						throw controlFailure;
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
			},
			{
				stdin: new Input(),
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({
					close: () => {
						throw restorationFailure;
					},
				}),
			},
		);
		await expect(controlAttaching).rejects.toMatchObject({ errors: [controlFailure, restorationFailure] });
	});
	it("rejects while preserving control and classifier failures after flushing pending output", async () => {
		const input = new Input();
		const output = new Output();
		output.setAcceptWrites(false);
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([0x01], 0, true),
					write: async () => {
						throw new Error("control failed");
					},
					resize: async () => ({}) as never,
				},
				reader: {
					read: async () => {
						throw new Error("state unavailable");
					},
				} as never,
				pollIntervalMs: 60_000,
			},
			{ stdin: input, stdout: output, terminal: new EventEmitter(), createRawTerminalLease: () => ({ close() {} }) },
		);
		await Promise.resolve();
		input.emit("data", Uint8Array.of(0x61));
		await Promise.resolve();
		output.setAcceptWrites(true);
		output.emit("drain");
		await expect(attaching).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: "control failed" }),
				expect.objectContaining({ message: "state unavailable" }),
			],
		});
		expect(output.chunks).toEqual([Uint8Array.of(0x01)]);
	});
	it("cleans up once when synchronous state classification throws", async () => {
		const controlFailure = new Error("control failed");
		const classifierFailure = new Error("state unavailable");
		const lease = leaseCounter();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: () => {
						throw controlFailure;
					},
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: {
					read: () => {
						throw classifierFailure;
					},
				} as never,
			},
			{
				stdin: new Input(),
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: lease.lease,
			},
		);
		await expect(attaching).rejects.toMatchObject({ errors: [controlFailure, classifierFailure] });
		expect(lease.closes()).toBe(1);
	});
	it("preserves control, classifier, and restoration failures together", async () => {
		const controlFailure = new Error("control failed");
		const classifierFailure = new Error("state unavailable");
		const restorationFailure = new Error("restore failed");
		const input = new Input();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => {
						throw controlFailure;
					},
					resize: async () => ({}) as never,
				},
				reader: {
					read: async () => {
						throw classifierFailure;
					},
				} as never,
				pollIntervalMs: 60_000,
			},
			{
				stdin: input,
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({
					close: () => {
						throw restorationFailure;
					},
				}),
			},
		);
		await Promise.resolve();
		input.emit("data", Uint8Array.of(0x61));
		await expect(attaching).rejects.toMatchObject({
			errors: [expect.objectContaining({ errors: [controlFailure, classifierFailure] }), restorationFailure],
		});
	});
	it("aggregates an emitted stdout failure with terminal restoration failure", async () => {
		const stdoutFailure = new Error("stdout disconnected");
		const restorationFailure = new Error("restore failed");
		const output = new Output();
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{
				stdin: new Input(),
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({
					close: () => {
						throw restorationFailure;
					},
				}),
			},
		);
		await Promise.resolve();
		output.emit("error", stdoutFailure);
		await expect(attaching).rejects.toMatchObject({ errors: [stdoutFailure, restorationFailure] });
	});
	it("pauses queued stdin at the high-water mark and fences a stalled write flood at its hard cap", async () => {
		const input = new Input();
		const firstWrite = Promise.withResolvers<void>();
		const lease = leaseCounter();
		let writes = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, true),
					write: async () => {
						writes++;
						await firstWrite.promise;
						return {} as never;
					},
					resize: async () => ({}) as never,
				},
				reader: reader(),
				pollIntervalMs: 60_000,
			},
			{
				stdin: input,
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: lease.lease,
			},
		);
		await Promise.resolve();
		input.emit("data", new Uint8Array(MAX_CONTROL_WRITE_BYTES));
		await Promise.resolve();
		expect({ writes, pauses: input.pauseCalls, resumes: input.resumeCalls }).toEqual({
			writes: 1,
			pauses: 1,
			resumes: 0,
		});
		input.emit("data", new Uint8Array(MAX_CONTROL_WRITE_BYTES));
		input.emit("data", Uint8Array.of(0x61));
		await expect(attaching).rejects.toThrow("visible_session_attach_input_queue_overflow");
		expect({ writes, closes: lease.closes(), pauses: input.pauseCalls, resumes: input.resumeCalls }).toEqual({
			writes: 1,
			closes: 1,
			pauses: 1,
			resumes: 1,
		});
		firstWrite.resolve();
		await Promise.resolve();
	});
	it("restores raw mode and aggregates failures when listener registration throws", async () => {
		const input = new Input();
		const output = new Output();
		const registrationFailure = new Error("listener registration failed");
		const restorationFailure = new Error("restore failed");
		const outputOn = output.on.bind(output);
		let closes = 0;
		output.on = ((event: string, listener: (...args: unknown[]) => void): unknown => {
			if (event === "error") throw registrationFailure;
			return outputOn(event, listener);
		}) as never;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, false),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
			},
			{
				stdin: input,
				stdout: output,
				terminal: new EventEmitter(),
				createRawTerminalLease: () => ({
					close: () => {
						closes++;
						throw restorationFailure;
					},
				}),
			},
		);
		await expect(attaching).rejects.toMatchObject({ errors: [registrationFailure, restorationFailure] });
		expect({
			closes,
			stdinDataListeners: input.listenerCount("data"),
			stdinEndListeners: input.listenerCount("end"),
			stdinErrorListeners: input.listenerCount("error"),
			stdoutDrainListeners: output.listenerCount("drain"),
			stdoutErrorListeners: output.listenerCount("error"),
		}).toEqual({
			closes: 1,
			stdinDataListeners: 0,
			stdinEndListeners: 0,
			stdinErrorListeners: 0,
			stdoutDrainListeners: 0,
			stdoutErrorListeners: 0,
		});
	});
	it("restores raw mode and aggregates failures when abort registration throws", async () => {
		const input = new Input();
		const terminal = new EventEmitter();
		const registrationFailure = new Error("abort registration failed");
		const restorationFailure = new Error("restore failed");
		const signal = {
			aborted: false,
			addEventListener: () => {
				throw registrationFailure;
			},
			removeEventListener: () => undefined,
		} as unknown as AbortSignal;
		let closes = 0;
		const attaching = runVisibleSessionAttach(
			{
				control: {
					stream: async () => response([], 0, false),
					write: async () => ({}) as never,
					resize: async () => ({}) as never,
				},
				reader: reader(),
				signal,
			},
			{
				stdin: input,
				stdout: new Output(),
				terminal,
				createRawTerminalLease: () => ({
					close: () => {
						closes++;
						throw restorationFailure;
					},
				}),
			},
		);
		await expect(attaching).rejects.toMatchObject({ errors: [registrationFailure, restorationFailure] });
		expect({
			closes,
			stdinDataListeners: input.listenerCount("data"),
			stdinEndListeners: input.listenerCount("end"),
			stdinErrorListeners: input.listenerCount("error"),
			terminalResizeListeners: terminal.listenerCount("resize"),
		}).toEqual({
			closes: 1,
			stdinDataListeners: 0,
			stdinEndListeners: 0,
			stdinErrorListeners: 0,
			terminalResizeListeners: 0,
		});
	});
});
