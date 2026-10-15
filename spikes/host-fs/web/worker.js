// The benchmark's Pyodide worker. It mounts the host's project folder three
// ways next to MEMFS and runs bench.py against each:
//   /mem        MEMFS (what a run sees today, after its folder was copied in)
//   /h_xhr      HOSTFS, every operation one synchronous XHR to the scheme handler
//   /h_buf      HOSTFS over XHR, writes buffered until fsync/close/read
//   /h_cache    HOSTFS over XHR, stat results cached until this worker changes them
//   /h_bridge   HOSTFS, every operation through the page and its WKScriptMessage bridge
//   /h_best     HOSTFS, bridge for small calls and XHR for big ones, write-behind and stat cache
//   /h_bestr    /h_best plus a 64 KB block read cache
import "./sab-polyfill.js";

let py;
let channel; // [state, metaLength, dataLength], meta JSON from byte 12, then data
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function xhrCall(meta, data) {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/__fs", false);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("X-Fs", JSON.stringify(meta));
  xhr.send(data ?? null);
  const result = JSON.parse(xhr.getResponseHeader("X-Fs-Result") ?? '{"error":"EIO"}');
  return { meta: result, data: new Uint8Array(xhr.response) };
}

function bridgeCall(meta, data) {
  const ints = new Int32Array(channel, 0, 3);
  Atomics.store(ints, 0, 0);
  postMessage({ type: "fs", meta, data: data ? data.slice() : null });
  Atomics.wait(ints, 0, 0);
  const result = JSON.parse(decoder.decode(new Uint8Array(channel, 12, ints[1]).slice()));
  const bytes = new Uint8Array(channel, 12 + ints[1], ints[2]).slice();
  return { meta: result, data: bytes };
}

/** The bridge for small calls (fewer hops), XHR for big ones (no base64). */
function hybridCall(meta, data) {
  const big = (data?.length ?? 0) > 32768 || (meta.op === "read" && meta.length > 32768);
  return big ? xhrCall(meta, data) : bridgeCall(meta, data);
}

const transports = { xhr: xhrCall, bridge: bridgeCall, hybrid: hybridCall };
const filesystems = {};

async function boot(msg) {
  channel = msg.channel;
  // As in the app (D13): the wasm-GC trampoline and no JSPI.
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
  delete WebAssembly.Suspending;
  delete WebAssembly.promising;
  const { loadPyodide } = await import(new URL("/pyodide/pyodide.mjs", location.href).href);
  const { createHostFS } = await import("./hostfs.js");
  py = await loadPyodide({ indexURL: new URL("/pyodide/", location.href).href, packageBaseUrl: "/pkgs/" });
  py.setStdout({ batched: (s) => postMessage({ type: "log", text: s }) });
  py.setStderr({ batched: (s) => postMessage({ type: "log", text: "stderr: " + s }) });
  const FS = py.FS;
  FS.mkdir("/mem");
  for (const [mount, transport, options] of [
    ["/h_xhr", "xhr", {}],
    ["/h_buf", "xhr", { buffered: true }],
    ["/h_cache", "xhr", { attrCache: true }],
    ["/h_bridge", "bridge", {}],
    ["/h_best", "hybrid", { buffered: true, attrCache: true }],
    ["/h_bestr", "hybrid", { buffered: true, attrCache: true, readCache: true }],
  ]) {
    const hostfs = createHostFS(py, transports[transport], options);
    FS.mkdir(mount);
    FS.mount(hostfs, {}, mount);
    filesystems[mount] = hostfs;
  }
  py.registerJsModule("hostfs", {
    now: () => performance.now(), // Python's clocks only tick in whole milliseconds here
    calls: (mount) => filesystems[mount]?.stats.calls ?? 0,
    by_op: (mount) => JSON.stringify(filesystems[mount]?.stats.byOp ?? {}),
    reset: (mount) => {
      if (filesystems[mount]) filesystems[mount].stats = Object.assign(filesystems[mount].stats, { calls: 0, byOp: {} });
    },
  });
  const source = await (await fetch("bench.py")).text();
  FS.writeFile("/home/pyodide/bench.py", source);
  py.runPython("import bench");
}

/** Round trips without Python: an empty call, and reads/writes of a few sizes. */
function transportBench() {
  const out = {};
  const time = (n, f) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) f(i);
    return (performance.now() - t0) / n;
  };
  for (const [name, call] of Object.entries({ xhr: xhrCall, bridge: bridgeCall })) {
    call({ op: "writefile", path: "blob.bin" }, new Uint8Array(4 << 20).fill(7));
    const { fd } = call({ op: "open", path: "blob.bin", flags: 2 }).meta;
    const r = {};
    r.noopMs = time(1000, () => call({ op: "noop" }));
    r.statMs = time(1000, () => call({ op: "stat", path: "blob.bin" }));
    for (const size of [4096, 65536, 1 << 20, 4 << 20]) {
      const n = size >= 1 << 20 ? 10 : 300;
      r[`read${size}Ms`] = time(n, (i) => call({ op: "read", fd, length: size, position: 0 }));
      const data = new Uint8Array(size).fill(i8(size));
      r[`write${size}Ms`] = time(n, () => call({ op: "write", fd, position: 0 }, data));
    }
    call({ op: "close", fd });
    out[name] = r;
  }
  return out;
}
const i8 = (n) => n & 0x7f;

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "boot") {
      await boot(msg);
      postMessage({ type: "ready" });
    } else if (msg.type === "transport") {
      postMessage({ type: "done", value: transportBench() });
    } else if (msg.type === "python") {
      const value = py.runPython(msg.code);
      postMessage({ type: "done", value: typeof value === "string" ? JSON.parse(value) : value });
    } else if (msg.type === "python-then-hang") {
      // For the crash test: run, report, then keep the worker busy until the
      // page kills it (no cleanup runs).
      py.runPython(msg.code);
      postMessage({ type: "done", value: "hanging" });
    }
  } catch (err) {
    postMessage({ type: "done", error: String(err.message ?? err) });
  }
};
