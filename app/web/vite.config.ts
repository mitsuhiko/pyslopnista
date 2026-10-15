import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const PYODIDE_VERSION = "314.0.7";
const PYODIDE_DIR = join(import.meta.dirname, "..", "vendor", `pyodide-${PYODIDE_VERSION}`);

const HOP_HEADERS = new Set(["host", "origin", "referer", "connection", "content-length", "accept-encoding", "x-pyslop-headers", "cookie"]);
const DROPPED = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy"]);

async function proxyHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const target = new URL(req.url!, "http://x").searchParams.get("url");
  if (!target || !/^https?:/.test(target)) {
    res.statusCode = 400;
    return res.end("bad proxy request");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(name) && !name.startsWith("sec-") && typeof value === "string") headers[name] = value;
  }
  const hidden = req.headers["x-pyslop-headers"];
  if (typeof hidden === "string") for (const [name, value] of Object.entries(JSON.parse(hidden))) headers[name.toLowerCase()] = String(value);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const r = await fetch(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "follow" });
    res.statusCode = r.status;
    r.headers.forEach((value, name) => !DROPPED.has(name) && res.setHeader(name, value));
    res.setHeader("X-Pyslop-Final-Url", r.url);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    const message = String((e as Error).cause ?? e).replace(/\n/g, " ");
    res.statusCode = 502;
    res.setHeader("X-Pyslop-Error", message);
    res.end(message);
  }
}

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
        if (url.startsWith("/pypi/simple/")) {
          // Same contract as the iOS host: Simple JSON API with file URLs pointing back here.
          const project = url.slice("/pypi/simple/".length).replace(/\/$/, "");
          fetch(`https://pypi.org/simple/${project}/`, { headers: { Accept: "application/vnd.pypi.simple.v1+json" } })
            .then(async (r) => {
              const body = (await r.text()).replaceAll("https://files.pythonhosted.org/", "/pypi-files/");
              res.statusCode = r.status;
              res.setHeader("Content-Type", "application/vnd.pypi.simple.v1+json");
              res.end(body);
            })
            .catch((e) => { res.statusCode = 502; res.end(String(e)); });
          return;
        }
        if (url === "/__http") {
          // HTTP for Python programs, same contract as the iOS host (D25).
          void proxyHttp(req, res);
          return;
        }
        if (url.startsWith("/pypi-files/")) {
          fetch(`https://files.pythonhosted.org/${url.slice("/pypi-files/".length)}`)
            .then(async (r) => {
              res.statusCode = r.status;
              res.end(Buffer.from(await r.arrayBuffer()));
            })
            .catch((e) => { res.statusCode = 502; res.end(String(e)); });
          return;
        }
        next();
      });
    },
  };
}

const PI_AI = join(import.meta.dirname, "node_modules/@earendil-works/pi-ai/dist");

export default defineConfig({
  plugins: [hostShim()],
  base: "/",
  resolve: {
    alias: [
      // The agent's sign-in flows (D33): pi-ai loads them through an import()
      // bundlers can't follow, and they are not in its exports; we import
      // them directly and register them like pi-ai's Bun build does.
      { find: /^@oauth\/(.*)$/, replacement: `${PI_AI}/auth/oauth/$1` },
      // Two flows import Node built-ins: the loopback callback server (on the
      // host's listener) and randomBytes.
      { find: "node:http", replacement: join(import.meta.dirname, "src/agent/shims/http.ts") },
      { find: "node:crypto", replacement: join(import.meta.dirname, "src/agent/shims/crypto.ts") },
    ],
  },
  // Two pages, no UI framework (D31): the engine (Python + analysis, no UI)
  // and the editor (one CodeMirror pane). Everything else is native.
  build: {
    outDir: "dist",
    target: "es2023",
    sourcemap: true,
    rollupOptions: { input: { engine: join(import.meta.dirname, "engine.html"), editor: join(import.meta.dirname, "editor.html") } },
  },
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
