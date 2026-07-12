import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	VISIBLE_SESSION_WSL_HMAC_ENV,
	VISIBLE_SESSION_WSL_RECEIPT_SCHEMA_VERSION,
	canonicalizeVisibleSessionWslReceipt,
	normalizeVisibleSessionWslGjcVersion,
	parseVisibleSessionWslReceiptProducerArgv,
	produceVisibleSessionWslReceipt,
	validateVisibleSessionWslReceipt,
	type VisibleSessionWslCommandResult,
	type VisibleSessionWslLifecycleMode,
	type VisibleSessionWslReceipt,
} from "./run-visible-session-wsl-e2e";
import {
	parseVisibleSessionWslReceiptVerifierArgv,
	verifyVisibleSessionWslReceipt,
	type VisibleSessionWslReceiptVerifierInput,
} from "./verify-visible-session-wsl-receipt";

const HEAD_SHA = "a".repeat(40);
const BINARY_SHA256 = "b".repeat(64);
const HMAC_KEY = "k".repeat(32);
const NOW = new Date("2026-07-12T12:00:00.000Z");

function successfulReceipt(createdAt = "2026-07-12T11:00:00.000Z"): VisibleSessionWslReceipt {
	const sourceResult = {
		mode: "source" as const,
		passed: true as const,
		headSha: HEAD_SHA,
		binarySha256: null,
		hostVersion: "gjc/0.10.1",
		distroVersion: "gjc/0.10.2",
		schemaVersionObserved: 2,
		tests: 1,
		skips: 0,
		failures: 0,
		survivors: 0,
		endpointLeaks: 0,
	};
	const compiledResult = {
		...sourceResult,
		mode: "compiled" as const,
		binarySha256: BINARY_SHA256,
	};
	return {
		schemaVersion: VISIBLE_SESSION_WSL_RECEIPT_SCHEMA_VERSION,
		headSha: HEAD_SHA,
		binarySha256: BINARY_SHA256,
		sourceResult,
		compiledResult,
		distro: "Ubuntu-24.04",
		hostVersion: "gjc/0.10.1",
		distroVersion: "gjc/0.10.2",
		schemaVersionObserved: 2,
		tests: 2,
		skips: 0,
		failures: 0,
		survivors: 0,
		endpointLeaks: 0,
		createdAt,
	};
}

function signatureFor(bytes: Uint8Array, key = HMAC_KEY): string {
	return createHmac("sha256", Buffer.from(key, "utf8")).update(bytes).digest("hex");
}

async function writeSignedReceipt(
	directory: string,
	receiptBytes: Uint8Array,
	key = HMAC_KEY,
): Promise<{ receiptPath: string; signaturePath: string }> {
	const receiptPath = path.join(directory, "receipt.json");
	const signaturePath = path.join(directory, "receipt.sig");
	await fs.writeFile(receiptPath, receiptBytes);
	await fs.writeFile(signaturePath, signatureFor(receiptBytes, key), "utf8");
	return { receiptPath, signaturePath };
}

function verifierInput(receiptPath: string, signaturePath: string): VisibleSessionWslReceiptVerifierInput {
	return {
		receiptPath,
		signaturePath,
		expectedHeadSha: HEAD_SHA,
		expectedBinarySha256: BINARY_SHA256,
		maxAgeHours: 2,
		hmacEnvironment: VISIBLE_SESSION_WSL_HMAC_ENV,
	};
}

function verificationDependencies(key = HMAC_KEY) {
	return {
		readEnvironment: (name: string): string | undefined => (name === VISIBLE_SESSION_WSL_HMAC_ENV ? key : undefined),
		now: (): Date => NOW,
	};
}

function successfulLifecycleReport(mode: VisibleSessionWslLifecycleMode): unknown {
	return {
		schemaVersion: 2,
		scenario: mode,
		sourceHead: HEAD_SHA,
		binarySha256: mode === "compiled" ? BINARY_SHA256 : null,
		sourceAttach: null,
		compiledAttach: null,
		ownerPid: 101,
		monitorPid: 102,
		terminalKind: "final",
		finalCount: 1,
		vanishedCount: 0,
		tokenPresentAfter: false,
		manifestPresentAfter: false,
		endpointReachableAfter: false,
		survivingPids: [],
		durationMs: 12,
		failures: [],
	};
}

describe("visible-session WSL receipt canonicalization", () => {
	test("uses recursive lexicographic key ordering and exact UTF-8 bytes", () => {
		const receipt = successfulReceipt();
		const canonical = canonicalizeVisibleSessionWslReceipt(receipt);
		const parsed = JSON.parse(canonical) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
		const source = parsed.sourceResult as Record<string, unknown>;
		expect(Object.keys(source)).toEqual([...Object.keys(source)].sort());
		expect(canonical.endsWith("\n")).toBe(false);
		expect(validateVisibleSessionWslReceipt(parsed)).toEqual(receipt);
	});
	test("normalizes only a bounded GJC version line", () => {
		expect(normalizeVisibleSessionWslGjcVersion("gjc/0.10.2\r\n")).toBe("gjc/0.10.2");
		for (const output of ["0.10.2\n", "gjc/0.10\n", "gjc/0.10.2\nunexpected", `gjc/0.10.2${"x".repeat(64)}`])
			expect(() => normalizeVisibleSessionWslGjcVersion(output)).toThrow("version output is invalid");
	});

	test("signs the exact canonical bytes rather than an equivalent JSON representation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wsl-receipt-test-"));
		try {
			const receipt = successfulReceipt();
			const canonical = Buffer.from(canonicalizeVisibleSessionWslReceipt(receipt), "utf8");
			const files = await writeSignedReceipt(directory, canonical);
			await expect(verifyVisibleSessionWslReceipt(verifierInput(files.receiptPath, files.signaturePath), verificationDependencies())).resolves.toEqual(receipt);

			const whitespace = Buffer.from(`${canonical.toString("utf8")}\n`, "utf8");
			const whitespaceFiles = await writeSignedReceipt(directory, whitespace);
			await expect(
				verifyVisibleSessionWslReceipt(verifierInput(whitespaceFiles.receiptPath, whitespaceFiles.signaturePath), verificationDependencies()),
			).rejects.toThrow("verification failed");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("visible-session WSL receipt trust boundaries", () => {
	test("rejects unsafe or non-exact producer and verifier argv", () => {
		const root = path.resolve(os.tmpdir(), "gjc-wsl-receipt-path");
		const unicodeDistro = "Ubuntu 日本語 24.04";
		expect(
			parseVisibleSessionWslReceiptProducerArgv([
				"--distro",
				unicodeDistro,
				"--source",
				"--compiled",
				"--head",
				HEAD_SHA,
				"--binary-sha256",
				BINARY_SHA256,
				"--out",
				path.join(root, "receipt.json"),
				"--signature",
				path.join(root, "receipt.sig"),
			]).distro,
		).toBe(unicodeDistro);
		expect(() =>
			parseVisibleSessionWslReceiptProducerArgv([
				"--distro",
				"Ubuntu-24.04",
				"--source",
				"--compiled",
				"--head",
				HEAD_SHA,
				"--binary-sha256",
				BINARY_SHA256,
				"--out",
				`${root}${path.sep}..${path.sep}receipt.json`,
				"--signature",
				path.join(root, "receipt.sig"),
			]),
		).toThrow("arguments");
		expect(() =>
			parseVisibleSessionWslReceiptProducerArgv([
				"--distro",
				"Ubuntu\r24.04",
				"--source",
				"--compiled",
				"--head",
				HEAD_SHA,
				"--binary-sha256",
				BINARY_SHA256,
				"--out",
				path.join(root, "receipt.json"),
				"--signature",
				path.join(root, "receipt.sig"),
			]),
		).toThrow("arguments");
		expect(() =>
			parseVisibleSessionWslReceiptVerifierArgv([
				"--receipt",
				path.join(root, "receipt.json"),
				"--signature",
				path.join(root, "receipt.sig"),
				"--expected-head",
				HEAD_SHA,
				"--expected-binary-sha",
				BINARY_SHA256,
				"--max-age-hours",
				"0",
				"--hmac-env",
				"ANOTHER_KEY",
			]),
		).toThrow("arguments");
	});
	test("rejects malformed receipt fields and unbound source or compiled evidence", () => {
		const receipt = successfulReceipt();
		const missing: Record<string, unknown> = { ...receipt };
		delete missing.distro;
		const invalidReceipts: unknown[] = [
			{ ...receipt, headSha: "A".repeat(40) },
			{ ...receipt, createdAt: "2026-07-12T11:00:00Z" },
			{ ...receipt, tests: 0 },
			{ ...receipt, schemaVersionObserved: 3 },
			{ ...receipt, sourceResult: { ...receipt.sourceResult, mode: "compiled" } },
			{ ...receipt, sourceResult: { ...receipt.sourceResult, passed: false } },
			{ ...receipt, compiledResult: { ...receipt.compiledResult, binarySha256: "c".repeat(64) } },
			{ ...receipt, unexpected: true },
			{
				...receipt,
				distroVersion: "gjc/0.11.0",
				sourceResult: { ...receipt.sourceResult, distroVersion: "gjc/0.11.0" },
				compiledResult: { ...receipt.compiledResult, distroVersion: "gjc/0.11.0" },
			},
			missing,
		];
		for (const invalid of invalidReceipts) expect(() => validateVisibleSessionWslReceipt(invalid)).toThrow("receipt is invalid");
	});

	test("rejects signature, key, schema, provenance, and freshness faults", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wsl-receipt-test-"));
		try {
			const canonical = Buffer.from(canonicalizeVisibleSessionWslReceipt(successfulReceipt()), "utf8");
			const files = await writeSignedReceipt(directory, canonical);
			await fs.writeFile(files.signaturePath, "0".repeat(64), "utf8");
			await expect(verifyVisibleSessionWslReceipt(verifierInput(files.receiptPath, files.signaturePath), verificationDependencies())).rejects.toThrow(
				"verification failed",
			);

			await fs.writeFile(files.signaturePath, signatureFor(canonical), "utf8");
			await expect(
				verifyVisibleSessionWslReceipt(verifierInput(files.receiptPath, files.signaturePath), verificationDependencies("short")),
			).rejects.toThrow("verification failed");

			const stale = successfulReceipt("2026-07-12T09:59:59.999Z");
			const staleFiles = await writeSignedReceipt(directory, Buffer.from(canonicalizeVisibleSessionWslReceipt(stale), "utf8"));
			await expect(verifyVisibleSessionWslReceipt(verifierInput(staleFiles.receiptPath, staleFiles.signaturePath), verificationDependencies())).rejects.toThrow(
				"verification failed",
			);

			const future = successfulReceipt("2026-07-12T12:00:00.001Z");
			const futureFiles = await writeSignedReceipt(directory, Buffer.from(canonicalizeVisibleSessionWslReceipt(future), "utf8"));
			await expect(verifyVisibleSessionWslReceipt(verifierInput(futureFiles.receiptPath, futureFiles.signaturePath), verificationDependencies())).rejects.toThrow(
				"verification failed",
			);
			await writeSignedReceipt(directory, canonical);

			const mismatchedHead = verifierInput(files.receiptPath, files.signaturePath);
			mismatchedHead.expectedHeadSha = "c".repeat(40);
			await expect(verifyVisibleSessionWslReceipt(mismatchedHead, verificationDependencies())).rejects.toThrow("verification failed");
			const mismatchedBinary = verifierInput(files.receiptPath, files.signaturePath);
			mismatchedBinary.expectedBinarySha256 = "d".repeat(64);
			await expect(verifyVisibleSessionWslReceipt(mismatchedBinary, verificationDependencies())).rejects.toThrow("verification failed");

			const malformed = {
				...successfulReceipt(),
				sourceResult: { ...successfulReceipt().sourceResult, mode: "compiled" },
				unexpected: true,
			};
			const malformedBytes = Buffer.from(JSON.stringify(malformed), "utf8");
			const malformedFiles = await writeSignedReceipt(directory, malformedBytes);
			await expect(verifyVisibleSessionWslReceipt(verifierInput(malformedFiles.receiptPath, malformedFiles.signaturePath), verificationDependencies())).rejects.toThrow(
				"verification failed",
			);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("visible-session WSL receipt producer", () => {
	test("executes source and compiled direct WSL argv and aggregates both lifecycle reports", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wsl-receipt-producer-"));
		try {
			const commands: string[][] = [];
			let translatedPaths = 0;
			const runCommand = async (argv: readonly string[]): Promise<VisibleSessionWslCommandResult> => {
				commands.push([...argv]);
				if (argv[0] !== "wsl.exe") return { exitCode: 0, stdout: "gjc/0.10.1\n" };
				const command = argv.slice(4);
				if (command[0] === "wslpath") {
					translatedPaths += 1;
					return { exitCode: 0, stdout: translatedPaths === 1 ? "/workspace/gjc" : "/workspace/evidence" };
				}
				if (command.at(-1) === "--version") return { exitCode: 0, stdout: "gjc/0.10.2\r\n" };
				return { exitCode: 0, stdout: "" };
			};
			const receiptPath = path.join(directory, "receipt.json");
			const signaturePath = path.join(directory, "receipt.sig");
			const receipt = await produceVisibleSessionWslReceipt(
				{
					distro: "Ubuntu-24.04",
					source: true,
					compiled: true,
					headSha: HEAD_SHA,
					binarySha256: BINARY_SHA256,
					receiptPath,
					signaturePath,
				},
				{
					runCommand,
					readEnvironment: (name: string): string | undefined =>
						name === VISIBLE_SESSION_WSL_HMAC_ENV ? HMAC_KEY : undefined,
					readLifecycleReport: async (mode: VisibleSessionWslLifecycleMode): Promise<unknown> => successfulLifecycleReport(mode),
					now: (): Date => new Date("2026-07-12T11:00:00.000Z"),
				},
			);
			expect(receipt).toMatchObject({ tests: 2, skips: 0, failures: 0, survivors: 0, endpointLeaks: 0 });
			expect(commands[0][0]).toBe(process.execPath);
			expect(commands[0][1]).toEndWith(path.join("packages", "coding-agent", "src", "cli.ts"));
			expect(commands[0][2]).toBe("--version");
			expect(
				commands.filter(command => command[0] === "wsl.exe" && command.at(-1) === "--version"),
			).toEqual([
				[
					"wsl.exe",
					"-d",
					"Ubuntu-24.04",
					"--exec",
					"/workspace/gjc/packages/coding-agent/dist/gjc.exe",
					"--version",
				],
			]);
			expect(commands.filter(command => command[0] === "wsl.exe").every(command => command[1] === "-d")).toBe(true);
			const lifecycleCommands = commands.filter(command => command.includes("--scenario"));
			expect(lifecycleCommands).toHaveLength(2);
			expect(lifecycleCommands[0]).toEqual([
				"wsl.exe",
				"-d",
				"Ubuntu-24.04",
				"--exec",
				"bun",
				"/workspace/gjc/scripts/visible-session-lifecycle-smoke.ts",
				"--scenario",
				"source",
				"--report",
				"/workspace/evidence/source.json",
			]);
			expect(lifecycleCommands[1]).toEqual([
				"wsl.exe",
				"-d",
				"Ubuntu-24.04",
				"--exec",
				"env",
				"GJC_VISIBLE_SESSION_COMPILED_BINARY=/workspace/gjc/packages/coding-agent/dist/gjc.exe",
				"bun",
				"/workspace/gjc/scripts/visible-session-lifecycle-smoke.ts",
				"--scenario",
				"compiled",
				"--report",
				"/workspace/evidence/compiled.json",
			]);
			await expect(verifyVisibleSessionWslReceipt(verifierInput(receiptPath, signaturePath), verificationDependencies())).resolves.toEqual(receipt);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	test("fails closed when host and selected WSL GJC major/minor versions differ", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wsl-receipt-version-"));
		try {
			let translatedPaths = 0;
			const runCommand = async (argv: readonly string[]): Promise<VisibleSessionWslCommandResult> => {
				if (argv[0] !== "wsl.exe") return { exitCode: 0, stdout: "gjc/0.10.1\n" };
				const command = argv.slice(4);
				if (command[0] === "wslpath") {
					translatedPaths += 1;
					return { exitCode: 0, stdout: translatedPaths === 1 ? "/workspace/gjc" : "/workspace/evidence" };
				}
				if (command.at(-1) === "--version") return { exitCode: 0, stdout: "gjc/0.11.0\n" };
				throw new Error("Lifecycle execution must not begin after version disagreement");
			};
			await expect(
				produceVisibleSessionWslReceipt(
					{
						distro: "Ubuntu-24.04",
						source: true,
						compiled: true,
						headSha: HEAD_SHA,
						binarySha256: BINARY_SHA256,
						receiptPath: path.join(directory, "receipt.json"),
						signaturePath: path.join(directory, "receipt.sig"),
					},
					{
						runCommand,
						readEnvironment: (name: string): string | undefined =>
							name === VISIBLE_SESSION_WSL_HMAC_ENV ? HMAC_KEY : undefined,
					},
				),
			).rejects.toThrow("do not share a major/minor");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
