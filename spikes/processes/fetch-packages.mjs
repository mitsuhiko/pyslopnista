// Downloads the wheels the tests use (numpy) for each bundled Pyodide into
// build/pkgs-<version>/, from the CDN pinned in app/runtimes.json.
//   node fetch-packages.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../app");
const { runtimes } = JSON.parse(fs.readFileSync(path.join(app, "runtimes.json"), "utf8"));
const WANTED = ["numpy"];

for (const rt of runtimes) {
  const lockPath = path.join(app, "vendor", `pyodide-${rt.pyodide}`, "pyodide-lock.json");
  if (!fs.existsSync(lockPath)) continue;
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const dest = path.join(here, "build", `pkgs-${rt.pyodide}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of WANTED) {
    const pkg = lock.packages[name];
    if (!pkg) {
      console.log(`${rt.pyodide}: no ${name}`);
      continue;
    }
    for (const dep of [name, ...(pkg.depends ?? [])]) {
      const file = lock.packages[dep].file_name;
      const target = path.join(dest, file);
      if (fs.existsSync(target)) continue;
      const res = await fetch(rt.cdn + file);
      if (!res.ok) throw new Error(`${file}: ${res.status}`);
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      console.log(`${rt.pyodide}: ${file}`);
    }
  }
}
