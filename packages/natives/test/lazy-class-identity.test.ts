import { describe, expect, it, vi } from "bun:test";
import { MacAppearanceObserver, Process } from "../native/index.js";

describe("lazy native class identity", () => {
	it("preserves instanceof and prototype identity for factory-returned handles", () => {
		const me = Process.fromPid(process.pid);
		expect(me).not.toBeNull();
		expect(me instanceof Process).toBe(true);
		expect(Object.getPrototypeOf(me)).toBe(Process.prototype);
		expect(me?.pid).toBe(process.pid);
	});

	it("keeps static factories spyable via vi.spyOn", () => {
		const spy = vi.spyOn(Process, "fromPath").mockReturnValue([]);
		try {
			expect(Process.fromPath("/nonexistent")).toEqual([]);
			expect(spy).toHaveBeenCalledWith("/nonexistent");
		} finally {
			spy.mockRestore();
		}
		expect(Array.isArray(Process.fromPath("/nonexistent"))).toBe(true);
	});

	it("keeps observer start spyable and restorable", () => {
		const stop = vi.fn();
		const spy = vi
			.spyOn(MacAppearanceObserver, "start")
			.mockImplementation((() => ({ stop })) as unknown as typeof MacAppearanceObserver.start);
		try {
			const handle = MacAppearanceObserver.start(() => {});
			expect(spy).toHaveBeenCalled();
			handle.stop();
			expect(stop).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
