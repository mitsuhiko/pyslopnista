// One case per worker (a native stack overflow ends the interpreter): boot
// Pyodide like the app does (wasm-gc trampoline, JSPI), optionally set
// CPython's stack protection, run the case and report what happened and how
// much of the linear (Emscripten) stack it used.
let py;
let m;
let crashSP = null;
const stderr = [];

async function boot(python) {
  // As in the app (D13): hiding the iOS UA selects the wasm-gc trampoline.
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
  const indexURL = new URL(`pyodide/${python}/`, location.href).href;
  const { loadPyodide } = await import(new URL("pyodide.mjs", indexURL).href);
  py = await loadPyodide({ indexURL, packageBaseUrl: new URL(`/pkgs/${python}/`, location.href).href, env: { HOME: "/home/pyodide" } });
  m = py._module;
  py.setStderr({ batched: (s) => stderr.push(s) });
  // Pyodide's fatal error handler: the linear stack pointer is still where
  // the overflow happened (wasm unwinding doesn't run epilogues).
  py._api.on_fatal = () => {
    crashSP = m._emscripten_stack_get_current();
    try { stacks = debugStacks(); } catch (e) { stacks = "failed: " + e; }
  };
}

let stacks = null;
function debugStacks() {
  const dec = new TextDecoder();
  const cString = (s) => { const b = new TextEncoder().encode(s + "\0"); const p = m._malloc(b.length); m.HEAPU8.set(b, p); return p; };
  const jsString = (p) => { if (!p) return "?"; const h = m.HEAPU8; let e = p; while (h[e]) e++; return dec.decode(h.subarray(p, e)); };
  const names = { file: cString("co_filename"), name: cString("co_qualname") };
  const attr = (code, name) => { const v = m._PyObject_GetAttrString(code, name); if (!v) return "?"; const t = jsString(m._PyUnicode_AsUTF8(v)); m._Py_DecRef(v); return t; };
  const out = [];
  out.push("current=" + m._PyThreadState_GetUnchecked());
  for (let t = m._PyInterpreterState_ThreadHead(m._PyInterpreterState_Main()); t; t = m._PyThreadState_Next(t)) {
    const lines = [];
    let frame = m._PyThreadState_GetFrame(t);
    for (let n = 0; frame && n < 20; n++) {
      const code = m._PyFrame_GetCode(frame);
      lines.push(`${attr(code, names.file)}:${m._PyFrame_GetLineNumber(frame)} ${attr(code, names.name)}`);
      m._Py_DecRef(code);
      const back = m._PyFrame_GetBack(frame);
      m._Py_DecRef(frame);
      frame = back;
    }
    out.push(`tstate ${t}: ${lines.join(" | ")}`);
  }
  return out.join("\n");
}

const CANARY = 0xa5a5a5a5;

function fillCanary() {
  const words = new Uint32Array(m.HEAPU8.buffer);
  const end = m._emscripten_stack_get_end();
  const sp = m._emscripten_stack_get_current();
  words.fill(CANARY, (end >>> 2) + 4, (sp >>> 2) - 1024);
}

/** Deepest linear stack address written since fillCanary, as bytes below the base. */
function highWater() {
  const words = new Uint32Array(m.HEAPU8.buffer);
  const end = m._emscripten_stack_get_end();
  const base = m._emscripten_stack_get_base();
  let i = (end >>> 2) + 4;
  const stop = base >>> 2;
  while (i < stop && words[i] === CANARY) i++;
  return base - i * 4;
}

async function wasmDepth() {
  const bytes = await (await fetch("stack.wasm")).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const max = (fn) => {
    let lo = 0;
    let hi = 1 << 20;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      try {
        fn(mid);
        lo = mid;
      } catch {
        hi = mid - 1;
      }
    }
    return lo;
  };
  const out = { plain: max(instance.exports.rec) };
  if (typeof WebAssembly.promising === "function") {
    const p = WebAssembly.promising(instance.exports.rec);
    let lo = 0;
    let hi = 1 << 20;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      try {
        await p(mid);
        lo = mid;
      } catch {
        hi = mid - 1;
      }
    }
    out.promising = lo;
  }
  return out;
}

let current = null; // the result being built (an async crash may only show up as a rejection)

onmessage = async ({ data }) => {
  const r = { case: data.name, mode: data.mode, limit: data.limit ?? 0 };
  current = r;
  try {
    if (data.wasmDepth) {
      Object.assign(r, await wasmDepth());
      postMessage(r);
      return;
    }
    const t0 = performance.now();
    await boot(data.python ?? "3.14");
    r.bootMs = Math.round(performance.now() - t0);
    const base = m._emscripten_stack_get_base();
    r.linearStack = base - m._emscripten_stack_get_end();
    if (data.limit) {
      const tstate = m._PyThreadState_GetUnchecked();
      const rc = m._PyUnstable_ThreadState_SetStackProtection(tstate, base - data.limit, data.limit);
      if (rc !== 0) throw new Error(`SetStackProtection: ${rc}`);
    }
    if (data.setup) {
      if (data.mode === "async") await py.runPythonAsync(data.setup);
      else py.runPython(data.setup);
    }
    const run = async (code) => (data.mode === "async" ? (await py.runPythonAsync(code)) : py.runPython(code));
    if (data.warm) {
      const tw = performance.now();
      for (let i = 0; i < data.warm.reps; i++) await run(data.warm.code);
      r.warmMs = Math.round(performance.now() - tw);
      // A spare worker idles before it runs anything: JSC's optimizing
      // compiles finish in the background meanwhile.
      await new Promise((resolve) => setTimeout(resolve, data.warmIdle ?? 500));
    }
    fillCanary();
    const t1 = performance.now();
    try {
      const value = await run(data.code);
      r.outcome = "ok";
      r.value = typeof value === "object" ? String(value) : value;
    } catch (e) {
      if (crashSP !== null) {
        r.outcome = "crash";
        r.linearAtCrash = base - crashSP;
        r.stacks = stacks;
        r.stderr = stderr.join("\n").slice(0, 3000);
        r.error = String(e?.message ?? e).slice(0, 200);
      } else {
        r.outcome = "exception";
        r.error = String(e?.message ?? e).trim().split("\n").at(-1).slice(0, 200);
      }
    }
    r.ms = Math.round(performance.now() - t1);
    if (r.outcome !== "crash") {
      r.highWater = highWater();
      try {
        r.alive = py.runPython("sum(range(10))") === 45;
      } catch (e) {
        r.alive = false;
      }
    }
  } catch (e) {
    r.outcome = "failed";
    r.error = String(e?.stack ?? e).slice(0, 400);
  }
  postMessage(r);
};

addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  if (crashSP !== null && current && !current.outcome) {
    current.outcome = "crash";
    current.linearAtCrash = m._emscripten_stack_get_base() - crashSP;
    current.error = String(e.reason?.message ?? e.reason).slice(0, 200);
    current.via = "rejection";
    current.stacks = stacks;
    current.stderr = stderr.join("\n").slice(0, 3000);
    postMessage(current);
  }
});
