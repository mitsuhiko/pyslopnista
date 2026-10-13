import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const PYODIDE_VERSION = "314.0.7";
const PYODIDE_DIR = join(import.meta.dirname, "..", "vendor", `pyodide-${PYODIDE_VERSION}`);

// Mirrors the iOS host for `npm run dev`: cross-origin isolation headers on
// everything, /pyodide/ from the vendored core, /pkgs/ proxied to the CDN.
function hostShim(): Plugin {
  return {
    name: "pyslopnista-host-shim",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        const url = req.url?.split("?")[0] ?? "";
        if (url.startsWith("/pyodide/")) {
          const file = join(PYODIDE_DIR, url.slice("/pyodide/".length));
          if (existsSync(file) && statSync(file).isFile()) {
            const type = file.endsWith(".wasm") ? "application/wasm" : file.endsWith("js") ? "text/javascript" : "application/octet-stream";
            res.setHeader("Content-Type", type);
            createReadStream(file).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), hostShim()],
  base: "/",
  build: { outDir: "dist", target: "es2023", sourcemap: true },
  server: {
    proxy: {
      "/pkgs": {
        target: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pkgs/, ""),
      },
    },
  },
});
