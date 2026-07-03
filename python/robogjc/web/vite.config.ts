import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite writes the bundle into `web/dist/`. The Rust robogjc service serves the
// dashboard from `/app/static` in the Docker image and falls back to
// `python/robogjc/web/dist` in source checkouts, so `dist/` is the only local
// build artifact.
const outDir = path.resolve(dirname, "dist");

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  base: "/static/",
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Hashed filenames so the server can cache `/static/*` aggressively;
        // today the bundle is small enough that one chunk is fine.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
      "/events": "http://localhost:8080",
      "/issues": "http://localhost:8080",
    },
  },
});
