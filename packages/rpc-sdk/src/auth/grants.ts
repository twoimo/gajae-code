import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapabilityScope, RedactionPolicy } from "../protocol/generated";

export type Principal = { kind: "unix"; uid: number; gid: number; pid?: number } | { kind: "native_tui_self" } | { kind: "bearer"; bearer_hash: string };
export interface GrantRecord { version: number; grantId: string; principalBinding: Principal; bearerHash?: string; issuedAt: string; expiresAt: string; renewableUntil: string; revokedAt?: string; issuer: string; purpose: string; sessions: string[]; scopes: CapabilityScope[]; redactionPolicy: RedactionPolicy; limits?: { maxSessions?: number; maxQueue?: number; maxReplay?: number }; audit?: { lastUsedAt?: string; denialCount?: number; renewalCount?: number } }
export function grantsDirectory(stateRoot = join(homedir(), ".gjc", "state")): string { return join(stateRoot, "rpc-sdk", "grants"); }

async function validateGrantDirectory(dir: string): Promise<void> {
	const info = await stat(dir);
	if (!info.isDirectory()) throw new Error(`grant path ${dir} is not a directory`);
	if ((info.mode & 0o077) !== 0) throw new Error(`grant directory ${dir} must not be group/world accessible`);
	const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (currentUid !== undefined && info.uid !== currentUid) throw new Error(`grant directory ${dir} must be owned by uid ${currentUid}, found ${info.uid}`);
}

export async function ensureGrantDirectory(stateRoot?: string): Promise<string> {
	const dir = grantsDirectory(stateRoot);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await validateGrantDirectory(dir);
	return dir;
}
export async function loadGrant(grantId: string, stateRoot?: string): Promise<GrantRecord> {
	const dir = grantsDirectory(stateRoot);
	await validateGrantDirectory(dir);
	const path = join(dir, `${grantId}.json`);
	const info = await stat(path);
	if ((info.mode & 0o077) !== 0) throw new Error(`grant file ${path} must not be group/world accessible`);
	const parsed = JSON.parse(await readFile(path, "utf8")) as GrantRecord;
	if (parsed.grantId !== grantId) throw new Error(`grant id mismatch: expected ${grantId}, found ${parsed.grantId}`);
	return parsed;
}
export function isGrantUsable(grant: GrantRecord, now = new Date()): boolean { return !grant.revokedAt && new Date(grant.expiresAt).getTime() > now.getTime(); }
