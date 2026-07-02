/**
 * Run Gajae Code as a codex-compatible JSON-RPC 2.0 app-server over stdio.
 *
 * Thin wrapper around the launch flow that forces `mode: "app-server"`.
 * Equivalent to `gjc --mode app-server`.
 */
import { Command } from "@gajae-code/utils/cli";
import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";

export default class AppServer extends Command {
	static description = "Run Gajae Code as a codex-compatible JSON-RPC 2.0 app-server over stdio";
	static strict = false;

	async run(): Promise<void> {
		const parsed = parseArgs(this.argv);
		parsed.mode = "app-server";
		await runRootCommand(parsed, this.argv);
	}
}
