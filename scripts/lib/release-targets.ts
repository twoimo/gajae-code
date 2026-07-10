export interface BinaryTarget {
	id: string;
	platform: string;
	arch: string;
	target: string;
	outfile: string;
	rustTriple: string;
}

export const releaseTargets: BinaryTarget[] = [
	{
		id: "darwin-arm64",
		platform: "darwin",
		arch: "arm64",
		target: "bun-darwin-arm64",
		outfile: "packages/coding-agent/binaries/gjc-darwin-arm64",
		rustTriple: "aarch64-apple-darwin",
	},
	{
		id: "darwin-x64",
		platform: "darwin",
		arch: "x64",
		target: "bun-darwin-x64-baseline",
		outfile: "packages/coding-agent/binaries/gjc-darwin-x64",
		rustTriple: "x86_64-apple-darwin",
	},
	{
		id: "linux-x64",
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-baseline",
		outfile: "packages/coding-agent/binaries/gjc-linux-x64",
		rustTriple: "x86_64-unknown-linux-gnu",
	},
	{
		id: "linux-arm64",
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64",
		outfile: "packages/coding-agent/binaries/gjc-linux-arm64",
		rustTriple: "aarch64-unknown-linux-gnu",
	},
	{
		id: "win32-x64",
		platform: "win32",
		arch: "x64",
		target: "bun-windows-x64-modern",
		outfile: "packages/coding-agent/binaries/gjc-windows-x64.exe",
		rustTriple: "x86_64-pc-windows-msvc",
	},
];
