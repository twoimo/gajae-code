import { GajaeCodeAppServerRpc, type GajaeCodeAppServerRpcOptions } from "./app-server-adapter";
import { GajaeCodeRpc, type HarnessRpc } from "./rpc-adapter";

export type HarnessAdapter = "rpc" | "app-server";

export interface CreateHarnessRpcOptions extends GajaeCodeAppServerRpcOptions {
	adapter?: HarnessAdapter;
	sessionDir: string;
}

export function createHarnessRpc(options: CreateHarnessRpcOptions): HarnessRpc {
	const adapter = options.adapter ?? process.env.GJC_HARNESS_ADAPTER;
	if (adapter === "app-server") {
		return new GajaeCodeAppServerRpc(options);
	}
	return new GajaeCodeRpc(options);
}
