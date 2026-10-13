// One Pyodide interpreter per worker (D6). The page talks to it with messages.
// Blocking calls back to the page (stdin, host.call_sync, time.sleep) use a
// SharedArrayBuffer channel and Atomics.wait (D13). Errors escaping Pyodide are
// reported as crashes (D16).
import "./sab-polyfill.js";

const decoder = new TextDecoder();
let py;
let syncChannel; // Int32Array view: [state, length], payload from byte 8
let nextCallId = 0;
const pendingCalls = new Map();
let uiDispatcher = null;
let manifest = new Map(); // path -> mtime of files synced into the project dir

function syncCall(op, value) {
  if (!syncChannel) throw new Error(`blocking call '${op}' needs cross-origin isolation`);
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

async function boot({ interrupt, channel, jspi, gcTrampoline, indexURL, packageBaseUrl, pythonFiles }) {
  syncChannel = channel;
  // CPython's Emscripten build falls back to a JS call trampoline on iOS, which
  // makes JSPI impossible; hiding the iOS UA selects the wasm-gc trampoline (D13).
  if (gcTrampoline) {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
  }
  if (!jspi) {
    delete WebAssembly.Suspending;
    delete WebAssembly.promising;
  }
  const interruptInts = interrupt ? new Int32Array(interrupt) : null;
  const t0 = performance.now();
  const { loadPyodide } = await import(new URL("pyodide.mjs", indexURL).href);
  py = await loadPyodide({
    indexURL,
    packageBaseUrl,
    env: { HOME: "/home/pyodide", MPLBACKEND: "agg" },
    stdout: (s) => postMessage({ type: "output", stream: "stdout", text: s + "\n" }),
    stderr: (s) => postMessage({ type: "output", stream: "stderr", text: s + "\n" }),
  });
  py.setStdout(writer("stdout"));
  py.setStderr(writer("stderr"));
  py.setStdin({ stdin: () => (syncChannel ? syncCall("stdin", null) ?? undefined : undefined) });
  if (interruptInts) py.setInterruptBuffer(interruptInts);
  py.registerJsModule("host", {
    call: (op, value) => asyncCall("host", { op, value: value?.toJs?.() ?? value }),
    call_sync: (op, value) => syncCall("host", { op, value: value?.toJs?.() ?? value }),
    // Sleeps without burning CPU; Stop notifies the interrupt buffer, which
    // wakes this early. KeyboardInterrupt is then raised by CPython's own signal
    // check right after we return, not thrown through JavaScript (which WebKit
    // reports as an uncaught worker error).
    sleep: (seconds) => {
      Atomics.wait(interruptInts, 0, 0, Math.max(0, seconds * 1000));
    },
  });
  py.registerJsModule("_pyslophost", {
    image: (b64) => postMessage({ type: "output", stream: "image", text: b64 }),
    status: (text) => postMessage({ type: "output", stream: "system", text: text + "\n" }),
  });
  py.registerJsModule("_uihost", {
    render: (json) => postMessage({ type: "ui-render", tree: json }),
    set_dispatcher: (fn) => {
      uiDispatcher?.destroy?.();
      uiDispatcher = fn;
    },
  });
  // Our runtime modules live outside the project dir.
  py.FS.mkdirTree("/lib/pyslop");
  for (const [name, url] of Object.entries(pythonFiles ?? {})) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
    py.FS.writeFile(`/lib/pyslop/${name}`, new Uint8Array(await res.arrayBuffer()));
  }
  py.runPython([
    "import sys",
    "sys.path.append('/lib/pyslop')",
    "import _pyslop",
    ...(interruptInts ? ["import time, host, pyodide.webloop", "time.sleep = pyodide.webloop._orig_sleep = host.sleep", "del time, host"] : []),
  ].join("\n"));
  postMessage({
    type: "ready", bootMs: performance.now() - t0, version: py.version,
    jspi: typeof WebAssembly.Suspending, gcTrampoline: !!gcTrampoline, isolated: !!syncChannel,
  });
}

/** Write the project's files into cwd and remember their mtimes. */
function syncIn(cwd, files) {
  py.FS.mkdirTree(cwd);
  manifest = new Map();
  for (const { path, data } of files) {
    const full = `${cwd}/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    py.FS.writeFile(full, data);
    manifest.set(path, py.FS.stat(full).mtime.getTime());
  }
}

/** Files under cwd that are new or modified since syncIn. */
function changedFiles(cwd) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of py.FS.readdir(dir)) {
      if (name === "." || name === ".." || name === "__pycache__") continue;
      const full = `${dir}/${name}`;
      const path = rel ? `${rel}/${name}` : name;
      const stat = py.FS.stat(full);
      if (py.FS.isDir(stat.mode)) walk(full, path);
      else if (manifest.get(path) !== stat.mtime.getTime()) out.push({ path, data: py.FS.readFile(full) });
    }
  };
  try {
    walk(cwd, "");
  } catch {
    // cwd may have been removed by the script
  }
  for (const f of out) manifest.set(f.path, Date.now());
  return out;
}

async function run({ code, filename, cwd, files, repl, indexURL }) {
  const t0 = performance.now();
  try {
    if (files && cwd) syncIn(cwd, files);
    if (cwd) {
      py.FS.mkdirTree(cwd);
      py.FS.chdir(cwd);
      py.runPython(`import sys\nif ${JSON.stringify(cwd)} not in sys.path: sys.path.insert(0, ${JSON.stringify(cwd)})\nsys.argv = [${JSON.stringify(filename ?? "")}]`);
    }
    if (!repl) {
      // Declared dependencies (PEP 723 or pyproject.toml) first, then
      // Pyodide packages that are imported but not declared.
      py.globals.set("__pyslop_src", code);
      py.globals.set("__pyslop_cwd", cwd ?? "/home/pyodide");
      py.globals.set("__pyslop_index", indexURL ?? new URL("/pypi/simple", location.href).href);
      await py.runPythonAsync("import _pyslop\nawait _pyslop.prepare_environment(__pyslop_src, __pyslop_cwd, __pyslop_index)\ndel __pyslop_src, __pyslop_cwd, __pyslop_index", { filename: "<dependencies>" });
    }
    await py.loadPackagesFromImports(code, {
      messageCallback: (m) => m.startsWith("Loading ") && postMessage({ type: "output", stream: "system", text: m.replace(/^Loading /, "Loading packages: ") + "\n" }),
      errorCallback: (m) => postMessage({ type: "output", stream: "stderr", text: m + "\n" }),
    });
    if (repl) {
      py.globals.set("__pyslop_src", code);
      await py.runPythonAsync("import _pyslop\nawait _pyslop.repl(__pyslop_src)", { filename: "<console>" });
    } else {
      const result = await py.runPythonAsync(code, { filename: filename ?? "<main>" });
      result?.destroy?.();
    }
    postMessage({ type: "done", ok: true, ms: performance.now() - t0, changed: cwd ? changedFiles(cwd) : [] });
  } catch (e) {
    postMessage({ type: "done", ok: false, error: String(e.message ?? e), ms: performance.now() - t0, changed: cwd ? changedFiles(cwd) : [] });
  }
}

// Errors escaping Pyodide are crashes (D16), except KeyboardInterrupt: it is a
// BaseException, so asyncio re-raises it out of the event loop after Stop.
function reportEscaped(error) {
  if (/KeyboardInterrupt\s*$/.test(error.trim())) return;
  postMessage({ type: "worker-error", error });
}
addEventListener("error", (e) => reportEscaped(String(e.message ?? e)));
addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  reportEscaped(String(e.reason?.message ?? e.reason));
});

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
    case "ui-event":
      if (uiDispatcher) uiDispatcher(msg.id, msg.args);
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
