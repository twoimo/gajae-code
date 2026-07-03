import { GajaeCodeAppServerRpc } from "./packages/coding-agent/src/harness-control-plane/app-server-adapter";

const WORKTREE = "/Users/bellman/Documents/Workspace/gjc-app-server";

const rpc = new GajaeCodeAppServerRpc({
	command: ["bun", "packages/coding-agent/src/cli.ts", "app-server"],
	cwd: WORKTREE,
});

let completed = false;
rpc.onEventFrame(frame => {
	if (frame.method === "turn/completed") completed = true;
});

await rpc.ready();

// Pre-state: single-flight acceptance requires idle + empty queues.
const pre = await rpc.getState();
console.log("pre-state:", JSON.stringify(pre));

const cursor = rpc.eventCursor();
const ack = await rpc.sendPrompt("Reply with exactly the single word: PONG");
console.log("sendPrompt ack:", JSON.stringify(ack));

const started = await rpc.waitForAgentStart(cursor, 60000);
console.log("agent-start:", JSON.stringify(started));

// Wait for turn completion.
const deadline = Date.now() + 90000;
while (!completed && Date.now() < deadline) {
	await new Promise(r => setTimeout(r, 200));
}
const text = await rpc.getLastAssistantText();
console.log("completed:", completed, "assistant_text:", JSON.stringify(text));
await rpc.close();

if (!ack.ack || !started || !completed || !(text ?? "").includes("PONG")) {
	console.log("PHASE4_LIVE_FAIL");
	process.exit(1);
}
console.log("PHASE4_LIVE_OK");
process.exit(0);
