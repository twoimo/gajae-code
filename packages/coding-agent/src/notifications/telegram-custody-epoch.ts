import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import { daemonPaths } from "./daemon-paths";

export const TELEGRAM_CUSTODY_EPOCH_SCHEMA_VERSION = 1;
export const TELEGRAM_CUSTODY_EPOCH_MAX_FILE_BYTES = 4_096;

export interface TelegramCustodyEpochBinding {
	ownerId: string;
	custodyEpoch: number;
}

export type TelegramCustodyEpochFailureReason = "corrupt" | "forward_version" | "exhausted";

export class TelegramCustodyEpochError extends Error {
	readonly reason: TelegramCustodyEpochFailureReason;

	constructor(reason: TelegramCustodyEpochFailureReason) {
		super(`Telegram custody epoch is ${reason}`);
		this.name = "TelegramCustodyEpochError";
		this.reason = reason;
	}
}

export interface TelegramCustodyEpochFs {
	mkdir(path: string, opts?: fs.MakeDirectoryOptions): Promise<unknown>;
	readFile(path: string, encoding: BufferEncoding): Promise<string>;
	writeFile(path: string, data: string, opts?: fs.WriteFileOptions): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	unlink(path: string): Promise<void>;
	open(path: string, flags: string, mode?: number): Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
}

const EPOCH_FILENAME = "telegram-custody-epoch.json";
const nodeFs: TelegramCustodyEpochFs = fs.promises as unknown as TelegramCustodyEpochFs;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBinding(value: unknown): value is TelegramCustodyEpochBinding {
	return (
		isPlainObject(value) &&
		typeof value.ownerId === "string" &&
		value.ownerId.length > 0 &&
		isPositiveSafeInteger(value.custodyEpoch)
	);
}

function findStringEnd(source: string, start: number): number | undefined {
	for (let position = start + 1; position < source.length; position++) {
		const character = source[position];
		if (character === "\\") {
			position++;
			continue;
		}
		if (character === '"') return position + 1;
	}
	return undefined;
}

/** JSON.parse intentionally accepts duplicate object members; epoch files do not. */
function hasDuplicateObjectKeys(source: string): boolean {
	function skipWhitespace(position: number): number {
		while (/\s/.test(source[position] ?? "")) position++;
		return position;
	}

	function scanString(position: number): { value: string; end: number } | undefined {
		const end = findStringEnd(source, position);
		if (end === undefined) return undefined;
		try {
			return { value: JSON.parse(source.slice(position, end)) as string, end };
		} catch {
			return undefined;
		}
	}

	function scanValue(position: number): number | undefined {
		position = skipWhitespace(position);
		const character = source[position];
		if (character === '"') return scanString(position)?.end;
		if (character === "{") {
			position = skipWhitespace(position + 1);
			const keys = new Set<string>();
			if (source[position] === "}") return position + 1;
			while (true) {
				if (source[position] !== '"') return undefined;
				const key = scanString(position);
				if (!key || keys.has(key.value)) return undefined;
				keys.add(key.value);
				position = skipWhitespace(key.end);
				if (source[position] !== ":") return undefined;
				const valueEnd = scanValue(position + 1);
				if (valueEnd === undefined) return undefined;
				position = skipWhitespace(valueEnd);
				if (source[position] === "}") return position + 1;
				if (source[position] !== ",") return undefined;
				position = skipWhitespace(position + 1);
			}
		}
		if (character === "[") {
			position = skipWhitespace(position + 1);
			if (source[position] === "]") return position + 1;
			while (true) {
				const valueEnd = scanValue(position);
				if (valueEnd === undefined) return undefined;
				position = skipWhitespace(valueEnd);
				if (source[position] === "]") return position + 1;
				if (source[position] !== ",") return undefined;
				position = skipWhitespace(position + 1);
			}
		}
		while (position < source.length && !/[\s,}\]]/.test(source[position]!)) position++;
		return position;
	}

	const end = scanValue(0);
	return end === undefined || skipWhitespace(end) !== source.length;
}

function parseTelegramCustodyEpoch(source: string): TelegramCustodyEpochBinding {
	if (Buffer.byteLength(source, "utf8") > TELEGRAM_CUSTODY_EPOCH_MAX_FILE_BYTES || hasDuplicateObjectKeys(source)) {
		throw new TelegramCustodyEpochError("corrupt");
	}

	let document: unknown;
	try {
		document = JSON.parse(source) as unknown;
	} catch {
		throw new TelegramCustodyEpochError("corrupt");
	}

	if (!isPlainObject(document)) throw new TelegramCustodyEpochError("corrupt");
	const version = document.version;
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
		throw new TelegramCustodyEpochError("corrupt");
	}
	if (version > TELEGRAM_CUSTODY_EPOCH_SCHEMA_VERSION) {
		throw new TelegramCustodyEpochError("forward_version");
	}

	const keys = Object.keys(document);
	if (
		keys.length !== 3 ||
		!Object.hasOwn(document, "version") ||
		!Object.hasOwn(document, "custodyEpoch") ||
		!Object.hasOwn(document, "ownerId")
	) {
		throw new TelegramCustodyEpochError("corrupt");
	}
	const binding = { ownerId: document.ownerId, custodyEpoch: document.custodyEpoch };
	if (!isBinding(binding)) throw new TelegramCustodyEpochError("corrupt");
	return binding;
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code);
}

async function syncFile(fsImpl: TelegramCustodyEpochFs, filePath: string): Promise<void> {
	const handle = await fsImpl.open(filePath, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(fsImpl: TelegramCustodyEpochFs, directoryPath: string): Promise<void> {
	const handle = await fsImpl.open(directoryPath, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function ensureEpochDirectory(fsImpl: TelegramCustodyEpochFs, agentDir: string): Promise<string> {
	const directory = daemonPaths(agentDir).dir;
	await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
	return directory;
}

async function writeTelegramCustodyEpoch(
	fsImpl: TelegramCustodyEpochFs,
	filePath: string,
	binding: TelegramCustodyEpochBinding,
): Promise<void> {
	const data = `${JSON.stringify({
		version: TELEGRAM_CUSTODY_EPOCH_SCHEMA_VERSION,
		custodyEpoch: binding.custodyEpoch,
		ownerId: binding.ownerId,
	})}\n`;
	if (Buffer.byteLength(data, "utf8") > TELEGRAM_CUSTODY_EPOCH_MAX_FILE_BYTES) {
		throw new TelegramCustodyEpochError("corrupt");
	}
	const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

	try {
		await fsImpl.writeFile(temporaryPath, data, { mode: 0o600 });
		await fsImpl.chmod(temporaryPath, 0o600);
		await syncFile(fsImpl, temporaryPath);
		await fsImpl.rename(temporaryPath, filePath);
		await syncFile(fsImpl, filePath);
		try {
			await syncDirectory(fsImpl, path.dirname(filePath));
		} catch (error) {
			if (!isUnsupportedDirectorySyncError(error)) throw error;
		}
	} catch (error) {
		await fsImpl.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export function telegramCustodyEpochPath(agentDir: string): string {
	return path.join(daemonPaths(agentDir).dir, EPOCH_FILENAME);
}

export async function readTelegramCustodyEpoch(input: {
	agentDir: string;
	fs?: TelegramCustodyEpochFs;
}): Promise<TelegramCustodyEpochBinding> {
	const fsImpl = input.fs ?? nodeFs;
	const filePath = telegramCustodyEpochPath(input.agentDir);
	let source: string;
	try {
		source = await fsImpl.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TelegramCustodyEpochError("corrupt");
		throw error;
	}
	return parseTelegramCustodyEpoch(source);
}

export async function allocateTelegramCustodyEpoch(input: {
	agentDir: string;
	ownerId: string;
	fs?: TelegramCustodyEpochFs;
}): Promise<TelegramCustodyEpochBinding> {
	if (typeof input.ownerId !== "string" || input.ownerId.length === 0) throw new TelegramCustodyEpochError("corrupt");

	const fsImpl = input.fs ?? nodeFs;
	const directory = await ensureEpochDirectory(fsImpl, input.agentDir);
	const filePath = telegramCustodyEpochPath(input.agentDir);
	return withFileLock(filePath, async () => {
		await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
		await fsImpl.chmod(directory, 0o700);

		let previous: TelegramCustodyEpochBinding | undefined;
		try {
			previous = parseTelegramCustodyEpoch(await fsImpl.readFile(filePath, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		if (previous?.custodyEpoch === Number.MAX_SAFE_INTEGER) {
			throw new TelegramCustodyEpochError("exhausted");
		}
		const binding: TelegramCustodyEpochBinding = {
			ownerId: input.ownerId,
			custodyEpoch: previous === undefined ? 1 : previous.custodyEpoch + 1,
		};
		await writeTelegramCustodyEpoch(fsImpl, filePath, binding);
		return binding;
	});
}

export async function withCurrentTelegramCustodyEpoch<T>(
	input: { agentDir: string; binding: TelegramCustodyEpochBinding; fs?: TelegramCustodyEpochFs },
	operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: "fenced" }> {
	if (!isBinding(input.binding)) return { ok: false, reason: "fenced" };

	const fsImpl = input.fs ?? nodeFs;
	await ensureEpochDirectory(fsImpl, input.agentDir);
	const filePath = telegramCustodyEpochPath(input.agentDir);
	return withFileLock(filePath, async () => {
		const current = await readTelegramCustodyEpoch({ agentDir: input.agentDir, fs: fsImpl });
		if (
			current.ownerId !== input.binding.ownerId ||
			current.custodyEpoch !== input.binding.custodyEpoch
		) {
			return { ok: false, reason: "fenced" };
		}
		return { ok: true, value: await operation() };
	});
}
