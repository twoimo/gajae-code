import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkPackageBoundaries } from "./check-package-boundaries";

const tempRoots: string[] = [];

async function createRepo(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-package-boundaries-"));
	tempRoots.push(root);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(root, relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}
	return root;
}

function packageJson(name: string, extra = ""): string {
	return `{ "name": "${name}", "version": "1.0.0"${extra} }\n`;
}

function basePackages(): Record<string, string> {
	return {
		"packages/agent-wire/package.json": packageJson("@gajae-code/agent-wire"),
		"packages/utils/package.json": packageJson("@gajae-code/utils"),
		"packages/utils/src/index.ts": "export * from './format';\n",
	};
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("package boundary guard", () => {
	test("fails independently when agent-wire declares a production dependency", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/agent-wire/package.json": packageJson(
				"@gajae-code/agent-wire",
				', "dependencies": { "@gajae-code/utils": "workspace:*" }',
			),
		});

		await expect(checkPackageBoundaries(root)).resolves.toEqual([
			expect.objectContaining({
				path: "packages/agent-wire/package.json",
				rule: "agent-wire-production-dependency",
			}),
		]);
	});

	test("fails independently when agent-wire imports a reverse-edge package", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/agent-wire/src/index.ts": 'import { createAgent } from "@gajae-code/coding-agent";\n',
		});

		const violations = await checkPackageBoundaries(root);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({
			path: "packages/agent-wire/src/index.ts",
			line: 1,
			rule: "agent-wire-reverse-edge",
		});
	});

	test("fails when agent-wire type-exports from a reverse-edge package", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/coding-agent/package.json": packageJson("@gajae-code/coding-agent"),
			"packages/agent-wire/src/index.ts": 'export type { ConsumerConfig } from "@gajae-code/coding-agent";\n',
		});

		const violations = await checkPackageBoundaries(root);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({
			path: "packages/agent-wire/src/index.ts",
			line: 1,
			rule: "agent-wire-reverse-edge",
		});
	});

	test("fails when agent-wire type-imports from a third-party package", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/agent-wire/src/index.ts": 'import type { Schema } from "zod";\n',
		});

		const violations = await checkPackageBoundaries(root);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({
			path: "packages/agent-wire/src/index.ts",
			line: 1,
			rule: "agent-wire-runtime-import",
		});
	});

	test("allows agent-wire relative imports and type exports", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/agent-wire/src/index.ts": `import type { Envelope } from "./envelope";
export type { WireError } from "./error";
void ({} as Envelope);
`,
			"packages/agent-wire/src/envelope.ts": "export interface Envelope {}\n",
			"packages/agent-wire/src/error.ts": "export interface WireError {}\n",
		});

		await expect(checkPackageBoundaries(root)).resolves.toEqual([]);
	});

	test("fails independently when utils root exports a process API", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/utils/src/index.ts": 'export { AbortError } from "./ptree";\n',
		});

		const violations = await checkPackageBoundaries(root);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({
			path: "packages/utils/src/index.ts",
			line: 1,
			rule: "utils-root-process-api",
		});
	});

	test("fails independently when a bare utils import requests a process API", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/consumer/package.json": packageJson("@gajae-code/consumer"),
			"packages/consumer/src/index.ts": 'import { ptree } from "@gajae-code/utils";\n',
		});

		const violations = await checkPackageBoundaries(root);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({
			path: "packages/consumer/src/index.ts",
			line: 1,
			rule: "utils-bare-process-import",
		});
	});

	test("passes package-name agent-wire and explicit utils process subpath imports", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/consumer/package.json": packageJson("@gajae-code/consumer"),
			"packages/consumer/src/index.ts": `import { AgentWireEnvelope } from "@gajae-code/agent-wire";
import { ptree } from "@gajae-code/utils/ptree";
void [AgentWireEnvelope, ptree];
`,
		});

		await expect(checkPackageBoundaries(root)).resolves.toEqual([]);
	});

	test("rejects sibling source imports to agent-wire", async () => {
		const root = await createRepo({
			...basePackages(),
			"packages/consumer/package.json": packageJson("@gajae-code/consumer"),
			"packages/consumer/src/index.ts": 'import { version } from "../../agent-wire/src/version";\n',
		});

		const violations = await checkPackageBoundaries(root);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({ rule: "agent-wire-package-import" });
	});
});
