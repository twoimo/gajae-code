import { spawn } from "node:child_process";
import path from "node:path";
import { readBrokerDiscovery, type BrokerDiscovery } from "./discovery";
export interface EnsureBrokerSettings { agentDir: string; heartbeatTtlMs?: number; }

const DISCOVERY_TIMEOUT_MS = 10_000;
const owners = new Map<string, { stop: () => Promise<void> }>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Starts the detached broker entrypoint when discovery has no live owner. */
export async function ensureBroker(settings: EnsureBrokerSettings): Promise<BrokerDiscovery> {
	const existing = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
	if (existing) return existing;
	const entrypoint = process.argv[1]?.endsWith("cli.ts") ? process.argv[1] : path.resolve(import.meta.dir, "../../cli.ts");
	const child = spawn(process.execPath, [entrypoint, "sdk", "broker-internal", "--agent-dir", settings.agentDir], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
	owners.set(settings.agentDir, {
		stop: async () => {
			try {
				child.kill("SIGTERM");
			} catch {}
			owners.delete(settings.agentDir);
		},
	});
	const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const discovered = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
		if (discovered) return discovered;
		await sleep(50);
	}
	throw new Error("Timed out waiting for detached SDK broker discovery.");
}
/** Test hook: returns a stop handle for the detached broker this process spawned. */
export function brokerOwnerForTest(agentDir: string): { stop: () => Promise<void> } | undefined {
	return owners.get(agentDir);
}
