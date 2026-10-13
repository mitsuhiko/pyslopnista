// Probes WKWebView + app:// for the features the runtime needs (Q1),
// storage persistence across launches (Q2), and bridge latency (Q3).

const out = document.getElementById("out");
const r = { href: location.href, origin: location.origin, ua: navigator.userAgent };

const bridge = (op, value) => window.webkit.messageHandlers.bridge.postMessage({ op, value });
const log = (msg) => { out.textContent += `\n${msg}`; bridge("log", msg); };
addEventListener("error", (e) => log(`error: ${e.message}`));
addEventListener("unhandledrejection", (e) => log(`unhandled: ${e.reason}`));

function t(key, fn) {
  log(`step ${key}`);
  try { r[key] = fn(); } catch (e) { r[key] = `ERR ${e.name}: ${e.message}`; }
}
async function ta(key, fn) {
  log(`step ${key}`);
  try { r[key] = await fn(); } catch (e) { r[key] = `ERR ${e.name}: ${e.message}`; }
}

// --- Q1: features -----------------------------------------------------------
t("isSecureContext", () => self.isSecureContext);
t("crossOriginIsolated", () => self.crossOriginIsolated);
t("SharedArrayBuffer", () => typeof SharedArrayBuffer);
t("jspi_Suspending", () => typeof WebAssembly.Suspending);
t("jspi_promising", () => typeof WebAssembly.promising);
t("exnref_JSTag", () => typeof WebAssembly.JSTag);
t("shared_wasm_memory", () => { new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }); return "ok"; });
for (const mb of [1024, 2048]) {
  t(`wasm_memory_${mb}MB`, () => new WebAssembly.Memory({ initial: mb * 16 }).buffer.byteLength / 2 ** 20);
}

// --- Q2: storage persistence --------------------------------------------------
const now = new Date().toISOString();
await ta("storage_persisted", () => navigator.storage?.persisted?.());
await ta("storage_persist_request", () => navigator.storage?.persist?.());
await ta("storage_estimate", async () => {
  const e = await navigator.storage.estimate();
  return { usageMB: +(e.usage / 2 ** 20).toFixed(2), quotaMB: +(e.quota / 2 ** 20).toFixed(0) };
});
t("previous_localStorage", () => localStorage.getItem("marker"));
t("write_localStorage", () => { localStorage.setItem("marker", now); return "ok"; });
await ta("previous_opfs", async () => {
  const dir = await navigator.storage.getDirectory();
  try {
    const fh = await dir.getFileHandle("marker.txt");
    return await (await fh.getFile()).text();
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
});
await ta("write_opfs", async () => {
  const dir = await navigator.storage.getDirectory();
  const fh = await dir.getFileHandle("marker.txt", { create: true });
  const w = await fh.createWritable();
  await w.write(now);
  await w.close();
  return "ok";
});
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("probe", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbOp(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}
await ta("previous_indexedDB", async () => idbOp(await idb(), "readonly", (s) => s.get("marker")));
await ta("write_indexedDB", async () => { await idbOp(await idb(), "readwrite", (s) => s.put(now, "marker")); return "ok"; });

// --- Q3: bridge latency from the page ----------------------------------------
async function timeIt(n, fn) {
  for (let i = 0; i < 20; i++) await fn(i); // warmup
  const start = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return { calls: n, avg_ms: +((performance.now() - start) / n).toFixed(3) };
}
await ta("page_messageHandler_roundtrip", () => timeIt(500, async (i) => {
  const v = await bridge("echo", { i });
  if (v.i !== i) throw new Error("echo mismatch");
}));
await ta("page_fetch_bridge_roundtrip", () => timeIt(500, async (i) => {
  const res = await fetch(`/__bridge/echo?v=${i}`);
  if ((await res.text()) !== String(i)) throw new Error("echo mismatch");
}));

// --- Q3: bridge latency from a worker ----------------------------------------
const worker = new Worker("worker.js");
// WKWebView on app:// hides the SharedArrayBuffer global even though the page is
// cross-origin isolated; shared wasm memory still hands out a SharedArrayBuffer.
t("sab_via_wasm_memory", () => {
  const buf = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer;
  return { ctorName: buf.constructor.name, byteLength: buf.byteLength, isGlobal: buf.constructor === globalThis.SharedArrayBuffer };
});
t("sab_ctor_callable", () => {
  const Ctor = new WebAssembly.Memory({ initial: 0, maximum: 0, shared: true }).buffer.constructor;
  const b = new Ctor(16);
  const ia = new Int32Array(b);
  Atomics.add(ia, 0, 5);
  return { byteLength: b.byteLength, atomicsAdd: Atomics.load(ia, 0), growable: typeof b.grow };
});
const control = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer; // [state, length] + payload
worker.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "log") {
    log(`worker: ${msg.value}`);
  } else if (msg.type === "relay") {
    const value = await bridge("echo", msg.value);
    worker.postMessage({ type: "relay-reply", id: msg.id, value });
  } else if (msg.type === "atomics-call") {
    const value = await bridge("echo", msg.value);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const ints = new Int32Array(control, 0, 2);
    new Uint8Array(control, 8).set(bytes);
    ints[1] = bytes.length;
    Atomics.store(ints, 0, 1);
    Atomics.notify(ints, 0);
  } else if (msg.type === "done") {
    r.worker = msg.results;
    await finish();
  }
};
worker.onerror = async (e) => { r.worker = `ERR ${e.message}`; await finish(); };
worker.postMessage({ type: "start", control });

async function finish() {
  const json = JSON.stringify(r, null, 2);
  out.textContent = json;
  await bridge("result", json);
}
