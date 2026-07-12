#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PackageBoundaryViolation {
	path: string;
	line: number;
	rule: string;
	message: string;
}

interface WorkspacePackage {
	name: string;
	directory: string;
	manifestPath: string;
	manifest: Record<string, unknown>;
}

interface ModuleStatement {
	kind: "import" | "export";
	line: number;
	specifier: string;
	text: string;
}

const DEFAULT_ROOT = path.join(import.meta.dir, "..");
const AGENT_WIRE = "@gajae-code/agent-wire";
const UTILS = "@gajae-code/utils";
const FORBIDDEN_AGENT_WIRE_TARGETS = new Set([
	"@gajae-code/coding-agent",
	"@gajae-code/bridge-client",
	"@gajae-code/ai",
	"@gajae-code/agent-core",
	"@gajae-code/utils",
	"@gajae-code/natives",
]);
const FORBIDDEN_UTILS_ROOT_API = new Set(["ptree", "procmgr", "AbortError", "ChildProcess", "Exception", "NonZeroExitError"]);
const SOURCE_EXTENSION = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

function toRepoPath(root: string, filePath: string): string {
	return path.relative(root, filePath).split(path.sep).join("/");
}

function lineAt(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

async function collectFiles(root: string, dir = root): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(root, filePath)));
		} else if (entry.isFile()) {
			files.push(filePath);
		}
	}
	return files;
}

async function collectWorkspacePackages(root: string): Promise<WorkspacePackage[]> {
	const files = await collectFiles(root);
	const packages: WorkspacePackage[] = [];
	for (const manifestPath of files) {
		if (path.basename(manifestPath) !== "package.json" || path.dirname(manifestPath) === root) continue;
		try {
			const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
			if (typeof manifest.name !== "string") continue;
			packages.push({
				name: manifest.name,
				directory: path.dirname(manifestPath),
				manifestPath,
				manifest,
			});
		} catch {
			// Invalid manifests belong to their own validation gate.
		}
	}
	return packages.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

function collectModuleStatements(text: string): ModuleStatement[] {
	const statements: ModuleStatement[] = [];
	const fromPattern = /(^|\n)([\t ]*)(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+(["'])([^"']+)\6/g;
	for (const match of text.matchAll(fromPattern)) {
		const start = (match.index ?? 0) + match[1].length + match[2].length;
		statements.push({
			kind: match[3] as "import" | "export",
			line: lineAt(text, start),
			specifier: match[7] ?? "",
			text: match[0],
		});
	}

	const sideEffectPattern = /(^|\n)([\t ]*)import\s+(["'])([^"']+)\3/g;
	for (const match of text.matchAll(sideEffectPattern)) {
		const start = (match.index ?? 0) + match[1].length + match[2].length;
		statements.push({
			kind: "import",
			line: lineAt(text, start),
			specifier: match[4] ?? "",
			text: match[0],
		});
	}
	return statements.sort((left, right) => left.line - right.line);
}

function hasForbiddenUtilsApi(statement: ModuleStatement): boolean {
	return [...FORBIDDEN_UTILS_ROOT_API].some((api) => new RegExp(`\\b${api}\\b`).test(statement.text));
}

function isAgentWireSourcePath(agentWireDirectory: string, sourceFile: string, specifier: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const resolved = path.resolve(path.dirname(sourceFile), specifier);
	const agentWireSource = path.join(agentWireDirectory, "src");
	return resolved === agentWireSource || resolved.startsWith(`${agentWireSource}${path.sep}`);
}

function manifestViolations(root: string, workspacePackage: WorkspacePackage): PackageBoundaryViolation[] {
	if (workspacePackage.name !== AGENT_WIRE) return [];
	const violations: PackageBoundaryViolation[] = [];
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
		const dependencies = workspacePackage.manifest[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		for (const dependency of Object.keys(dependencies as Record<string, unknown>).sort()) {
			violations.push({
				path: toRepoPath(root, workspacePackage.manifestPath),
				line: 1,
				rule: "agent-wire-production-dependency",
				message: `${AGENT_WIRE} must not declare production dependency ${dependency} in ${field}.`,
			});
		}
	}
	return violations;
}

async function sourceViolations(root: string, workspacePackages: WorkspacePackage[]): Promise<PackageBoundaryViolation[]> {
	const agentWirePackage = workspacePackages.find((workspacePackage) => workspacePackage.name === AGENT_WIRE);
	const violations: PackageBoundaryViolation[] = [];
	for (const workspacePackage of workspacePackages) {
		const files = await collectFiles(workspacePackage.directory);
		for (const filePath of files) {
			if (!SOURCE_EXTENSION.test(filePath) || !toRepoPath(workspacePackage.directory, filePath).startsWith("src/")) continue;
			const text = await Bun.file(filePath).text();
			const relativePath = toRepoPath(root, filePath);
			for (const statement of collectModuleStatements(text)) {
				if (workspacePackage.name === AGENT_WIRE && !statement.specifier.startsWith(".")) {
					const target = statement.specifier.split("/").slice(0, statement.specifier.startsWith("@") ? 2 : 1).join("/");
					violations.push({
						path: relativePath,
						line: statement.line,
						rule: FORBIDDEN_AGENT_WIRE_TARGETS.has(target)
							? "agent-wire-reverse-edge"
							: "agent-wire-runtime-import",
						message: FORBIDDEN_AGENT_WIRE_TARGETS.has(target)
							? `${AGENT_WIRE} must not import ${target}; it is a package-boundary reverse edge.`
							: `${AGENT_WIRE} must not import ${statement.specifier}; it is a dependency-free leaf.`,
					});
				}

				if (
					agentWirePackage &&
					workspacePackage.name !== AGENT_WIRE &&
					isAgentWireSourcePath(agentWirePackage.directory, filePath, statement.specifier)
				) {
					violations.push({
						path: relativePath,
						line: statement.line,
						rule: "agent-wire-package-import",
						message: `Import ${AGENT_WIRE} by package name instead of sibling source path ${statement.specifier}.`,
					});
				}

				if (workspacePackage.name === UTILS && filePath === path.join(workspacePackage.directory, "src", "index.ts")) {
					const moduleName = statement.specifier.replace(/^\.\//, "").replace(/\.[cm]?[jt]sx?$/, "");
					if (moduleName === "ptree" || moduleName === "procmgr" || hasForbiddenUtilsApi(statement)) {
						violations.push({
							path: relativePath,
							line: statement.line,
							rule: "utils-root-process-api",
							message: `${UTILS} root must not import or export process APIs.`,
						});
					}
				}

				if (statement.kind === "import" && statement.specifier === UTILS && hasForbiddenUtilsApi(statement)) {
					violations.push({
						path: relativePath,
						line: statement.line,
						rule: "utils-bare-process-import",
						message: `Import process APIs from ${UTILS}/ptree or ${UTILS}/procmgr, not ${UTILS}.`,
					});
				}
			}
		}
	}
	return violations;
}

export async function checkPackageBoundaries(root = DEFAULT_ROOT): Promise<PackageBoundaryViolation[]> {
	const absoluteRoot = path.resolve(root);
	const workspacePackages = await collectWorkspacePackages(absoluteRoot);
	const violations = [...workspacePackages.flatMap((workspacePackage) => manifestViolations(absoluteRoot, workspacePackage))];
	violations.push(...(await sourceViolations(absoluteRoot, workspacePackages)));
	return violations.sort((left, right) =>
		left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule),
	);
}

if (import.meta.main) {
	const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
	const violations = await checkPackageBoundaries(root);
	if (violations.length === 0) {
		console.log("[OK] Package boundary check passed.");
		process.exit(0);
	}

	console.error(`[FAIL] Found ${violations.length} package-boundary violation${violations.length === 1 ? "" : "s"}:`);
	for (const violation of violations) {
		console.error(`- ${violation.path}:${violation.line}: [${violation.rule}] ${violation.message}`);
	}
	process.exit(1);
}
