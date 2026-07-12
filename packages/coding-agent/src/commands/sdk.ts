import { Args, Command, Flags } from "@gajae-code/utils/cli";
import type { Args as ParsedArgs } from "../cli/args";
import { applyStartupModelProfiles, createSessionManager } from "../main";
import { initializeExtensions } from "../modes/runtime-init";
import { createAgentSession } from "../sdk";
import { Broker } from "../sdk/broker/broker";
import { readSessionLifecycleLaunchRequest, type SessionLifecycleLaunchRequest } from "../sdk/broker/lifecycle";
import { SessionManager } from "../session/session-manager";

export function lifecycleArgs(request: SessionLifecycleLaunchRequest, cwd: string, agentDir: string): ParsedArgs {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...(request.operation === "session.resume" ? { resume: request.sessionPath } : {}),
		...(request.modelPreset ? { mpreset: request.modelPreset } : {}),
		...(request.operation === "session.fork"
			? {
					fork: request.sourceSessionPath ?? request.sourceSessionId,
					sessionDir: SessionManager.getDefaultSessionDir(cwd, agentDir),
				}
			: {}),
	};
}

/** Runs the same persisted AgentSession bootstrap used by the production CLI. */
async function runSessionHost(): Promise<void> {
	const request = readSessionLifecycleLaunchRequest(process.env.GJC_SDK_LIFECYCLE_REQUEST);
	const agentDir = process.env.GJC_AGENT_DIR;
	if (!agentDir) throw new Error("GJC_AGENT_DIR is required for sdk session-host-internal.");
	const cwd = process.cwd();
	const parsed = lifecycleArgs(request, cwd, agentDir);
	const sessionManager = await createSessionManager(parsed, cwd);
	const { session } = await createAgentSession({ cwd, agentDir, sessionManager });
	if (request.modelPreset) {
		await applyStartupModelProfiles({
			session,
			settings: session.settings,
			modelRegistry: session.modelRegistry,
			parsedArgs: parsed,
		});
	}
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void session.dispose().finally(() => process.exit(0));
	};
	await initializeExtensions(session, {
		reportSendError: () => {},
		reportRuntimeError: () => {},
		onShutdown: stop,
	});
	if (session.sessionManager.getSessionId() !== request.sessionId)
		throw new Error(
			`Lifecycle session id mismatch: expected ${request.sessionId}, got ${session.sessionManager.getSessionId()}.`,
		);
	await session.sessionManager.ensureOnDisk();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	await new Promise<void>(() => {});
}

export default class Sdk extends Command {
	static description = "SDK internal services";
	static hidden = true;
	static args = { action: Args.string({ required: true, options: ["broker-internal", "session-host-internal"] }) };
	static flags = { "agent-dir": Flags.string({ description: "Internal broker agent directory" }) };
	async run(): Promise<void> {
		const { args, flags } = await this.parse(Sdk);
		if (args.action === "session-host-internal") {
			await runSessionHost();
			return;
		}
		const agentDir = flags["agent-dir"] as string | undefined;
		if (!agentDir) throw new Error("--agent-dir is required for sdk broker-internal.");
		const broker = new Broker({ agentDir });
		await broker.start();
		if (!broker.ownsDiscovery) return;
		const stop = () => void broker.stop().finally(() => process.exit(0));
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		await new Promise<void>(() => {});
	}
}
