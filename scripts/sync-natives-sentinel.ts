#!/usr/bin/env bun
/**
 * Sync (or check) the pi-natives version sentinel against the current
 * `@gajae-code/natives` package version.
 *
 *   bun scripts/sync-natives-sentinel.ts          # fix: rewrite the 3 sentinel files
 *   bun scripts/sync-natives-sentinel.ts --check  # CI: fail if drifted, touch nothing
 *
 * Run the bare form after any version bump that didn't go through the full
 * `scripts/release.ts` flow (manual bump, branch rebase). The `--check` form is
 * wired into `check:ts` so CI rejects drift before it can brick a compiled
 * binary. Both delegate to `scripts/lib/bump-natives-sentinel.ts`.
 */
import { bumpNativesSentinel, verifyNativesSentinel } from "./lib/bump-natives-sentinel.ts";

const isCheck = process.argv.includes("--check");

if (isCheck) {
	const sentinelName = await verifyNativesSentinel();
	console.log(`✅ pi-natives version sentinel in sync (${sentinelName})`);
} else {
	const { sentinelName, changed, files } = await bumpNativesSentinel();
	if (changed) {
		console.log(`Bumped pi-natives version sentinel to ${sentinelName}:`);
		for (const f of files) if (f.changed) console.log(`  ✏  ${f.path}`);
	} else {
		console.log(`pi-natives version sentinel already in sync (${sentinelName})`);
	}
}
