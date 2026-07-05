import { defineConfig, type Plugin } from "vite";

// Tauri's asset protocol serves the frontend from a custom origin; Vite's
// default `crossorigin` attribute on the emitted module/style tags makes the
// webview fetch them in CORS mode, which fails there and yields a white
// screen. Strip `crossorigin` from the built index.html so the packaged app
// loads its bundle.
function stripCrossorigin(): Plugin {
	return {
		name: "strip-crossorigin",
		transformIndexHtml(html) {
			return html.replaceAll(" crossorigin", "");
		},
	};
}

export default defineConfig({
	// Relative asset URLs so the built frontend loads under Tauri's asset
	// protocol (absolute /assets/* whitescreens in the packaged app).
	base: "./",
	plugins: [stripCrossorigin()],
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
