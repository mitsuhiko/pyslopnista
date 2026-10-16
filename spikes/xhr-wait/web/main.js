// Q25: is a worker's first synchronous XHR after a long block slow? Runs each
// case in a fresh worker and reports JSON to the host.
const post = (op, fields = {}) => window.webkit.messageHandlers.bridge.postMessage({ op, ...fields });

function runCase(kind, arg) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("worker.js", { type: "module" });
    const sab = new SharedArrayBuffer(4);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = ({ data }) => {
      if (data.type === "notify-me") {
        setTimeout(() => {
          Atomics.store(new Int32Array(sab), 0, 1);
          Atomics.notify(new Int32Array(sab), 0);
        }, data.after);
      } else if (data.type === "done") {
        worker.terminate();
        resolve(data.out);
      }
    };
    worker.postMessage({ kind, arg, sab });
  });
}

const CASES = [
  ["wait", 100], ["wait", 500], ["wait", 900], ["wait", 1100], ["wait", 1500], ["wait", 2000], ["wait", 3000], ["wait", 5000],
  ["slices", 2000], ["busy", 2000], ["notified", 2000], ["notified", 300],
  ["wait-then-yield", 2000], ["wait-then-fetch", 2000],
  ["sequence", [2000, 2000, 300, 2000, 5000]],
];

// The cases that showed stalls, for counting them.
const FOCUS = [
  ["sequence", [2000, 2000, 2000, 5000, 2000, 3000, 2000]],
  ["wait", 5000], ["wait-then-yield", 2000], ["wait-then-fetch", 2000],
];

async function main() {
  const params = new URLSearchParams(location.hash.slice(1));
  const repeat = Number(params.get("repeat") ?? 2);
  // heartbeat=<ms>: a timer on the page's main thread while the cases run.
  const heartbeat = Number(params.get("heartbeat") ?? 0);
  if (heartbeat) setInterval(() => {}, heartbeat);
  const cases = params.get("cases") === "focus" ? FOCUS : CASES;
  const result = { userAgent: navigator.userAgent, visibility: document.visibilityState, heartbeat, cases: [] };
  for (let i = 0; i < repeat; i++) {
    for (const [kind, arg] of cases) {
      result.cases.push({ kind, arg, ...(await runCase(kind, arg)) });
    }
  }
  await post("result", { value: JSON.stringify(result, null, 1) });
  document.getElementById("out").textContent = JSON.stringify(result, null, 1);
}

main().catch((e) => post("result", { value: JSON.stringify({ error: String(e?.stack ?? e) }) }));
