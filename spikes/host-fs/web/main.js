// Runs the host-fs benchmark and reports JSON to the host (result.json).
// Steps (location.hash, comma separated, or "all"):
//   probe      what a Uint8Array becomes in a WKScriptMessage
//   transport  raw round trips: sync XHR vs the page's bridge, by size
//   python     bench.py's file and SQLite workloads on every mount
//   check      the SQLite files the workloads wrote, opened natively
//   crash      kill the worker in the middle of a spilled transaction, then
//              open the database natively (hot journal rollback)
//   copy       what copying a database in and out costs (today's approach)

const encoder = new TextEncoder();
const CHANNEL = 12 + (24 << 20);

const post = (op, fields = {}) => window.webkit.messageHandlers.bridge.postMessage({ op, ...fields });
const log = (text) => post("log", { value: text });

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

class Bench {
  constructor() {
    this.channel = new SharedArrayBuffer(CHANNEL);
    this.worker = new Worker("worker.js", { type: "module" });
    this.waiting = null;
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => this.waiting?.reject(new Error(e.message));
  }

  start() {
    return this.send({ type: "boot", channel: this.channel }, "ready");
  }

  send(msg, until = "done") {
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, until };
      this.worker.postMessage(msg);
    });
  }

  async handle(msg) {
    if (msg.type === "log") return log(msg.text);
    if (msg.type === "fs") return this.relay(msg);
    if (this.waiting && msg.type === this.waiting.until) {
      const { resolve, reject } = this.waiting;
      this.waiting = null;
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.value);
    }
  }

  /** The bridge transport: the worker blocks while the page asks Swift. */
  async relay({ meta, data }) {
    let reply;
    try {
      reply = await post("fs", { meta, data: data ? toBase64(data) : null });
    } catch (e) {
      log(`relay ${JSON.stringify(meta)} failed: ${e}`);
      reply = { error: "EIO" };
    }
    const bytes = reply.data ? fromBase64(reply.data) : new Uint8Array(0);
    delete reply.data;
    const json = encoder.encode(JSON.stringify(reply));
    const ints = new Int32Array(this.channel, 0, 3);
    new Uint8Array(this.channel, 12).set(json);
    new Uint8Array(this.channel, 12 + json.length).set(bytes);
    ints[1] = json.length;
    ints[2] = bytes.length;
    Atomics.store(ints, 0, 1);
    Atomics.notify(ints, 0);
  }

  python(code) {
    return this.send({ type: "python", code });
  }
}

const MOUNTS = [
  ["/mem", "mem"],
  ["/h_xhr", "xhr"],
  ["/h_cache", "cache"],
  ["/h_bridge", "bridge"],
  ["/h_buf", "buf"],
  ["/h_best", "best"],
  ["/h_bestr", "bestr"],
];
const WORKLOADS = ["files", "sqlite_default", "sqlite_exclusive", "sqlite_wal_exclusive", "wal"];

async function main() {
  const wanted = (location.hash.slice(1) || "all").split(",");
  const on = (step) => wanted.includes("all") || wanted.includes(step);
  const result = { date: new Date().toISOString(), userAgent: navigator.userAgent };
  await post("reset");

  if (on("probe")) {
    result.probe = {
      uint8Array: await post("probe", { value: new Uint8Array([1, 2, 3]) }),
      arrayBuffer: await post("probe", { value: new Uint8Array([1, 2, 3]).buffer }),
    };
  }

  const t0 = performance.now();
  const bench = new Bench();
  await bench.start();
  result.bootMs = Math.round(performance.now() - t0);

  if (on("transport")) result.transport = await bench.send({ type: "transport" });

  if (on("python") || on("check") || on("copy")) {
    // Warm up the interpreter's code paths on MEMFS first.
    log("warming up");
    await bench.python(`import bench; bench.run("/mem", "warmup", ${JSON.stringify(WORKLOADS)})`);
    result.python = {};
    log("warmed up");
    for (const [mount, tag] of MOUNTS) {
      log(`python on ${mount}`);
      result.python[tag] = await bench.python(`import bench; bench.run(${JSON.stringify(mount)}, ${JSON.stringify(tag)}, ${JSON.stringify(WORKLOADS)})`);
    }
  }

  if (on("check")) {
    result.check = {};
    for (const [, tag] of MOUNTS.slice(1)) {
      result.check[tag] = await post("sqlite", { path: `${tag}/bench.db`, table: "t" });
    }
    result.check.listing = await post("listing", { path: "xhr" });
  }

  if (on("copy")) {
    // Today a run copies its folder into MEMFS and writes changed files back
    // whole (D20, D27). The cost for the database the workloads made:
    result.copy = await bench.python(`
import json, time, os
import js
src = "/h_xhr/xhr/bench.db"
out = {"bytes": os.path.getsize(src)}
for mount in ("/h_xhr", "/h_bridge"):
    path = f"{mount}/xhr/bench.db"
    t0 = time.perf_counter()
    with open(path, "rb") as f:
        data = f.read()
    t1 = time.perf_counter()
    with open(f"{mount}/xhr/copy.db", "wb") as f:
        f.write(data)
    t2 = time.perf_counter()
    out[mount[1:]] = {"read_whole_ms": round((t1 - t0) * 1000, 2), "write_whole_ms": round((t2 - t1) * 1000, 2)}
json.dumps(out)
`);
  }

  if (on("crash")) {
    result.crash = {};
    for (const [mount, tag] of [["/h_xhr", "crash_xhr"], ["/h_cache", "crash_cache"], ["/h_buf", "crash_buf"], ["/h_best", "crash_best"], ["/h_bestr", "crash_bestr"]]) {
      const victim = new Bench();
      await victim.start();
      const t = performance.now();
      await victim.send({ type: "python-then-hang", code: `import bench; bench.crash_setup(${JSON.stringify(mount)}, ${JSON.stringify(tag)})` });
      const ms = Math.round(performance.now() - t);
      victim.worker.terminate();
      const listing = await post("listing", { path: tag });
      result.crash[tag] = { setupMs: ms, filesAfterKill: listing, native: await post("sqlite", { path: `${tag}/crash.db`, table: "t" }) };
    }
  }

  await post("result", { value: JSON.stringify(result, null, 2) });
  document.getElementById("out").textContent = JSON.stringify(result, null, 2);
}

main().catch(async (e) => {
  await post("result", { value: JSON.stringify({ error: String(e.message ?? e), stack: String(e.stack) }) });
});
