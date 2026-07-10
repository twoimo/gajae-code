import { findLaunchArgumentEndIndex, getLaunchOptionArguments } from "../../cli/thinking-arg";

export const ACP_TERMINAL_AUTH_FLAG = "--acp-terminal-auth";

export interface AcpTerminalAuthArgs {
	args: string[];
	terminalAuth: boolean;
}

export function prepareAcpTerminalAuthArgs(rawArgs: readonly string[]): AcpTerminalAuthArgs {
	const optionArgs = getLaunchOptionArguments(rawArgs);
	let terminalAuth = false;
	for (let index = 0; index < optionArgs.length; index++) {
		if (optionArgs[index] === ACP_TERMINAL_AUTH_FLAG) {
			terminalAuth = true;
			break;
		}
		index = findLaunchArgumentEndIndex(optionArgs, index);
	}

	// Preserve argv so removing auth or mode spans cannot make neighboring
	// launch options acquire new values. Callers suppress ACP mode semantically.
	return { args: [...rawArgs], terminalAuth };
}
