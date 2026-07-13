/**
 * pi-natives version-sentinel sync — the single source of truth.
 *
 * Background
 * ----------
 * The native-addon loader (`packages/natives/native/loader-state.js`) derives,
 * at load time, the symbol name it demands from `package.json#version`:
 *
 *     __piNativesV + version.replace(/[^A-Za-z0-9]/g, "_")
 *
 * The Rust addon must export that exact name via `#[napi(js_name = "…")]`
 * (`crates/pi-natives/src/lib.rs`), and the generated
 * `packages/natives/native/{index.js,index.d.ts}` re-export it. If any of these
 * drifts from the package version, the compiled binary refuses to load the
 * `.node` with:
 *
 *     "Loaded … but it does not expose the @gajae-code/natives@<ver> version
 *      sentinel `__piNativesV…`. The .node file on disk is from a different
 *      release than this loader — reinstall to re-sync."
 *
 * Historically only `scripts/release.ts` bumped the sentinel, so any version
 * change that skipped the full release (a manual bump, a branch rebase) silently
 * desynced it and bricked the binary. Because the sentinel is a pure function of
 * the version, this module owns the derivation so every caller — `release.ts`,
 * the `sync-natives-sentinel` CLI, and the CI `--check` gate — stays in lockstep
 * and drift can no longer ship silently.
 */

const SENTINEL_FILES = [
	"crates/pi-natives/src/lib.rs",
	"packages/natives/native/index.d.ts",
	"packages/natives/native/index.js",
] as const;

/** Matches any `__piNativesV<id>` token (the `id` run is alnum/underscore). */
const SENTINEL_PATTERN = /__piNativesV[A-Za-z0-9_]+/g;

const NATIVES_PACKAGE_JSON = "packages/natives/package.json";

/** Compute the sentinel symbol name the loader expects for a given version. */
export function sentinelNameFor(version: string): string {
	return `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** Read the canonical version from `@gajae-code/natives`'s package.json. */
export async function readNativesVersion(): Promise<string> {
	const pkg = (await Bun.file(NATIVES_PACKAGE_JSON).json()) as { version: string };
	return pkg.version;
}

export interface SentinelBumpResult {
	/** The sentinel symbol name the addon must export for this version. */
	sentinelName: string;
	/** `true` if at least one file was rewritten; `false` if already in sync. */
	changed: boolean;
	/** Per-file rewrite status, in `SENTINEL_FILES` order. */
	files: { path: string; changed: boolean }[];
}

/**
 * Read-only check: throws if any sentinel-bearing file drifted from the given
 * version (defaults to the current `@gajae-code/natives` package version). Used
 * by the CI `--check` gate so drift fails the build instead of bricking the
 * compiled binary at runtime.
 */
export async function verifyNativesSentinel(version?: string): Promise<string> {
	const ver = version ?? (await readNativesVersion());
	const expected = sentinelNameFor(ver);
	const problems: string[] = [];

	for (const file of SENTINEL_FILES) {
		const text = await Bun.file(file).text();
		if (!text.includes(expected)) {
			problems.push(`  - ${file}: missing \`${expected}\``);
		}
	}

	// The Rust macro literal is the load-bearing one — it is the symbol the
	// `.node` actually exports. Call it out explicitly so a hand-edited macro
	// that moved the `__piNativesV…` token out of `js_name` is caught.
	const libRs = await Bun.file(SENTINEL_FILES[0]).text();
	if (!libRs.includes(`js_name = "${expected}"`)) {
		problems.push(
			`  - ${SENTINEL_FILES[0]}: missing \`js_name = "${expected}"\` (the Rust macro literal the addon exports)`,
		);
	}

	if (problems.length > 0) {
		throw new Error(
			`pi-natives version sentinel out of sync for @gajae-code/natives@${ver} (expected \`${expected}\`):\n` +
				`${problems.join("\n")}\n` +
				`Fix: \`bun scripts/sync-natives-sentinel.ts\``,
		);
	}
	return expected;
}

/**
 * Rewrite every sentinel-bearing file so the exported symbol matches the given
 * version (defaults to the current `@gajae-code/natives` package version).
 * Idempotent: files already in sync are left untouched. Always verifies after
 * writing, so a missing `__piNativesV…` token (e.g. a hand-edited Rust macro)
 * surfaces as a loud error rather than a silently stale build.
 */
export async function bumpNativesSentinel(version?: string): Promise<SentinelBumpResult> {
	const ver = version ?? (await readNativesVersion());
	const sentinelName = sentinelNameFor(ver);
	const files: SentinelBumpResult["files"] = [];
	let changed = false;

	for (const file of SENTINEL_FILES) {
		const before = await Bun.file(file).text();
		// Fresh regex per file: a /g regex literal carries stateful `lastIndex`
		// across .exec/.test, so reusing one instance is a latent footgun.
		const after = before.replace(SENTINEL_PATTERN, sentinelName);
		const fileChanged = after !== before;
		if (fileChanged) {
			await Bun.write(file, after);
			changed = true;
		}
		files.push({ path: file, changed: fileChanged });
	}

	await verifyNativesSentinel(ver);
	return { sentinelName, changed, files };
}
