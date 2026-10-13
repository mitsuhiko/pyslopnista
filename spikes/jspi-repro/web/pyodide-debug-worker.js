// Loads Pyodide with logging wrappers around WebAssembly.Suspending and
// WebAssembly.promising, plus a heartbeat so the page can tell a spinning
// worker from a promise that never settles.
const log = (text) => postMessage({ type: "log", text });
setInterval(() => postMessage({ type: "tick" }), 100);

const CASES = {
  run_sync_resolved: "from pyodide.ffi import run_sync\nfrom js import Promise\nrun_sync(Promise.resolve(42))",
  run_sync_timer: "from pyodide.ffi import run_sync, create_once_callable\nfrom js import Promise, setTimeout\nrun_sync(Promise.new(create_once_callable(lambda res, rej: setTimeout(create_once_callable(lambda: res(9)), 50))))",
  time_sleep: "import time\nt = time.perf_counter()\ntime.sleep(0.1)\nround(time.perf_counter() - t, 3)",
  can_run_sync: "from pyodide.ffi import can_run_sync\ncan_run_sync()",
  plain: "1 + 1",
};

// JS-driven cases that shorten the stack between promising and suspending.
const JS_CASES = {
  // promising(JsvPromise_Syncify) directly: no CPython frames at all
  syncify_direct: async (py) => {
    const m = py._module;
    m.validSuspender.value = true;
    const f = WebAssembly.promising(m._JsvPromise_Syncify);
    const r = await f(Promise.resolve(42));
    return `${r}`;
  },
  // Python function called with callPromising: 469 -> 468 -> Vectorcall -> eval -> run_sync
  call_promising_run_sync: async (py) => {
    const f = py.runPython("from pyodide.ffi import run_sync\ndef f(p):\n    return run_sync(p)\nf");
    return `${await f.callPromising(Promise.resolve(42))}`;
  },
  // builtin run_sync itself called with callPromising (no Python frame)
  call_promising_builtin: async (py) => {
    const f = py.runPython("from pyodide.ffi import run_sync\nrun_sync");
    return `${await f.callPromising(Promise.resolve(42))}`;
  },
};

onmessage = async (e) => {
  const { name, debugJspi } = e.data;
  if (e.data.spoofUA) {
    // CPython's Emscripten trampoline falls back to a JS trampoline on iOS
    // (gh-130418, WebKit bug 293113). Hide the iOS UA so it uses wasm-gc.
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    log(`spoofed UA: ${navigator.userAgent}`);
  }
  if (debugJspi) {
    const OrigSuspending = WebAssembly.Suspending;
    self.OrigSuspending = OrigSuspending;
    const origPromising = WebAssembly.promising;
    let sid = 0, pid = 0;
    WebAssembly.Suspending = function (fn) {
      log(`new Suspending(${fn.name || "anon"})`);
      return new OrigSuspending(async (...args) => {
        const id = ++sid;
        log(`suspend#${id} enter args=${args.map((a) => a === null ? "null" : typeof a).join(",")}`);
        if (self.logStacks) log(`suspend#${id} stack:\n${new Error().stack}`);
        try {
          const r = await fn(...args);
          log(`suspend#${id} resolved -> ${typeof r} ${String(r).slice(0, 40)}`);
          return r;
        } catch (err) {
          log(`suspend#${id} threw ${err}`);
          throw err;
        }
      });
    };
    WebAssembly.promising = function (f) {
      const p = origPromising(f);
      log(`promising(${f.name})`);
      return function (...args) {
        const id = ++pid;
        log(`promising#${id} call ${f.name}`);
        const r = p(...args);
        r.then((v) => log(`promising#${id} fulfilled ${typeof v}`), (err) => log(`promising#${id} rejected ${err}`));
        return r;
      };
    };
  }
  // Optional import patching: ?patch=<variant> swaps Pyodide's saveState /
  // restoreState to find which part of JsvPromise_Syncify upsets WebKit.
  const patch = e.data.patch;
  if (patch) {
    const wrapInfo = (info) => {
      const env = info?.env;
      if (!env?.saveState) return info;
      const origSave = env.saveState, origRestore = env.restoreState;
      log(`patching saveState/restoreState: ${patch}`);
      if (patch === "fake_state") {
        env.saveState = () => ({ fake: true });
        env.restoreState = () => {};
      } else if (patch === "capture_only") {
        env.saveState = () => { const t = self.pyModule._captureThreadState(); return { t }; };
        env.restoreState = (st) => { self.pyModule._restoreThreadState(st.t); };
      } else if (patch === "inspect") {
        const h = env.syncifyHandler;
        log(`env.syncifyHandler: typeof=${typeof h} ctor=${h?.constructor?.name} isSuspending=${h instanceof (self.OrigSuspending ?? WebAssembly.Suspending)}`);
        log(`info keys: ${Object.keys(info).join(",")}; env keys: ${Object.keys(env).length}`);
        let suspendingCount = 0;
        for (const [k, v] of Object.entries(env)) if (v && typeof v === "object" && v.constructor?.name === "Suspending") { suspendingCount++; log(`  suspending import: ${k}`); }
        log(`suspending imports: ${suspendingCount}`);
      } else if (patch === "orig_logged") {
        env.saveState = () => { const r = origSave(); log(`saveState -> ${typeof r}`); return r; };
        env.restoreState = (st) => origRestore(st);
      }
      return info;
    };
    const origInstantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = (src, info) => origInstantiate(src, wrapInfo(info));
    const origStreaming = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = (src, info) => origStreaming(src, wrapInfo(info));
  }
  const { loadPyodide } = await import("/pyodide/pyodide.mjs");
  const py = await loadPyodide({ indexURL: new URL("/pyodide/", location.href).href });
  log(`loaded ${py.version}`);
  self.pyModule = py._module;
  try {
    let r;
    if (JS_CASES[name]) {
      log(`js case ${name}`);
      r = await JS_CASES[name](py);
    } else {
      log(`runPythonAsync ${name}`);
      r = await py.runPythonAsync(CASES[name]);
    }
    postMessage({ type: "done", text: `ok ${r}` });
  } catch (err) {
    postMessage({ type: "done", text: `error ${String(err.message ?? err).split("\n").slice(-2).join(" ")}` });
  }
};
