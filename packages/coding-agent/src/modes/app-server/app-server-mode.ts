import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { AgentSessionHost } from "./agent-session-host";
import { startAppServer } from "./host";

export async function runAppServerMode(): Promise<void> {
	const host = new AgentSessionHost();
	const handle = startAppServer(host, { onFrame: frame => process.stdout.write(`${frame}\n`) });
	host.setEmitter((threadId, generation, eventType, payload) => {
		handle.emitEvent(threadId, generation, eventType, payload);
	});

	let wsActive = false;
	if (process.env.GJC_APP_SERVER_WS === "1" || process.env.GJC_APP_SERVER_LISTEN === "ws") {
		const token = process.env.GJC_APP_SERVER_WS_TOKEN?.trim() || randomBytes(32).toString("base64url");
		const sessionId = process.env.GJC_SESSION_ID?.trim() || `app-server-${randomUUID()}`;
		const stateRoot = process.env.GJC_APP_SERVER_STATE_ROOT?.trim() || undefined;
		const url = await handle.server.listenWs("127.0.0.1", 0, token, sessionId, stateRoot);
		process.stderr.write(
			`${JSON.stringify({ type: "app-server-ws", url, token: "<redacted>", sessionId, stateRoot })}\n`,
		);
		wsActive = true;
	}

	const connectionId = handle.openConnection();
	process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

	try {
		const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
		for await (const line of lines) {
			if (line.length === 0) continue;
			const response = await handle.dispatch(connectionId, line);
			if (response !== null) process.stdout.write(`${response}\n`);
		}
	} finally {
		handle.closeConnection(connectionId);
	}

	// On stdio EOF the server is done; the native handle's threadsafe callbacks
	// keep the event loop alive, so exit explicitly. In WS mode the socket keeps
	// serving, so stay alive.
	if (!wsActive) {
		process.exit(0);
	}
}
