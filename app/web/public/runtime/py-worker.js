// One Pyodide interpreter per worker (D6). The page talks to it with messages.
// Blocking calls back to the page (stdin, host.call_sync, time.sleep) use a
// SharedArrayBuffer channel and Atomics.wait (D13). Errors escaping Pyodide are
// reported as crashes (D16).
import "./sab-polyfill.js";

// HTTP for Python programs (D25): cross-origin XHR and fetch go through the
// host's /__http proxy, which makes the request natively (no CORS). requests
// (urllib3's Pyodide backend), urllib (pyodide-http) and pyfetch all use these.
{
  const PROXY = new URL("/__http", location.href).href;
  // Headers scripts may not set; the proxy sets them for us.
  const FORBIDDEN = new Set(["user-agent", "cookie", "referer", "origin", "host", "connection", "accept-encoding", "content-length"]);
  const proxied = (url) => {
    try {
      const u = new URL(url, location.href);
      return (u.protocol === "http:" || u.protocol === "https:") && u.origin !== location.origin ? `${PROXY}?url=${encodeURIComponent(u.href)}` : null;
    } catch {
      return null;
    }
  };
  const networkError = (message) => new DOMException(`Network error: ${message}`, "NetworkError");

  const NativeXHR = self.XMLHttpRequest;
  self.XMLHttpRequest = class extends NativeXHR {
    open(method, url, async = true, ...rest) {
      this._via = proxied(url);
      this._hidden = {};
      this._sync = async === false;
      return super.open(method, this._via ?? url, async, ...rest);
    }
    setRequestHeader(name, value) {
      if (this._via && FORBIDDEN.has(name.toLowerCase())) this._hidden[name] = value;
      else super.setRequestHeader(name, value);
    }
    send(body) {
      if (this._via && Object.keys(this._hidden).length) super.setRequestHeader("X-Pyslop-Headers", JSON.stringify(this._hidden));
      super.send(body);
      const error = this._via && this._sync ? this.getResponseHeader("X-Pyslop-Error") : null;
      if (error) throw networkError(error);
    }
    get responseURL() {
      return (this._via && this.getResponseHeader("X-Pyslop-Final-Url")) || super.responseURL;
    }
  };

  const nativeFetch = self.fetch.bind(self);
  /** Header pairs as given (Request and Headers objects drop forbidden ones). */
  const rawHeaders = (h) => {
    if (!h) return [];
    if (h instanceof Map) return [...h];
    if (Array.isArray(h)) return h;
    if (typeof h.entries === "function" && !(h.constructor === Object)) return [...h.entries()];
    return Object.entries(h);
  };
  self.fetch = async (input, init) => {
    const request = new Request(input, init);
    const via = proxied(request.url);
    if (!via) return nativeFetch(request);
    const headers = new Headers(request.headers);
    const hidden = {};
    for (const [name, value] of rawHeaders(init?.headers)) if (FORBIDDEN.has(String(name).toLowerCase())) hidden[name] = String(value);
    if (Object.keys(hidden).length) headers.set("X-Pyslop-Headers", JSON.stringify(hidden));
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    const response = await nativeFetch(via, { method: request.method, headers, body, signal: request.signal, redirect: "follow" });
    const error = response.headers.get("X-Pyslop-Error");
    if (error) throw new TypeError(`Network error: ${error}`);
    const final = response.headers.get("X-Pyslop-Final-Url");
    if (final) Object.defineProperty(response, "url", { value: final });
    return response;
  };
}

const decoder = new TextDecoder();
let py;
let syncChannel; // Int32Array view: [state, length], payload from byte 8
let nextCallId = 0;
const pendingCalls = new Map();
let uiDispatcher = null;
let manifest = new Map(); // path -> version (mtime and size) of files synced into the project dir
let written = new Set(); // paths this program wrote back (their deletion is written back too)
let flushTimer = null;
let plumbing; // a private namespace for our own Python, so the program's globals stay clean

// Turtle graphics (D29): ops from _pyslop_turtle.py, sent to the page at most
// every 16 ms, and always before the program blocks, sleeps or prints (so the
// console keeps the order) and when it ends.
let turtleBatches = [];
let turtleSentAt = 0;
function flushTurtle() {
  if (turtleBatches.length) {
    postMessage({ type: "turtle", batches: turtleBatches });
    turtleBatches = [];
  }
  turtleSentAt = performance.now();
}
let measureContext;
/** A 2D context for measuring text and parsing colors (null if unavailable). */
function context2d() {
  if (measureContext === undefined) {
    try {
      measureContext = new OffscreenCanvas(1, 1).getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  return measureContext;
}

/** Run our own setup code without touching the program's namespace (__main__). */
function runPlumbing(code) {
  py.runPython(code, { globals: plumbing });
}
let runCwd = null; // the program's working directory, for later write-backs

function syncCall(op, value) {
  if (!syncChannel) throw new Error(`blocking call '${op}' needs cross-origin isolation`);
  flushTurtle();
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
      if (turtleBatches.length) flushTurtle();
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
    stdout: (s) => (flushTurtle(), postMessage({ type: "output", stream: "stdout", text: s + "\n" })),
    stderr: (s) => (flushTurtle(), postMessage({ type: "output", stream: "stderr", text: s + "\n" })),
  });
  py.setStdout(writer("stdout"));
  py.setStderr(writer("stderr"));
  py.setStdin({ stdin: () => (syncChannel ? syncCall("stdin", null) ?? undefined : undefined) });
  if (interruptInts) py.setInterruptBuffer(interruptInts);
  py.registerJsModule("host", {
    call: (op, value) => asyncCall("host", { op, value: value?.toJs?.() ?? value }),
    call_sync: (op, value) => syncCall("host", { op, value: value?.toJs?.() ?? value }),
    // Sleeps without burning CPU; any signal wakes it early. KeyboardInterrupt
    // (Stop) is then raised by CPython's own signal check right after we
    // return, not thrown through JavaScript (which WebKit reports as an
    // uncaught worker error). _pyslop_debug wraps this into time.sleep.
    sleep: (seconds) => {
      flushTurtle();
      Atomics.wait(interruptInts, 0, 0, Math.max(0, seconds * 1000));
      // Woken by Pause or a breakpoint update: run that handler now, before
      // the sleep loop waits again (CPython only polls the buffer now and then).
      const signal = Atomics.load(interruptInts, 0);
      if (signal !== 0 && signal !== 2) py.checkInterrupt();
    },
  });
  py.registerJsModule("_pyslophost", {
    image: (b64) => postMessage({ type: "output", stream: "image", text: b64 }),
    status: (text) => postMessage({ type: "output", stream: "system", text: text + "\n" }),
    // The debugger's blocking round trip (_pyslop_debug.py); null when interrupted.
    debug: (json) => {
      const reply = syncCall("debug", JSON.parse(json));
      return reply == null ? null : JSON.stringify(reply);
    },
    turtle: (json) => {
      turtleBatches.push(json);
      if (performance.now() - turtleSentAt > 16) flushTurtle();
    },
    // Events (waiting up to `wait` ms for one) and dialogs; null when interrupted.
    turtle_call: (json) => {
      const reply = syncCall("turtle", JSON.parse(json));
      return reply === undefined ? null : JSON.stringify(reply);
    },
    measure_text: (font, text) => {
      const ctx = context2d();
      if (!ctx) return null;
      ctx.font = font;
      return ctx.measureText(text).width;
    },
    /** A CSS color as the canvas normalizes it ("#rrggbb"), or null if it is none. */
    css_color: (name) => {
      const ctx = context2d();
      if (!ctx) return name;
      ctx.fillStyle = "#010203";
      ctx.fillStyle = name;
      const a = ctx.fillStyle;
      ctx.fillStyle = "#040506";
      ctx.fillStyle = name;
      return a === ctx.fillStyle ? a : null;
    },
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
  plumbing = py.runPython("dict()");
  runPlumbing([
    "import sys",
    "sys.path.append('/lib/pyslop')",
    "import _pyslop, _pyslop_debug",
    interruptInts ? "import host\n_pyslop_debug.install(host.sleep)\ndel host" : "_pyslop_debug.install()",
  ].join("\n"));
  postMessage({
    type: "ready", bootMs: performance.now() - t0, version: py.version,
    jspi: typeof WebAssembly.Suspending, gcTrampoline: !!gcTrampoline, isolated: !!syncChannel,
  });
}

// mtimes are in milliseconds; the size catches a second write in the same one.
const version = (stat) => `${stat.mtime.getTime()}:${stat.size}`;

/** Write the project's files into cwd and remember their mtimes. */
function syncIn(cwd, files) {
  py.FS.mkdirTree(cwd);
  manifest = new Map();
  written = new Set();
  for (const { path, data } of files) {
    const full = `${cwd}/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    py.FS.writeFile(full, data);
    manifest.set(path, version(py.FS.stat(full)));
  }
}

/**
 * Files under cwd that are new or modified since the last call (data), and
 * files this program wrote back earlier and has deleted since (data: null).
 *
 * The order is SQLite's: rollback journals first, then the other files, then
 * deletions. A database is then never newer on disk than its journal, and a
 * journal deleted at commit does not stay behind as a "hot" one that would
 * roll the database back when it is next opened.
 */
function changedFiles(cwd) {
  const out = [];
  const seen = new Set();
  const walk = (dir, rel) => {
    for (const name of py.FS.readdir(dir)) {
      if (name === "." || name === ".." || name === "__pycache__") continue;
      const full = `${dir}/${name}`;
      const path = rel ? `${rel}/${name}` : name;
      const stat = py.FS.stat(full);
      if (py.FS.isDir(stat.mode)) {
        walk(full, path);
        continue;
      }
      seen.add(path);
      const v = version(stat);
      if (manifest.get(path) !== v) {
        out.push({ path, data: py.FS.readFile(full) });
        manifest.set(path, v);
        written.add(path);
      }
    }
  };
  try {
    py.FS.stat(cwd);
  } catch {
    return []; // cwd was removed by the script: write nothing back, delete nothing
  }
  walk(cwd, "");
  const journal = (p) => /-(journal|wal)$/.test(p);
  out.sort((a, b) => Number(journal(b.path)) - Number(journal(a.path)));
  for (const path of written) {
    if (seen.has(path)) continue;
    out.push({ path, data: null });
    written.delete(path);
    manifest.delete(path);
  }
  return out;
}

/**
 * Hand changed files to the page while the program idles (the timer only fires
 * between Python's tasks), so a UI app's data reaches the disk within a
 * second, not only when it closes. A killed app or a crash loses at most that.
 */
function startFlushing() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (!runCwd) return;
    const changed = changedFiles(runCwd);
    if (changed.length) postMessage({ type: "files", changed });
  }, 500);
}

/**
 * Call one of our runtime modules directly (awaiting coroutines), so nothing
 * passes through the program's namespace (where the debugger and >>> see it).
 */
async function callRuntime(module, name, ...args) {
  const mod = py.pyimport(module);
  try {
    const result = mod[name](...args);
    const value = result && typeof result.then === "function" ? await result : result;
    value?.destroy?.();
  } finally {
    mod.destroy();
  }
}

async function run({ code, filename, cwd, files, repl, indexURL, breakpoints }) {
  const t0 = performance.now();
  try {
    if (files && cwd) syncIn(cwd, files);
    if (cwd && !repl) {
      runCwd = cwd;
      startFlushing();
    }
    if (cwd) {
      py.FS.mkdirTree(cwd);
      py.FS.chdir(cwd);
      runPlumbing(`import sys\nif ${JSON.stringify(cwd)} not in sys.path: sys.path.insert(0, ${JSON.stringify(cwd)})\nsys.argv = [${JSON.stringify(filename ?? "")}]`);
    }
    if (!repl) {
      // Declared dependencies (PEP 723 or pyproject.toml) first, then
      // Pyodide packages that are imported but not declared.
      await callRuntime("_pyslop", "prepare_environment", code, cwd ?? "/home/pyodide", indexURL ?? new URL("/pypi/simple", location.href).href);
    }
    // urllib.request has no Pyodide backend of its own: pyodide-http adds one (sync XHR).
    if (/^\s*(import|from)\s[^\n#]*\burllib\b/m.test(code)) {
      await py.loadPackage("pyodide-http");
      runPlumbing("import pyodide_http\npyodide_http.patch_urllib()");
    }
    await py.loadPackagesFromImports(code, {
      messageCallback: (m) => m.startsWith("Loading ") && postMessage({ type: "output", stream: "system", text: m.replace(/^Loading /, "Loading packages: ") + "\n" }),
      errorCallback: (m) => postMessage({ type: "output", stream: "stderr", text: m + "\n" }),
    });
    // urllib3 drops User-Agent because browsers forbid setting it; our proxy
    // sets it (the XHR/fetch shim passes it along), so let it through.
    if (/\b(requests|urllib3)\b/.test(code)) {
      runPlumbing("try:\n    import urllib3.contrib.emscripten.fetch as _f\n    _f.HEADERS_TO_IGNORE = ()\nexcept ImportError:\n    pass");
    }
    if (repl) {
      await callRuntime("_pyslop", "repl", code);
    } else {
      await callRuntime("_pyslop_debug", "start", JSON.stringify(breakpoints ?? {}));
      try {
        const result = await py.runPythonAsync(code, { filename: filename ?? "<main>" });
        result?.destroy?.();
        // A turtle program with event handlers keeps running, as in IDLE.
        runPlumbing("import sys\nif '_pyslop_turtle' in sys.modules: sys.modules['_pyslop_turtle'].finish()");
      } finally {
        await callRuntime("_pyslop_debug", "finished");
      }
    }
    finishTurtle();
    postMessage({ type: "done", ok: true, ms: performance.now() - t0, changed: cwd ? changedFiles(cwd) : [] });
  } catch (e) {
    finishTurtle();
    postMessage({ type: "done", ok: false, error: String(e.message ?? e), ms: performance.now() - t0, changed: cwd ? changedFiles(cwd) : [] });
  }
}

/** Send what the program drew last (also when it failed). */
function finishTurtle() {
  try {
    runPlumbing("import sys\nif '_pyslop_turtle' in sys.modules: sys.modules['_pyslop_turtle'].flush_all()");
  } catch {
    // the interpreter is unusable; nothing to send
  }
  flushTurtle();
}

// Errors escaping Pyodide are crashes (D16), except KeyboardInterrupt: it is a
// BaseException, so asyncio re-raises it out of the event loop after Stop.
function reportEscaped(error) {
  if (/KeyboardInterrupt\s*$/.test(error.trim())) return;
  postMessage({ type: "worker-error", error });
}
addEventListener("error", (e) => {
  // A plain Event (not an ErrorEvent) has no message: say where it came from.
  const where = e.message ?? `${e.type} event from ${e.target?.constructor?.name ?? "?"}${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`;
  reportEscaped(String(where));
});
// An unhandled rejection is a crash only if it says the interpreter broke (a
// wasm trap, a stack overflow, Pyodide's fatal error). Libraries leave other
// rejections behind: urllib3 starts a helper worker for streaming downloads,
// which WebKit refuses with an error Event that nobody handles.
const FATAL = /fatal error|unreachable|out of bounds|call stack|RuntimeError|Aborted/i;
addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  const reason = e.reason;
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason?.message ?? reason);
  if (reason instanceof Error && FATAL.test(message)) reportEscaped(message);
  else console.warn("unhandled rejection (ignored):", reason);
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
    case "sync":
      // Files a UI app wrote after its script returned (e.g. saved data).
      postMessage({ type: "synced", id: msg.id, changed: runCwd ? changedFiles(runCwd) : [] });
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
