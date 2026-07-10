export const RECENT_DIRECTORIES_KEY = "gjc-gui.recentDirectories";
export const MAX_RECENT_DIRECTORIES = 8;
export const DEFAULT_CWD = "/tmp";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function normalizeDirectoryInput(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (!(trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed))) return "";
	// Strip trailing separators (keep the root itself) so "/tmp/" === "/tmp".
	const stripped = trimmed.replace(/(?<=[^\\/:])[\\/]+$/, "");
	return stripped;
}

export function basename(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).pop() || normalized || path;
}

export function recentDirectoryDisplay(path: string, maxLength = 32): string {
	const redactedPath = redactDirectoryPath(path);
	const name = basename(redactedPath);
	const display = name && name !== redactedPath ? `${name} — ${redactedPath}` : name || redactedPath;
	return display.length > maxLength ? `${display.slice(0, Math.max(1, maxLength - 1))}…` : display;
}

export function readRecentDirectories(storage: StorageLike, key = RECENT_DIRECTORIES_KEY): string[] {
	try {
		const parsed = JSON.parse(storage.getItem(key) ?? "[]");
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string").slice(0, MAX_RECENT_DIRECTORIES)
			: [];
	} catch {
		return [];
	}
}

export function rememberDirectoryValue(current: string[], directory: string): string[] {
	return [directory, ...current.filter(existing => existing !== directory)].slice(0, MAX_RECENT_DIRECTORIES);
}

export function writeRecentDirectories(
	storage: StorageLike,
	directories: string[],
	key = RECENT_DIRECTORIES_KEY,
): void {
	storage.setItem(key, JSON.stringify(directories.slice(0, MAX_RECENT_DIRECTORIES)));
}

export function redactDirectoryPath(value: string): string {
	return redactHomePath(value);
}
function redactHomePath(value: string): string {
	return value
		.replace(/^\/Users\/[^/]+/i, "~")
		.replace(/^\/home\/[^/]+/i, "~")
		.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+([\\/]|$)/, (_match, sep: string) => (sep ? `~${sep}` : "~"));
}
