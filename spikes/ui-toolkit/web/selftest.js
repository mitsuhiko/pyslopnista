// Scripted checks for the UI toolkit: drives the example apps through real
// DOM events and measures the event -> Python -> render -> patch round trip.
import { bridge } from "../runtime.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), max: +s.at(-1).toFixed(2) };
};

export async function selftest({ pool, runCode, renderer, appEl, closeApp }) {
  const r = {};
  const log = (m) => bridge("log", m);
  let waiters = [];
  let renderCount = 0;
  renderer.onRendered = (seq, info) => {
    renderCount++;
    const w = waiters;
    waiters = [];
    w.forEach((f) => f(info));
  };
  const nextRender = (timeout = 5000) =>
    new Promise((resolve, reject) => {
      waiters.push(resolve);
      setTimeout(() => reject(new Error("timed out waiting for render")), timeout);
    });
  const src = async (name) => (await fetch(`examples/${name}.py`)).text();
  const q = (sel) => appEl.querySelector(sel);
  const qa = (sel) => [...appEl.querySelectorAll(sel)];
  const button = (label) => qa(".ui-button").find((b) => b.textContent === label);
  const consoleText = () => document.getElementById("out").textContent;

  async function step(name, fn) {
    const t0 = performance.now();
    try {
      r[name] = { ok: true, ...(await fn()) };
    } catch (e) {
      r[name] = { ok: false, error: String(e.message ?? e) };
    }
    r[name].wallMs = Math.round(performance.now() - t0);
    await log(`${name}: ${JSON.stringify(r[name])}`);
  }

  async function start(code) {
    const first = nextRender(15000);
    const t0 = performance.now();
    runCode(code);
    const info = await first;
    return { firstRenderMs: +(performance.now() - t0).toFixed(1), ...info };
  }

  async function act(fn) {
    const p = nextRender();
    const t0 = performance.now();
    fn();
    const info = await p;
    return { ms: performance.now() - t0, info };
  }

  r.boot = await pool.spare.ready;

  await step("counter", async () => {
    const first = await start(await src("counter"));
    const taps = [];
    for (let i = 0; i < 50; i++) taps.push((await act(() => button("+1").click())).ms);
    const shown = q(".ui-text-largeTitle").textContent;
    if (shown !== "50") throw new Error(`expected 50, saw ${shown}`);
    return { first, tapRoundTripMs: stats(taps) };
  });

  await step("todo", async () => {
    const first = await start(await src("todo"));
    const input = q(".ui-textfield");
    const keys = [];
    for (const ch of "Buy milk") {
      input.value += ch;
      keys.push((await act(() => input.dispatchEvent(new Event("input")))).ms);
    }
    if (button("Add").disabled) throw new Error("Add should be enabled");
    const rowsBefore = qa(".ui-row");
    await act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
    let rows = qa(".ui-row");
    if (rows.length !== 3) throw new Error(`expected 3 rows, got ${rows.length}`);
    if (rows[2].querySelector(".ui-row-title").textContent !== "Buy milk") throw new Error("new row missing");
    if (input.value !== "") throw new Error("input not cleared");
    const keptElements = rows[0] === rowsBefore[0] && rows[1] === rowsBefore[1];
    await act(() => rows[2].click());
    if (!qa(".ui-row")[2].classList.contains("ui-row-done")) throw new Error("toggle failed");
    const second = rows[1];
    await act(() => rows[0].querySelector(".ui-row-delete").click());
    rows = qa(".ui-row");
    if (rows.length !== 2) throw new Error(`expected 2 rows after delete, got ${rows.length}`);
    const footer = q(".ui-section-footer:not([hidden])")?.textContent;
    return {
      first, keystrokeRoundTripMs: stats(keys), keyedRowsReused: keptElements && rows[0] === second,
      footer,
    };
  });

  await step("timer", async () => {
    await start(await src("timer"));
    const before = renderCount;
    await sleep(1000);
    const rendersPerSecond = renderCount - before;
    const shown = parseFloat(q(".ui-text-largeTitle").textContent);
    await act(() => q(".ui-switch").click());
    const frozen = q(".ui-text-largeTitle").textContent;
    await sleep(400);
    const stillFrozen = q(".ui-text-largeTitle").textContent === frozen;
    if (!stillFrozen) throw new Error("timer kept running after toggle off");
    return { rendersPerSecond, shownAfter1s: shown };
  });

  await step("widgets", async () => {
    await start(await src("widgets"));
    const slider = q(".ui-slider");
    slider.value = "30";
    await act(() => slider.dispatchEvent(new Event("input")));
    const footer = q(".ui-section-footer").textContent;
    if (footer !== "Font size 30") throw new Error(`footer: ${footer}`);
    return { footer };
  });

  await step("callback_error", async () => {
    await start([
      "import ui",
      "n = ui.state(0)",
      "def boom(): raise ValueError('boom from a callback')",
      "ui.run(lambda: ui.Screen('Errors', ui.Button('Boom', on_tap=boom), ui.Button('Ok', on_tap=lambda: n.update(lambda v: v + 1)), ui.Text(str(n.value))))",
    ].join("\n"));
    button("Boom").click();
    await sleep(300);
    const sawTraceback = consoleText().includes("ValueError: boom from a callback");
    await act(() => button("Ok").click());
    const stillAlive = q(".ui-text").textContent === "1";
    if (!sawTraceback || !stillAlive) throw new Error(`traceback=${sawTraceback} alive=${stillAlive}`);
    return { sawTraceback, stillAlive };
  });

  await step("big_list", async () => {
    const first = await start([
      "import ui",
      "items = ui.state(list(range(1000)))",
      "ui.run(lambda: ui.Screen('Big list',",
      "    ui.Button('Reverse', on_tap=lambda: items.set(items.value[::-1])),",
      "    ui.Button('Drop first', on_tap=lambda: items.set(items.value[1:])),",
      "    ui.Section([ui.Row(f'Item {i}', detail=str(i * i), key=i) for i in items.value])))",
    ].join("\n"));
    const reverse = await act(() => button("Reverse").click());
    const drop = await act(() => button("Drop first").click());
    return {
      first,
      reverse: { ms: +reverse.ms.toFixed(1), ...reverse.info },
      dropFirst: { ms: +drop.ms.toFixed(1), ...drop.info },
      rows: qa(".ui-row").length,
    };
  });

  await step("rerun_resets_state", async () => {
    await start(await src("counter"));
    return { shown: q(".ui-text-largeTitle").textContent };
  });

  closeApp();
  return r;
}
