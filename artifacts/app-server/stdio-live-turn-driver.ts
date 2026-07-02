const proc = Bun.spawn(["bun", "packages/coding-agent/src/cli.ts", "app-server"], {
	cwd: "/Users/bellman/Documents/Workspace/gjc-app-server",
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

const decoder = new TextDecoder();
let out = "";
let threadId: string | undefined;
let sawPong = false;
let sawCompleted = false;

const w = (obj: unknown) => proc.stdin.write(`${JSON.stringify(obj)}\n`);

(async () => {
	const reader = proc.stdout.getReader();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			out += `${line}\n`;
			let msg: any;
			try { msg = JSON.parse(line); } catch { continue; }
			if (msg.type === "ready") {
				w({ id: 1, method: "initialize", params: {} });
				w({ method: "initialized" });
				w({ id: 2, method: "thread/start", params: { cwd: "/Users/bellman/Documents/Workspace/gjc-app-server" } });
			} else if (msg.id === 2 && msg.result) {
				threadId = msg.result.thread?.id;
				w({ id: 3, method: "turn/start", params: { threadId, input: "Reply with exactly the single word: PONG" } });
			} else if (msg.method === "item/agentMessage/delta" && typeof msg.params?.delta === "string" && msg.params.delta.includes("PONG")) {
				sawPong = true;
			} else if (msg.method === "turn/completed") {
				sawCompleted = true;
				proc.stdin.end();
			}
		}
	}
})();

const timer = setTimeout(() => { proc.stdin.end(); proc.kill(); }, 90000);
await proc.exited;
clearTimeout(timer);
const err = decoder.decode(await new Response(proc.stderr).arrayBuffer());
console.log("=== STDOUT ===\n" + out);
console.log("=== STDERR (tail) ===\n" + err.split("\n").slice(-15).join("\n"));
console.log(`\nRESULT: threadId=${threadId} sawPong=${sawPong} sawCompleted=${sawCompleted}`);
