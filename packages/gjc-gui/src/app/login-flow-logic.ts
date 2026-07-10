export type LoginFlowState = "idle" | "pending-browser" | "needs-input" | "authenticated" | "failed" | "cancelled" | "unsupported";

export function nextLoginFlowState(current: LoginFlowState, incoming: LoginFlowState): LoginFlowState {
	if (["authenticated", "failed", "cancelled", "unsupported"].includes(current)) return current;
	return incoming;
}

export function redactedLoginFlowView(input: { state: LoginFlowState; promptMessage?: string; authUrl?: string; instructions?: string }): { state: LoginFlowState; promptMessage?: string; authUrl?: string; instructions?: string } {
	return {
		state: input.state,
		...(input.promptMessage ? { promptMessage: input.promptMessage } : {}),
		...(input.authUrl ? { authUrl: input.authUrl } : {}),
		...(input.instructions ? { instructions: input.instructions } : {}),
	};
}
