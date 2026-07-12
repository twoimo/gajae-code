import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";

export const VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION = 1 as const;
export const VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_PUBLIC_LOG_CAP_BYTES = 64 * 1024;
export const MAX_PUBLIC_TEXT_BYTES = 4096;
export const PUBLIC_LOG_TRUNCATION_MARKER = "[visible-session log truncated]\n";
/** Maximum encoded schema-2 public file payload, shared with the untrusted reader. */
export const MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES = 128 * 1024;
const REDACTION_MARKER_SEARCH_START = 0xe000;
const REDACTION_MARKER_SEARCH_LENGTH = 64;
const MAX_REDACTION_UPDATE_SECRETS = 128;
const MAX_REDACTION_UPDATE_BYTES = 64 * 1024;
const PROJECTION_LOCK_RETRIES = 600;
const projectionWriteQueues = new Map<string, Promise<void>>();

export interface VisibleSessionStatePaths {
	root: string;
	metadata: string;
	events: string;
	pane: string;
	runtimeState: string;
	promptAccepted: string;
	final: string;
	vanished: string;
	journal: string;
	lock: string;
	/** Serializes schema-2 projection publication independently of private CAS. */
	projectionLock: string;
	/** Private schema-2 projection outbox. Never written to the public directory. */
	projectionJournal: string;
	/** Public schema-2 publication manifest. */
	publication: string;
	/** Private durable redaction-publication transaction journal. */
	redactionJournal: string;
	/** Private durable redaction-rebase transaction journal. */
	redactionRebaseJournal: string;
	/** Private durable nonterminal mutation journal. */
	mutationJournal: string;
	/** Private durable log-redaction state. */
	redactionState: string;
}

export interface VisibleSessionStateProcess {
	pid: number;
	startIdentity: string;
}

/** This is private-manifest input. It is never written to the public directory. */
export interface VisibleSessionRoleIdentity {
	generationId: string;
	leaseId: string;
	owner: VisibleSessionStateProcess;
	redactions: readonly string[];
	/** Redactions applied only to durable pane/event log bytes. */
	logRedactions?: readonly string[];
}
/**
 * Opt-in G003 public projection. `privateRoot` is the only location for CAS,
 * authority, cleanup, locks, and terminal journals.
 */
export interface VisibleSessionStateProjection {
	publicRoot: string;
	privateRoot: string;
	session: string;
	workdir: string;
	branch: string;
	createdAt: string;
	gjcBin: string;
	worktreeBaselineDirty: boolean;
	owner: { pid: number; startedAt: string };
	backend: "conpty";
}
export interface VisibleSessionProjectedMetadata {
	schemaVersion: typeof VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
	session: string;
	workdir: string;
	branch: string;
	createdAt: string;
	gjcBin: string;
	stateDir: string;
	paneLog: string;
	eventsLog: string;
	finalStatus: string;
	runtimeState: string;
	vanishedStatus: string;
	promptAcceptedStatus: string;
	worktreeBaselineDirty: boolean;
	backend: "conpty";
	generation: string;
	generationId: string;
	owner: { pid: number; startedAt: string };
}
export interface VisibleSessionProjectedRuntime {
	schemaVersion: typeof VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
	backend: "conpty";
	generation: string;
	generationId: string;
	owner: { pid: number; startedAt: string };
	summary: string;
	status: string;
	updatedAt: string;
	present: boolean;
	valid: boolean;
	state: string | null;
	source: string | null;
	event: string | null;
	reason: string | null;
	terminal: boolean;
	terminalState: string | null;
	terminalSource: string | null;
	finalResponsePresent: boolean;
	previousRuntimeState: string | null;
	sessionMatches: boolean;
	cwdMatches: boolean;
}
export interface VisibleSessionProjectedPromptAccepted {
	schemaVersion: typeof VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
	backend: "conpty";
	generation: string;
	generationId: string;
	owner: { pid: number; startedAt: string };
	session: string;
	acceptedAt: string;
	summary: "prompt accepted";
	worktreeBaselineDirty: boolean;
}
export interface VisibleSessionProjectedFinalRecord {
	schemaVersion: typeof VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
	backend: "conpty";
	generation: string;
	generationId: string;
	owner: { pid: number; startedAt: string };
	session: string;
	status: number;
	startedAt: string;
	finishedAt: string;
	paneLog: string;
	runtimeState: string;
	turnEvidencePresent: boolean;
	promptAccepted: boolean;
	ownerExitReason: string;
	severity: "normal" | "failure";
	runtimeTerminal: boolean;
	runtimeTerminalState: string | null;
	runtimeTerminalSource: string | null;
	worktreeBaselineDirty: boolean;
	observedRecoverableWorktreeChanges: boolean;
	worktreeChangedSinceBaseline: boolean;
	runtimeStateSummary: VisibleSessionProjectedRuntimeSummary;
	committedAt: string;
	runtimeSummary: string;
	worktreeSummary: string;
	evidenceSummary: string;
}
export interface VisibleSessionProjectedRuntimeSummary {
	summary: string;
	status: string;
	updatedAt: string;
	present: boolean;
	valid: boolean;
	state: string | null;
	source: string | null;
	event: string | null;
	reason: string | null;
	terminal: boolean;
	terminalState: string | null;
	terminalSource: string | null;
	finalResponsePresent: boolean;
	previousRuntimeState: string | null;
	sessionMatches: boolean;
	cwdMatches: boolean;
	ownerExitReason: string;
	severity: "normal" | "failure";
}
export interface VisibleSessionProjectedVanishedRecord {
	schemaVersion: typeof VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
	backend: "conpty";
	generation: string;
	generationId: string;
	owner: { pid: number; startedAt: string };
	session: string;
	workdir: string;
	detectedAt: string;
	committedAt: string;
	reason: string;
	phase: string;
	severity: "failure";
	promptAccepted: boolean;
	finalPresent: false;
	tuiReady: boolean;
	paneLog: string;
	eventsLog: string;
	finalStatus: string;
	runtimeState: string;
	promptAcceptedStatus: string;
	evidenceSummary: string;
}

export interface ProjectionReservation {
	operationId: string;
	target: ProjectionTarget;
	digest: string;
	expectedRevision: number;
	committedRevision: number | null;
	state: "prepared" | "committed";
}
export interface VisibleSessionStateMetadata {
	schemaVersion: typeof VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION;
	revision: number;
	generationId: string;
	authority: string;
	createdAt: string;
	normalSummary: string;
	cleanup: VisibleSessionCleanupState | null;
	projection: ProjectionReservation | null;
}

export interface VisibleSessionStateRuntime {
	summary: string;
	status: string;
	updatedAt: string;
}

export interface VisibleSessionPromptAccepted {
	acceptedAt: string;
	summary: string;
}

export interface VisibleSessionTerminalRecord {
	schemaVersion: typeof VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION;
	generationId: string;
	committedAt: string;
	ownerExitReason: string;
	severity: "info" | "warning" | "error";
	runtimeSummary: string;
	worktreeSummary: string;
	evidenceSummary: string;
}

export interface VisibleSessionVanishedRecord {
	schemaVersion: typeof VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION;
	generationId: string;
	committedAt: string;
	reason: string;
	evidenceSummary: string;
}

export interface VisibleSessionWrite {
	expectedRevision: number;
}

export interface VisibleSessionAppendInput extends VisibleSessionWrite {
	entry: string;
	capBytes?: number;
}

export interface VisibleSessionTerminalCommit extends VisibleSessionWrite {
	record: VisibleSessionTerminalRecord;
}

export interface VisibleSessionVanishedCommit extends VisibleSessionWrite {
	record: VisibleSessionVanishedRecord;
}
export interface VisibleSessionProjectedTerminalCommit extends VisibleSessionWrite {
	record: VisibleSessionProjectedFinalRecord;
}
export interface VisibleSessionProjectedVanishedCommit extends VisibleSessionWrite {
	record: VisibleSessionProjectedVanishedRecord;
}

export interface VisibleSessionPostCommitCleanup {
	kind: "cleanup-private-token";
	generationId: string;
	leaseId: string;
}

export interface VisibleSessionCleanupState {
	receipt: VisibleSessionPostCommitCleanup;
	status: "pending" | "claimed" | "acknowledged";
	claimant: string | null;
}

export interface VisibleSessionCommitReceipt {
	revision: number;
	idempotent: boolean;
	cleanup: VisibleSessionPostCommitCleanup;
}
interface TerminalJournal {
	kind: "final" | "vanished";
	record: VisibleSessionTerminalRecord | VisibleSessionVanishedRecord;
	revision: number;
	cleanup: VisibleSessionPostCommitCleanup;
	projection: ProjectionReservation | null;
}
export type ProjectionTarget = "metadata" | "runtime" | "prompt" | "pane" | "events" | "final" | "vanished";
export type ProjectionFiles = Record<ProjectionTarget, string | null>;

interface RedactionPublicationJournal {
	redactions: readonly string[];
	pane: string;
	events: string;
	generationId: string;
	authority: string;
}

type LegacyMutationTarget = "runtime" | "prompt" | "pane" | "events";

interface LegacyMutationJournal {
	target: LegacyMutationTarget;
	content: string;
	expectedRevision: number;
	metadata: VisibleSessionStateMetadata;
	generationId: string;
	authority: string;
	operationDigest: string;
}

interface ProjectionJournal {
	target: ProjectionTarget;
	content: string;
	privateContent: string;
	privateDigest: string;
	expectedRevision: number;
	committedRevision: number | null;
	generationId: string;
	authority: string;
	files: ProjectionFiles | null;
	operationId: string;
	digest: string;
}
export interface VisibleSessionPublicationManifest {
	schemaVersion: typeof VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
	epoch: number;
	generationId: string;
	owner: { pid: number; startedAt: string };
	files: ProjectionFiles;
}
function pathContains(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function visibleSessionStatePaths(root: string): VisibleSessionStatePaths {
	return {
		root,
		metadata: path.join(root, "metadata.json"),
		events: path.join(root, "events.log"),
		pane: path.join(root, "pane.log"),
		runtimeState: path.join(root, "runtime-state.json"),
		promptAccepted: path.join(root, "prompt-accepted.json"),
		final: path.join(root, "final.json"),
		vanished: path.join(root, "vanished.json"),
		journal: path.join(root, ".terminal-journal.json"),
		projectionJournal: path.join(root, ".projection-journal.json"),
		projectionLock: path.join(root, ".projection"),
		publication: path.join(root, ".publication.json"),
		redactionJournal: path.join(root, ".redaction-publication.json"),
		redactionRebaseJournal: path.join(root, ".redaction-rebase.json"),
		mutationJournal: path.join(root, ".mutation-journal.json"),
		redactionState: path.join(root, ".log-redactions.json"),
		lock: path.join(root, ".state"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validText(value: unknown): value is string {
	return (
		typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_PUBLIC_TEXT_BYTES
	);
}
function validatedLogRedactions(redactions: readonly unknown[]): readonly string[] {
	if (redactions.some(redaction => typeof redaction !== "string" || redaction.includes("\0")))
		throw new Error("Visible session redaction update is invalid");
	const unique = [
		...new Set(redactions.filter((redaction): redaction is string => typeof redaction === "string")),
	].filter(redaction => redaction.length > 0);
	if (
		unique.length > MAX_REDACTION_UPDATE_SECRETS ||
		unique.reduce((bytes, redaction) => bytes + Buffer.byteLength(redaction, "utf8"), 0) > MAX_REDACTION_UPDATE_BYTES
	)
		throw new Error("Visible session redaction update is invalid");
	return unique;
}
export function redactVisibleSessionText(value: string, redactions: readonly string[]): string {
	let result = value;
	const secrets = redactions.filter(secret => secret.length > 0);
	for (const secret of secrets) result = result.split(secret).join("[redacted]");
	return secrets.some(secret => result.includes(secret)) ? "" : result;
}

function overlapsPublicGeneration(generationId: string, privateIdentity: string): boolean {
	return privateIdentity.length > 0 && generationId.includes(privateIdentity);
}

function validReceipt(value: unknown): value is VisibleSessionPostCommitCleanup {
	return (
		isRecord(value) &&
		exactKeys(value, ["kind", "generationId", "leaseId"]) &&
		value.kind === "cleanup-private-token" &&
		validText(value.generationId) &&
		validText(value.leaseId)
	);
}

function validCleanup(value: unknown): value is VisibleSessionCleanupState {
	return (
		isRecord(value) &&
		exactKeys(value, ["receipt", "status", "claimant"]) &&
		validReceipt(value.receipt) &&
		(value.status === "pending" || value.status === "claimed" || value.status === "acknowledged") &&
		(value.claimant === null || validText(value.claimant))
	);
}
function validProjectionReservation(value: unknown): value is ProjectionReservation {
	return (
		isRecord(value) &&
		exactKeys(value, ["operationId", "target", "digest", "expectedRevision", "committedRevision", "state"]) &&
		validText(value.operationId) &&
		["metadata", "runtime", "prompt", "pane", "events", "final", "vanished"].includes(value.target as string) &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.digest) &&
		typeof value.expectedRevision === "number" &&
		Number.isSafeInteger(value.expectedRevision) &&
		value.expectedRevision >= 0 &&
		(value.committedRevision === null ||
			(typeof value.committedRevision === "number" &&
				Number.isSafeInteger(value.committedRevision) &&
				value.committedRevision === value.expectedRevision + 1)) &&
		(value.state === "prepared" || value.state === "committed") &&
		(value.state === "prepared") === (value.committedRevision === null)
	);
}

function validMetadata(value: unknown): value is VisibleSessionStateMetadata {
	return (
		isRecord(value) &&
		(exactKeys(value, [
			"schemaVersion",
			"revision",
			"generationId",
			"authority",
			"createdAt",
			"normalSummary",
			"cleanup",
		]) ||
			exactKeys(value, [
				"schemaVersion",
				"revision",
				"generationId",
				"authority",
				"createdAt",
				"normalSummary",
				"cleanup",
				"projection",
			])) &&
		value.schemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION &&
		typeof value.revision === "number" &&
		Number.isSafeInteger(value.revision) &&
		value.revision >= 0 &&
		validText(value.generationId) &&
		validText(value.authority) &&
		validText(value.createdAt) &&
		validText(value.normalSummary) &&
		(value.cleanup === null || validCleanup(value.cleanup)) &&
		(value.projection === undefined || value.projection === null || validProjectionReservation(value.projection))
	);
}

function sameJson(left: object, right: object): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function authorityFingerprint(identity: VisibleSessionRoleIdentity): string {
	return createHash("sha256")
		.update(`${identity.leaseId}\0${identity.owner.pid}\0${identity.owner.startIdentity}`)
		.digest("hex");
}

function terminalCleanup(identity: VisibleSessionRoleIdentity): VisibleSessionPostCommitCleanup {
	return {
		kind: "cleanup-private-token",
		generationId: identity.generationId,
		leaseId: authorityFingerprint(identity),
	};
}

function stableJson(value: object): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}
function boundedStableJson(value: object, maximumBytes: number, message: string): string {
	const serialized = stableJson(value);
	if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw new Error(message);
	return serialized;
}
function assertSerializedRedactionState(
	redactions: readonly string[],
	identity: VisibleSessionRoleIdentity,
	message: string,
): void {
	boundedStableJson(
		{
			redactions,
			generationId: identity.generationId,
			authority: authorityFingerprint(identity),
		},
		MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
		message,
	);
}

function trimUtf8Tail(content: Buffer, limit: number): Buffer {
	let start = Math.max(0, content.length - limit);
	while (start < content.length && (content[start] & 0xc0) === 0x80) start += 1;
	return content.subarray(start);
}
function trimUtf8Prefix(content: Buffer, limit: number): Buffer {
	let end = Math.min(content.length, limit);
	let lead = end - 1;
	while (lead >= 0 && (content[lead] & 0xc0) === 0x80) lead -= 1;
	if (lead >= 0) {
		const byte = content[lead];
		const length =
			byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
		if (lead + length > end) end = lead;
	}
	return content.subarray(0, end);
}
function markerIsSafe(marker: string, secrets: readonly string[]): boolean {
	return secrets.every(secret => {
		if (secret.length === 0 || secret.includes(marker) || marker.includes(secret)) return false;
		for (let length = 1; length < Math.min(marker.length, secret.length); length += 1) {
			if (marker.endsWith(secret.slice(0, length)) || secret.endsWith(marker.slice(0, length))) return false;
		}
		return true;
	});
}
function safeLogMarker(secrets: readonly string[]): Buffer {
	if (markerIsSafe(PUBLIC_LOG_TRUNCATION_MARKER, secrets)) return Buffer.from(PUBLIC_LOG_TRUNCATION_MARKER, "utf8");
	for (
		let codePoint = REDACTION_MARKER_SEARCH_START;
		codePoint < REDACTION_MARKER_SEARCH_START + REDACTION_MARKER_SEARCH_LENGTH;
		codePoint += 1
	) {
		const marker = String.fromCodePoint(codePoint);
		if (markerIsSafe(marker, secrets)) return Buffer.from(marker, "utf8");
	}
	throw new Error("Visible session log truncation marker is unsafe");
}
export function appendVisibleSessionLog(
	previous: Buffer,
	entry: Buffer,
	cap: number,
	redactions: readonly string[] = [],
): Buffer {
	const secrets = redactions.filter(secret => secret.length > 0);
	const candidate = Buffer.from(
		redactVisibleSessionText(Buffer.concat([previous, entry]).toString("utf8"), secrets),
		"utf8",
	);
	if (candidate.length <= cap) return candidate;
	const marker = safeLogMarker(secrets);
	const output = Buffer.concat([marker, trimUtf8Tail(candidate, cap - marker.length)]);
	if (secrets.some(secret => output.includes(secret))) throw new Error("Visible session log redaction is unsafe");
	return output;
}
const WINDOWS_RENAME_RETRY_ATTEMPTS = 5;
const WINDOWS_RENAME_RETRY_DELAY_MS = 25;

function isTransientWindowsRenameError(error: unknown): boolean {
	return isRecord(error) && process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES");
}

async function renameWithWindowsSharingRetry(temporary: string, file: string): Promise<void> {
	for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await fs.rename(temporary, file);
			return;
		} catch (error) {
			if (!isTransientWindowsRenameError(error) || attempt === WINDOWS_RENAME_RETRY_ATTEMPTS - 1) throw error;
			await Bun.sleep(WINDOWS_RENAME_RETRY_DELAY_MS);
		}
	}
}

async function syncParentDirectory(directory: string): Promise<void> {
	// Windows does not expose directory handles that Node can fsync. Rename is the
	// platform's strongest available replacement guarantee, so do not mask it.
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
	} finally {
		await handle.close();
	}
}

async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.${path.basename(file)}-${process.pid}-${randomUUID()}.tmp`);
	try {
		const handle = await fs.open(temporary, "wx");
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await renameWithWindowsSharingRetry(temporary, file);
		await syncParentDirectory(directory);
	} catch (primary) {
		try {
			await fs.rm(temporary, { force: true });
		} catch (cleanup) {
			throw new AggregateError([primary, cleanup], "Visible session atomic write and cleanup failed");
		}
		throw primary;
	}
}
export class VisibleSessionPublicFileChangedError extends Error {
	constructor() {
		super("Visible session public file changed during read");
		this.name = "VisibleSessionPublicFileChangedError";
	}
}

export async function readVisibleSessionPublicFile(file: string): Promise<Buffer> {
	return readVisibleSessionBoundedFile(file, MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES);
}
export async function readVisibleSessionBoundedFile(file: string, maximumBytes: number): Promise<Buffer> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
		throw new Error("Visible session file bound is invalid");
	const before = await fs.lstat(file);
	if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes)
		throw new Error("Visible session public file is invalid");
	const handle = await fs.open(file, "r");
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size > maximumBytes) throw new Error("Visible session public file is invalid");
		if (opened.size !== before.size || (before.ino !== 0 && opened.ino !== before.ino))
			throw new VisibleSessionPublicFileChangedError();
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead === 0) throw new VisibleSessionPublicFileChangedError();
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (!after.isFile() || after.size !== opened.size || (opened.ino !== 0 && after.ino !== opened.ino))
			throw new VisibleSessionPublicFileChangedError();
		return bytes;
	} finally {
		await handle.close();
	}
}

class VisibleSessionStateCore {
	readonly #paths: VisibleSessionStatePaths;
	readonly #identity: VisibleSessionRoleIdentity;
	#redactions: readonly string[];
	#logRedactions: readonly string[];

	constructor(root: string, identity: VisibleSessionRoleIdentity) {
		if (
			!validText(identity.generationId) ||
			!validText(identity.leaseId) ||
			!Number.isSafeInteger(identity.owner.pid) ||
			identity.owner.pid <= 0 ||
			!validText(identity.owner.startIdentity)
		)
			throw new Error("Visible session authority requires an exact private identity");
		if (
			[identity.leaseId, identity.owner.startIdentity].some(privateIdentity =>
				overlapsPublicGeneration(identity.generationId, privateIdentity),
			)
		)
			throw new Error("Visible session private identity overlaps the public generation ID");
		this.#paths = visibleSessionStatePaths(root);
		this.#identity = {
			generationId: identity.generationId,
			leaseId: identity.leaseId,
			owner: { pid: identity.owner.pid, startIdentity: identity.owner.startIdentity },
			redactions: [...identity.redactions],
		};
		this.#redactions = validatedLogRedactions([
			...identity.redactions,
			identity.leaseId,
			identity.owner.startIdentity,
		]);
		this.#logRedactions = validatedLogRedactions([...this.#redactions, ...(identity.logRedactions ?? [])]);
		this.#assertRedactionStateFits(this.#logRedactions);
	}

	get paths(): VisibleSessionStatePaths {
		return this.#paths;
	}
	get generationId(): string {
		return this.#identity.generationId;
	}
	async addRedactions(redactions: readonly string[]): Promise<void> {
		this.#validateRedactions(redactions);
		await withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			const metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			const next = this.#mergeLogRedactions(redactions);
			if (sameJson({ redactions: next }, { redactions: this.#logRedactions })) return;
			await this.#assertNoTerminal();
			const pane = appendVisibleSessionLog(
				await this.#readBytes(this.#paths.pane),
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				next,
			);
			const events = appendVisibleSessionLog(
				await this.#readBytes(this.#paths.events),
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				next,
			);
			await this.#writeRedactionRebaseJournal(next, pane, events);
			await this.#reconcileRedactionRebase();
		});
	}
	#validateRedactions(redactions: readonly string[]): void {
		if (
			redactions.length > MAX_REDACTION_UPDATE_SECRETS ||
			redactions.reduce(
				(bytes, secret) => bytes + (typeof secret === "string" ? Buffer.byteLength(secret, "utf8") : 0),
				0,
			) > MAX_REDACTION_UPDATE_BYTES
		)
			throw new Error("Visible session redaction update is invalid");
		validatedLogRedactions(redactions);
	}
	#assertRedactionStateFits(redactions: readonly string[]): void {
		assertSerializedRedactionState(redactions, this.#identity, "Visible session redaction update is invalid");
	}
	#mergeLogRedactions(redactions: readonly string[]): readonly string[] {
		const next = validatedLogRedactions([...this.#logRedactions, ...redactions]);
		this.#assertRedactionStateFits(next);
		return next;
	}

	async initialize(): Promise<VisibleSessionStateMetadata> {
		await fs.mkdir(this.#paths.root, { recursive: true });
		return withFileLock(this.#paths.lock, async () => {
			let metadata: VisibleSessionStateMetadata;
			try {
				metadata = await this.#readMetadata();
				if (
					metadata.generationId !== this.#identity.generationId ||
					metadata.authority !== authorityFingerprint(this.#identity)
				)
					throw new Error("Visible session state authority mismatch");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				metadata = {
					schemaVersion: VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
					revision: 0,
					generationId: this.#identity.generationId,
					authority: authorityFingerprint(this.#identity),
					createdAt: new Date().toISOString(),
					normalSummary: "",
					cleanup: null,
					projection: null,
				};
				await this.#atomicWrite(this.#paths.metadata, stableJson(metadata));
			}
			await this.#recoverPending();
			const durableRedactions = await this.#readDurableLogRedactions();
			if (durableRedactions) {
				const next = this.#mergeLogRedactions(durableRedactions);
				if (sameJson({ redactions: next }, { redactions: durableRedactions })) this.#logRedactions = next;
				else {
					const pane = appendVisibleSessionLog(
						await this.#readBytes(this.#paths.pane),
						Buffer.alloc(0),
						DEFAULT_PUBLIC_LOG_CAP_BYTES,
						next,
					);
					const events = appendVisibleSessionLog(
						await this.#readBytes(this.#paths.events),
						Buffer.alloc(0),
						DEFAULT_PUBLIC_LOG_CAP_BYTES,
						next,
					);
					await this.#writeRedactionRebaseJournal(next, pane, events);
					await this.#reconcileRedactionRebase();
				}
			}
			const paneBeforeRebase = await this.#readBytes(this.#paths.pane);
			const eventsBeforeRebase = await this.#readBytes(this.#paths.events);
			const paneAfterRebase = appendVisibleSessionLog(
				paneBeforeRebase,
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				this.#logRedactions,
			);
			const eventsAfterRebase = appendVisibleSessionLog(
				eventsBeforeRebase,
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				this.#logRedactions,
			);
			if (!paneBeforeRebase.equals(paneAfterRebase) || !eventsBeforeRebase.equals(eventsAfterRebase)) {
				await this.#writeRedactionRebaseJournal(this.#logRedactions, paneAfterRebase, eventsAfterRebase);
				await this.#reconcileRedactionRebase();
			}
			return this.#readMetadata();
		});
	}

	async readMetadata(): Promise<VisibleSessionStateMetadata> {
		return this.#readMetadata();
	}
	async readTerminal(): Promise<VisibleSessionTerminalRecord | VisibleSessionVanishedRecord | null> {
		const final = await this.#readRecordIfPresent(this.#paths.final);
		const vanished = await this.#readRecordIfPresent(this.#paths.vanished);
		if (final && vanished) throw new Error("Visible session terminal state is corrupt");
		if (final) return this.#final(final, false);
		if (vanished) return this.#vanished(vanished, false);
		return null;
	}
	async hasPromptAccepted(): Promise<boolean> {
		const metadata = await this.#readMetadata();
		this.#assertAuthority(metadata);
		try {
			const value = await this.#readJson(this.#paths.promptAccepted);
			if (
				!isRecord(value) ||
				!exactKeys(value, ["acceptedAt", "summary"]) ||
				!validText(value.acceptedAt) ||
				!validText(value.summary)
			)
				throw new Error("Visible session private prompt receipt is corrupt");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	async hasTerminalOutcome(): Promise<boolean> {
		return (await this.#readJournal()) !== null || (await this.readTerminal()) !== null;
	}

	async normal(
		input: VisibleSessionWrite,
		summary: string,
		projection: ProjectionReservation | null = null,
	): Promise<number> {
		return withFileLock(this.#paths.lock, async () => {
			const metadata = await this.#assertWrite(input);
			if (projection) this.#assertProjection(metadata, projection);
			await this.#assertNoTerminal();
			const next = {
				...metadata,
				revision: metadata.revision + 1,
				normalSummary: this.#text(summary),
				projection: projection
					? { ...projection, state: "committed" as const, committedRevision: metadata.revision + 1 }
					: metadata.projection,
			};
			await this.#atomicWrite(this.#paths.metadata, stableJson(next));
			return next.revision;
		});
	}
	async runtime(
		input: VisibleSessionWrite,
		runtime: VisibleSessionStateRuntime,
		projection: ProjectionReservation | null = null,
	): Promise<number> {
		return this.#writeRecord(
			input,
			this.#paths.runtimeState,
			{
				summary: this.#text(runtime.summary),
				status: this.#text(runtime.status),
				updatedAt: this.#text(runtime.updatedAt),
			},
			projection,
		);
	}
	async promptAccepted(
		input: VisibleSessionWrite,
		prompt: VisibleSessionPromptAccepted,
		projection: ProjectionReservation | null = null,
	): Promise<number> {
		return this.#writeRecord(
			input,
			this.#paths.promptAccepted,
			{
				acceptedAt: this.#text(prompt.acceptedAt),
				summary: this.#text(prompt.summary),
			},
			projection,
		);
	}
	async append(
		input: VisibleSessionAppendInput,
		file: string,
		lineDelimited: boolean,
		projection: ProjectionReservation | null = null,
	): Promise<number> {
		const cap = input.capBytes ?? DEFAULT_PUBLIC_LOG_CAP_BYTES;
		if (
			!Number.isSafeInteger(cap) ||
			cap < Buffer.byteLength(PUBLIC_LOG_TRUNCATION_MARKER, "utf8") ||
			cap > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
		)
			throw new Error("Visible session log cap is invalid");
		const entry = this.#text(input.entry);
		const target = this.#mutationTarget(file);
		const operationDigest = this.#mutationDigest({ target, lineDelimited, cap, entry });
		return withFileLock(this.#paths.lock, async () => {
			const recovered = await this.#recoverPending(input.expectedRevision, target, operationDigest);
			if (recovered !== null) return recovered;
			const metadata = await this.#assertWrite(input);
			if (projection) this.#assertProjection(metadata, projection);
			await this.#assertNoTerminal();
			if (!lineDelimited && entry.length === 0) return metadata.revision;
			const appended = Buffer.from(lineDelimited ? `${entry}\n` : entry, "utf8");
			const content = appendVisibleSessionLog(await this.#readBytes(file), appended, cap, this.#logRedactions);
			return this.#commitMutation(target, content, metadata, projection, operationDigest);
		});
	}
	async reserveProjection(
		expectedRevision: number,
		target: ProjectionTarget,
		digest: string,
		operationId: string,
	): Promise<ProjectionReservation> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			const metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			if (metadata.projection) {
				if (
					metadata.projection.operationId !== operationId ||
					metadata.projection.target !== target ||
					metadata.projection.digest !== digest ||
					metadata.projection.expectedRevision !== expectedRevision
				)
					throw new Error("Visible session projection operation is already reserved");
				return metadata.projection;
			}
			if (metadata.revision !== expectedRevision) throw new Error("Visible session state revision mismatch");
			const projection: ProjectionReservation = {
				operationId,
				target,
				digest,
				expectedRevision,
				committedRevision: null,
				state: "prepared",
			};
			await this.#writeMetadata({ ...metadata, projection });
			return projection;
		});
	}

	async clearProjection(projection: ProjectionReservation): Promise<void> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			const metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			if (metadata.projection === null) return;
			if (!sameJson(metadata.projection, projection))
				throw new Error("Visible session projection reservation mismatch");
			if (metadata.projection.state !== "prepared")
				throw new Error("Visible session projection reservation is already committed");
			await this.#writeMetadata({ ...metadata, projection: null });
		});
	}
	async clearCommittedNonterminalProjection(projection: ProjectionReservation): Promise<void> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			const metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			if (
				metadata.projection?.state !== "committed" ||
				metadata.projection.target === "final" ||
				metadata.projection.target === "vanished" ||
				metadata.projection.operationId !== projection.operationId ||
				metadata.projection.target !== projection.target ||
				metadata.projection.digest !== projection.digest ||
				metadata.projection.expectedRevision !== projection.expectedRevision ||
				metadata.projection.committedRevision !== projection.committedRevision
			)
				throw new Error("Visible session projection committed receipt mismatch");
			await this.#writeMetadata({ ...metadata, projection: null });
		});
	}
	async clearPreparedProjection(): Promise<void> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			const metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			if (metadata.projection?.state !== "prepared") return;
			await this.#writeMetadata({ ...metadata, projection: null });
		});
	}
	async recoverProjectedMutation(
		projection: ProjectionReservation,
		target: ProjectionTarget,
		privateContent: Buffer,
	): Promise<number> {
		return withFileLock(this.#paths.lock, async () => {
			if (target === "final" || target === "vanished")
				throw new Error("Visible session terminal projection requires terminal journal reconciliation");
			await this.#recoverPending();
			const metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			if (metadata.revision === projection.expectedRevision + 1) {
				if (
					metadata.projection?.state !== "committed" ||
					metadata.projection.operationId !== projection.operationId ||
					metadata.projection.target !== projection.target ||
					metadata.projection.digest !== projection.digest ||
					metadata.projection.expectedRevision !== projection.expectedRevision ||
					metadata.projection.committedRevision !== metadata.revision
				)
					throw new Error("Visible session projection commit receipt is corrupt");
				if (target !== "metadata") {
					const destination = this.#mutationPath(target);
					if (!(await this.#readBytes(destination)).equals(privateContent))
						throw new Error("Visible session projected mutation private bytes are corrupt");
				}
				return metadata.revision;
			}
			if (metadata.revision !== projection.expectedRevision)
				throw new Error("Visible session state revision mismatch");
			this.#assertProjection(metadata, projection);
			await this.#assertNoTerminal();
			if (target === "metadata") {
				const next = {
					...metadata,
					revision: metadata.revision + 1,
					normalSummary: this.#text(privateContent.toString("utf8")),
					projection: {
						...projection,
						state: "committed" as const,
						committedRevision: metadata.revision + 1,
					},
				};
				await this.#writeMetadata(next);
				return next.revision;
			}
			const operationDigest = this.#mutationDigest({ target, content: privateContent.toString("base64") });
			return this.#commitMutation(target, privateContent, metadata, projection, operationDigest);
		});
	}

	async terminal(
		input: VisibleSessionTerminalCommit | VisibleSessionVanishedCommit,
		target: string,
		other: string,
		kind: "final" | "vanished",
		projection: ProjectionReservation | null = null,
	): Promise<VisibleSessionCommitReceipt> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			const metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			const record =
				"ownerExitReason" in input.record ? this.#final(input.record, false) : this.#vanished(input.record, false);
			if ((kind === "final") !== "ownerExitReason" in input.record)
				throw new Error("Visible session terminal kind is invalid");
			if (
				projection &&
				(!metadata.projection ||
					!sameJson(metadata.projection, projection) ||
					(metadata.projection.state !== "prepared" && metadata.projection.state !== "committed"))
			)
				throw new Error("Visible session projection reservation mismatch");
			const pending = await this.#readJournal();
			if (pending) {
				if (pending.kind !== kind) throw new Error("Visible session terminal outcome already committed");
				if (!sameJson(pending.record, record)) throw new Error("Visible session terminal record is immutable");
				return this.#reconcile(pending);
			}
			const otherRecord = await this.#readRecordIfPresent(other);
			if (otherRecord) throw new Error("Visible session terminal outcome already committed");
			const existing = await this.#readRecordIfPresent(target);
			if (existing) {
				const persisted = kind === "final" ? this.#final(record, true) : this.#vanished(record, true);
				if (!sameJson(existing, persisted)) throw new Error("Visible session terminal record is immutable");
				if (!metadata.cleanup) throw new Error("Visible session terminal cleanup is corrupt");
				this.#assertCleanupAuthority(metadata.cleanup);
				return { revision: metadata.revision, idempotent: true, cleanup: metadata.cleanup.receipt };
			}
			if (metadata.revision !== input.expectedRevision) throw new Error("Visible session state revision mismatch");
			const journal = {
				kind,
				record,
				revision: metadata.revision + 1,
				cleanup: terminalCleanup(this.#identity),
				projection,
			};
			await this.#atomicWrite(this.#paths.journal, stableJson(journal));
			return this.#reconcile(journal);
		});
	}

	async claimCleanup(claimant: string): Promise<VisibleSessionPostCommitCleanup | null> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			let metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			const pending = await this.#readJournal();
			if (pending) {
				await this.#reconcile(pending);
				metadata = await this.#readMetadata();
				this.#assertAuthority(metadata);
			}
			const cleanup = await this.#cleanupState(metadata);
			if (!cleanup || cleanup.status === "acknowledged") return null;
			const exactClaimant = this.#claimant(claimant);
			if (cleanup.status === "claimed" && cleanup.claimant !== exactClaimant)
				throw new Error("Visible session cleanup already claimed");
			if (cleanup.status === "pending")
				await this.#writeMetadata({
					...metadata,
					revision: metadata.revision + 1,
					cleanup: { ...cleanup, status: "claimed", claimant: exactClaimant },
				});
			return cleanup.receipt;
		});
	}
	async ackCleanup(claimant: string): Promise<void> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			let metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			const pending = await this.#readJournal();
			if (pending) {
				await this.#reconcile(pending);
				metadata = await this.#readMetadata();
				this.#assertAuthority(metadata);
			}
			const cleanup = await this.#cleanupState(metadata);
			if (!cleanup || cleanup.status === "acknowledged") return;
			const exactClaimant = this.#claimant(claimant);
			if (cleanup.status !== "claimed" || cleanup.claimant !== exactClaimant)
				throw new Error("Visible session cleanup claim mismatch");
			await this.#writeMetadata({
				...metadata,
				revision: metadata.revision + 1,
				cleanup: { ...cleanup, status: "acknowledged" },
			});
		});
	}
	async revokeCleanup(claimant: string): Promise<void> {
		return withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
			let metadata = await this.#readMetadata();
			this.#assertAuthority(metadata);
			const pending = await this.#readJournal();
			if (pending) {
				await this.#reconcile(pending);
				metadata = await this.#readMetadata();
				this.#assertAuthority(metadata);
			}
			const cleanup = await this.#cleanupState(metadata);
			if (!cleanup || cleanup.status === "acknowledged") return;
			const exactClaimant = this.#claimant(claimant);
			if (cleanup.status !== "claimed" || cleanup.claimant !== exactClaimant)
				throw new Error("Visible session cleanup claim mismatch");
			await this.#writeMetadata({
				...metadata,
				revision: metadata.revision + 1,
				cleanup: { ...cleanup, status: "pending", claimant: null },
			});
		});
	}

	async #reconcile(journal: TerminalJournal): Promise<VisibleSessionCommitReceipt> {
		const target = journal.kind === "final" ? this.#paths.final : this.#paths.vanished;
		const other = journal.kind === "final" ? this.#paths.vanished : this.#paths.final;
		const otherRecord = await this.#readRecordIfPresent(other);
		if (otherRecord) throw new Error("Visible session terminal outcome already committed");
		const existing = await this.#readRecordIfPresent(target);
		const published =
			journal.kind === "final" ? this.#final(journal.record, true) : this.#vanished(journal.record, true);
		if (existing && !sameJson(existing, published))
			throw new Error("Visible session terminal journal conflicts with published record");
		if (!existing) await this.#atomicWrite(target, stableJson(published));
		const current = await this.#readMetadata();
		this.#assertAuthority(current);
		if (current.revision < journal.revision)
			await this.#writeMetadata({
				...current,
				revision: journal.revision,
				cleanup: { receipt: journal.cleanup, status: "pending", claimant: null },
				projection: journal.projection
					? { ...journal.projection, state: "committed", committedRevision: journal.revision }
					: current.projection,
			});
		else if (
			!current.cleanup ||
			!sameJson(current.cleanup.receipt, journal.cleanup) ||
			(journal.projection !== null &&
				!sameJson(current.projection ?? {}, {
					...journal.projection,
					state: "committed",
					committedRevision: journal.revision,
				}))
		)
			throw new Error("Visible session terminal metadata is corrupt");
		await fs.rm(this.#paths.journal, { force: true });
		return { revision: journal.revision, idempotent: false, cleanup: journal.cleanup };
	}
	async #writeRecord(
		input: VisibleSessionWrite,
		file: string,
		value: object,
		projection: ProjectionReservation | null = null,
	): Promise<number> {
		const target = this.#mutationTarget(file);
		const content = Buffer.from(stableJson(value), "utf8");
		const operationDigest = this.#mutationDigest({ target, content: content.toString("base64") });
		return withFileLock(this.#paths.lock, async () => {
			const recovered = await this.#recoverPending(input.expectedRevision, target, operationDigest);
			if (recovered !== null) return recovered;
			const metadata = await this.#assertWrite(input);
			if (projection) this.#assertProjection(metadata, projection);
			await this.#assertNoTerminal();
			return this.#commitMutation(target, content, metadata, projection, operationDigest);
		});
	}
	async #assertWrite(input: VisibleSessionWrite): Promise<VisibleSessionStateMetadata> {
		await this.#recoverPending();
		const metadata = await this.#readMetadata();
		this.#assertAuthority(metadata);
		if (metadata.revision !== input.expectedRevision) throw new Error("Visible session state revision mismatch");
		return metadata;
	}
	#assertProjection(metadata: VisibleSessionStateMetadata, projection: ProjectionReservation): void {
		if (
			metadata.projection?.state !== "prepared" ||
			metadata.projection.operationId !== projection.operationId ||
			metadata.projection.target !== projection.target ||
			metadata.projection.digest !== projection.digest ||
			metadata.projection.expectedRevision !== projection.expectedRevision ||
			metadata.projection.committedRevision !== null
		)
			throw new Error("Visible session projection reservation mismatch");
	}
	#assertAuthority(metadata: VisibleSessionStateMetadata): void {
		if (
			metadata.generationId !== this.#identity.generationId ||
			metadata.authority !== authorityFingerprint(this.#identity)
		)
			throw new Error("Visible session authority mismatch");
	}
	#assertCleanupAuthority(cleanup: VisibleSessionCleanupState): void {
		if (
			cleanup.receipt.generationId !== this.#identity.generationId ||
			cleanup.receipt.leaseId !== authorityFingerprint(this.#identity)
		)
			throw new Error("Visible session cleanup authority mismatch");
	}
	async #cleanupState(metadata: VisibleSessionStateMetadata): Promise<VisibleSessionCleanupState | null> {
		if (metadata.cleanup === null) {
			if (await this.hasTerminalOutcome()) throw new Error("Visible session terminal cleanup is corrupt");
			return null;
		}
		this.#assertCleanupAuthority(metadata.cleanup);
		return metadata.cleanup;
	}
	async #assertNoTerminal(): Promise<void> {
		if (
			(await this.#readJournal()) ||
			(await this.#readRecordIfPresent(this.#paths.final)) ||
			(await this.#readRecordIfPresent(this.#paths.vanished))
		)
			throw new Error("Visible session terminal outcome already committed");
	}
	#final(value: unknown, redact: boolean): VisibleSessionTerminalRecord {
		if (
			!isRecord(value) ||
			!exactKeys(value, [
				"schemaVersion",
				"generationId",
				"committedAt",
				"ownerExitReason",
				"severity",
				"runtimeSummary",
				"worktreeSummary",
				"evidenceSummary",
			]) ||
			value.schemaVersion !== VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION ||
			value.generationId !== this.#identity.generationId ||
			(value.severity !== "info" && value.severity !== "warning" && value.severity !== "error") ||
			!validText(value.committedAt) ||
			!validText(value.ownerExitReason) ||
			!validText(value.runtimeSummary) ||
			!validText(value.worktreeSummary) ||
			!validText(value.evidenceSummary)
		)
			throw new Error("Visible session terminal record is invalid");
		return {
			schemaVersion: value.schemaVersion,
			generationId: value.generationId,
			committedAt: redact ? this.#text(value.committedAt) : value.committedAt,
			ownerExitReason: redact ? this.#text(value.ownerExitReason) : value.ownerExitReason,
			severity: value.severity,
			runtimeSummary: redact ? this.#text(value.runtimeSummary) : value.runtimeSummary,
			worktreeSummary: redact ? this.#text(value.worktreeSummary) : value.worktreeSummary,
			evidenceSummary: redact ? this.#text(value.evidenceSummary) : value.evidenceSummary,
		};
	}
	#vanished(value: unknown, redact: boolean): VisibleSessionVanishedRecord {
		if (
			!isRecord(value) ||
			!exactKeys(value, ["schemaVersion", "generationId", "committedAt", "reason", "evidenceSummary"]) ||
			value.schemaVersion !== VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION ||
			value.generationId !== this.#identity.generationId ||
			!validText(value.committedAt) ||
			!validText(value.reason) ||
			!validText(value.evidenceSummary)
		)
			throw new Error("Visible session terminal record is invalid");
		return {
			schemaVersion: value.schemaVersion,
			generationId: value.generationId,
			committedAt: redact ? this.#text(value.committedAt) : value.committedAt,
			reason: redact ? this.#text(value.reason) : value.reason,
			evidenceSummary: redact ? this.#text(value.evidenceSummary) : value.evidenceSummary,
		};
	}
	#text(value: string): string {
		if (typeof value !== "string" || value.includes("\0")) throw new Error("Visible session public text is invalid");
		return trimUtf8Prefix(Buffer.from(this.#safe(value), "utf8"), MAX_PUBLIC_TEXT_BYTES).toString("utf8");
	}
	#claimant(value: string): string {
		if (!validText(value) || this.#safe(value) !== value)
			throw new Error("Visible session cleanup claimant is invalid");
		return value;
	}
	#safe(value: string): string {
		return redactVisibleSessionText(value, this.#redactions);
	}
	#mutationTarget(file: string): LegacyMutationTarget {
		if (file === this.#paths.runtimeState) return "runtime";
		if (file === this.#paths.promptAccepted) return "prompt";
		if (file === this.#paths.pane) return "pane";
		if (file === this.#paths.events) return "events";
		throw new Error("Visible session mutation target is invalid");
	}
	#mutationPath(target: LegacyMutationTarget): string {
		return {
			runtime: this.#paths.runtimeState,
			prompt: this.#paths.promptAccepted,
			pane: this.#paths.pane,
			events: this.#paths.events,
		}[target];
	}
	#mutationDigest(value: object): string {
		return createHash("sha256").update(stableJson(value)).digest("hex");
	}
	#nextMutationMetadata(
		metadata: VisibleSessionStateMetadata,
		projection: ProjectionReservation | null,
	): VisibleSessionStateMetadata {
		const revision = metadata.revision + 1;
		return {
			...metadata,
			revision,
			projection: projection
				? { ...projection, state: "committed" as const, committedRevision: revision }
				: metadata.projection,
		};
	}
	async #commitMutation(
		target: LegacyMutationTarget,
		content: Buffer,
		metadata: VisibleSessionStateMetadata,
		projection: ProjectionReservation | null,
		operationDigest: string,
	): Promise<number> {
		const journal: LegacyMutationJournal = {
			target,
			content: content.toString("base64"),
			expectedRevision: metadata.revision,
			metadata: this.#nextMutationMetadata(metadata, projection),
			generationId: this.#identity.generationId,
			authority: authorityFingerprint(this.#identity),
			operationDigest,
		};
		await this.#atomicWrite(
			this.#paths.mutationJournal,
			boundedStableJson(
				journal,
				MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 2,
				"Visible session mutation journal is too large",
			),
		);
		await this.#reconcileMutation(journal);
		return journal.metadata.revision;
	}
	async recover(): Promise<void> {
		await withFileLock(this.#paths.lock, async () => {
			await this.#recoverPending();
		});
	}
	async #recoverPending(
		expectedRevision?: number,
		target?: LegacyMutationTarget,
		operationDigest?: string,
	): Promise<number | null> {
		const recovered = await this.#recoverPendingMutation(expectedRevision, target, operationDigest);
		await this.#reconcileRedactionRebase();
		return recovered;
	}
	async #recoverPendingMutation(
		expectedRevision?: number,
		target?: LegacyMutationTarget,
		operationDigest?: string,
	): Promise<number | null> {
		const journal = await this.#readMutationJournal();
		if (!journal) return null;
		await this.#reconcileMutation(journal);
		return expectedRevision === journal.expectedRevision &&
			target === journal.target &&
			operationDigest === journal.operationDigest
			? journal.metadata.revision
			: null;
	}
	async #reconcileMutation(journal: LegacyMutationJournal): Promise<void> {
		const current = await this.#readMetadata();
		this.#assertAuthority(current);
		if (current.revision === journal.expectedRevision) {
			await this.#atomicWrite(this.#mutationPath(journal.target), Buffer.from(journal.content, "base64"));
			await this.#writeMetadata(journal.metadata);
		} else if (current.revision !== journal.metadata.revision || !sameJson(current, journal.metadata))
			throw new Error("Visible session mutation journal revision is corrupt");
		else await this.#atomicWrite(this.#mutationPath(journal.target), Buffer.from(journal.content, "base64"));
		await fs.rm(this.#paths.mutationJournal, { force: true });
	}
	async #writeRedactionRebaseJournal(redactions: readonly string[], pane: Buffer, events: Buffer): Promise<void> {
		this.#assertRedactionStateFits(redactions);
		await this.#atomicWrite(
			this.#paths.redactionRebaseJournal,
			boundedStableJson(
				{
					redactions,
					pane: pane.toString("base64"),
					events: events.toString("base64"),
					generationId: this.#identity.generationId,
					authority: authorityFingerprint(this.#identity),
				} satisfies RedactionPublicationJournal,
				MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 4,
				"Visible session redaction rebase journal is too large",
			),
		);
	}
	async #reconcileRedactionRebase(): Promise<void> {
		const journal = await this.#readRedactionRebaseJournal();
		if (!journal) return;
		const redactions = this.#mergeLogRedactions(journal.redactions);
		const pane = appendVisibleSessionLog(
			Buffer.from(journal.pane, "base64"),
			Buffer.alloc(0),
			DEFAULT_PUBLIC_LOG_CAP_BYTES,
			redactions,
		);
		const events = appendVisibleSessionLog(
			Buffer.from(journal.events, "base64"),
			Buffer.alloc(0),
			DEFAULT_PUBLIC_LOG_CAP_BYTES,
			redactions,
		);
		await this.#atomicWrite(
			this.#paths.redactionState,
			boundedStableJson(
				{
					redactions,
					generationId: this.#identity.generationId,
					authority: authorityFingerprint(this.#identity),
				},
				MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
				"Visible session durable redaction state is too large",
			),
		);
		await this.#atomicWrite(this.#paths.pane, pane);
		await this.#atomicWrite(this.#paths.events, events);
		this.#logRedactions = redactions;
		await fs.rm(this.#paths.redactionRebaseJournal, { force: true });
	}
	async #readMutationJournal(): Promise<LegacyMutationJournal | null> {
		try {
			const value = await this.#readJson(this.#paths.mutationJournal, MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 2);
			if (
				!isRecord(value) ||
				!exactKeys(value, [
					"target",
					"content",
					"expectedRevision",
					"metadata",
					"generationId",
					"authority",
					"operationDigest",
				]) ||
				!["runtime", "prompt", "pane", "events"].includes(value.target as string) ||
				typeof value.content !== "string" ||
				(value.content.length === 0 && value.target !== "pane" && value.target !== "events") ||
				Buffer.byteLength(value.content, "utf8") > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 2 ||
				typeof value.expectedRevision !== "number" ||
				!Number.isSafeInteger(value.expectedRevision) ||
				value.expectedRevision < 0 ||
				!validMetadata(value.metadata) ||
				value.metadata.revision !== value.expectedRevision + 1 ||
				value.metadata.generationId !== this.#identity.generationId ||
				value.metadata.authority !== authorityFingerprint(this.#identity) ||
				typeof value.generationId !== "string" ||
				typeof value.authority !== "string" ||
				value.generationId !== this.#identity.generationId ||
				value.authority !== authorityFingerprint(this.#identity) ||
				typeof value.operationDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(value.operationDigest)
			)
				throw new Error("Visible session mutation journal is corrupt");
			const content = Buffer.from(value.content, "base64");
			if (
				content.toString("base64") !== value.content ||
				(content.length === 0 && value.target !== "pane" && value.target !== "events") ||
				content.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
			)
				throw new Error("Visible session mutation journal is corrupt");
			return {
				target: value.target as LegacyMutationTarget,
				content: value.content,
				expectedRevision: value.expectedRevision,
				metadata: {
					...(value.metadata as VisibleSessionStateMetadata),
					projection: (value.metadata as VisibleSessionStateMetadata).projection ?? null,
				},
				generationId: value.generationId,
				authority: value.authority,
				operationDigest: value.operationDigest,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #readRedactionRebaseJournal(): Promise<RedactionPublicationJournal | null> {
		try {
			const value = await this.#readJson(
				this.#paths.redactionRebaseJournal,
				MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 4,
			);
			if (
				!isRecord(value) ||
				!exactKeys(value, ["redactions", "pane", "events", "generationId", "authority"]) ||
				!Array.isArray(value.redactions) ||
				typeof value.pane !== "string" ||
				typeof value.events !== "string" ||
				typeof value.generationId !== "string" ||
				typeof value.authority !== "string" ||
				value.generationId !== this.#identity.generationId ||
				value.authority !== authorityFingerprint(this.#identity)
			)
				throw new Error("Visible session redaction rebase journal is corrupt");
			const redactions = validatedLogRedactions(value.redactions as readonly unknown[]);
			if (!sameJson({ redactions }, { redactions: value.redactions }))
				throw new Error("Visible session redaction rebase journal is corrupt");
			this.#assertRedactionStateFits(redactions);
			const pane = Buffer.from(value.pane, "base64");
			const events = Buffer.from(value.events, "base64");
			if (
				pane.toString("base64") !== value.pane ||
				events.toString("base64") !== value.events ||
				pane.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES ||
				events.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
			)
				throw new Error("Visible session redaction rebase journal is corrupt");
			return {
				redactions,
				pane: value.pane,
				events: value.events,
				generationId: value.generationId,
				authority: value.authority,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #readDurableLogRedactions(): Promise<readonly string[] | null> {
		try {
			const value = await this.#readJson(this.#paths.redactionState, MAX_REDACTION_UPDATE_BYTES * 2);
			if (
				!isRecord(value) ||
				!exactKeys(value, ["redactions", "generationId", "authority"]) ||
				!Array.isArray(value.redactions) ||
				typeof value.generationId !== "string" ||
				typeof value.authority !== "string" ||
				value.generationId !== this.#identity.generationId ||
				value.authority !== authorityFingerprint(this.#identity)
			)
				throw new Error("Visible session durable redaction state is corrupt");
			const redactions = validatedLogRedactions(value.redactions as readonly unknown[]);
			if (!sameJson({ redactions }, { redactions: value.redactions }))
				throw new Error("Visible session durable redaction state is corrupt");
			this.#assertRedactionStateFits(redactions);
			return redactions;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #writeMetadata(metadata: VisibleSessionStateMetadata): Promise<void> {
		await this.#atomicWrite(this.#paths.metadata, stableJson(metadata));
	}
	async #readMetadata(): Promise<VisibleSessionStateMetadata> {
		const value = await this.#readJson(this.#paths.metadata);
		if (!validMetadata(value)) throw new Error("Visible session state metadata is corrupt or unsupported");
		return { ...value, projection: value.projection ?? null };
	}
	async #readRecordIfPresent(file: string): Promise<object | null> {
		try {
			const value = await this.#readJson(file);
			if (!isRecord(value)) throw new Error("Visible session terminal record is corrupt");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #readJournal(): Promise<TerminalJournal | null> {
		try {
			const value = await this.#readJson(this.#paths.journal);
			if (
				!isRecord(value) ||
				(!exactKeys(value, ["kind", "record", "revision", "cleanup"]) &&
					!exactKeys(value, ["kind", "record", "revision", "cleanup", "projection"]))
			)
				throw new Error("Visible session terminal journal is corrupt");
			const kind = value.kind;
			const record = value.record;
			const revision = value.revision;
			const cleanup = value.cleanup;
			const projection = value.projection ?? null;
			if (
				(kind !== "final" && kind !== "vanished") ||
				!isRecord(record) ||
				typeof revision !== "number" ||
				!Number.isSafeInteger(revision) ||
				revision < 1 ||
				!validReceipt(cleanup) ||
				cleanup.generationId !== this.#identity.generationId ||
				cleanup.leaseId !== authorityFingerprint(this.#identity) ||
				(projection !== null && !validProjectionReservation(projection))
			)
				throw new Error("Visible session terminal journal is corrupt");
			return {
				kind,
				record: kind === "final" ? this.#final(record, false) : this.#vanished(record, false),
				revision,
				cleanup,
				projection: projection as ProjectionReservation | null,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #readJson(file: string, maximumBytes = MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES): Promise<unknown> {
		const bytes = await readVisibleSessionBoundedFile(file, maximumBytes);
		try {
			return JSON.parse(bytes.toString("utf8")) as unknown;
		} catch (cause) {
			throw new Error("Visible session state contains invalid JSON", { cause });
		}
	}
	async #readBytes(file: string): Promise<Buffer> {
		try {
			return await readVisibleSessionPublicFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
			throw error;
		}
	}
	async #atomicWrite(file: string, content: string | Buffer): Promise<void> {
		await atomicWrite(file, content);
	}
}
export async function readVisibleSessionPrivateTerminal(
	privateRoot: string,
	identity: VisibleSessionRoleIdentity,
): Promise<VisibleSessionTerminalRecord | VisibleSessionVanishedRecord | null> {
	const state = new VisibleSessionStateCore(privateRoot, identity);
	const metadata = await state.readMetadata();
	if (metadata.generationId !== identity.generationId || metadata.authority !== authorityFingerprint(identity))
		throw new Error("Visible session private terminal authority mismatch");
	return state.readTerminal();
}

class VisibleSessionProjectedStateCore {
	readonly #private: VisibleSessionStateCore;
	readonly #projection: VisibleSessionStateProjection;
	#paths: VisibleSessionStatePaths;
	readonly #identity: VisibleSessionRoleIdentity;
	#redactions: readonly string[];
	#logRedactions: readonly string[];

	constructor(projection: VisibleSessionStateProjection, identity: VisibleSessionRoleIdentity) {
		if (
			projection.backend !== "conpty" ||
			!validText(projection.publicRoot) ||
			projection.publicRoot.length === 0 ||
			!validText(projection.privateRoot) ||
			projection.privateRoot.length === 0 ||
			!validText(projection.session) ||
			!validText(projection.workdir) ||
			!validText(projection.branch) ||
			!validText(projection.createdAt) ||
			!validText(projection.gjcBin) ||
			typeof projection.worktreeBaselineDirty !== "boolean" ||
			!Number.isSafeInteger(projection.owner.pid) ||
			projection.owner.pid <= 0 ||
			!validText(projection.owner.startedAt)
		)
			throw new Error("Visible session projection is invalid");
		const publicRoot = path.resolve(projection.publicRoot);
		const privateRoot = path.resolve(projection.privateRoot);
		if (pathContains(publicRoot, privateRoot) || pathContains(privateRoot, publicRoot))
			throw new Error("Visible session public and private roots must not overlap");
		this.#private = new VisibleSessionStateCore(privateRoot, identity);
		this.#projection = {
			...projection,
			publicRoot,
			privateRoot,
			owner: { pid: projection.owner.pid, startedAt: projection.owner.startedAt },
		};
		this.#paths = visibleSessionStatePaths(publicRoot);
		this.#identity = {
			generationId: identity.generationId,
			leaseId: identity.leaseId,
			owner: { pid: identity.owner.pid, startIdentity: identity.owner.startIdentity },
			redactions: [...identity.redactions],
		};
		this.#redactions = validatedLogRedactions([
			...identity.redactions,
			identity.leaseId,
			identity.owner.startIdentity,
		]);
		this.#logRedactions = validatedLogRedactions([...this.#redactions, ...(identity.logRedactions ?? [])]);
		assertSerializedRedactionState(
			this.#logRedactions,
			this.#identity,
			"Visible session redaction update is invalid",
		);
	}
	async addRedactions(redactions: readonly string[]): Promise<void> {
		if (
			redactions.length > MAX_REDACTION_UPDATE_SECRETS ||
			redactions.reduce(
				(bytes, redaction) => bytes + (typeof redaction === "string" ? Buffer.byteLength(redaction, "utf8") : 0),
				0,
			) > MAX_REDACTION_UPDATE_BYTES
		)
			throw new Error("Visible session redaction update is invalid");
		validatedLogRedactions(redactions);
		await this.#serialized(async () => {
			const next = validatedLogRedactions([
				...this.#logRedactions,
				...((await this.#readDurableLogRedactions()) ?? []),
				...redactions,
			]);
			assertSerializedRedactionState(next, this.#identity, "Visible session redaction update is invalid");
			if (sameJson({ redactions: next }, { redactions: this.#logRedactions })) return;
			const pane = appendVisibleSessionLog(
				await this.#readTrustedPrivateLog(this.#private.paths.pane, DEFAULT_PUBLIC_LOG_CAP_BYTES),
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				next,
			);
			const events = appendVisibleSessionLog(
				await this.#readTrustedPrivateLog(this.#private.paths.events, DEFAULT_PUBLIC_LOG_CAP_BYTES),
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				next,
			);
			await this.#writeRedactionPublicationJournal(next, pane, events);
			await this.#reconcileRedactionPublication();
		});
	}

	get paths(): VisibleSessionStatePaths {
		return this.#paths;
	}

	async initialize(): Promise<VisibleSessionStateMetadata> {
		return this.#serialized(async () => {
			await fs.mkdir(this.#projection.publicRoot, { recursive: true });
			await fs.mkdir(this.#projection.privateRoot, { recursive: true });
			const publicRoot = await fs.realpath(this.#projection.publicRoot);
			const privateRoot = await fs.realpath(this.#projection.privateRoot);
			if (pathContains(publicRoot, privateRoot) || pathContains(privateRoot, publicRoot))
				throw new Error("Visible session public and private roots must not overlap");
			this.#paths = visibleSessionStatePaths(publicRoot);
			await this.#private.initialize();
			const durableRedactions = await this.#readDurableLogRedactions();
			if (durableRedactions)
				this.#logRedactions = validatedLogRedactions([...this.#logRedactions, ...durableRedactions]);
			await this.#reconcileProjectionLocked();
			const pane = appendVisibleSessionLog(
				await this.#readTrustedPrivateLog(this.#private.paths.pane, DEFAULT_PUBLIC_LOG_CAP_BYTES),
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				this.#logRedactions,
			);
			const events = appendVisibleSessionLog(
				await this.#readTrustedPrivateLog(this.#private.paths.events, DEFAULT_PUBLIC_LOG_CAP_BYTES),
				Buffer.alloc(0),
				DEFAULT_PUBLIC_LOG_CAP_BYTES,
				this.#logRedactions,
			);
			await this.#writeRedactionPublicationJournal(this.#logRedactions, pane, events);
			await this.#reconcileProjectionLocked();
			let metadata = await this.#private.readMetadata();
			if (metadata.revision === 0 && metadata.projection === null) {
				await this.#publish("metadata", Buffer.from(stableJson(this.#metadata()), "utf8"), 0);
				metadata = await this.#private.readMetadata();
			}
			return metadata;
		});
	}
	async readMetadata(): Promise<VisibleSessionStateMetadata> {
		await this.#reconcileProjection();
		return this.#private.readMetadata();
	}
	async readTerminal(): Promise<VisibleSessionProjectedFinalRecord | VisibleSessionProjectedVanishedRecord | null> {
		return this.#serialized(async () => {
			await this.#reconcileProjectionLocked();
			const terminal = await this.#private.readTerminal();
			if (!terminal) return null;
			await this.#assertTerminalPublication();
			const projected = await this.#readRecord(
				"ownerExitReason" in terminal ? this.#paths.final : this.#paths.vanished,
			);
			if (!projected) throw new Error("Visible session terminal publication is pending");
			if ("ownerExitReason" in terminal) {
				const record = this.#readFinal(projected);
				if (!sameJson(this.#privateFinal(record), terminal))
					throw new Error("Visible session terminal publication is corrupt");
				return record;
			}
			const record = this.#readVanished(projected);
			if (!sameJson(this.#privateVanished(record), terminal))
				throw new Error("Visible session terminal publication is corrupt");
			return record;
		});
	}
	async hasPromptAccepted(): Promise<boolean> {
		return this.#private.hasPromptAccepted();
	}
	async normal(input: VisibleSessionWrite, summary: string): Promise<number> {
		return this.#serialized(async () => {
			const normalSummary = this.#text(summary);
			await this.#prepare(
				"metadata",
				Buffer.from(stableJson(this.#metadata()), "utf8"),
				input.expectedRevision,
				Buffer.from(normalSummary, "utf8"),
			);
			const projection = await this.#reservePreparedProjection("metadata", input.expectedRevision);
			try {
				const revision = await this.#private.normal(input, normalSummary, projection);
				await this.#markProjectionCommitted(revision);
				await this.#reconcileProjectionLocked();
				return revision;
			} catch (error) {
				return this.#settleNonterminalFailure("metadata", input.expectedRevision, error);
			}
		});
	}
	async runtime(input: VisibleSessionWrite, value: VisibleSessionProjectedRuntime): Promise<number> {
		return this.#serialized(async () => {
			const runtime = this.#runtime(value);
			await this.#prepare(
				"runtime",
				Buffer.from(stableJson(runtime), "utf8"),
				input.expectedRevision,
				Buffer.from(
					stableJson({ summary: runtime.summary, status: runtime.status, updatedAt: runtime.updatedAt }),
					"utf8",
				),
			);
			const projection = await this.#reservePreparedProjection("runtime", input.expectedRevision);
			try {
				const revision = await this.#private.runtime(
					input,
					{
						summary: runtime.summary,
						status: runtime.status,
						updatedAt: runtime.updatedAt,
					},
					projection,
				);
				await this.#markProjectionCommitted(revision);
				await this.#reconcileProjectionLocked();
				return revision;
			} catch (error) {
				return this.#settleNonterminalFailure("runtime", input.expectedRevision, error);
			}
		});
	}
	async promptAccepted(input: VisibleSessionWrite, value: VisibleSessionProjectedPromptAccepted): Promise<number> {
		return this.#serialized(async () => {
			const prompt = this.#promptAccepted(value);
			await this.#prepare(
				"prompt",
				Buffer.from(stableJson(prompt), "utf8"),
				input.expectedRevision,
				Buffer.from(stableJson({ acceptedAt: prompt.acceptedAt, summary: prompt.summary }), "utf8"),
			);
			const projection = await this.#reservePreparedProjection("prompt", input.expectedRevision);
			try {
				const revision = await this.#private.promptAccepted(
					input,
					{ acceptedAt: prompt.acceptedAt, summary: prompt.summary },
					projection,
				);
				await this.#markProjectionCommitted(revision);
				await this.#reconcileProjectionLocked();
				return revision;
			} catch (error) {
				return this.#settleNonterminalFailure("prompt", input.expectedRevision, error);
			}
		});
	}
	async append(input: VisibleSessionAppendInput, file: string, lineDelimited: boolean): Promise<number> {
		return this.#serialized(async () => {
			const privateFile = file === this.#paths.pane ? this.#private.paths.pane : this.#private.paths.events;
			const cap = input.capBytes ?? DEFAULT_PUBLIC_LOG_CAP_BYTES;
			if (
				!Number.isSafeInteger(cap) ||
				cap < Buffer.byteLength(PUBLIC_LOG_TRUNCATION_MARKER, "utf8") ||
				cap > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
			)
				throw new Error("Visible session log cap is invalid");
			const entry = this.#text(input.entry);
			if (entry.length === 0 && !lineDelimited) return this.#private.append(input, privateFile, lineDelimited);
			const previous = await this.#readTrustedPrivateLog(privateFile, cap);
			const content = appendVisibleSessionLog(
				previous,
				Buffer.from(lineDelimited ? `${entry}\n` : entry, "utf8"),
				cap,
				this.#logRedactions,
			);
			const target: ProjectionTarget = file === this.#paths.pane ? "pane" : "events";
			await this.#prepare(target, content, input.expectedRevision, content);
			const projection = await this.#reservePreparedProjection(target, input.expectedRevision);
			try {
				const revision = await this.#private.append(input, privateFile, lineDelimited, projection);
				await this.#markProjectionCommitted(revision);
				await this.#reconcileProjectionLocked();
				return revision;
			} catch (error) {
				return this.#settleNonterminalFailure(target, input.expectedRevision, error);
			}
		});
	}
	async final(input: VisibleSessionProjectedTerminalCommit): Promise<VisibleSessionCommitReceipt> {
		return this.#serialized(async () => {
			const record = this.#final(input.record);
			if (!this.#isFinal(record)) throw new Error("Visible session projected final record is invalid");
			const digest = createHash("sha256").update(stableJson(record)).digest("hex");
			let projection: ProjectionReservation | null = null;
			try {
				await this.#reconcileProjectionLocked();
				projection = await this.#reserveTerminalProjection(input.expectedRevision, "final", digest);
				if (projection.state === "committed") {
					await this.#reconcileProjectionLocked();
					return this.#private.terminal(
						{ expectedRevision: input.expectedRevision, record: this.#privateFinal(record) },
						this.#private.paths.final,
						this.#private.paths.vanished,
						"final",
						projection,
					);
				}
				await this.#prepare(
					"final",
					Buffer.from(stableJson(record), "utf8"),
					input.expectedRevision,
					Buffer.from(stableJson(this.#privateFinal(record)), "utf8"),
					projection.operationId,
					digest,
					true,
				);
				const receipt = await this.#private.terminal(
					{ expectedRevision: input.expectedRevision, record: this.#privateFinal(record) },
					this.#private.paths.final,
					this.#private.paths.vanished,
					"final",
					projection,
				);
				await this.#markProjectionCommitted(receipt.revision);
				await this.#reconcileProjectionLocked();
				return receipt;
			} catch (error) {
				if (projection)
					return this.#abortProjectionAfterFailure("final", input.expectedRevision, error, projection);
				throw error;
			}
		});
	}
	async vanished(input: VisibleSessionProjectedVanishedCommit): Promise<VisibleSessionCommitReceipt> {
		return this.#serialized(async () => {
			const record = this.#vanished(input.record);
			if (!this.#isVanished(record)) throw new Error("Visible session projected vanished record is invalid");
			const digest = createHash("sha256").update(stableJson(record)).digest("hex");
			let projection: ProjectionReservation | null = null;
			try {
				await this.#reconcileProjectionLocked();
				projection = await this.#reserveTerminalProjection(input.expectedRevision, "vanished", digest);
				if (projection.state === "committed") {
					await this.#reconcileProjectionLocked();
					return this.#private.terminal(
						{ expectedRevision: input.expectedRevision, record: this.#privateVanished(record) },
						this.#private.paths.vanished,
						this.#private.paths.final,
						"vanished",
						projection,
					);
				}
				await this.#prepare(
					"vanished",
					Buffer.from(stableJson(record), "utf8"),
					input.expectedRevision,
					Buffer.from(stableJson(this.#privateVanished(record)), "utf8"),
					projection.operationId,
					digest,
					true,
				);
				const receipt = await this.#private.terminal(
					{ expectedRevision: input.expectedRevision, record: this.#privateVanished(record) },
					this.#private.paths.vanished,
					this.#private.paths.final,
					"vanished",
					projection,
				);
				await this.#markProjectionCommitted(receipt.revision);
				await this.#reconcileProjectionLocked();
				return receipt;
			} catch (error) {
				if (projection)
					return this.#abortProjectionAfterFailure("vanished", input.expectedRevision, error, projection);
				throw error;
			}
		});
	}
	async #reserveTerminalProjection(
		expectedRevision: number,
		target: "final" | "vanished",
		digest: string,
	): Promise<ProjectionReservation> {
		const metadata = await this.#private.readMetadata();
		const retained = metadata.projection;
		const operationId =
			retained &&
			retained.target === target &&
			retained.digest === digest &&
			retained.expectedRevision === expectedRevision
				? retained.operationId
				: randomUUID();
		return this.#private.reserveProjection(expectedRevision, target, digest, operationId);
	}
	async claimCleanup(claimant: string): Promise<VisibleSessionPostCommitCleanup | null> {
		return this.#serialized(async () => {
			await this.#reconcileProjectionLocked();
			await this.#assertTerminalPublication();
			return this.#private.claimCleanup(claimant);
		});
	}
	async ackCleanup(claimant: string): Promise<void> {
		return this.#serialized(() => this.#private.ackCleanup(claimant));
	}
	async revokeCleanup(claimant: string): Promise<void> {
		return this.#serialized(() => this.#private.revokeCleanup(claimant));
	}
	async #serialized<T>(operation: () => Promise<T>): Promise<T> {
		const key = this.#private.paths.projectionLock;
		const previous = projectionWriteQueues.get(key) ?? Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const queued = previous.then(() => promise);
		projectionWriteQueues.set(key, queued);
		await previous;
		try {
			await fs.mkdir(path.dirname(key), { recursive: true });
			return await withFileLock(
				this.#private.paths.projectionLock,
				async () => {
					await this.#recoverBeforeOperation();
					return operation();
				},
				{ retries: PROJECTION_LOCK_RETRIES },
			);
		} finally {
			resolve();
			if (projectionWriteQueues.get(key) === queued) projectionWriteQueues.delete(key);
		}
	}
	async #recoverBeforeOperation(): Promise<void> {
		await this.#private.recover();
		try {
			await this.#private.readMetadata();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		await this.#reconcileProjectionLocked();
	}
	async #publish(target: ProjectionTarget, content: Buffer, revision: number): Promise<void> {
		await this.#prepare(target, content, revision, Buffer.alloc(0));
		if (revision === 0) {
			const journal = await this.#readProjectionJournal();
			if (!journal) throw new Error("Visible session projection journal is missing");
			await this.#writeProjectionJournal({ ...journal, committedRevision: 0 });
		} else await this.#markProjectionCommitted(revision);
		await this.#reconcileProjectionLocked();
	}
	async #prepare(
		target: ProjectionTarget,
		content: Buffer,
		expectedRevision: number,
		privateContent: Buffer,
		operationId: string | null = null,
		digest: string | null = null,
		preservePreparedReservation = false,
	): Promise<void> {
		if (target !== "final" && target !== "vanished" && (await this.#private.hasTerminalOutcome()))
			throw new Error("Visible session terminal outcome already committed");
		if (
			(content.length === 0 && target !== "pane" && target !== "events") ||
			content.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES ||
			privateContent.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
		)
			throw new Error("Visible session projected file is too large");
		const operation = operationId ?? randomUUID();
		const contentDigest = digest ?? createHash("sha256").update(content).digest("hex");
		const privateDigest = createHash("sha256").update(privateContent).digest("hex");
		if (!preservePreparedReservation) await this.#reconcileProjectionLocked();
		await this.#writeProjectionJournal({
			target,
			content: content.toString("base64"),
			privateContent: privateContent.toString("base64"),
			privateDigest,
			expectedRevision,
			committedRevision: null,
			generationId: this.#identity.generationId,
			authority: authorityFingerprint(this.#identity),
			files: null,
			operationId: operation,
			digest: contentDigest,
		});
	}
	async #reservePreparedProjection(
		target: ProjectionTarget,
		expectedRevision: number,
	): Promise<ProjectionReservation> {
		const journal = await this.#readProjectionJournal();
		if (
			!journal ||
			journal.target !== target ||
			journal.expectedRevision !== expectedRevision ||
			journal.committedRevision !== null
		)
			throw new Error("Visible session projection intent is missing");
		try {
			return await this.#private.reserveProjection(expectedRevision, target, journal.digest, journal.operationId);
		} catch (error) {
			try {
				const metadata = await this.#private.readMetadata();
				const reserved = metadata.projection;
				if (
					reserved?.state !== "prepared" ||
					reserved.operationId !== journal.operationId ||
					reserved.target !== journal.target ||
					reserved.digest !== journal.digest ||
					reserved.expectedRevision !== journal.expectedRevision
				)
					await fs.rm(this.#private.paths.projectionJournal, { force: true });
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Visible session projection reservation and cleanup both failed",
				);
			}
			throw error;
		}
	}
	async #abortPreparedProjection(
		target: ProjectionTarget,
		expectedRevision: number,
		projection: ProjectionReservation | null = null,
	): Promise<void> {
		if (target === "final" || target === "vanished") {
			const metadata = await this.#private.readMetadata();
			this.#assertPrivateAuthority(metadata);
			const terminal = await this.#private.readTerminal();
			const noPrivateTerminalIntent = terminal === null && !(await this.#private.hasTerminalOutcome());
			const noPrivateMutation =
				metadata.revision === expectedRevision &&
				projection !== null &&
				metadata.projection !== null &&
				sameJson(metadata.projection, projection) &&
				metadata.projection.state === "prepared" &&
				noPrivateTerminalIntent;
			if (!noPrivateMutation) return;
		}
		const journal = await this.#readProjectionJournal();
		if (
			journal &&
			journal.target === target &&
			journal.expectedRevision === expectedRevision &&
			journal.committedRevision === null
		)
			await fs.rm(this.#private.paths.projectionJournal, { force: true });
		if (projection?.state === "prepared") await this.#private.clearProjection(projection);
	}
	async #abortProjectionAfterFailure(
		target: ProjectionTarget,
		expectedRevision: number,
		failure: unknown,
		projection: ProjectionReservation | null = null,
	): Promise<never> {
		try {
			await this.#abortPreparedProjection(target, expectedRevision, projection);
		} catch (abortError) {
			throw new AggregateError([failure, abortError], "Visible session projection mutation and abort both failed");
		}
		throw failure;
	}
	async #settleNonterminalFailure(
		target: ProjectionTarget,
		expectedRevision: number,
		failure: unknown,
	): Promise<number> {
		try {
			const journal = await this.#readProjectionJournal();
			if (
				!journal ||
				journal.target !== target ||
				journal.expectedRevision !== expectedRevision ||
				journal.committedRevision !== null ||
				!journal.operationId ||
				!journal.digest
			)
				throw failure;
			await this.#reconcileProjectionLocked();
			const metadata = await this.#private.readMetadata();
			if (metadata.revision !== expectedRevision + 1)
				throw new Error("Visible session projected mutation recovery revision is invalid");
			return metadata.revision;
		} catch (recoveryError) {
			if (recoveryError === failure) throw failure;
			throw new AggregateError([failure, recoveryError], "Visible session projection mutation recovery failed");
		}
	}
	async #markProjectionCommitted(committedRevision: number): Promise<void> {
		const journal = await this.#readProjectionJournal();
		if (!journal) throw new Error("Visible session projection journal is missing");
		const metadata = await this.#private.readMetadata();
		if (
			metadata.revision !== committedRevision ||
			!metadata.projection ||
			metadata.projection.state !== "committed" ||
			metadata.projection.operationId !== journal.operationId ||
			metadata.projection.target !== journal.target ||
			metadata.projection.digest !== journal.digest ||
			metadata.projection.expectedRevision !== journal.expectedRevision ||
			metadata.projection.committedRevision !== committedRevision
		)
			throw new Error("Visible session projection commit receipt is corrupt");
		await this.#writeProjectionJournal({ ...journal, committedRevision });
	}
	#assertPrivateAuthority(metadata: VisibleSessionStateMetadata): void {
		if (
			metadata.generationId !== this.#identity.generationId ||
			metadata.authority !== authorityFingerprint(this.#identity)
		)
			throw new Error("Visible session private terminal authority mismatch");
	}
	async #assertCommittedTerminalProjection(
		journal: ProjectionJournal,
		metadata: VisibleSessionStateMetadata,
	): Promise<void> {
		if (journal.target !== "final" && journal.target !== "vanished") return;
		this.#assertPrivateAuthority(metadata);
		if (
			metadata.revision !== journal.expectedRevision + 1 ||
			!metadata.projection ||
			metadata.projection.state !== "committed" ||
			metadata.projection.operationId !== journal.operationId ||
			metadata.projection.target !== journal.target ||
			metadata.projection.digest !== journal.digest ||
			metadata.projection.expectedRevision !== journal.expectedRevision ||
			metadata.projection.committedRevision !== metadata.revision
		)
			throw new Error("Visible session terminal projection commit receipt is corrupt");
		const terminal = await this.#private.readTerminal();
		const privateRecord = JSON.parse(Buffer.from(journal.privateContent, "base64").toString("utf8")) as unknown;
		if (
			!terminal ||
			"ownerExitReason" in terminal !== (journal.target === "final") ||
			!isRecord(privateRecord) ||
			!sameJson(terminal, privateRecord)
		)
			throw new Error("Visible session terminal projection proof is corrupt");
	}
	async #reconcileProjection(): Promise<void> {
		return this.#serialized(() => this.#reconcileProjectionLocked());
	}
	async #assertTerminalJournalDigest(
		journal: ProjectionJournal,
		metadata: VisibleSessionStateMetadata,
	): Promise<void> {
		if (journal.target !== "final" && journal.target !== "vanished") return;
		if (!metadata.projection) throw new Error("Visible session terminal projection proof is missing");
		const record = JSON.parse(Buffer.from(journal.content, "base64").toString("utf8")) as unknown;
		if (!isRecord(record) || createHash("sha256").update(stableJson(record)).digest("hex") !== journal.digest)
			throw new Error("Visible session terminal projection digest is corrupt");
		if (
			metadata.projection.operationId !== journal.operationId ||
			metadata.projection.target !== journal.target ||
			metadata.projection.digest !== journal.digest ||
			metadata.projection.expectedRevision !== journal.expectedRevision ||
			metadata.projection.committedRevision !== journal.committedRevision
		)
			throw new Error("Visible session terminal projection reservation is corrupt");
	}
	async #writeProjectionJournal(journal: ProjectionJournal): Promise<void> {
		await atomicWrite(
			this.#private.paths.projectionJournal,
			boundedStableJson(
				journal,
				MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 4,
				"Visible session projection journal is too large",
			),
		);
	}
	async #writeRedactionPublicationJournal(redactions: readonly string[], pane: Buffer, events: Buffer): Promise<void> {
		assertSerializedRedactionState(redactions, this.#identity, "Visible session redaction update is invalid");
		await atomicWrite(
			this.#private.paths.redactionJournal,
			boundedStableJson(
				{
					redactions,
					pane: pane.toString("base64"),
					events: events.toString("base64"),
					generationId: this.#identity.generationId,
					authority: authorityFingerprint(this.#identity),
				} satisfies RedactionPublicationJournal,
				MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 4,
				"Visible session redaction publication journal is too large",
			),
		);
	}
	async #readDurableLogRedactions(): Promise<readonly string[] | null> {
		try {
			const value = JSON.parse(
				(
					await readVisibleSessionBoundedFile(this.#private.paths.redactionState, MAX_REDACTION_UPDATE_BYTES * 2)
				).toString("utf8"),
			) as unknown;
			if (
				!isRecord(value) ||
				!exactKeys(value, ["redactions", "generationId", "authority"]) ||
				!Array.isArray(value.redactions) ||
				value.generationId !== this.#identity.generationId ||
				value.authority !== authorityFingerprint(this.#identity)
			)
				throw new Error("Visible session durable redaction state is corrupt");
			const redactions = validatedLogRedactions(value.redactions as readonly unknown[]);
			if (!sameJson({ redactions }, { redactions: value.redactions }))
				throw new Error("Visible session durable redaction state is corrupt");
			assertSerializedRedactionState(
				redactions,
				this.#identity,
				"Visible session durable redaction state is corrupt",
			);
			return redactions;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #reconcileRedactionPublication(): Promise<void> {
		let journal: RedactionPublicationJournal;
		try {
			const value = JSON.parse(
				(
					await readVisibleSessionBoundedFile(
						this.#private.paths.redactionJournal,
						MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 4,
					)
				).toString("utf8"),
			) as unknown;
			if (
				!isRecord(value) ||
				!exactKeys(value, ["redactions", "pane", "events", "generationId", "authority"]) ||
				!Array.isArray(value.redactions) ||
				typeof value.pane !== "string" ||
				typeof value.events !== "string" ||
				typeof value.generationId !== "string" ||
				typeof value.authority !== "string" ||
				value.generationId !== this.#identity.generationId ||
				value.authority !== authorityFingerprint(this.#identity)
			)
				throw new Error("Visible session redaction publication journal is corrupt");
			const redactions = validatedLogRedactions(value.redactions as readonly unknown[]);
			if (!sameJson({ redactions }, { redactions: value.redactions }))
				throw new Error("Visible session redaction publication journal is corrupt");
			assertSerializedRedactionState(
				redactions,
				this.#identity,
				"Visible session redaction publication journal is corrupt",
			);
			journal = {
				redactions,
				pane: value.pane,
				events: value.events,
				generationId: value.generationId,
				authority: value.authority,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const recordedPane = Buffer.from(journal.pane, "base64");
		const recordedEvents = Buffer.from(journal.events, "base64");
		if (
			recordedPane.toString("base64") !== journal.pane ||
			recordedEvents.toString("base64") !== journal.events ||
			recordedPane.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES ||
			recordedEvents.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
		)
			throw new Error("Visible session redaction publication is too large");
		const redactions = validatedLogRedactions([
			...this.#logRedactions,
			...((await this.#readDurableLogRedactions()) ?? []),
			...journal.redactions,
		]);
		assertSerializedRedactionState(redactions, this.#identity, "Visible session redaction publication is too large");
		await this.#private.addRedactions(redactions);
		const pane = appendVisibleSessionLog(
			await this.#readTrustedPrivateLog(this.#private.paths.pane, DEFAULT_PUBLIC_LOG_CAP_BYTES),
			Buffer.alloc(0),
			DEFAULT_PUBLIC_LOG_CAP_BYTES,
			redactions,
		);
		const events = appendVisibleSessionLog(
			await this.#readTrustedPrivateLog(this.#private.paths.events, DEFAULT_PUBLIC_LOG_CAP_BYTES),
			Buffer.alloc(0),
			DEFAULT_PUBLIC_LOG_CAP_BYTES,
			redactions,
		);
		await this.#write(this.#paths.pane, pane);
		await this.#write(this.#paths.events, events);
		const files = await this.#publicationFiles();
		const metadata = await this.#private.readMetadata();
		await this.#writePublicationManifest(metadata.revision, files);
		this.#logRedactions = redactions;
		await fs.rm(this.#private.paths.redactionJournal, { force: true });
	}

	async #reconcileProjectionLocked(): Promise<void> {
		await this.#reconcileProjectionJournalLocked();
		await this.#reconcileRedactionPublication();
	}
	async #reconcileProjectionJournalLocked(): Promise<void> {
		const journal = await this.#readProjectionJournal();
		if (!journal) {
			const metadata = await this.#private.readMetadata();
			if (metadata.projection?.state === "committed") {
				if (metadata.projection.target === "final" || metadata.projection.target === "vanished") return;
				await this.#retireCommittedNonterminalProjection(metadata.projection);
				return;
			}
			await this.#private.clearPreparedProjection();
			return;
		}
		if (journal.committedRevision === null) {
			const metadata = await this.#private.readMetadata();
			if (
				metadata.revision === journal.expectedRevision + 1 &&
				metadata.projection?.state === "committed" &&
				metadata.projection.operationId === journal.operationId &&
				metadata.projection.target === journal.target &&
				metadata.projection.digest === journal.digest &&
				metadata.projection.expectedRevision === journal.expectedRevision &&
				metadata.projection.committedRevision === metadata.revision
			) {
				await this.#assertCommittedTerminalProjection(journal, metadata);
				await this.#writeProjectionJournal({ ...journal, committedRevision: metadata.revision });
				return this.#reconcileProjectionJournalLocked();
			}
			if (metadata.revision === journal.expectedRevision) {
				if (
					metadata.projection?.state !== "prepared" ||
					metadata.projection.operationId !== journal.operationId ||
					metadata.projection.target !== journal.target ||
					metadata.projection.digest !== journal.digest ||
					metadata.projection.expectedRevision !== journal.expectedRevision ||
					metadata.projection.committedRevision !== null
				) {
					if (metadata.projection === null) {
						await fs.rm(this.#private.paths.projectionJournal, { force: true });
						return;
					}
					throw new Error("Visible session projection reservation is corrupt");
				}
				if (journal.target === "final" || journal.target === "vanished") {
					const privateRecord = JSON.parse(
						Buffer.from(journal.privateContent, "base64").toString("utf8"),
					) as unknown;
					if (!isRecord(privateRecord)) throw new Error("Visible session terminal private journal is corrupt");
					const receipt =
						journal.target === "final"
							? await this.#private.terminal(
									{
										expectedRevision: journal.expectedRevision,
										record: privateRecord as unknown as VisibleSessionTerminalRecord,
									},
									this.#private.paths.final,
									this.#private.paths.vanished,
									"final",
									metadata.projection,
								)
							: await this.#private.terminal(
									{
										expectedRevision: journal.expectedRevision,
										record: privateRecord as unknown as VisibleSessionVanishedRecord,
									},
									this.#private.paths.vanished,
									this.#private.paths.final,
									"vanished",
									metadata.projection,
								);
					await this.#markProjectionCommitted(receipt.revision);
					return this.#reconcileProjectionJournalLocked();
				}
				const revision = await this.#private.recoverProjectedMutation(
					metadata.projection,
					journal.target,
					Buffer.from(journal.privateContent, "base64"),
				);
				await this.#markProjectionCommitted(revision);
				return this.#reconcileProjectionJournalLocked();
			}
			if (metadata.revision !== journal.expectedRevision + 1)
				throw new Error("Visible session projection journal revision is corrupt");
			if (
				metadata.projection?.state !== "committed" ||
				metadata.projection.operationId !== journal.operationId ||
				metadata.projection.target !== journal.target ||
				metadata.projection.digest !== journal.digest ||
				metadata.projection.expectedRevision !== journal.expectedRevision ||
				metadata.projection.committedRevision !== metadata.revision
			)
				throw new Error("Visible session projection commit receipt is corrupt");
		}
		await this.#assertTerminalJournalDigest(journal, await this.#private.readMetadata());
		const destination = {
			metadata: this.#paths.metadata,
			runtime: this.#paths.runtimeState,
			prompt: this.#paths.promptAccepted,
			pane: this.#paths.pane,
			events: this.#paths.events,
			final: this.#paths.final,
			vanished: this.#paths.vanished,
		}[journal.target];
		const bytes = Buffer.from(journal.content, "base64");
		await this.#write(destination, bytes);
		if (journal.target === "final") await fs.rm(this.#paths.vanished, { force: true });
		if (journal.target === "vanished") await fs.rm(this.#paths.final, { force: true });
		const files = journal.files ?? (await this.#publicationFiles());
		if (journal.files === null) await this.#writeProjectionJournal({ ...journal, files });
		const committedRevision = journal.committedRevision;
		if (committedRevision === null) throw new Error("Visible session projection journal is not committed");
		await this.#writePublicationManifest(committedRevision, files);
		const manifest = await this.#readPublicationManifest();
		if (
			!manifest ||
			manifest.epoch < committedRevision ||
			manifest.files[journal.target] !== createHash("sha256").update(bytes).digest("hex") ||
			!sameJson(manifest.files, files)
		)
			throw new Error("Visible session projection publication verification failed");
		if (journal.target !== "final" && journal.target !== "vanished") {
			const metadata = await this.#private.readMetadata();
			if (journal.committedRevision === journal.expectedRevision && metadata.projection === null) {
				await fs.rm(this.#private.paths.projectionJournal, { force: true });
				return;
			}
			if (
				!metadata.projection ||
				metadata.projection.operationId !== journal.operationId ||
				metadata.projection.target !== journal.target ||
				metadata.projection.digest !== journal.digest ||
				metadata.projection.expectedRevision !== journal.expectedRevision ||
				metadata.projection.committedRevision !== journal.committedRevision
			)
				throw new Error("Visible session projection committed receipt is corrupt");
			await fs.rm(this.#private.paths.projectionJournal, { force: true });
			await this.#private.clearCommittedNonterminalProjection(metadata.projection);
		}
	}
	async #retireCommittedNonterminalProjection(projection: ProjectionReservation): Promise<void> {
		if (projection.committedRevision === null)
			throw new Error("Visible session projection committed receipt is corrupt");
		const manifest = await this.#readPublicationManifest();
		if (
			!manifest ||
			manifest.epoch < projection.committedRevision ||
			manifest.files[projection.target] !== projection.digest
		)
			throw new Error("Visible session projection committed receipt is not published");
		await this.#private.clearCommittedNonterminalProjection(projection);
	}
	async #readProjectionJournal(): Promise<ProjectionJournal | null> {
		try {
			const value = JSON.parse(
				(
					await readVisibleSessionBoundedFile(
						this.#private.paths.projectionJournal,
						MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 4,
					)
				).toString("utf8"),
			) as unknown;
			if (
				!isRecord(value) ||
				!exactKeys(value, [
					"target",
					"content",
					"privateContent",
					"privateDigest",
					"expectedRevision",
					"committedRevision",
					"generationId",
					"authority",
					"files",
					"operationId",
					"digest",
				]) ||
				!["metadata", "runtime", "prompt", "pane", "events", "final", "vanished"].includes(
					value.target as string,
				) ||
				typeof value.content !== "string" ||
				(value.content.length === 0 && value.target !== "pane" && value.target !== "events") ||
				Buffer.byteLength(value.content, "utf8") > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 2 ||
				typeof value.privateContent !== "string" ||
				Buffer.byteLength(value.privateContent, "utf8") > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 2 ||
				typeof value.privateDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(value.privateDigest) ||
				typeof value.expectedRevision !== "number" ||
				!Number.isSafeInteger(value.expectedRevision) ||
				value.expectedRevision < 0 ||
				value.generationId !== this.#identity.generationId ||
				value.authority !== authorityFingerprint(this.#identity) ||
				(value.committedRevision !== null &&
					(typeof value.committedRevision !== "number" ||
						!Number.isSafeInteger(value.committedRevision) ||
						(value.committedRevision !== value.expectedRevision + 1 &&
							!(value.target === "metadata" && value.committedRevision === value.expectedRevision)))) ||
				(value.files !== null && !this.#isProjectionFiles(value.files)) ||
				!validText(value.operationId) ||
				typeof value.digest !== "string" ||
				!/^[a-f0-9]{64}$/.test(value.digest)
			)
				throw new Error("Visible session projection journal is corrupt");
			const content = Buffer.from(value.content, "base64");
			if (
				content.toString("base64") !== value.content ||
				(content.length === 0 && value.target !== "pane" && value.target !== "events") ||
				content.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
			)
				throw new Error("Visible session projection journal is corrupt");
			if (createHash("sha256").update(content).digest("hex") !== value.digest)
				throw new Error("Visible session projection journal digest is corrupt");
			if (value.target === "final" || value.target === "vanished") {
				const record = JSON.parse(content.toString("utf8")) as unknown;
				if (!isRecord(record) || createHash("sha256").update(stableJson(record)).digest("hex") !== value.digest)
					throw new Error("Visible session terminal projection journal is corrupt");
			}
			const privateContent = Buffer.from(value.privateContent, "base64");
			if (
				privateContent.toString("base64") !== value.privateContent ||
				privateContent.length > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
			)
				throw new Error("Visible session projection journal is corrupt");
			if (createHash("sha256").update(privateContent).digest("hex") !== value.privateDigest)
				throw new Error("Visible session projection private journal digest is corrupt");
			return {
				target: value.target as ProjectionTarget,
				content: value.content,
				privateContent: value.privateContent,
				privateDigest: value.privateDigest,
				expectedRevision: value.expectedRevision,
				committedRevision: value.committedRevision as number | null,
				generationId: value.generationId,
				authority: value.authority,
				files: value.files as ProjectionFiles | null,
				operationId: value.operationId as string,
				digest: value.digest as string,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #readTrustedPrivateLog(file: string, cap: number): Promise<Buffer> {
		if (
			!Number.isSafeInteger(cap) ||
			cap < Buffer.byteLength(PUBLIC_LOG_TRUNCATION_MARKER, "utf8") ||
			cap > MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES
		)
			throw new Error("Visible session log cap is invalid");
		try {
			const bytes = await readVisibleSessionBoundedFile(file, MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES);
			return bytes;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
			throw error;
		}
	}
	async #publicationFiles(): Promise<ProjectionFiles> {
		const paths: Record<ProjectionTarget, string> = {
			metadata: this.#paths.metadata,
			runtime: this.#paths.runtimeState,
			prompt: this.#paths.promptAccepted,
			pane: this.#paths.pane,
			events: this.#paths.events,
			final: this.#paths.final,
			vanished: this.#paths.vanished,
		};
		const files: ProjectionFiles = {
			metadata: null,
			runtime: null,
			prompt: null,
			pane: null,
			events: null,
			final: null,
			vanished: null,
		};
		for (const [name, file] of Object.entries(paths) as [ProjectionTarget, string][]) {
			try {
				files[name] = createHash("sha256")
					.update(await readVisibleSessionPublicFile(file))
					.digest("hex");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return files;
	}
	async #writePublicationManifest(minimumEpoch: number, files: ProjectionFiles): Promise<void> {
		const previous = await this.#readPublicationManifest();
		const epoch = Math.max(minimumEpoch, (previous?.epoch ?? -1) + 1);
		await this.#write(this.#paths.publication, {
			schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
			epoch,
			generationId: this.#identity.generationId,
			owner: this.#owner(),
			files,
		} satisfies VisibleSessionPublicationManifest);
	}
	async #readPublicationManifest(): Promise<VisibleSessionPublicationManifest | null> {
		try {
			const value = JSON.parse(
				(
					await readVisibleSessionBoundedFile(this.#paths.publication, MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES)
				).toString("utf8"),
			) as unknown;
			if (
				!isRecord(value) ||
				!exactKeys(value, ["schemaVersion", "epoch", "generationId", "owner", "files"]) ||
				value.schemaVersion !== VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION ||
				typeof value.epoch !== "number" ||
				!Number.isSafeInteger(value.epoch) ||
				value.epoch < 0 ||
				value.generationId !== this.#identity.generationId ||
				!this.#isOwner(value.owner) ||
				!this.#isProjectionFiles(value.files)
			)
				throw new Error("Visible session publication manifest is corrupt");
			return {
				schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
				epoch: value.epoch,
				generationId: value.generationId,
				owner: value.owner,
				files: value.files,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	#isProjectionFiles(value: unknown): value is ProjectionFiles {
		return (
			isRecord(value) &&
			exactKeys(value, ["metadata", "runtime", "prompt", "pane", "events", "final", "vanished"]) &&
			Object.values(value).every(hash => hash === null || (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)))
		);
	}
	async #assertTerminalPublication(): Promise<void> {
		const terminal = await this.#private.readTerminal();
		if (!terminal) return;
		const target: ProjectionTarget = "ownerExitReason" in terminal ? "final" : "vanished";
		const metadata = await this.#private.readMetadata();
		const journal = await this.#readProjectionJournal();
		if (
			!journal ||
			journal.target !== target ||
			journal.committedRevision === null ||
			!metadata.projection ||
			metadata.projection.state !== "committed" ||
			metadata.projection.operationId !== journal.operationId ||
			metadata.projection.digest !== journal.digest ||
			metadata.projection.target !== target
		)
			throw new Error("Visible session terminal publication is pending");
		await this.#assertTerminalJournalDigest(journal, metadata);
		const privateRecord = JSON.parse(Buffer.from(journal.privateContent, "base64").toString("utf8")) as unknown;
		if (!isRecord(privateRecord) || !sameJson(terminal, privateRecord))
			throw new Error("Visible session terminal projection proof is corrupt");
	}
	#metadata(): VisibleSessionProjectedMetadata {
		return {
			schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
			session: this.#text(this.#projection.session),
			workdir: this.#text(this.#projection.workdir),
			branch: this.#text(this.#projection.branch),
			createdAt: this.#text(this.#projection.createdAt),
			gjcBin: this.#text(this.#projection.gjcBin),
			stateDir: this.#paths.root,
			paneLog: this.#paths.pane,
			eventsLog: this.#paths.events,
			finalStatus: this.#paths.final,
			runtimeState: this.#paths.runtimeState,
			vanishedStatus: this.#paths.vanished,
			promptAcceptedStatus: this.#paths.promptAccepted,
			worktreeBaselineDirty: this.#projection.worktreeBaselineDirty,
			backend: "conpty",
			generation: this.#identity.generationId,
			generationId: this.#identity.generationId,
			owner: this.#owner(),
		};
	}

	#runtime(value: VisibleSessionProjectedRuntime): VisibleSessionProjectedRuntime {
		if (
			typeof value.present !== "boolean" ||
			typeof value.valid !== "boolean" ||
			typeof value.terminal !== "boolean" ||
			typeof value.finalResponsePresent !== "boolean" ||
			typeof value.sessionMatches !== "boolean" ||
			typeof value.cwdMatches !== "boolean"
		)
			throw new Error("Visible session projected runtime is invalid");
		return {
			schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
			backend: "conpty",
			generation: this.#identity.generationId,
			generationId: this.#identity.generationId,
			owner: this.#owner(),
			summary: this.#text(value.summary),
			status: this.#text(value.status),
			updatedAt: this.#text(value.updatedAt),
			present: value.present,
			valid: value.valid,
			state: this.#nullable(value.state),
			source: this.#nullable(value.source),
			event: this.#nullable(value.event),
			reason: this.#nullable(value.reason),
			terminal: value.terminal,
			terminalState: this.#nullable(value.terminalState),
			terminalSource: this.#nullable(value.terminalSource),
			finalResponsePresent: value.finalResponsePresent,
			previousRuntimeState: this.#nullable(value.previousRuntimeState),
			sessionMatches: value.sessionMatches,
			cwdMatches: value.cwdMatches,
		};
	}

	#promptAccepted(value: VisibleSessionProjectedPromptAccepted): VisibleSessionProjectedPromptAccepted {
		return {
			schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
			backend: "conpty",
			generation: this.#identity.generationId,
			generationId: this.#identity.generationId,
			owner: this.#owner(),
			session: this.#text(this.#projection.session),
			acceptedAt: this.#text(value.acceptedAt),
			summary: "prompt accepted",
			worktreeBaselineDirty: this.#projection.worktreeBaselineDirty,
		};
	}

	#final(value: VisibleSessionProjectedFinalRecord): VisibleSessionProjectedFinalRecord {
		if (
			!Number.isSafeInteger(value.status) ||
			value.status < 0 ||
			typeof value.turnEvidencePresent !== "boolean" ||
			typeof value.promptAccepted !== "boolean" ||
			typeof value.runtimeTerminal !== "boolean" ||
			typeof value.observedRecoverableWorktreeChanges !== "boolean" ||
			typeof value.worktreeChangedSinceBaseline !== "boolean" ||
			(value.severity !== "normal" && value.severity !== "failure")
		)
			throw new Error("Visible session projected final record is invalid");
		const runtimeStateSummary = this.#runtimeSummary(value.runtimeStateSummary);
		if (
			value.runtimeTerminal !== runtimeStateSummary.terminal ||
			this.#nullable(value.runtimeTerminalState) !== runtimeStateSummary.terminalState ||
			this.#nullable(value.runtimeTerminalSource) !== runtimeStateSummary.terminalSource ||
			this.#text(value.ownerExitReason) !== runtimeStateSummary.ownerExitReason ||
			value.severity !== runtimeStateSummary.severity
		)
			throw new Error("Visible session projected final terminal facts are inconsistent");
		return {
			schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
			backend: "conpty",
			generation: this.#identity.generationId,
			generationId: this.#identity.generationId,
			owner: this.#owner(),
			session: this.#text(this.#projection.session),
			status: value.status,
			startedAt: this.#text(value.startedAt),
			finishedAt: this.#text(value.finishedAt),
			paneLog: this.#paths.pane,
			runtimeState: this.#paths.runtimeState,
			turnEvidencePresent: value.turnEvidencePresent,
			promptAccepted: value.promptAccepted,
			ownerExitReason: this.#text(value.ownerExitReason),
			severity: value.severity,
			runtimeTerminal: value.runtimeTerminal,
			runtimeTerminalState: this.#nullable(value.runtimeTerminalState),
			runtimeTerminalSource: this.#nullable(value.runtimeTerminalSource),
			worktreeBaselineDirty: this.#projection.worktreeBaselineDirty,
			observedRecoverableWorktreeChanges: value.observedRecoverableWorktreeChanges,
			worktreeChangedSinceBaseline: value.worktreeChangedSinceBaseline,
			runtimeStateSummary,
			committedAt: this.#text(value.committedAt),
			runtimeSummary: this.#text(value.runtimeSummary),
			worktreeSummary: this.#text(value.worktreeSummary),
			evidenceSummary: this.#text(value.evidenceSummary),
		};
	}

	#vanished(value: VisibleSessionProjectedVanishedRecord): VisibleSessionProjectedVanishedRecord {
		if (typeof value.promptAccepted !== "boolean" || typeof value.tuiReady !== "boolean")
			throw new Error("Visible session projected vanished record is invalid");
		return {
			schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
			backend: "conpty",
			generation: this.#identity.generationId,
			generationId: this.#identity.generationId,
			owner: this.#owner(),
			session: this.#text(this.#projection.session),
			workdir: this.#text(this.#projection.workdir),
			detectedAt: this.#text(value.detectedAt),
			committedAt: this.#text(value.committedAt),
			reason: this.#text(value.reason),
			phase: this.#text(value.phase),
			severity: "failure",
			promptAccepted: value.promptAccepted,
			finalPresent: false,
			tuiReady: value.tuiReady,
			paneLog: this.#paths.pane,
			eventsLog: this.#paths.events,
			finalStatus: this.#paths.final,
			runtimeState: this.#paths.runtimeState,
			promptAcceptedStatus: this.#paths.promptAccepted,
			evidenceSummary: this.#text(value.evidenceSummary),
		};
	}

	#runtimeSummary(value: VisibleSessionProjectedRuntimeSummary): VisibleSessionProjectedRuntimeSummary {
		if (
			typeof value.present !== "boolean" ||
			typeof value.valid !== "boolean" ||
			typeof value.terminal !== "boolean" ||
			typeof value.finalResponsePresent !== "boolean" ||
			typeof value.sessionMatches !== "boolean" ||
			typeof value.cwdMatches !== "boolean" ||
			(value.severity !== "normal" && value.severity !== "failure")
		)
			throw new Error("Visible session projected runtime summary is invalid");
		return {
			summary: this.#text(value.summary),
			status: this.#text(value.status),
			updatedAt: this.#text(value.updatedAt),
			present: value.present,
			valid: value.valid,
			state: this.#nullable(value.state),
			source: this.#nullable(value.source),
			event: this.#nullable(value.event),
			reason: this.#nullable(value.reason),
			terminal: value.terminal,
			terminalState: this.#nullable(value.terminalState),
			terminalSource: this.#nullable(value.terminalSource),
			finalResponsePresent: value.finalResponsePresent,
			previousRuntimeState: this.#nullable(value.previousRuntimeState),
			sessionMatches: value.sessionMatches,
			cwdMatches: value.cwdMatches,
			ownerExitReason: this.#text(value.ownerExitReason),
			severity: value.severity,
		};
	}

	#privateFinal(value: VisibleSessionProjectedFinalRecord): VisibleSessionTerminalRecord {
		return {
			schemaVersion: VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
			generationId: this.#identity.generationId,
			committedAt: value.committedAt,
			ownerExitReason: value.ownerExitReason,
			severity: value.severity === "normal" ? "info" : "error",
			runtimeSummary: value.runtimeSummary,
			worktreeSummary: value.worktreeSummary,
			evidenceSummary: value.evidenceSummary,
		};
	}

	#privateVanished(value: VisibleSessionProjectedVanishedRecord): VisibleSessionVanishedRecord {
		return {
			schemaVersion: VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
			generationId: this.#identity.generationId,
			committedAt: value.committedAt,
			reason: value.reason,
			evidenceSummary: value.evidenceSummary,
		};
	}

	#owner(): { pid: number; startedAt: string } {
		return { pid: this.#projection.owner.pid, startedAt: this.#text(this.#projection.owner.startedAt) };
	}

	#nullable(value: string | null): string | null {
		return value === null ? null : this.#text(value);
	}

	#text(value: string): string {
		if (typeof value !== "string" || value.includes("\0")) throw new Error("Visible session public text is invalid");
		return trimUtf8Prefix(
			Buffer.from(redactVisibleSessionText(value, this.#redactions), "utf8"),
			MAX_PUBLIC_TEXT_BYTES,
		).toString("utf8");
	}

	async #readRecord(file: string): Promise<Record<string, unknown> | null> {
		try {
			const value = JSON.parse((await readVisibleSessionPublicFile(file)).toString("utf8")) as unknown;
			if (!isRecord(value)) throw new Error("Visible session terminal record is corrupt");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	#readFinal(value: Record<string, unknown>): VisibleSessionProjectedFinalRecord {
		if (!this.#isFinal(value)) throw new Error("Visible session terminal record is corrupt");
		return this.#final(value);
	}

	#readVanished(value: Record<string, unknown>): VisibleSessionProjectedVanishedRecord {
		if (!this.#isVanished(value)) throw new Error("Visible session terminal record is corrupt");
		return this.#vanished(value);
	}

	#isFinal(value: unknown): value is VisibleSessionProjectedFinalRecord {
		return (
			isRecord(value) &&
			exactKeys(value, [
				"schemaVersion",
				"backend",
				"generation",
				"generationId",
				"owner",
				"session",
				"status",
				"startedAt",
				"finishedAt",
				"paneLog",
				"runtimeState",
				"turnEvidencePresent",
				"promptAccepted",
				"ownerExitReason",
				"severity",
				"runtimeTerminal",
				"runtimeTerminalState",
				"runtimeTerminalSource",
				"worktreeBaselineDirty",
				"observedRecoverableWorktreeChanges",
				"worktreeChangedSinceBaseline",
				"runtimeStateSummary",
				"committedAt",
				"runtimeSummary",
				"worktreeSummary",
				"evidenceSummary",
			]) &&
			value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
			value.backend === "conpty" &&
			value.generation === this.#identity.generationId &&
			value.generationId === this.#identity.generationId &&
			this.#isOwner(value.owner) &&
			typeof value.status === "number" &&
			Number.isSafeInteger(value.status) &&
			value.status >= 0 &&
			[
				"session",
				"startedAt",
				"finishedAt",
				"paneLog",
				"runtimeState",
				"ownerExitReason",
				"committedAt",
				"runtimeSummary",
				"worktreeSummary",
				"evidenceSummary",
			].every(key => validText(value[key])) &&
			typeof value.turnEvidencePresent === "boolean" &&
			typeof value.promptAccepted === "boolean" &&
			(value.severity === "normal" || value.severity === "failure") &&
			typeof value.runtimeTerminal === "boolean" &&
			this.#isNullableText(value.runtimeTerminalState) &&
			this.#isNullableText(value.runtimeTerminalSource) &&
			typeof value.worktreeBaselineDirty === "boolean" &&
			typeof value.observedRecoverableWorktreeChanges === "boolean" &&
			typeof value.worktreeChangedSinceBaseline === "boolean" &&
			this.#isRuntimeSummary(value.runtimeStateSummary)
		);
	}

	#isVanished(value: unknown): value is VisibleSessionProjectedVanishedRecord {
		return (
			isRecord(value) &&
			exactKeys(value, [
				"schemaVersion",
				"backend",
				"generation",
				"generationId",
				"owner",
				"session",
				"workdir",
				"detectedAt",
				"committedAt",
				"reason",
				"phase",
				"severity",
				"promptAccepted",
				"finalPresent",
				"tuiReady",
				"paneLog",
				"eventsLog",
				"finalStatus",
				"runtimeState",
				"promptAcceptedStatus",
				"evidenceSummary",
			]) &&
			value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
			value.backend === "conpty" &&
			value.generation === this.#identity.generationId &&
			value.generationId === this.#identity.generationId &&
			this.#isOwner(value.owner) &&
			[
				"session",
				"workdir",
				"detectedAt",
				"committedAt",
				"reason",
				"phase",
				"paneLog",
				"eventsLog",
				"finalStatus",
				"runtimeState",
				"promptAcceptedStatus",
				"evidenceSummary",
			].every(key => validText(value[key])) &&
			value.severity === "failure" &&
			typeof value.promptAccepted === "boolean" &&
			value.finalPresent === false &&
			typeof value.tuiReady === "boolean"
		);
	}

	#isRuntimeSummary(value: unknown): value is VisibleSessionProjectedRuntimeSummary {
		return (
			isRecord(value) &&
			exactKeys(value, [
				"summary",
				"status",
				"updatedAt",
				"present",
				"valid",
				"state",
				"source",
				"event",
				"reason",
				"terminal",
				"terminalState",
				"terminalSource",
				"finalResponsePresent",
				"previousRuntimeState",
				"sessionMatches",
				"cwdMatches",
				"ownerExitReason",
				"severity",
			]) &&
			["summary", "status", "updatedAt", "ownerExitReason"].every(key => validText(value[key])) &&
			["present", "valid", "terminal", "finalResponsePresent", "sessionMatches", "cwdMatches"].every(
				key => typeof value[key] === "boolean",
			) &&
			["state", "source", "event", "reason", "terminalState", "terminalSource", "previousRuntimeState"].every(key =>
				this.#isNullableText(value[key]),
			) &&
			(value.severity === "normal" || value.severity === "failure")
		);
	}

	#isOwner(value: unknown): value is { pid: number; startedAt: string } {
		return (
			isRecord(value) &&
			exactKeys(value, ["pid", "startedAt"]) &&
			value.pid === this.#projection.owner.pid &&
			value.startedAt === this.#text(this.#projection.owner.startedAt)
		);
	}

	#isNullableText(value: unknown): value is string | null {
		return value === null || validText(value);
	}

	async #write(file: string, value: object | Buffer): Promise<void> {
		await atomicWrite(file, Buffer.isBuffer(value) ? value : stableJson(value));
	}
}

function isProjectedFinalCommit(
	input: VisibleSessionTerminalCommit | VisibleSessionProjectedTerminalCommit,
): input is VisibleSessionProjectedTerminalCommit {
	return input.record.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
}

function isProjectedVanishedCommit(
	input: VisibleSessionVanishedCommit | VisibleSessionProjectedVanishedCommit,
): input is VisibleSessionProjectedVanishedCommit {
	return input.record.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION;
}

export class VisibleSessionStateOwner {
	readonly #legacy: VisibleSessionStateCore | null;
	readonly #projected: VisibleSessionProjectedStateCore | null;

	constructor(root: string, identity: VisibleSessionRoleIdentity);
	constructor(projection: VisibleSessionStateProjection, identity: VisibleSessionRoleIdentity);
	constructor(rootOrProjection: string | VisibleSessionStateProjection, identity: VisibleSessionRoleIdentity) {
		this.#legacy =
			typeof rootOrProjection === "string" ? new VisibleSessionStateCore(rootOrProjection, identity) : null;
		this.#projected =
			typeof rootOrProjection === "string" ? null : new VisibleSessionProjectedStateCore(rootOrProjection, identity);
	}

	get paths(): VisibleSessionStatePaths {
		return this.#projected ? this.#projected.paths : this.#legacy!.paths;
	}

	async initialize(): Promise<VisibleSessionStateMetadata> {
		return this.#projected ? this.#projected.initialize() : this.#legacy!.initialize();
	}

	async readMetadata(): Promise<VisibleSessionStateMetadata> {
		return this.#projected ? this.#projected.readMetadata() : this.#legacy!.readMetadata();
	}
	async addRedactions(redactions: readonly string[]): Promise<void> {
		if (this.#projected) await this.#projected.addRedactions(redactions);
		else await this.#legacy!.addRedactions(redactions);
	}

	async updateNormal(input: VisibleSessionWrite, summary: string): Promise<number> {
		return this.#projected ? this.#projected.normal(input, summary) : this.#legacy!.normal(input, summary);
	}

	async updateRuntime(input: VisibleSessionWrite, runtime: VisibleSessionStateRuntime): Promise<number>;
	async updateRuntime(input: VisibleSessionWrite, runtime: VisibleSessionProjectedRuntime): Promise<number>;
	async updateRuntime(
		input: VisibleSessionWrite,
		runtime: VisibleSessionStateRuntime | VisibleSessionProjectedRuntime,
	): Promise<number> {
		if (this.#projected) {
			if (!("present" in runtime)) throw new Error("Visible session projected runtime is invalid");
			return this.#projected.runtime(input, runtime);
		}
		return this.#legacy!.runtime(input, runtime);
	}

	async recordPromptAccepted(input: VisibleSessionWrite, prompt: VisibleSessionPromptAccepted): Promise<number>;
	async recordPromptAccepted(
		input: VisibleSessionWrite,
		prompt: VisibleSessionProjectedPromptAccepted,
	): Promise<number>;
	async recordPromptAccepted(
		input: VisibleSessionWrite,
		prompt: VisibleSessionPromptAccepted | VisibleSessionProjectedPromptAccepted,
	): Promise<number> {
		if (this.#projected) {
			if (!("schemaVersion" in prompt)) throw new Error("Visible session projected prompt receipt is invalid");
			return this.#projected.promptAccepted(input, prompt);
		}
		return this.#legacy!.promptAccepted(input, prompt);
	}

	async appendOutput(input: VisibleSessionAppendInput): Promise<number> {
		return this.#projected
			? this.#projected.append(input, this.#projected.paths.pane, false)
			: this.#legacy!.append(input, this.#legacy!.paths.pane, false);
	}

	async appendEvent(input: VisibleSessionAppendInput): Promise<number> {
		return this.#projected
			? this.#projected.append(input, this.#projected.paths.events, true)
			: this.#legacy!.append(input, this.#legacy!.paths.events, true);
	}

	async commitFinal(input: VisibleSessionTerminalCommit): Promise<VisibleSessionCommitReceipt>;
	async commitFinal(input: VisibleSessionProjectedTerminalCommit): Promise<VisibleSessionCommitReceipt>;
	async commitFinal(
		input: VisibleSessionTerminalCommit | VisibleSessionProjectedTerminalCommit,
	): Promise<VisibleSessionCommitReceipt> {
		if (this.#projected) {
			if (!isProjectedFinalCommit(input)) throw new Error("Visible session projected final receipt is invalid");
			return this.#projected.final(input);
		}
		if (isProjectedFinalCommit(input)) throw new Error("Visible session final receipt is invalid");
		return this.#legacy!.terminal(input, this.#legacy!.paths.final, this.#legacy!.paths.vanished, "final");
	}
}

export class VisibleSessionStateMonitor {
	readonly #legacy: VisibleSessionStateCore | null;
	readonly #projected: VisibleSessionProjectedStateCore | null;

	constructor(root: string, identity: VisibleSessionRoleIdentity);
	constructor(projection: VisibleSessionStateProjection, identity: VisibleSessionRoleIdentity);
	constructor(rootOrProjection: string | VisibleSessionStateProjection, identity: VisibleSessionRoleIdentity) {
		this.#legacy =
			typeof rootOrProjection === "string" ? new VisibleSessionStateCore(rootOrProjection, identity) : null;
		this.#projected =
			typeof rootOrProjection === "string" ? null : new VisibleSessionProjectedStateCore(rootOrProjection, identity);
	}

	get paths(): VisibleSessionStatePaths {
		return this.#projected ? this.#projected.paths : this.#legacy!.paths;
	}

	async readMetadata(): Promise<VisibleSessionStateMetadata> {
		return this.#projected ? this.#projected.readMetadata() : this.#legacy!.readMetadata();
	}

	async readTerminal(): Promise<
		| VisibleSessionTerminalRecord
		| VisibleSessionVanishedRecord
		| VisibleSessionProjectedFinalRecord
		| VisibleSessionProjectedVanishedRecord
		| null
	> {
		return this.#projected ? this.#projected.readTerminal() : this.#legacy!.readTerminal();
	}
	async hasPromptAccepted(): Promise<boolean> {
		return this.#projected ? this.#projected.hasPromptAccepted() : this.#legacy!.hasPromptAccepted();
	}

	async commitVanished(input: VisibleSessionVanishedCommit): Promise<VisibleSessionCommitReceipt>;
	async commitVanished(input: VisibleSessionProjectedVanishedCommit): Promise<VisibleSessionCommitReceipt>;
	async commitVanished(
		input: VisibleSessionVanishedCommit | VisibleSessionProjectedVanishedCommit,
	): Promise<VisibleSessionCommitReceipt> {
		if (this.#projected) {
			if (!isProjectedVanishedCommit(input))
				throw new Error("Visible session projected vanished receipt is invalid");
			return this.#projected.vanished(input);
		}
		if (isProjectedVanishedCommit(input)) throw new Error("Visible session vanished receipt is invalid");
		return this.#legacy!.terminal(input, this.#legacy!.paths.vanished, this.#legacy!.paths.final, "vanished");
	}

	async claimCleanup(claimant: string): Promise<VisibleSessionPostCommitCleanup | null> {
		return this.#projected ? this.#projected.claimCleanup(claimant) : this.#legacy!.claimCleanup(claimant);
	}

	async ackCleanup(claimant: string): Promise<void> {
		return this.#projected ? this.#projected.ackCleanup(claimant) : this.#legacy!.ackCleanup(claimant);
	}

	async revokeCleanup(claimant: string): Promise<void> {
		return this.#projected ? this.#projected.revokeCleanup(claimant) : this.#legacy!.revokeCleanup(claimant);
	}
}
