import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkPackageReferenceGraph } from "./package-reference-graph";

const temporaryRoots: string[] = [];

interface FixtureProject {
	dependencies?: Record<string, string>;
	name: string;
	references?: string[];
}

async function createFixture(projects: FixtureProject[]): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-package-reference-graph-"));
	temporaryRoots.push(root);
	for (const project of projects) {
		const directory = path.join(root, "packages", project.name);
		await fs.mkdir(directory, { recursive: true });
		await Bun.write(
			path.join(directory, "package.json"),
			JSON.stringify({ dependencies: project.dependencies, name: project.name, version: "1.0.0" }),
		);
		await Bun.write(
			path.join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { composite: true },
				references: project.references?.map(reference => ({ path: reference })),
			}),
		);
	}
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

describe("package reference graph", () => {
	test("keeps every first-party project composite and matched to its manifest dependencies", async () => {
		await expect(checkPackageReferenceGraph()).resolves.toEqual([]);
	});
	test("accepts a graph whose production workspace dependencies match references", async () => {
		const root = await createFixture([
			{ name: "core" },
			{
				dependencies: { core: "catalog:" },
				name: "app",
				references: ["../core"],
			},
		]);

		await expect(checkPackageReferenceGraph(root)).resolves.toEqual([]);
	});

	test("reports missing and extra references with config paths", async () => {
		const root = await createFixture([
			{ name: "core", references: ["../app"] },
			{
				dependencies: { core: "workspace:*" },
				name: "app",
			},
		]);

		const violations = await checkPackageReferenceGraph(root);
		expect(violations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "missing-reference", path: "packages/app/tsconfig.json" }),
				expect.objectContaining({ kind: "reverse-reference", path: "packages/core/tsconfig.json" }),
			]),
		);
	});

	test("fails a synthetic reverse-edge fixture independently", async () => {
		const root = await createFixture([
			{ name: "core", references: ["../app"] },
			{
				dependencies: { core: "workspace:*" },
				name: "app",
				references: ["../core"],
			},
		]);

		const violations = await checkPackageReferenceGraph(root);
		expect(violations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "reverse-reference",
					message: expect.stringContaining("reverse reference"),
					path: "packages/core/tsconfig.json",
				}),
			]),
		);
	});

	test("reports non-workspace references and reference cycles", async () => {
		const root = await createFixture([
			{ name: "a", references: ["../b", "../../external"] },
			{ name: "b", references: ["../a"] },
		]);

		const violations = await checkPackageReferenceGraph(root);
		expect(violations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "cyclic-reference", path: "packages/a/tsconfig.json" }),
				expect.objectContaining({ kind: "non-workspace-reference", path: "packages/a/tsconfig.json" }),
			]),
		);
	});
});
