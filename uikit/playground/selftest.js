// Browser checks for ui.py + renderer.js, run from playground/#selftest.
// Each step drives an example like a user would and checks the DOM.
import { UIRenderer } from "../web/renderer.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what = "condition", timeout = 8000) {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(16);
  }
}

const app = () => document.getElementById("app");
const qa = (sel, root = app()) => [...root.querySelectorAll(sel)];
const q = (sel, root = app()) => root.querySelector(sel);
const byText = (sel, text, root = app()) => qa(sel, root).find((e) => e.textContent.trim() === text);
const visibleScreen = () => qa(".ui-screen").filter((s) => !s.inert && !s.closest("[hidden]") && !s.classList.contains("ui-pop-out")).pop();

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function enter(input) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function selftest(pg, params) {
  const only = params.get("only");
  const report = { ua: navigator.userAgent, steps: {} };
  let nextRender = null;
  pg.onRendered = (seq, stats) => {
    const f = nextRender;
    nextRender = null;
    f?.(stats);
  };
  const rendered = () => new Promise((r) => (nextRender = r));

  async function step(name, fn) {
    if (only && !name.includes(only)) return;
    const t0 = performance.now();
    try {
      report.steps[name] = { ok: true, ...((await fn()) ?? {}), ms: Math.round(performance.now() - t0) };
    } catch (e) {
      report.steps[name] = { ok: false, error: String(e.stack ?? e), output: pg.output.slice(-2000) };
    }
  }

  await step("counter", async () => {
    await pg.loadExample("Counter");
    const plus = await until(() => byText(".ui-button", "+1"), "+1 button");
    const big = q(".ui-text-largeTitle");
    const times = [];
    for (let i = 0; i < 30; i++) {
      const done = rendered();
      const t = performance.now();
      plus.click();
      await done;
      times.push(performance.now() - t);
    }
    assert(big.textContent === "30", `count is ${big.textContent}`);
    assert(q(".ui-text-footnote").textContent === "doubled: 60", "computed");
    assert(q(".ui-text-largeTitle") === big, "text node was replaced");
    const reset = byText(".ui-button", "Reset");
    assert(!reset.disabled, "reset enabled");
    reset.click();
    await until(() => big.textContent === "0" && reset.disabled, "reset");
    times.sort((a, b) => a - b);
    return { tapAvgMs: +(times.reduce((a, b) => a + b) / times.length).toFixed(2), tapP95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2) };
  });

  await step("todos", async () => {
    await pg.loadExample("Todos");
    const rows = () => qa(".ui-row").filter((r) => !r.textContent.includes("Nothing here"));
    const footer = () => q(".ui-section-footer:not([hidden])").textContent;
    await until(() => rows().length === 3, "3 rows");
    assert(footer().startsWith("2 of 3 left"), footer());
    const input = q(".ui-textfield input");
    type(input, "Write tests");
    await until(() => !byText(".ui-button", "Add").disabled, "add enabled");
    enter(input);
    await until(() => rows().length === 4 && input.value === "", "added row");
    assert(footer().startsWith("3 of 4 left"), footer());
    const build = rows().find((r) => r.textContent.includes("Build an app"));
    build.querySelector(".ui-row-inner").click();
    await until(() => footer().startsWith("2 of 4"), "toggled");
    assert(build.classList.contains("ui-row-done"), "row shows done");
    byText(".ui-segment", "Done").click();
    await until(() => rows().length === 2, "filter Done");
    byText(".ui-segment", "All").click();
    await until(() => rows().length === 4, "filter All");
    assert(rows()[1] === build, "row element kept across filters");
    const publish = rows().find((r) => r.textContent.includes("Publish it"));
    publish.querySelector(".ui-row-delete").click();
    await until(() => rows().length === 3, "deleted");
    byText(".ui-button", "Clear").click();
    const ok = await until(() => byText(".ui-alert-button", "Remove"), "confirm dialog");
    ok.click();
    await until(() => rows().length === 1 && footer().startsWith("1 of 1"), "cleared");
    return { rows: rows().map((r) => r.textContent) };
  });

  await step("todoApp", async () => {
    await pg.loadExample("Todo App");
    const screen = () => visibleScreen();
    const cards = await until(() => qa(".ui-card").length === 4 && qa(".ui-card"), "smart cards");
    const cardCount = (i) => cards[i].querySelector(".ui-text-title2").textContent;
    assert(cardCount(0) === "1" && cardCount(2) === "5", `today ${cardCount(0)}, all ${cardCount(2)}`);
    // Open Groceries and add a to-do.
    qa(".ui-row").find((r) => r.textContent.includes("Groceries")).querySelector(".ui-row-inner").click();
    await until(() => screen()?.querySelector(".ui-screen-title")?.textContent === "Groceries", "groceries");
    const input = screen().querySelector(".ui-textfield input");
    type(input, "Bread");
    enter(input);
    const rows = () => [...screen().querySelectorAll(".ui-row")];
    await until(() => rows().some((r) => r.textContent.includes("Bread")), "added Bread");
    assert(cardCount(2) === "6", "all count follows");
    // Check one off with the circle: it leaves the Open filter.
    rows().find((r) => r.textContent.includes("Oat milk")).querySelector(".ui-row-check").click();
    await until(() => !rows().some((r) => r.textContent.includes("Oat milk")), "checked off");
    assert(cardCount(0) === "0", "today count updated");
    // Open the detail screen of Bread, set a priority and move it to the Inbox.
    rows().find((r) => r.textContent.includes("Bread")).querySelector(".ui-row-inner").click();
    await until(() => screen()?.querySelector(".ui-navbar-title")?.textContent === "Bread", "detail");
    const detail = screen();
    const title = detail.querySelector(".ui-textfield input");
    type(title, "Sourdough bread");
    await until(() => detail.querySelector(".ui-navbar-title").textContent === "Sourdough bread", "renamed");
    const [priority, list] = [...detail.querySelectorAll(".ui-select")];
    priority.value = "3";
    priority.dispatchEvent(new Event("change", { bubbles: true }));
    list.value = "0";
    list.dispatchEvent(new Event("change", { bubbles: true }));
    detail.querySelector(".ui-navbar-back").click();
    await until(() => qa(".ui-nav > .ui-screen").length === 2 && !rows().some((r) => r.textContent.includes("Sourdough")), "moved away");
    screen().querySelector(".ui-navbar-back").click();
    await until(() => qa(".ui-nav > .ui-screen").length === 1, "home");
    const inbox = qa(".ui-row").find((r) => r.textContent.includes("Inbox"));
    assert(inbox.querySelector(".ui-row-detail").textContent === "2", "inbox count");
    // Search in All.
    cards[2].click();
    await until(() => screen()?.querySelector(".ui-screen-title")?.textContent === "All", "all");
    type(screen().querySelector("input[type=search]"), "sour");
    await until(() => rows().length === 1 && rows()[0].textContent.includes("!!!"), "search + priority");
    screen().querySelector(".ui-navbar-back").click();
    await until(() => qa(".ui-nav > .ui-screen").length === 1, "home again");
    // Delete the Learning list (with confirm).
    qa(".ui-row").find((r) => r.textContent.includes("Learning")).querySelector(".ui-row-delete").click();
    (await until(() => byText(".ui-alert-button", "Delete"), "confirm")).click();
    await until(() => !qa(".ui-row").some((r) => r.textContent.includes("Learning")), "list deleted");
    // Saved into todos.db (SQLite) after a quiet half second; read it with a
    // separate connection, like the next run of the app would.
    await sleep(800);
    const saved = JSON.parse(await pg.py.eval([
      "import json, sqlite3",
      "_db = sqlite3.connect('todos.db')",
      "_db.row_factory = sqlite3.Row",
      "json.dumps({t: [dict(r) for r in _db.execute(f'SELECT * FROM {t}')] for t in ('lists', 'todos')})",
    ].join("\n")));
    assert(saved.lists.length === 2 && saved.todos.some((t) => t.title === "Sourdough bread" && t.priority === 3 && t.list === 1), "saved");
    return { todos: saved.todos.length };
  });

  await step("bigList", async () => {
    let first = null;
    const firstRender = new Promise((r) => (nextRender = r));
    const t0 = performance.now();
    pg.run(`
import ui
items = ui.store([{"n": i, "done": False} for i in range(1000)])
def App():
    return ui.Screen("Big", ui.Button("reverse", on_click=items.reverse), ui.Button("toggle", on_click=lambda: items[500].update(done=not items[500].done)),
        ui.Button("shuffle", on_click=lambda: items.sort(key=lambda t: (t.n * 7919) % 1000)),
        ui.Section(ui.For(items, lambda t: ui.Row(f"Row {t.n}", checked=lambda: t.done))))
ui.run(App)
`);
    const stats = await firstRender;
    const firstMs = performance.now() - t0;
    const rows = () => qa(".ui-row");
    await until(() => rows().length === 1000, "1000 rows");
    first = rows()[0];
    let done = rendered();
    let t = performance.now();
    byText(".ui-button", "reverse").click();
    const revStats = await done;
    const reverseMs = performance.now() - t;
    assert(rows()[999] === first, "row element moved, not recreated");
    const toggles = [];
    let toggleStats;
    for (let i = 0; i < 7; i++) {
      done = rendered();
      t = performance.now();
      byText(".ui-button", "toggle").click();
      toggleStats = await done;
      toggles.push(performance.now() - t);
      assert(toggleStats.ops === 1, `toggle sent ${toggleStats.ops} ops`);
    }
    const toggleMs = toggles.sort((a, b) => a - b)[3];
    assert(rows().find((r) => r.textContent.includes("Row 499")).classList.contains("ui-row-done"), "row 499 done");
    done = rendered();
    t = performance.now();
    byText(".ui-button", "shuffle").click();
    const shuffleStats = await done;
    const shuffleMs = performance.now() - t;
    // Python side alone: build 1,000 rows and serialize them.
    const pyBuildMs = await pg.py.eval("import time\nt0 = time.perf_counter()\nui.run(App)\n(time.perf_counter() - t0) * 1000");
    await until(() => rows().length === 1000, "rebuilt");
    return {
      pyBuildMs: +pyBuildMs.toFixed(1),
      firstRenderMs: Math.round(firstMs), firstDomMs: Math.round(stats.domMs), firstBytes: stats.bytes,
      reverseMs: +reverseMs.toFixed(1), reverseOps: revStats.ops, toggleMs: +toggleMs.toFixed(2),
      shuffleMs: +shuffleMs.toFixed(1), shuffleOps: shuffleStats.ops,
    };
  });

  await step("navigation", async () => {
    await pg.loadExample("Navigation");
    const grace = await until(() => qa(".ui-row").find((r) => r.textContent.includes("Grace Hopper")), "rows");
    grace.querySelector(".ui-row-inner").click();
    await until(() => qa(".ui-nav > .ui-screen").length === 2, "pushed");
    const detail = visibleScreen();
    assert(detail.querySelector(".ui-screen-title").textContent === "Grace Hopper", "detail title");
    assert(detail.querySelector(".ui-navbar-back").textContent === "People", "back label");
    detail.querySelector(".ui-switch").click();
    await until(() => q(".ui-section-footer").textContent.includes("Grace Hopper"), "favorite footer");
    // Rename through a prompt dialog.
    byText(".ui-button", "Rename…", detail).click();
    const input = await until(() => q(".ui-alert-input"), "prompt");
    input.value = "Amazing Grace";
    byText(".ui-alert-button", "OK").click();
    await until(() => detail.querySelector(".ui-screen-title").textContent === "Amazing Grace", "renamed");
    detail.querySelector(".ui-navbar-back").click();
    await until(() => qa(".ui-nav > .ui-screen").length === 1, "popped");
    assert(grace.textContent.includes("Amazing Grace"), "list row updated");
    // Add through the sheet.
    q(".ui-navbar-trailing .ui-button").click();
    const sheet = await until(() => q(".ui-sheet-backdrop"), "sheet");
    const [name, role] = qa(".ui-sheet input");
    type(name, "Margaret Hamilton");
    type(role, "Engineer");
    await until(() => !byText(".ui-button", "Save", sheet).disabled, "save enabled");
    byText(".ui-button", "Save", sheet).click();
    await until(() => !q(".ui-sheet-backdrop"), "sheet closed");
    await until(() => qa(".ui-row").some((r) => r.textContent.includes("Margaret Hamilton")), "added person");
    // Edge swipe back.
    qa(".ui-row").find((r) => r.textContent.includes("Ada"))
      .querySelector(".ui-row-inner").click();
    await until(() => qa(".ui-nav > .ui-screen").length === 2, "pushed again");
    await sleep(450);
    const nav = q(".ui-nav");
    const rect = nav.getBoundingClientRect();
    const pe = (type, x) => nav.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: rect.left + x, clientY: rect.top + 300, pointerId: 7, button: 0, buttons: 1 }));
    pe("pointerdown", 5);
    for (let x = 20; x <= 300; x += 40) pe("pointermove", x);
    pe("pointerup", 300);
    await until(() => qa(".ui-nav > .ui-screen").length === 1, "swiped back");
  });

  await step("settings", async () => {
    await pg.loadExample("Settings");
    const summary = () => qa(".ui-card .ui-text")[0].textContent + " | " + qa(".ui-card .ui-text")[1].textContent;
    await until(() => summary().includes("notify=True"), "summary");
    byText(".ui-toggle", "Notifications").querySelector("input").click();
    await until(() => summary().includes("notify=False"), "toggle");
    assert(q(".ui-slider").disabled, "slider disabled");
    const plus = q(".ui-stepper-button[aria-label=Increment]");
    plus.click();
    await until(() => summary().includes("size=15"), "stepper");
    const select = q(".ui-select");
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => summary().includes("likes rs"), "menu picker");
    assert(q(".ui-picker-value").textContent === "Rust", "menu shows the choice");
    const date = q(".ui-date");
    date.value = "2000-01-31";
    date.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => summary().includes("31 Jan 2000"), "date");
    const name = q(".ui-textfield input");
    type(name, "Grace");
    await until(() => summary().startsWith("Grace"), "name");
    return { summary: summary() };
  });

  await step("tabs", async () => {
    await pg.loadExample("Tabs");
    const items = await until(() => qa(".ui-tabbar-item").length === 3 && qa(".ui-tabbar-item"), "tab bar");
    assert(q(".ui-tabbar-badge").textContent === "5", "badge");
    // Swipe a message row open and delete it: the badge follows.
    const row = qa(".ui-row")[0];
    const inner = row.querySelector(".ui-row-inner");
    const rect = inner.getBoundingClientRect();
    const pe = (type, x) => inner.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: rect.left + x, clientY: rect.top + 10, pointerId: 3, button: 0, buttons: 1 }));
    pe("pointerdown", 300);
    for (let x = 280; x >= 180; x -= 20) pe("pointermove", x);
    pe("pointerup", 180);
    await until(() => row.__revealed, "row revealed");
    row.querySelector(".ui-row-delete").click();
    await until(() => q(".ui-tabbar-badge")?.textContent === "4", "badge updated");
    items[1].click();
    await until(() => qa(".ui-tab")[1].hidden === false && qa(".ui-tab")[0].hidden, "tab 2 shown");
    const start = byText(".ui-button", "Start");
    start.click();
    const display = qa(".ui-tab")[1].querySelector(".ui-text-largeTitle");
    await until(() => parseFloat(display.textContent) > 0.3, "stopwatch running");
    byText(".ui-button", "Lap").click();
    await until(() => qa(".ui-tab")[1].querySelectorAll(".ui-row").length === 1, "lap row");
    byText(".ui-button", "Stop").click();
    const stopped = display.textContent;
    await sleep(200);
    assert(display.textContent === stopped, "stopwatch stopped");
    items[2].click();
    await until(() => qa(".ui-tab")[2].textContent.includes("tab 3"), "selected signal synced");
  });

  await step("canvas", async () => {
    await pg.loadExample("Bounce");
    await sleep(1500);
    const fps = await pg.py.eval("fps.peek()");
    const canvas = q(".ui-canvas");
    const before = (await pg.py.eval("len(balls.peek())"));
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + 40, pointerId: 1, button: 0 }));
    await until(() => true);
    await sleep(100);
    const after = await pg.py.eval("len(balls.peek())");
    assert(after === before + 1, `tap added a ball (${before} -> ${after})`);
    assert(fps > 20, `fps ${fps}`);
    // Paint: drag to draw a stroke.
    await pg.loadExample("Paint");
    const paint = await until(() => q(".ui-canvas"), "paint canvas");
    const r = paint.getBoundingClientRect();
    const pe = (type, x, y) => paint.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 2, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
    pe("pointerdown", 10, 10);
    for (let i = 1; i <= 10; i++) pe("pointermove", 10 + i * 20, 10 + i * 15);
    pe("pointerup", 210, 160);
    await until(() => !byText(".ui-button", "Clear").disabled, "stroke recorded");
    const points = await pg.py.eval("len(strokes[0]['points'])");
    const pixel = paint.getContext("2d").getImageData(Math.round((110 / 360) * paint.width), Math.round((85 / 360) * paint.height), 1, 1).data;
    return { fps, points, pixel: [...pixel] };
  });

  await step("asyncData", async () => {
    await pg.loadExample("Async Data");
    await until(() => q(".ui-spinner") && !q(".ui-spinner").hidden, "loading spinner");
    await until(() => qa(".ui-text-title3").some((t) => t.textContent === "Simple is better than complex."), "first quote");
    byText(".ui-button", "Next quote").click();
    await until(() => qa(".ui-text-title3").some((t) => t.textContent === "Readability counts."), "second quote");
    const pill = qa(".ui-text").find((t) => t.textContent === "odd");
    assert(pill, "reactive text");
    assert(pill.style.background === "var(--tint)" && pill.style.borderRadius === "12px", `modifiers ${pill.style.cssText}`);
  });

  await step("resync", async () => {
    await pg.loadExample("Todos");
    await until(() => qa(".ui-row").length === 3, "rows");
    // A second renderer attached late gets the whole current tree.
    const other = document.createElement("div");
    other.style.cssText = "position:fixed;left:-2000px;width:390px;height:600px";
    document.body.append(other);
    const main = pg.renderer;
    const second = new UIRenderer(other, (id, args) => pg.py.send(id, args));
    pg.py.onRender = (json) => {
      main.render(json);
      second.render(json);
    };
    await until(() => other.querySelectorAll(".ui-row").length === 3, "second renderer filled");
    const text = (root) => [...root.querySelectorAll(".ui-row")].map((r) => r.textContent).join("|");
    assert(text(other) === text(app()), "same rows");
    // Both keep updating afterwards.
    q(".ui-row-inner").click();
    await until(() => other.querySelector(".ui-row").classList.contains("ui-row-done") !== app().querySelector(".ui-row").classList.contains("ui-row-done") ? false : !app().querySelector(".ui-row").classList.contains("ui-row-done"), "both updated");
    other.remove();
  });

  await step("errors", async () => {
    await pg.run(`
import ui
n = ui.signal(0)
def boom():
    n.set(n() + 1)
    raise ValueError("oops")
def App():
    return ui.VStack(ui.Text(f"static {n()}"), ui.Text(n), ui.Button("boom", on_click=boom))
ui.run(App)
`);
    const btn = await until(() => byText(".ui-button", "boom"), "button");
    btn.click();
    await until(() => pg.output.includes("ValueError: oops"), "traceback");
    btn.click();
    await until(() => qa(".ui-vstack")[0]?.textContent.includes("static 02"), "still works");
    assert(pg.output.includes("ui hint"), "untracked read hint");
    assert(!pg.output.includes("ui.py"), "ui.py frames hidden");
    return { output: pg.output.split("\n").filter((l) => l.includes("hint") || l.includes("Error")) };
  });

  await step("plot", async () => {
    if (params.get("offline")) return { skipped: true };
    await pg.loadExample("Plot");
    const img = await until(() => q(".ui-image")?.src.startsWith("data:image/png") && q(".ui-image"), "plot image", 60000);
    const first = img.src;
    const slider = q(".ui-slider");
    slider.value = "5";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => img.src !== first, "plot redrawn", 10000);
    return { pngBytes: img.src.length };
  });

  report.ok = Object.values(report.steps).every((s) => s.ok);
  return report;
}
