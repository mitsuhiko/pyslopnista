// JSPI test cases. Each test instantiates fresh modules and returns
// { ok, value, detail }. Runs in Node, browser workers and the main thread.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadBytes(name) {
  if (typeof process !== "undefined" && process.versions?.node) {
    const { readFile } = await import("node:fs/promises");
    return readFile(new URL(name, import.meta.url));
  }
  const res = await fetch(new URL(name, import.meta.url));
  return new Uint8Array(await res.arrayBuffer());
}

let moduleCache = {};
async function compile(name) {
  moduleCache[name] ??= await WebAssembly.compile(await loadBytes(name));
  return moduleCache[name];
}

// Mirrors Pyodide's syncifyHandler: async (x, y) => await (x ?? y)
const inner = async (x, y) => await (x ?? y);

async function instantiate({ suspendFn = inner } = {}) {
  const env = {};
  env.suspend = new WebAssembly.Suspending(suspendFn);
  let exports;
  env.reenter = (v) => exports.leaf(v);
  env.call_inner_suspend = (s, p) => exports.inner_suspend(s, p);
  const instance = await WebAssembly.instantiate(await compile("jspi.wasm"), { env });
  exports = instance.exports;
  return exports;
}

async function instantiateEH() {
  const env = { suspend: new WebAssembly.Suspending(inner) };
  const instance = await WebAssembly.instantiate(await compile("jspi-eh.wasm"), { env });
  return instance.exports;
}

const resolvedLater = (v, how) => {
  switch (how) {
    case "resolved": return Promise.resolve(v);
    case "microtask": return new Promise((r) => queueMicrotask(() => r(v)));
    case "timer": return sleep(20).then(() => v);
    case "plain": return v; // not a promise; the async inner still suspends
  }
};

const expect = (value, want) => ({ ok: value === want, value: String(value) });

async function instantiateTables() {
  const suspend = new WebAssembly.Suspending(inner);
  const other = (await WebAssembly.instantiate(await compile("jspi-other.wasm"), { env: { suspend } })).exports;
  const itable = new WebAssembly.Table({ initial: 4, element: "anyfunc" });
  const e = (await WebAssembly.instantiate(await compile("jspi-table.wasm"), {
    env: { suspend, itable, other_thunk: other.thunk },
  })).exports;
  e.tbl.set(0, e.thunk);
  itable.set(0, e.thunk);
  itable.set(1, other.thunk);
  return e;
}

const tableTest = (fn) => async () => {
  const e = await instantiateTables();
  return expect(await WebAssembly.promising(e[fn])(null, resolvedLater(3, "timer")), 3);
};

async function instantiateTier() {
  const env = { suspend: new WebAssembly.Suspending(inner) };
  return (await WebAssembly.instantiate(await compile("jspi-tier.wasm"), { env })).exports;
}

const tierTest = (fn, n) => async () => {
  const e = await instantiateTier();
  return expect(await WebAssembly.promising(e[fn])(null, resolvedLater(4, "timer"), n), 4);
};

// warm up a function with many non-suspending calls from JS, then suspend through it
const warmedTest = (fn, calls) => async () => {
  const e = await instantiateTier();
  for (let i = 0; i < calls; i++) e[fn](null, null, 0);
  return expect(await WebAssembly.promising(e[fn])(null, resolvedLater(4, "timer"), 1), 4);
};

// Instantiate jspi.wasm through different API paths (Pyodide uses
// instantiateStreaming) and run the "direct" export.
async function viaPath(path, { sig = false } = {}) {
  const suspend = new WebAssembly.Suspending(inner);
  if (sig) suspend.sig = "eee";
  let exports;
  const env = { suspend, reenter: (v) => exports.leaf(v), call_inner_suspend: (s, p) => exports.inner_suspend(s, p) };
  const url = new URL("jspi.wasm", import.meta.url);
  if (path === "streaming") {
    exports = (await WebAssembly.instantiateStreaming(fetch(url), { env })).instance.exports;
  } else if (path === "bytes") {
    exports = (await WebAssembly.instantiate(await loadBytes("jspi.wasm"), { env })).instance.exports;
  } else if (path === "sync_instance") {
    exports = new WebAssembly.Instance(await compile("jspi.wasm"), { env }).exports;
  } else if (path === "compile_streaming") {
    exports = (await WebAssembly.instantiate(await WebAssembly.compileStreaming(fetch(url)), { env })).exports;
  }
  return expect(await WebAssembly.promising(exports.direct)(null, resolvedLater(8, "timer")), 8);
}

async function maxDepth(fn) {
  let lo = 0, hi = 1 << 22;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    try { fn(mid); lo = mid; } catch { hi = mid - 1; }
  }
  return lo;
}

export const tests = {
  stack_depth: async () => {
    const e = (await WebAssembly.instantiate(await compile("stack.wasm"), {})).exports;
    const jsRec = (n) => (n === 0 ? 0 : 1 + jsRec(n - 1));
    const wasm = await maxDepth(e.rec);
    const wasmFat = await maxDepth(e.fat);
    const js = await maxDepth(jsRec);
    return { ok: true, value: `wasm=${wasm} wasmFat=${wasmFat} js=${js}` };
  },
  path_streaming: () => viaPath("streaming"),
  path_bytes: () => viaPath("bytes"),
  path_sync_instance: () => viaPath("sync_instance"),
  path_compile_streaming: () => viaPath("compile_streaming"),
  path_streaming_with_sig: () => viaPath("streaming", { sig: true }),
  hot_caller_1k: tierTest("hot_caller", 1_000),
  hot_caller_100k: tierTest("hot_caller", 100_000),
  hot_caller_10M: tierTest("hot_caller", 10_000_000),
  hot_loop_self_100k: tierTest("hot_loop_self", 100_000),
  hot_loop_self_10M: tierTest("hot_loop_self", 10_000_000),
  warmed_plain_caller_1k: warmedTest("plain_caller", 1_000),
  warmed_plain_caller_100k: warmedTest("plain_caller", 100_000),
  warmed_plain_caller_1M: warmedTest("plain_caller", 1_000_000),
  own_table_elem: tableTest("own_table_elem"),
  own_table_js_set: tableTest("own_table_js_set"),
  imported_table_js_set: tableTest("imported_table_js_set"),
  imported_table_other_instance: tableTest("imported_table_other_instance"),
  import_other_instance: tableTest("import_other_instance"),
  suspending_object_shape: async () => {
    const fn = async () => 1;
    const s = new WebAssembly.Suspending(fn);
    let callResult;
    try { callResult = String(s()); } catch (e) { callResult = `throws ${e.name}`; }
    return {
      ok: typeof s === "object",
      value: `typeof=${typeof s} ctor=${s.constructor?.name} toString=${Object.prototype.toString.call(s)} ` +
        `instanceof Suspending=${s instanceof WebAssembly.Suspending} same-as-fn=${s === fn} call=${callResult}`,
    };
  },
  features: async () => ({
    ok: typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function",
    value: `Suspending=${typeof WebAssembly.Suspending} promising=${typeof WebAssembly.promising}`,
  }),

  direct_resolved: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.direct)(null, resolvedLater(42, "resolved")), 42);
  },
  direct_microtask: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.direct)(null, resolvedLater(42, "microtask")), 42);
  },
  direct_timer: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.direct)(null, resolvedLater(42, "timer")), 42);
  },
  direct_plain_value: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.direct)(null, 42), 42);
  },
  sync_suspending_fn: async () => {
    // Suspending wrapping a non-async function: must not suspend at all
    const e = await instantiate({ suspendFn: (x, y) => y });
    return expect(await WebAssembly.promising(e.direct)(null, 42), 42);
  },
  indirect_timer: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.indirect)(null, resolvedLater(7, "timer")), 7);
  },
  loop_100_resolved: async () => {
    const e = await instantiate();
    const n = await WebAssembly.promising(e.loop)(null, 1, 100);
    const counter = new Int32Array(e.memory.buffer)[0];
    return { ok: n === 100 && counter === 100, value: `n=${n} counter=${counter}` };
  },
  loop_1000_microtask: async () => {
    const e = await instantiate({ suspendFn: async () => { await new Promise((r) => queueMicrotask(r)); return null; } });
    const t0 = performance.now();
    const n = await WebAssembly.promising(e.loop)(null, null, 1000);
    return { ok: n === 1000, value: `n=${n} us/suspend=${((performance.now() - t0) * 1000 / 1000).toFixed(1)}` };
  },
  deep_1000_timer: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.deep)(null, resolvedLater(5, "timer"), 1000), 5);
  },
  deep_20000_resolved: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.deep)(null, resolvedLater(5, "resolved"), 20000), 5);
  },
  after_reenter_timer: async () => {
    const e = await instantiate();
    return expect(await WebAssembly.promising(e.after_reenter)(null, resolvedLater(9, "timer")), 9);
  },
  concurrent_two: async () => {
    const e = await instantiate();
    const run = WebAssembly.promising(e.direct);
    const a = run(null, sleep(40).then(() => "a"));
    const b = run(null, sleep(10).then(() => "b"));
    const [ra, rb] = await Promise.all([a, b]);
    return { ok: ra === "a" && rb === "b", value: `${ra},${rb}` };
  },
  js_frame_between_throws: async () => {
    const e = await instantiate();
    try {
      const v = await WebAssembly.promising(e.js_frame_between)(null, resolvedLater(1, "timer"));
      return { ok: false, value: `returned ${v} (expected SuspendError)` };
    } catch (err) {
      return { ok: true, value: `${err.name}: ${err.message}` };
    }
  },
  no_promising_throws: async () => {
    const e = await instantiate();
    try {
      const v = e.direct(null, resolvedLater(1, "timer"));
      return { ok: false, value: `returned ${v} (expected SuspendError)` };
    } catch (err) {
      return { ok: true, value: `${err.name}: ${err.message}` };
    }
  },
  eh_after_resume: async () => {
    const e = await instantiateEH();
    return expect(await WebAssembly.promising(e.eh_after_resume)(null, resolvedLater(1, "timer")), 7);
  },
  eh_rejected: async () => {
    const e = await instantiateEH();
    const rejected = sleep(10).then(() => { throw new Error("boom"); });
    return expect(await WebAssembly.promising(e.eh_rejected)(null, rejected), 1);
  },
};

export async function runTest(name) {
  const t0 = performance.now();
  try {
    const r = await tests[name]();
    return { name, ...r, ms: +(performance.now() - t0).toFixed(1) };
  } catch (err) {
    return { name, ok: false, value: `threw ${err?.name}: ${err?.message}`, ms: +(performance.now() - t0).toFixed(1) };
  }
}
