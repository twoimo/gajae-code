/**
 * G003 acceptance gate: the native-TUI runtime-control boundary.
 *
 * The unified RPC SDK requires ALL native-TUI runtime input/control/subscription
 * to flow through one injected `NativeTuiRuntimeBoundary` adapter (see
 * docs/rpc-sdk/runtime-port.md + the approved remaining-work plan). This static
 * gate fails if any native-TUI file makes a direct `AgentSession` runtime-control
 * call outside the adapter, so the cutover cannot silently regress.
 *
 * Scope: native interactive TUI only. ACP (`modes/acp/*`) and RPC/bridge transports
 * are separate boundaries and are NOT scanned here.
 *
 * Status semantics: this gate is green only when every native-TUI control seam
 * routes through the adapter, and the adapter itself routes through the Rust
 * `RpcSdkPipeline` typed N-API gate before touching `AgentSession`.

 *
 * Usage: bun run scripts/rpc-sdk/verify-native-tui-boundary.ts [--json]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Native-TUI files whose runtime control must route through NativeTuiRuntimeBoundary.
const SCANNED_FILES = [
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/modes/controllers/command-controller.ts",
	"packages/coding-agent/src/modes/controllers/event-controller.ts",
	"packages/coding-agent/src/modes/controllers/extension-ui-controller.ts",
	"packages/coding-agent/src/modes/controllers/input-controller.ts",
	"packages/coding-agent/src/modes/interactive-mode.ts",
	"packages/coding-agent/src/modes/utils/ui-helpers.ts",
];

// Explicitly classified NON-runtime native-TUI files: documented per the architect
// review (classify-or-include requirement). agent-dashboard.ts spins up an isolated,
// UI-less, tool-less, one-shot sub-session purely to generate an agent spec; it is
// not the interactive runtime control surface and never drives the user's live
// session, so it is out of the boundary's scope.
const EXCLUDED_NON_RUNTIME = ["packages/coding-agent/src/modes/components/agent-dashboard.ts"];
void EXCLUDED_NON_RUNTIME;

// The forbidden direct AgentSession runtime-control surface (inventory-derived).
// Reads like `queuedMessageCount` / `isStreaming` are NOT control and are allowed.
const CONTROL_METHODS = [
	"prompt",
	"promptCustomMessage",
	"sendCustomMessage",
	"followUp",
	"steer",
	"abort",
	"subscribe",
	"sendUserMessage",
] as const;

// The adapter (and runtime internals) are the ONLY places allowed to call these
// directly. Once it exists, it is excluded from the scan.
const ADAPTER_FILE = "packages/coding-agent/src/modes/native-tui-runtime-boundary.ts";

const CONTROL_CALL = new RegExp(`\\bsession\\s*(?:\\?\\.)?\\s*\\.\\s*(${CONTROL_METHODS.join("|")})\\s*\\(`, "g");

const REQUIRED_ADAPTER_PATTERNS = [
	{ name: "RpcSdkPipeline import", pattern: /import \{ RpcSdkPipeline \} from "(?:@gajae-code\/natives|\.\.\/\.\.\/\.\.\/natives\/native\/index\.js)"/ },
	{ name: "pipeline submit gate", pattern: /\.submit\(this\.#principalJson, command\)/ },
	{ name: "ordered completion", pattern: /\.completeOrdered\(\)/ },
	{ name: "zero-serialization assertion", pattern: /isZeroSerialization\(\)/ },
] as const;

interface Violation {
	file: string;
	line: number;
	method: string;
	text: string;
}

interface AdapterViolation {
	requirement: string;
}

function lineForOffset(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (src.charCodeAt(i) === 10) line++;
	}
	return line;
}

function lineTextForOffset(src: string, offset: number): string {
	const start = src.lastIndexOf("\n", offset) + 1;
	const end = src.indexOf("\n", offset);
	return src.slice(start, end === -1 ? src.length : end).trim();
}

function scanSource(rel: string, src: string): Violation[] {
	const violations: Violation[] = [];
	CONTROL_CALL.lastIndex = 0;
	for (let match = CONTROL_CALL.exec(src); match; match = CONTROL_CALL.exec(src)) {
		violations.push({
			file: rel,
			line: lineForOffset(src, match.index),
			method: match[1],
			text: lineTextForOffset(src, match.index),
		});
	}
	return violations;
}

export function regressionCases(): Violation[] {
	return scanSource(
		"regression.ts",
		`this.ctx.session
			.prompt("wrapped");
		this.ctx.session
			.sendCustomMessage(message, options);
		this.ctx.session.sendUserMessage(content, options);
		this.ctx.session.isStreaming;
		this.ctx.sessionManager.setSessionName("ok", "user");
		await session.prompt("main startup");
		await session.promptCustomMessage({ customType: "hidden", content: "main" });`,
	);
}

export function scan(): Violation[] {
	const violations: Violation[] = [];
	for (const rel of SCANNED_FILES) {
		if (rel === ADAPTER_FILE) continue;
		let src: string;
		try {
			src = readFileSync(join(REPO_ROOT, rel), "utf8");
		} catch {
			continue; // file may be renamed/removed during cutover; absence is not a violation
		}
		violations.push(...scanSource(rel, src));
	}
	return violations;
}

export function scanAdapterRouting(): AdapterViolation[] {
	let src: string;
	try {
		src = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
	} catch {
		return [{ requirement: "NativeTuiRuntimeBoundary file exists" }];
	}
	return REQUIRED_ADAPTER_PATTERNS.filter(requirement => !requirement.pattern.test(src)).map(requirement => ({
		requirement: requirement.name,
	}));
}


function main(): void {
	const violations = scan();
	const adapterViolations = scanAdapterRouting();
	const regressions = regressionCases();
	if (regressions.length !== 5) {
		throw new Error(`native-TUI boundary gate regression failed: expected 5 wrapped-call detections, got ${regressions.length}`);
	}
	const ok = violations.length === 0 && adapterViolations.length === 0;
	const asJson = process.argv.includes("--json");
	if (asJson) {
		console.log(
			JSON.stringify(
				{ ok, violationCount: violations.length, violations, adapterViolationCount: adapterViolations.length, adapterViolations },
				null,
				2,
			),
		);
	} else if (ok) {
		console.log("OK: native-TUI runtime control routes through NativeTuiRuntimeBoundary and RpcSdkPipeline");
	} else {
		if (violations.length > 0) {
			console.error(`FAIL: ${violations.length} direct AgentSession runtime-control call(s) bypass NativeTuiRuntimeBoundary:`);
			for (const v of violations) console.error(`  ${v.file}:${v.line}  session.${v.method}(  ->  ${v.text}`);
		}
		if (adapterViolations.length > 0) {
			console.error(`FAIL: NativeTuiRuntimeBoundary is missing ${adapterViolations.length} Rust pipeline routing requirement(s):`);
			for (const v of adapterViolations) console.error(`  ${v.requirement}`);
		}
		console.error("\nG003 cutover incomplete: route native-TUI controls through NativeTuiRuntimeBoundary + RpcSdkPipeline.");
	}
	process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
	main();
}
