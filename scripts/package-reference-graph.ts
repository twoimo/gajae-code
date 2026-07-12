#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type PackageReferenceViolationKind =
	| "cyclic-reference"
	| "extra-reference"
	| "reverse-reference"
	| "missing-reference"
	| "non-workspace-reference"
	| "root-reference";

export interface PackageReferenceViolation {
	kind: PackageReferenceViolationKind;
	path: string;
	message: string;
}

interface Manifest {
	dependencies?: Record<string, string>;
	name?: string;
}

interface ProjectConfig {
	compilerOptions?: { composite?: boolean };
	references?: Array<{ path?: string }>;
}

interface WorkspaceProject {
	configPath: string;
	directory: string;
	manifest: Manifest;
	manifestPath: string;
	name: string;
}

const DEFAULT_ROOT = path.join(import.meta.dir, "..");
const PRODUCTION_DEPENDENCY_FIELDS = ["dependencies"] as const;

function repoPath(root: string, filePath: string): string {
	return path.relative(root, filePath).split(path.sep).join("/");
}

function normalizeDependencyName(name: string, version: string): string | undefined {
	if (version.startsWith("workspace:") || version.startsWith("catalog:") || version.length > 0) return name;
	return undefined;
}

async function workspaceProjects(root: string): Promise<WorkspaceProject[]> {
	const packagesDirectory = path.join(root, "packages");
	let entries: fs.Dirent[];
	try {
		entries = await fs.readdir(packagesDirectory, { withFileTypes: true });
	} catch {
		return [];
	}

	const projects: WorkspaceProject[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue;
		const directory = path.join(packagesDirectory, entry.name);
		const manifestPath = path.join(directory, "package.json");
		const configPath = path.join(directory, "tsconfig.json");
		if (!(await Bun.file(manifestPath).exists()) || !(await Bun.file(configPath).exists())) continue;
		const manifest = (await Bun.file(manifestPath).json()) as Manifest;
		if (!manifest.name) continue;
		projects.push({ configPath, directory, manifest, manifestPath, name: manifest.name });
	}
	return projects;
}

async function readConfig(configPath: string): Promise<ProjectConfig> {
	return (await Bun.file(configPath).json()) as ProjectConfig;
}

function expectedDependencies(project: WorkspaceProject, projectsByName: Map<string, WorkspaceProject>): string[] {
	const names = new Set<string>();
	for (const field of PRODUCTION_DEPENDENCY_FIELDS) {
		for (const [name, version] of Object.entries(project.manifest[field] ?? {})) {
			if (typeof version !== "string") continue;
			const normalized = normalizeDependencyName(name, version);
			if (normalized && projectsByName.has(normalized)) names.add(normalized);
		}
	}
	return [...names].sort();
}

function resolveReference(configPath: string, referencePath: string): string {
	const resolved = path.resolve(path.dirname(configPath), referencePath);
	return path.extname(resolved) === ".json" ? resolved : path.join(resolved, "tsconfig.json");
}

function detectCycles(
	root: string,
	projects: WorkspaceProject[],
	actualDependencies: Map<string, Set<string>>,
): PackageReferenceViolation[] {
	const violations: PackageReferenceViolation[] = [];
	const visited = new Set<string>();
	const active: string[] = [];
	const activeNames = new Set<string>();
	const projectsByName = new Map(projects.map(project => [project.name, project]));

	function visit(name: string): void {
		if (activeNames.has(name)) {
			const cycle = [...active.slice(active.indexOf(name)), name];
			const source = projectsByName.get(name);
			violations.push({
				kind: "cyclic-reference",
				path: source ? repoPath(root, source.configPath) : name,
				message: `Cyclic project reference: ${cycle.join(" -> ")}.`,
			});
			return;
		}
		if (visited.has(name)) return;
		visited.add(name);
		active.push(name);
		activeNames.add(name);
		for (const dependency of [...(actualDependencies.get(name) ?? [])].sort()) visit(dependency);
		active.pop();
		activeNames.delete(name);
	}

	for (const project of projects) visit(project.name);
	return violations;
}

async function rootReferenceViolations(root: string, projects: WorkspaceProject[]): Promise<PackageReferenceViolation[]> {
	const rootConfigPath = path.join(root, "tsconfig.json");
	if (!(await Bun.file(rootConfigPath).exists())) return [];
	const config = await readConfig(rootConfigPath);
	const projectPaths = new Set(projects.map(project => project.configPath));
	const references = (config.references ?? [])
		.filter(reference => typeof reference.path === "string")
		.map(reference => resolveReference(rootConfigPath, reference.path!));
	const referencedProjects = references.filter(reference => projectPaths.has(reference));
	const missing = projects.filter(project => !referencedProjects.includes(project.configPath));
	const aggregate = references.find(reference => reference === path.join(root, "packages", "tsconfig.workspace.json"));
	const violations: PackageReferenceViolation[] = [];
	if (aggregate) {
		violations.push({
			kind: "root-reference",
			path: repoPath(root, rootConfigPath),
			message: "Root tsconfig must reference package projects directly, not packages/tsconfig.workspace.json.",
		});
	}
	for (const project of missing) {
		violations.push({
			kind: "root-reference",
			path: repoPath(root, rootConfigPath),
			message: `Root tsconfig is missing ${repoPath(root, project.configPath)}.`,
		});
	}
	return violations;
}

export async function checkPackageReferenceGraph(root = DEFAULT_ROOT): Promise<PackageReferenceViolation[]> {
	const absoluteRoot = path.resolve(root);
	const projects = await workspaceProjects(absoluteRoot);
	const projectsByName = new Map(projects.map(project => [project.name, project]));
	const projectsByConfigPath = new Map(projects.map(project => [project.configPath, project]));
	const actualDependencies = new Map<string, Set<string>>();
	const violations: PackageReferenceViolation[] = [];

	for (const project of projects) {
		const config = await readConfig(project.configPath);
		if (config.compilerOptions?.composite !== true) {
			violations.push({
				kind: "missing-reference",
				path: repoPath(absoluteRoot, project.configPath),
				message: `${project.name} must set compilerOptions.composite to true.`,
			});
		}

		const expected = new Set(expectedDependencies(project, projectsByName));
		const actual = new Set<string>();
		for (const reference of config.references ?? []) {
			if (typeof reference.path !== "string") continue;
			const referencedConfigPath = resolveReference(project.configPath, reference.path);
			const target = projectsByConfigPath.get(referencedConfigPath);
			if (!target) {
				violations.push({
					kind: "non-workspace-reference",
					path: repoPath(absoluteRoot, project.configPath),
					message: `${project.name} references non-workspace project ${repoPath(absoluteRoot, referencedConfigPath)}.`,
				});
				continue;
			}
			actual.add(target.name);
		}
		actualDependencies.set(project.name, actual);

		for (const name of expected) {
			if (actual.has(name)) continue;
			const target = projectsByName.get(name)!;
			violations.push({
				kind: "missing-reference",
				path: repoPath(absoluteRoot, project.configPath),
				message: `${project.name} is missing reference to ${name} (${repoPath(absoluteRoot, target.configPath)}).`,
			});
		}
		for (const name of actual) {
			if (expected.has(name)) continue;
			const target = projectsByName.get(name)!;
			const reverse = expectedDependencies(target, projectsByName).includes(project.name);
			violations.push({
				kind: reverse ? "reverse-reference" : "extra-reference",
				path: repoPath(absoluteRoot, project.configPath),
				message: reverse
					? `${project.name} has reverse reference to ${name} (${repoPath(absoluteRoot, target.configPath)}).`
					: `${project.name} has extra reference to ${name} (${repoPath(absoluteRoot, target.configPath)}).`,
			});
		}
	}

	violations.push(...detectCycles(absoluteRoot, projects, actualDependencies));
	violations.push(...(await rootReferenceViolations(absoluteRoot, projects)));
	return violations.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind) || left.message.localeCompare(right.message));
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const rootArgument = args.find(argument => argument !== "--check");
	const violations = await checkPackageReferenceGraph(rootArgument ? path.resolve(rootArgument) : DEFAULT_ROOT);
	if (violations.length === 0) {
		console.log("[OK] Package reference graph passed.");
		process.exit(0);
	}
	console.error(`[FAIL] Found ${violations.length} package-reference violation${violations.length === 1 ? "" : "s"}:`);
	for (const violation of violations) console.error(`- ${violation.path}: [${violation.kind}] ${violation.message}`);
	process.exit(1);
}
