import { Command } from "@gajae-code/utils/cli";
import { runNativeDeepInterviewCommand } from "../gjc-runtime/deep-interview-runtime";

export default class DeepInterview extends Command {
	static description = "Run native GJC deep-interview workflow";
	static strict = false;
	static examples = ['$ gjc deep-interview --standard "<idea>"'];

	async run(): Promise<void> {
		const result = await runNativeDeepInterviewCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
