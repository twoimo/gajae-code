import { splitArgvAtDelimiter } from "@gajae-code/utils/cli";
import { findLaunchArgumentEndIndex, findStartupSlashCommandIndex } from "../../cli/thinking-arg";

export const ACP_TERMINAL_AUTH_FLAG = "--acp-terminal-auth";

export interface AcpTerminalAuthArgs {
	args: string[];
	terminalAuth: boolean;
}

export function prepareAcpTerminalAuthArgs(rawArgs: readonly string[]): AcpTerminalAuthArgs {
	const delimiter = splitArgvAtDelimiter(rawArgs);
	const slashCommandIndex = findStartupSlashCommandIndex(delimiter.beforeDelimiter);
	const optionEnd = slashCommandIndex ?? delimiter.beforeDelimiter.length;
	const optionArgs = delimiter.beforeDelimiter.slice(0, optionEnd);
	const payloadArgs = delimiter.beforeDelimiter.slice(optionEnd);
	if (delimiter.hasDelimiter) payloadArgs.push("--", ...delimiter.afterDelimiter);

	const withoutAuthFlag: string[] = [];
	let terminalAuth = false;
	for (let index = 0; index < optionArgs.length; index++) {
		const arg = optionArgs[index];
		if (arg === ACP_TERMINAL_AUTH_FLAG) {
			terminalAuth = true;
			continue;
		}
		const endIndex = findLaunchArgumentEndIndex(optionArgs, index);
		withoutAuthFlag.push(...optionArgs.slice(index, endIndex + 1));
		index = endIndex;
	}

	if (!terminalAuth) {
		return { args: [...withoutAuthFlag, ...payloadArgs], terminalAuth: false };
	}

	const args: string[] = [];
	for (let index = 0; index < withoutAuthFlag.length; index++) {
		const arg = withoutAuthFlag[index];
		if (arg === "--mode") {
			index = findLaunchArgumentEndIndex(withoutAuthFlag, index);
			continue;
		}
		if (arg.startsWith("--mode=")) {
			continue;
		}
		const endIndex = findLaunchArgumentEndIndex(withoutAuthFlag, index);
		args.push(...withoutAuthFlag.slice(index, endIndex + 1));
		index = endIndex;
	}

	return { args: [...args, ...payloadArgs], terminalAuth: true };
}
