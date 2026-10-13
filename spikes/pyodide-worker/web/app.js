import { bridge, WorkerPool } from "./runtime.js";

const $ = (id) => document.getElementById(id);
const out = $("out");
const status = $("status");
const stdinField = $("stdin");
const pool = new WorkerPool();
let active = null;

function append(stream, text) {
  const span = document.createElement("span");
  span.className = stream;
  span.textContent = text;
  out.append(span);
  out.scrollTop = out.scrollHeight;
}

function askInput() {
  stdinField.style.display = "block";
  stdinField.focus();
  return new Promise((resolve) => {
    stdinField.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const text = stdinField.value;
      stdinField.value = "";
      stdinField.style.display = "none";
      append("input", text + "\n");
      resolve(text + "\n");
    };
  });
}

async function runCode(code, { onInput = askInput, onOutput = append, onStart } = {}) {
  active?.terminate();
  const worker = await pool.take();
  active = worker;
  worker.onOutput = onOutput;
  worker.onInput = onInput;
  status.textContent = "running";
  const resultPromise = worker.run(code);
  onStart?.();
  const result = await resultPromise;
  stdinField.style.display = "none";
  if (!result.ok) append("stderr", result.error);
  status.textContent = `${result.ok ? "done" : "failed"} in ${result.ms.toFixed(0)} ms`;
  return result;
}

$("run").onclick = () => runCode($("code").value);
$("stop").onclick = () => active?.stop();
$("clear").onclick = () => { out.textContent = ""; };
pool.spare.ready.then(
  (info) => { status.textContent = `ready (Python ${info.version}, boot ${info.bootMs.toFixed(0)} ms)`; },
  (err) => { status.textContent = "boot failed"; append("stderr", String(err)); },
);

if (location.hash.startsWith("#selftest")) {
  let only = location.hash.split("=")[1]?.split(",").filter(Boolean);
  if (only && !only.length) only = undefined;
  const { selftest } = await import("./selftest.js");
  const results = await selftest({ pool, runCode, append, stop: () => active?.stop(), only });
  await bridge("result", JSON.stringify(results, null, 2));
}
