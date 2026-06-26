import * as os from "node:os";
import * as path from "node:path";

export const GJC_RPC_DAEMON_SOCKET_ENV = "GJC_RPC_DAEMON_SOCKET";

export function defaultDaemonSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[GJC_RPC_DAEMON_SOCKET_ENV];
	if (configured && configured.length > 0) return configured;
	const runtimeDir = env.XDG_RUNTIME_DIR;
	if (runtimeDir && runtimeDir.length > 0) return path.join(runtimeDir, "gjc", "rpc-sdk", "daemon.sock");
	if (process.platform === "win32") return path.join(os.tmpdir(), "gjc", "rpc-sdk", "daemon.sock");
	return path.join(process.cwd(), ".gjc", "state", "rpc-sdk", "daemon.sock");
}
