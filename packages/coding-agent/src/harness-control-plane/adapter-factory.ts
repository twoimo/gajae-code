import type { HarnessRpc } from "./adapter-contract";
import { GajaeCodeAppServerRpc, type GajaeCodeAppServerRpcOptions } from "./app-server-adapter";

export type HarnessAdapter = "app-server";

export interface CreateHarnessRpcOptions extends GajaeCodeAppServerRpcOptions {
	adapter?: HarnessAdapter;
	sessionDir: string;
}

/** The harness always drives the app-server adapter; the legacy rpc transport is retired. */
export function createHarnessRpc(options: CreateHarnessRpcOptions): HarnessRpc {
	return new GajaeCodeAppServerRpc(options);
}
