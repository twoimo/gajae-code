import type { HarnessRpc } from "./adapter-contract";
import { GajaeCodeAppServerRpc, type GajaeCodeAppServerRpcOptions } from "./app-server-adapter";
import { GajaeCodeRpc } from "./rpc-adapter";

export type HarnessAdapter = "rpc" | "app-server";

export interface CreateHarnessRpcOptions extends GajaeCodeAppServerRpcOptions {
	adapter?: HarnessAdapter;
	sessionDir: string;
}

export function createHarnessRpc(options: CreateHarnessRpcOptions): HarnessRpc {
	const adapter = options.adapter ?? process.env.GJC_HARNESS_ADAPTER ?? "app-server";
	if (adapter === "rpc") {
		const LegacyRpc = GajaeCodeRpc;
		return new LegacyRpc(options);
	}
	return new GajaeCodeAppServerRpc(options);
}
