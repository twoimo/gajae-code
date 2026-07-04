import { defineConfig } from "vite";

export default defineConfig({
	esbuild: {
		target: "esnext",
		tsconfigRaw: {
			compilerOptions: {
				target: "ESNext",
			},
		},
	},
	build: {
		target: "esnext",
	},
	server: {
		port: 5178,
		strictPort: true,
	},
	preview: {
		port: 4178,
		strictPort: true,
	},
});
