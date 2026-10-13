// Runs probe.py in Pyodide on a worker thread; this main thread plays the page.
// Usage: node node-run.mjs   (expects ../../app/vendor/pyodide-314.0.7)
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pyodideDir = path.resolve(here, "../../app/vendor/pyodide-314.0.7");

if (isMainThread) {
  const interrupt = new Int32Array(new SharedArrayBuffer(4));
  const command = new SharedArrayBuffer(8 + 64 * 1024); // [state, length] + JSON
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { interrupt: interrupt.buffer, command } });
  const ints = new Int32Array(command, 0, 2);
  const send = (cmd) => {
    const bytes = new TextEncoder().encode(JSON.stringify(cmd));
    new Uint8Array(command, 8).set(bytes);
    ints[1] = bytes.length;
    Atomics.store(ints, 0, 1);
    Atomics.notify(ints, 0);
  };
  // Script the debugging session the page would drive.
  const script = [
    { op: "eval", expr: "name" },
    { op: "next" }, // -> line 3
    { op: "eval", expr: "message.upper()" },
    { op: "eval", expr: "undefined_name" },
    { op: "continue" }, // -> second call stops at line 2 again
    { op: "eval", expr: "name" },
    { op: "continue" },
    // E: paused via SIGUSR1 inside spin()
    { op: "eval", expr: "i > 0" },
    { op: "next" },
    { op: "continue" },
  ];
  worker.on("message", (msg) => {
    const event = JSON.parse(msg);
    if (event.kind === "results") {
      console.log(JSON.stringify(event, null, 2));
      worker.terminate();
      return;
    }
    console.log("event:", JSON.stringify(event));
    if (event.kind === "ready-for-pause") {
      // A "Pause" button: deliver SIGUSR1 (10) through Pyodide's interrupt buffer.
      setTimeout(() => {
        const t = performance.now();
        Atomics.store(interrupt, 0, 10);
        console.log(`sent SIGUSR1 at +${(t / 1000).toFixed(2)}s`);
      }, 200);
    } else if (event.kind === "stopped" || event.kind === "value") {
      const next = script.shift();
      console.log("  page ->", JSON.stringify(next));
      send(next);
    }
  });
  worker.on("error", (e) => console.error("worker error:", e));
} else {
  const { loadPyodide } = await import(path.join(pyodideDir, "pyodide.mjs"));
  const py = await loadPyodide({ indexURL: pyodideDir + "/" });
  py.setStdout({ batched: (s) => parentPort.postMessage(JSON.stringify({ kind: "stdout", text: s })) });
  py.setInterruptBuffer(new Int32Array(workerData.interrupt));
  const ints = new Int32Array(workerData.command, 0, 2);
  py.registerJsModule("dbghost", {
    report: (json) => parentPort.postMessage(json),
    read_file: (name) => readFileSync(path.join(here, name), "utf8"),
    wait_command: () => {
      Atomics.wait(ints, 0, 0);
      const text = new TextDecoder().decode(new Uint8Array(workerData.command, 8, ints[1]).slice());
      Atomics.store(ints, 0, 0);
      return text;
    },
  });
  py.runPython(readFileSync(path.join(here, "probe.py"), "utf8"), { filename: "probe.py" });
}
