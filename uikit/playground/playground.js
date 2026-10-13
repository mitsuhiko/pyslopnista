// Playground: pick an example, edit it, run it in a fresh worker, see the app.
import { UIRenderer } from "../web/renderer.js";

const INDEX_URL = new URL("/pyodide/", location.href).href;
// Only the core is vendored; packages like matplotlib come from the CDN.
const PACKAGES_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const UI_URL = new URL("../python/ui.py", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const consoleEl = $("console");
const statusEl = $("status");
const codeEl = $("code");

class Py {
  constructor() {
    this.worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
    this.onOutput = () => {};
    this.onRender = () => {};
    this.pending = null;
    this.evals = new Map();
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.postMessage({ type: "boot", indexURL: INDEX_URL, packageBaseUrl: PACKAGES_URL, uiUrl: UI_URL });
  }

  handle(msg) {
    if (msg.type === "ready") this.resolveReady(msg);
    else if (msg.type === "output") this.onOutput(msg.stream, msg.text);
    else if (msg.type === "ui-render") this.onRender(msg.tree);
    else if (msg.type === "done") this.pending?.(msg);
    else if (msg.type === "eval-result") {
      const done = this.evals.get(msg.id);
      this.evals.delete(msg.id);
      done?.(msg);
    }
  }

  run(code, filename) {
    return new Promise((resolve) => {
      this.pending = resolve;
      this.worker.postMessage({ type: "run", code, filename });
    });
  }

  eval(code) {
    const id = Math.random();
    return new Promise((resolve, reject) => {
      this.evals.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.value)));
      this.worker.postMessage({ type: "eval", id, code });
    });
  }

  send(id, args) {
    this.worker.postMessage({ type: "ui-event", id, args });
  }
}

function log(stream, text) {
  const span = document.createElement("span");
  span.className = stream;
  span.textContent = text;
  consoleEl.append(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

let spare = new Py();
spare.ready.then((info) => (statusEl.textContent = `Python ${info.version} ready (${info.bootMs.toFixed(0)} ms)`));

export const pg = {
  py: null,
  renderer: null,
  output: "",
  /** Run code in a fresh interpreter; resolves when the script returned. */
  async run(code, filename = "app.py") {
    this.py?.worker.terminate();
    const py = (this.py = spare);
    spare = new Py();
    consoleEl.replaceChildren();
    this.output = "";
    py.onOutput = (stream, text) => {
      this.output += text;
      log(stream, text);
    };
    await py.ready;
    this.renderer?.clear();
    this.renderer = new UIRenderer(appEl, (id, args) => py.send(id, args));
    this.renderer.onRendered = (...a) => this.onRendered?.(...a);
    py.onRender = (json) => this.renderer.render(json);
    const t0 = performance.now();
    const result = await py.run(code, filename);
    statusEl.textContent = `${filename}: ${result.ok ? "ran" : "failed"} in ${(performance.now() - t0).toFixed(0)} ms`;
    return result;
  },
  onRendered: null,
};
window.pg = pg;

async function loadExample(name) {
  const code = await (await fetch(new URL(`../examples/${encodeURIComponent(name)}.py`, import.meta.url))).text();
  codeEl.value = code;
  for (const b of $("examples").children) b.classList.toggle("active", b.textContent === name);
  history.replaceState(null, "", `#${encodeURIComponent(name)}`);
  return pg.run(code, `${name}.py`);
}
pg.loadExample = loadExample;

const names = await (await fetch(new URL("../examples/index.json", import.meta.url))).json();
for (const name of names) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => loadExample(name);
  $("examples").append(b);
}
$("run").onclick = () => pg.run(codeEl.value, "app.py");
codeEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) pg.run(codeEl.value, "app.py");
  if (e.key === "Tab") {
    e.preventDefault();
    codeEl.setRangeText("    ", codeEl.selectionStart, codeEl.selectionEnd, "end");
  }
});

const hash = decodeURIComponent(location.hash.slice(1));
if (hash.startsWith("selftest")) {
  const { selftest } = await import("./selftest.js");
  window.__selftest = await selftest(pg, new URLSearchParams(hash.slice("selftest".length).replace(/^[&?]/, "")));
  console.log("SELFTEST " + JSON.stringify(window.__selftest));
} else {
  await loadExample(names.includes(hash) ? hash : names[0]);
}
