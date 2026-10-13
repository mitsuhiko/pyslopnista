// One Pyodide interpreter per worker. The page talks to it with messages;
// blocking calls back to the page (stdin, synchronous host calls) use a
// SharedArrayBuffer channel and Atomics.wait.
import "./sab-polyfill.js";
import { loadPyodide } from "./pyodide/pyodide.mjs";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
let py;
let syncChannel; // Int32Array view: [state, length], payload from byte 8
let nextCallId = 0;
const pendingCalls = new Map();

function syncCall(op, value) {
  const ints = new Int32Array(syncChannel, 0, 2);
  Atomics.store(ints, 0, 0);
  postMessage({ type: "call", sync: true, op, value });
  Atomics.wait(ints, 0, 0);
  const bytes = new Uint8Array(syncChannel, 8, ints[1]).slice();
  const reply = JSON.parse(decoder.decode(bytes));
  if (reply.interrupted) {
    py.checkInterrupt(); // raises KeyboardInterrupt if the page set the interrupt buffer
    return null;
  }
  if (reply.error) throw new Error(reply.error);
  return reply.value;
}

function asyncCall(op, value) {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    postMessage({ type: "call", sync: false, id, op, value });
  });
}

function writer(stream) {
  return {
    write(buf) {
      postMessage({ type: "output", stream, text: decoder.decode(buf) });
      return buf.length;
    },
  };
}

async function boot({ interrupt, channel, jspi, gcTrampoline }) {
  syncChannel = channel;
  // CPython's Emscripten build sniffs the UA and on iOS falls back to a JS call
  // trampoline (gh-130418, for WebKit bug 293113, fixed upstream in 2025). The
  // JS trampoline puts JS frames on every C function-pointer call, which makes
  // JSPI suspension impossible. Hiding the iOS UA selects the wasm-gc trampoline.
  if (gcTrampoline) {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
  }
  // WebKit exposes JSPI but Pyodide's run_sync hangs with it (see README), so
  // hide it unless explicitly requested. Pyodide checks at load time.
  if (!jspi) {
    delete WebAssembly.Suspending;
    delete WebAssembly.promising;
  }
  const interruptInts = new Int32Array(interrupt);
  const t0 = performance.now();
  py = await loadPyodide({
    indexURL: new URL("/pyodide/", location.href).href,
    packageBaseUrl: new URL("/pkgs/", location.href).href,
    stdout: (s) => postMessage({ type: "output", stream: "stdout", text: s + "\n" }),
    stderr: (s) => postMessage({ type: "output", stream: "stderr", text: s + "\n" }),
  });
  py.setStdout(writer("stdout"));
  py.setStderr(writer("stderr"));
  py.setStdin({ stdin: () => syncCall("stdin", null) ?? undefined }); // autoEOF: one line per read
  py.setInterruptBuffer(interruptInts);
  py.registerJsModule("host", {
    call: (op, value) => asyncCall("host", { op, value: value?.toJs?.() ?? value }),
    call_sync: (op, value) => syncCall("host", { op, value: value?.toJs?.() ?? value }),
    // Sleeps without burning CPU; the page's stop() notifies the interrupt
    // buffer, which wakes this immediately.
    sleep: (seconds) => {
      Atomics.wait(interruptInts, 0, 0, Math.max(0, seconds * 1000));
      py.checkInterrupt();
    },
  });
  py.runPython([
    "import time, host, pyodide.webloop",
    "time.sleep = pyodide.webloop._orig_sleep = host.sleep",
    "del time, host",
  ].join("\n"));
  const bootMs = performance.now() - t0;
  postMessage({ type: "ready", bootMs, version: py.version, jspi: typeof WebAssembly.Suspending, gcTrampoline: !!gcTrampoline });
}

async function run({ code, filename }) {
  const t0 = performance.now();
  try {
    await py.loadPackagesFromImports(code, {
      messageCallback: (m) => postMessage({ type: "output", stream: "system", text: m + "\n" }),
      errorCallback: (m) => postMessage({ type: "output", stream: "stderr", text: m + "\n" }),
    });
    const loadMs = performance.now() - t0;
    const result = await py.runPythonAsync(code, { filename: filename ?? "<main>" });
    const repr = result === undefined ? null : String(result);
    result?.destroy?.();
    postMessage({ type: "done", ok: true, result: repr, ms: performance.now() - t0, loadMs });
  } catch (e) {
    postMessage({ type: "done", ok: false, error: String(e.message ?? e), ms: performance.now() - t0 });
  }
}

onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "boot":
      try {
        await boot(msg);
      } catch (err) {
        postMessage({ type: "boot-failed", error: String(err.stack ?? err) });
      }
      break;
    case "run":
      await run(msg);
      break;
    case "call-reply": {
      const pending = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.value);
      break;
    }
  }
};
