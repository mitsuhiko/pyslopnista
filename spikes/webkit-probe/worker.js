const r = {};
const t = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = "ERR " + e.message; } };
t("crossOriginIsolated", () => self.crossOriginIsolated);
t("jspi_Suspending", () => typeof WebAssembly.Suspending);
t("sync_xhr", () => { const n = 50, s = performance.now();
  for (let i = 0; i < n; i++) { const x = new XMLHttpRequest(); x.open("GET", "/sync?" + i, false); x.send(); if (x.status !== 200) throw new Error("status " + x.status); }
  return {calls: n, avg_ms_including_10ms_server_sleep: ((performance.now() - s) / n).toFixed(2)}; });
t("atomics_wait", () => { const sab = new SharedArrayBuffer(4); const ia = new Int32Array(sab); const s = performance.now(); Atomics.wait(ia, 0, 0, 50); return "waited " + (performance.now()-s).toFixed(0) + "ms"; });
postMessage(r);
