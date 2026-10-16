// One case per worker: block the way a Python program does (Atomics.wait,
// a busy loop, ...), then make synchronous XHRs like HostFS (D35) and time
// both halves: request -> handler (X-Handled-At) and handler -> response.
import "./sab-polyfill.js";

function xhr() {
  const sent = Date.now();
  const t0 = performance.now();
  const x = new XMLHttpRequest();
  x.open("POST", "/__echo", false);
  x.send(null);
  const ms = performance.now() - t0;
  const handled = Number(x.getResponseHeader("X-Handled-At"));
  const received = Date.now();
  return { ms: r(ms), toHost: r(handled - sent), back: r(received - handled), at: received % 1000 };
}
const r = (x) => Math.round(x * 10) / 10;

async function fetchEcho() {
  const t0 = performance.now();
  const res = await fetch("/__echo", { method: "POST" });
  await res.arrayBuffer();
  return { ms: r(performance.now() - t0) };
}

const busy = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

onmessage = async ({ data: { kind, arg, sab } }) => {
  const i32 = new Int32Array(sab);
  const out = { warm: xhr() };
  const t0 = performance.now();
  switch (kind) {
    case "wait": // one Atomics.wait that times out
      Atomics.wait(i32, 0, 0, arg);
      break;
    case "slices": // Atomics.wait in 50 ms slices (how procs-worker.js waits)
      while (performance.now() - t0 < arg) Atomics.wait(i32, 0, 0, 50);
      break;
    case "busy":
      busy(arg);
      break;
    case "notified": // a long wait, woken by the page after `arg` ms
      postMessage({ type: "notify-me", after: arg });
      Atomics.wait(i32, 0, 0, 30000);
      break;
    case "wait-then-yield": // back to the event loop before the XHR
      Atomics.wait(i32, 0, 0, arg);
      await new Promise((resolve) => setTimeout(resolve, 0));
      break;
    case "wait-then-fetch":
      Atomics.wait(i32, 0, 0, arg);
      out.blockedMs = r(performance.now() - t0);
      out.fetch = await fetchEcho();
      out.after = xhr();
      postMessage({ type: "done", out });
      return;
    case "sequence": { // the same wait several times in one worker
      out.rounds = [];
      for (const ms of arg) {
        Atomics.wait(i32, 0, 0, ms);
        out.rounds.push({ wait: ms, first: xhr(), second: xhr() });
      }
      postMessage({ type: "done", out });
      return;
    }
  }
  out.blockedMs = r(performance.now() - t0);
  out.first = xhr();
  out.second = xhr();
  postMessage({ type: "done", out });
};
