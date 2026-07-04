import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";

class FakeStdout extends EventEmitter {
	setEncoding(_encoding: BufferEncoding): void {}
}

class FakeProcess extends EventEmitter {
	readonly stdout = new FakeStdout();
	readonly stderr = new FakeStdout();
	readonly stdin = {
		write: (_chunk: string, callback?: (error?: Error | null) => void): boolean => {
			callback?.(null);
			return true;
		},
		end: (): void => {},
	};
	kill(): void {
		this.emit("exit", 0);
	}
}

let createHarnessRpc: typeof import("../src/harness-control-plane/adapter-factory").createHarnessRpc;

let GajaeCodeAppServerRpc: typeof import("../src/harness-control-plane/app-server-adapter").GajaeCodeAppServerRpc;

beforeAll(async () => {
	mock.module("node:child_process", () => ({
		execFileSync: mock(() => Buffer.from("")),
		spawn: mock(() => new FakeProcess()),
	}));
	({ createHarnessRpc } = await import("../src/harness-control-plane/adapter-factory"));

	({ GajaeCodeAppServerRpc } = await import("../src/harness-control-plane/app-server-adapter"));
});

afterEach(() => {
	delete process.env.GJC_HARNESS_ADAPTER;
});

describe("createHarnessRpc", () => {
	it("returns the app-server adapter by default", () => {
		const rpc = createHarnessRpc({ sessionDir: "/tmp/gjc-session" });
		expect(rpc).toBeInstanceOf(GajaeCodeAppServerRpc);
	});

	it("returns the app-server adapter when GJC_HARNESS_ADAPTER is app-server", () => {
		process.env.GJC_HARNESS_ADAPTER = "app-server";
		const rpc = createHarnessRpc({ sessionDir: "/tmp/gjc-session" });
		expect(rpc).toBeInstanceOf(GajaeCodeAppServerRpc);
	});
});
