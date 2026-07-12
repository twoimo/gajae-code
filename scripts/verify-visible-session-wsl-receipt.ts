#!/usr/bin/env bun
import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	VISIBLE_SESSION_WSL_HMAC_ENV,
	canonicalizeVisibleSessionWslReceipt,
	validateVisibleSessionWslReceipt,
	type VisibleSessionWslReceipt,
} from "./run-visible-session-wsl-e2e";

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 64;
const MAX_AGE_HOURS = 24 * 366;

export interface VisibleSessionWslReceiptVerifierInput {
	receiptPath: string;
	signaturePath: string;
	expectedHeadSha: string;
	expectedBinarySha256: string;
	maxAgeHours: number;
	hmacEnvironment: typeof VISIBLE_SESSION_WSL_HMAC_ENV;
}

export interface VisibleSessionWslReceiptVerifierDependencies {
	readEnvironment?: (name: string) => string | undefined;
	now?: () => Date;
}

function argumentError(): Error {
	return new Error("Visible-session WSL receipt verifier arguments are invalid");
}

function verificationError(): Error {
	return new Error("Visible-session WSL receipt verification failed");
}

function isHeadSha(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isBinarySha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSafeAbsolutePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\u0000\r\n]/.test(value)) return false;
	if (!path.isAbsolute(value)) return false;
	return !value.split(/[\\/]+/).some(part => part === "." || part === "..");
}

function normalizeSafeAbsolutePath(value: unknown): string {
	if (!isSafeAbsolutePath(value)) throw argumentError();
	return path.resolve(value);
}

function areSamePath(left: string, right: string): boolean {
	const normalizedLeft = process.platform === "win32" ? left.toLowerCase() : left;
	const normalizedRight = process.platform === "win32" ? right.toLowerCase() : right;
	return normalizedLeft === normalizedRight;
}

/** The verifier deliberately accepts only the Gate-2 invocation shape and HMAC environment name. */
export function parseVisibleSessionWslReceiptVerifierArgv(
	argv: readonly string[],
): VisibleSessionWslReceiptVerifierInput {
	if (
		argv.length !== 12 ||
		argv[0] !== "--receipt" ||
		argv[2] !== "--signature" ||
		argv[4] !== "--expected-head" ||
		argv[6] !== "--expected-binary-sha" ||
		argv[8] !== "--max-age-hours" ||
		argv[10] !== "--hmac-env" ||
		!isHeadSha(argv[5]) ||
		!isBinarySha256(argv[7]) ||
		argv[11] !== VISIBLE_SESSION_WSL_HMAC_ENV ||
		!/^[1-9]\d{0,3}$/.test(argv[9])
	)
		throw argumentError();
	const maxAgeHours = Number(argv[9]);
	if (!Number.isSafeInteger(maxAgeHours) || maxAgeHours > MAX_AGE_HOURS) throw argumentError();
	const receiptPath = normalizeSafeAbsolutePath(argv[1]);
	const signaturePath = normalizeSafeAbsolutePath(argv[3]);
	if (areSamePath(receiptPath, signaturePath)) throw argumentError();
	return {
		receiptPath,
		signaturePath,
		expectedHeadSha: argv[5],
		expectedBinarySha256: argv[7],
		maxAgeHours,
		hmacEnvironment: VISIBLE_SESSION_WSL_HMAC_ENV,
	};
}

function requireHmacKey(readEnvironment: (name: string) => string | undefined): Buffer {
	const key = readEnvironment(VISIBLE_SESSION_WSL_HMAC_ENV);
	if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) throw verificationError();
	return Buffer.from(key, "utf8");
}

async function readSafeFile(file: string, maximumBytes: number): Promise<Buffer> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size < 0 || stat.size > maximumBytes) throw verificationError();
		return await fs.readFile(file);
	} catch {
		throw verificationError();
	}
}

function parseCanonicalReceipt(receiptBytes: Buffer): VisibleSessionWslReceipt {
	let value: unknown;
	try {
		value = JSON.parse(receiptBytes.toString("utf8")) as unknown;
	} catch {
		throw verificationError();
	}
	let receipt: VisibleSessionWslReceipt;
	try {
		receipt = validateVisibleSessionWslReceipt(value);
	} catch {
		throw verificationError();
	}
	const canonicalBytes = Buffer.from(canonicalizeVisibleSessionWslReceipt(receipt), "utf8");
	if (!receiptBytes.equals(canonicalBytes)) throw verificationError();
	return receipt;
}

function verifySignature(receiptBytes: Buffer, signatureBytes: Buffer, key: Buffer): void {
	if (signatureBytes.length !== MAX_SIGNATURE_BYTES) throw verificationError();
	const signature = signatureBytes.toString("utf8");
	if (!/^[a-f0-9]{64}$/.test(signature)) throw verificationError();
	const expected = createHmac("sha256", key).update(receiptBytes).digest("hex");
	const expectedBytes = Buffer.from(expected, "utf8");
	const actualBytes = Buffer.from(signature, "utf8");
	if (!timingSafeEqual(expectedBytes, actualBytes)) throw verificationError();
}

function verifyFreshness(receipt: VisibleSessionWslReceipt, maximumAgeHours: number, now: Date): void {
	const createdAt = Date.parse(receipt.createdAt);
	const current = now.getTime();
	const maximumAgeMilliseconds = maximumAgeHours * 60 * 60 * 1_000;
	if (!Number.isFinite(current) || createdAt > current || current - createdAt > maximumAgeMilliseconds)
		throw verificationError();
}

/**
 * Verifies the exact signed bytes, canonical schema, provenance bindings, and bounded age.
 * It accepts no key material except the mandated environment variable lookup.
 */
export async function verifyVisibleSessionWslReceipt(
	input: VisibleSessionWslReceiptVerifierInput,
	dependencies: VisibleSessionWslReceiptVerifierDependencies = {},
): Promise<VisibleSessionWslReceipt> {
	if (
		!isHeadSha(input.expectedHeadSha) ||
		!isBinarySha256(input.expectedBinarySha256) ||
		!Number.isSafeInteger(input.maxAgeHours) ||
		input.maxAgeHours < 1 ||
		input.maxAgeHours > MAX_AGE_HOURS ||
		input.hmacEnvironment !== VISIBLE_SESSION_WSL_HMAC_ENV
	)
		throw argumentError();
	const receiptPath = normalizeSafeAbsolutePath(input.receiptPath);
	const signaturePath = normalizeSafeAbsolutePath(input.signaturePath);
	if (areSamePath(receiptPath, signaturePath)) throw argumentError();
	const readEnvironment = dependencies.readEnvironment ?? (name => process.env[name]);
	const now = dependencies.now ?? (() => new Date());
	const key = requireHmacKey(readEnvironment);
	const receiptBytes = await readSafeFile(receiptPath, MAX_RECEIPT_BYTES);
	const signatureBytes = await readSafeFile(signaturePath, MAX_SIGNATURE_BYTES);
	const receipt = parseCanonicalReceipt(receiptBytes);
	verifySignature(receiptBytes, signatureBytes, key);
	if (receipt.headSha !== input.expectedHeadSha || receipt.binarySha256 !== input.expectedBinarySha256)
		throw verificationError();
	verifyFreshness(receipt, input.maxAgeHours, now());
	return receipt;
}

if (import.meta.main) {
	try {
		const input = parseVisibleSessionWslReceiptVerifierArgv(process.argv.slice(2));
		await verifyVisibleSessionWslReceipt(input);
	} catch {
		process.exitCode = 1;
	}
}
