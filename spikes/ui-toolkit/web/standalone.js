// Entry point of an exported (published) app: boots Pyodide, runs app.py,
// renders the UI full screen. No editor, no console.
import { bridge, PyWorker } from "./runtime.js";
import { UIRenderer } from "./ui-renderer.js";

const config = await (await fetch("app.json")).json();
const errorEl = document.getElementById("error");
const splash = document.getElementById("splash");
const t0 = performance.now();

const worker = new PyWorker({
  indexURL: config.pyodide,
  packageBaseUrl: config.pyodide,
  jspi: config.jspi,
  gcTrampoline: config.jspi,
  files: { "ui.py": new URL("ui.py", location.href).href },
});
const renderer = new UIRenderer(document.getElementById("app"), (id, args) => worker.sendUIEvent(id, args));
let firstRenderMs = null;
worker.onUIRender = (json) => {
  renderer.render(json);
  if (firstRenderMs === null) {
    firstRenderMs = performance.now() - t0;
    splash.remove();
  }
};
worker.onOutput = (stream, text) => {
  if (stream === "stderr") {
    console.error(text);
    errorEl.hidden = false;
    errorEl.textContent += text;
  } else {
    console.log(text);
  }
};

const info = await worker.ready;
const code = await (await fetch("app.py")).text();
const result = await worker.run(code, "app.py");
if (!result.ok) {
  splash.remove();
  errorEl.hidden = false;
  errorEl.textContent += result.error;
}

// Self-test hook for the spike (serve.py records it; ignored on real hosts).
if (location.hash === "#selftest") {
  const report = { ua: navigator.userAgent, boot: info, firstRenderMs, crossOriginIsolated: self.crossOriginIsolated, result: result.ok };
  const plus = [...document.querySelectorAll(".ui-button")].find((b) => b.textContent === "+1");
  if (plus) {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const done = new Promise((r) => (renderer.onRendered = r));
      const s = performance.now();
      plus.click();
      await done;
      times.push(performance.now() - s);
    }
    report.tapAvgMs = +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2);
    report.shown = document.querySelector(".ui-text-largeTitle")?.textContent;
  }
  await bridge("result", JSON.stringify(report, null, 2)).catch(() => {});
}
