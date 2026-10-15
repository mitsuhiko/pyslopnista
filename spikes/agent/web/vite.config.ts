import { join } from "node:path";
import { defineConfig } from "vite";

const piAi = join(import.meta.dirname, "node_modules/@earendil-works/pi-ai/dist");

export default defineConfig({
  base: "/",
  resolve: {
    alias: [
      // pi-ai loads its OAuth flows through an import() bundlers can't follow;
      // we import them directly (they are not in the package's exports) and
      // register them like the Bun build does.
      { find: /^@oauth\/(.*)$/, replacement: `${piAi}/auth/oauth/$1` },
      // Two flows import Node built-ins: the loopback server and randomBytes.
      { find: "node:http", replacement: join(import.meta.dirname, "src/shims/http.ts") },
      { find: "node:crypto", replacement: join(import.meta.dirname, "src/shims/crypto.ts") },
    ],
  },
  build: { outDir: "dist", target: "es2023", sourcemap: true },
});
