// Worker side of the bridge latency probe. Three ways for (future) Python in a
// worker to reach Swift:
//   1. async relay through the page (what JSPI would wrap)
//   2. blocking relay through the page using Atomics.wait on a SharedArrayBuffer
//   3. blocking sync XHR straight to the app:// scheme handler

const r = {};
let control;
let nextId = 0;
const pending = new Map();

function t(key, fn) {
  postMessage({ type: "log", value: key });
  try { r[key] = fn(); } catch (e) { r[key] = `ERR ${e.name}: ${e.message}`; }
}
async function ta(key, fn) {
  postMessage({ type: "log", value: key });
  try { r[key] = await fn(); } catch (e) { r[key] = `ERR ${e.name}: ${e.message}`; }
}
async function timeIt(n, fn) {
  for (let i = 0; i < 20; i++) await fn(i);
  const start = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return { calls: n, avg_ms: +((performance.now() - start) / n).toFixed(3) };
}

function relay(value) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    postMessage({ type: "relay", id, value });
  });
}

function atomicsCall(value) {
  const ints = new Int32Array(control, 0, 2);
  Atomics.store(ints, 0, 0);
  postMessage({ type: "atomics-call", value });
  const res = Atomics.wait(ints, 0, 0, 5000);
  if (res === "timed-out") throw new Error("atomics call timed out");
  const bytes = new Uint8Array(control, 8, ints[1]).slice();
  return JSON.parse(new TextDecoder().decode(bytes));
}

function syncXhr(method, i) {
  const xhr = new XMLHttpRequest();
  if (method === "GET") {
    xhr.open("GET", `/__bridge/echo?v=${i}`, false);
    xhr.send();
  } else {
    xhr.open("POST", "/__bridge/echo", false);
    xhr.send(String(i));
  }
  if (xhr.status !== 200) throw new Error(`status ${xhr.status}`);
  return xhr.responseText;
}

onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "relay-reply") {
    pending.get(msg.id)(msg.value);
    pending.delete(msg.id);
    return;
  }
  if (msg.type !== "start") return;
  control = msg.control;

  t("crossOriginIsolated", () => self.crossOriginIsolated);
  t("received_shared_buffer", () => `${control?.constructor?.name} ${control?.byteLength}`);
  t("SharedArrayBuffer_global", () => typeof SharedArrayBuffer);
  t("jspi_Suspending", () => typeof WebAssembly.Suspending);
  await ta("opfs_sync_access_handle", async () => {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle("sync-probe.bin", { create: true });
    const h = await fh.createSyncAccessHandle();
    h.write(new Uint8Array([1, 2, 3]), { at: 0 });
    const size = h.getSize();
    h.close();
    return `ok (size ${size})`;
  });

  await ta("worker_async_relay_roundtrip", () => timeIt(500, async (i) => {
    const v = await relay({ i });
    if (v.i !== i) throw new Error("mismatch");
  }));
  await ta("worker_atomics_relay_roundtrip", () => !control ? "skipped: no SharedArrayBuffer" : timeIt(500, (i) => {
    const v = atomicsCall({ i });
    if (v.i !== i) throw new Error("mismatch");
  }));
  await ta("worker_sync_xhr_get_roundtrip", () => timeIt(500, (i) => {
    if (syncXhr("GET", i) !== String(i)) throw new Error("mismatch");
  }));
  await ta("worker_sync_xhr_post_roundtrip", () => timeIt(500, (i) => {
    const got = syncXhr("POST", i);
    if (got !== String(i)) throw new Error(`mismatch: got ${JSON.stringify(got)}`);
  }));

  postMessage({ type: "done", results: r });
};
