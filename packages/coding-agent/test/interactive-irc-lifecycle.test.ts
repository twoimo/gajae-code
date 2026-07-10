import { beforeAll, describe, expect, it, vi } from "bun:test";

import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";

import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

function createForkContext(fork: () => Promise<boolean>) {
	const resetIrcSidebarSession = vi.fn();
	const ctx = {
		session: {
			isStreaming: false,
			fork,
			sessionFile: "/tmp/sessions/fork.jsonl",
		},
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
		resetIrcSidebarSession,
	} as unknown as InteractiveModeContext;
	return { ctx, resetIrcSidebarSession };
}

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

describe("IRC lifecycle resets", () => {
	it("resets the IRC sidebar only after a successful fork", async () => {
		const { ctx, resetIrcSidebarSession } = createForkContext(async () => true);

		await new CommandController(ctx).handleForkCommand();

		expect(resetIrcSidebarSession).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("preserves IRC sidebar state when a fork is cancelled or fails", async () => {
		const cancelled = createForkContext(async () => false);
		await new CommandController(cancelled.ctx).handleForkCommand();
		expect(cancelled.resetIrcSidebarSession).not.toHaveBeenCalled();

		const failed = createForkContext(async () => Promise.reject(new Error("disk failure")));
		await expect(new CommandController(failed.ctx).handleForkCommand()).rejects.toThrow("disk failure");
		expect(failed.resetIrcSidebarSession).not.toHaveBeenCalled();
	});
});
