import { bridge, defaultOptions, WorkerPool } from "../runtime.js";
import { UIRenderer } from "./ui-renderer.js";

export const EXAMPLES = ["counter", "todo", "timer", "widgets"];

const $ = (id) => document.getElementById(id);
const out = $("out");
const status = $("status");
const appEl = $("app");

const options = { ...defaultOptions(), files: { "ui.py": new URL("ui.py", location.href).href } };
const pool = new WorkerPool(options);
let active = null;

const renderer = new UIRenderer(appEl, (id, args) => active?.sendUIEvent(id, args));

function append(stream, text) {
  const span = document.createElement("span");
  span.className = stream;
  span.textContent = text;
  out.append(span);
  out.scrollTop = out.scrollHeight;
}

async function loadExample(name) {
  const res = await fetch(`examples/${name}.py`);
  $("code").value = await res.text();
}

/** Runs code in a fresh worker; a UI app keeps running after the script ends. */
export async function runCode(code) {
  closeApp();
  const worker = await pool.take();
  active = worker;
  worker.onOutput = append;
  worker.onUIRender = (json) => {
    renderer.render(json);
    appEl.classList.add("open");
  };
  status.textContent = "running";
  const result = await worker.run(code, "main.py");
  if (!result.ok) append("stderr", result.error);
  status.textContent = result.ok ? `script finished in ${result.ms.toFixed(0)} ms` : "failed";
  return result;
}

function closeApp() {
  active?.terminate("closed");
  active = null;
  renderer.clear();
  appEl.classList.remove("open");
}

for (const name of EXAMPLES) $("example").append(new Option(name, name));
$("example").onchange = () => loadExample($("example").value);
$("run").onclick = () => runCode($("code").value);
$("stop").onclick = () => active?.stop();
$("close").onclick = closeApp;
await loadExample(EXAMPLES[0]);
pool.spare.ready.then(
  (info) => { status.textContent = `ready (boot ${info.bootMs.toFixed(0)} ms)`; },
  (err) => { status.textContent = "boot failed"; append("stderr", String(err)); },
);

const autorun = location.hash.match(/^#run=(\w+)/)?.[1];
if (autorun) {
  await loadExample(autorun);
  runCode($("code").value);
}

if (location.hash.startsWith("#selftest")) {
  const { selftest } = await import("./selftest.js");
  const results = await selftest({ pool, runCode, renderer, appEl, append, closeApp });
  await bridge("result", JSON.stringify(results, null, 2));
}
