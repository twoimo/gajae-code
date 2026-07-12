import * as path from "node:path";
import { runVisibleSessionMonitor } from "./monitor";
import { runVisibleSessionOwner } from "./owner";

export type VisibleSessionInternalRole = "owner-internal" | "monitor-internal";

export interface VisibleSessionInternalCommand {
	role: VisibleSessionInternalRole;
	manifestPath: string;
}

export type VisibleSessionInternalRoleRunner = (manifestPath: string) => Promise<void>;

export interface VisibleSessionInternalCommandDependencies {
	runOwner?: VisibleSessionInternalRoleRunner;
	runMonitor?: VisibleSessionInternalRoleRunner;
}
export type VisibleSessionInternalCommandClassification =
	| { kind: "ordinary" }
	| { kind: "valid"; command: VisibleSessionInternalCommand }
	| { kind: "malformed-reserved" };

export type VisibleSessionInternalCommandRunner = (argv: readonly string[]) => Promise<void>;

function invalidInternalCommand(): Error {
	return new Error("Invalid visible-session internal command");
}

/** Parses only the private owner and monitor role invocations. */
export function parseVisibleSessionInternalCommand(argv: readonly string[]): VisibleSessionInternalCommand {
	if (argv.length !== 4 || argv[0] !== "visible-session" || argv[2] !== "--manifest") {
		throw invalidInternalCommand();
	}

	const role = argv[1];
	if (role !== "owner-internal" && role !== "monitor-internal") throw invalidInternalCommand();

	const manifestPath = argv[3];
	if (!path.isAbsolute(manifestPath)) throw invalidInternalCommand();

	return { role, manifestPath };
}

/**
 * Classifies private role intent without reserving the ordinary
 * `visible-session` launch prompt.
 */
export function classifyVisibleSessionInternalCommand(
	argv: readonly string[],
): VisibleSessionInternalCommandClassification {
	const role = argv[1];
	const reservedIntent =
		argv[0] === "visible-session" &&
		(role === "owner-internal" || role === "monitor-internal" || role?.endsWith("-internal") === true);
	if (!reservedIntent) return { kind: "ordinary" };

	try {
		return { kind: "valid", command: parseVisibleSessionInternalCommand(argv) };
	} catch {
		return { kind: "malformed-reserved" };
	}
}

export function isVisibleSessionInternalFastPath(argv: readonly string[]): boolean {
	return classifyVisibleSessionInternalCommand(argv).kind === "valid";
}

export async function runVisibleSessionInternalCommandIfReserved(
	argv: readonly string[],
	runCommand: VisibleSessionInternalCommandRunner = runVisibleSessionInternalCommand,
): Promise<boolean> {
	if (classifyVisibleSessionInternalCommand(argv).kind === "ordinary") return false;
	parseVisibleSessionInternalCommand(argv);
	await runCommand(argv);
	return true;
}

/** Runs a validated private role without exposing a public CLI command. */
export async function runVisibleSessionInternalCommand(
	argv: readonly string[],
	dependencies: VisibleSessionInternalCommandDependencies = {},
): Promise<void> {
	const command = parseVisibleSessionInternalCommand(argv);
	if (command.role === "owner-internal") {
		await (dependencies.runOwner ?? runVisibleSessionOwner)(command.manifestPath);
		return;
	}
	await (dependencies.runMonitor ?? runVisibleSessionMonitor)(command.manifestPath);
}
