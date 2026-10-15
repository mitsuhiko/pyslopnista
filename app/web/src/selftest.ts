// End-to-end checks for the app (run with #selftest): edit, run, input, plots,
// file write-back, console, UI apps, crash recovery. Runs in the engine page
// (D31) and drives the native app through the host (`app`), the focused
// editor page through the host as well. Reports via the bridge.
import { analysis } from "./analysis/client";
import { base64ToBytes, call, fs, locations } from "./host";
import { breakpoints } from "./debug/breakpoints";
import { session } from "./session";
import { turtleScenes } from "./turtle";
import navigationExample from "../../../uikit/examples/Navigation.py?raw";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeout = 15000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error("timed out");
    await sleep(50);
  }
}

// The native UI app (D30), as the host's renderer sees it.
interface NativeNode {
  i: number;
  t: string;
  p: Record<string, any>;
  c?: NativeNode[];
}

const nativeTree = () =>
  call<{ visible: boolean; tree: NativeNode; sheets: number[]; dialogs: { id: number; kind: string }[] }>("test.ui", { action: "tree" });
const nativeRenderStats = () => call<{ ops: number; ms: number }>("test.ui", { action: "stats" });
const nativeEvent = (id: number, event: string, args: unknown[] = []) => call("test.ui", { action: "event", id, event, args });

function findNodes(node: NativeNode, pred: (n: NativeNode) => boolean, out: NativeNode[] = []): NativeNode[] {
  if (pred(node)) out.push(node);
  for (const c of node.c ?? []) findNodes(c, pred, out);
  return out;
}

const untilNode = (pred: (n: NativeNode) => boolean) =>
  until(async () => {
    const t = await nativeTree();
    return t.visible ? findNodes(t.tree, pred)[0] : undefined;
  });

/** The native app, through the host's self-test hooks (SelfTest.swift). */
const appCall = <T = any>(method: string, ...args: unknown[]) => call<T>("app", { method, args });
const editorCall = <T = any>(method: string, ...args: unknown[]) => appCall<T>("editor", method, args);

const app = {
  openFile: (path: string) => appCall("openFile", path),
  openLocation: (path: string, line?: number, column?: number) => appCall("openLocation", path, line ?? null, column ?? null),
  currentFile: () => appCall<string | null>("currentFile"),
  editorPath: () => editorCall<string | null>("path"),
  run: () => appCall("run"),
  format: () => appCall("format"),
  goToDefinition: () => appCall("goToDefinition"),
  panes: () => appCall<{ tabs: string[]; active: string | null }[]>("panes"),
  setSplit: (on: boolean) => appCall("setSplit", on),
  closeTab: (path: string) => appCall("closeTab", path),
  showPane: (pane: string) => appCall("showPane", pane),
  wide: () => appCall<boolean>("wide"),
  tapTraceback: (text: string) => appCall<number>("tapTraceback", text),
  focusField: (field: "console" | "input") => appCall("focusField", field),
  fieldValue: (field: "console" | "input") => appCall<string>("fieldValue", field),
  submitField: (field: "console" | "input") => appCall("submitField", field),
  blurFields: () => appCall("blurFields"),
  clearField: (field: "console" | "input") => appCall("clearField", field),
};

const consoleText = () => session.getSnapshot().lines.filter((l) => l.kind !== "image" && l.kind !== "turtle").map((l) => l.text).join("");
const idle = () => session.getSnapshot().status === "idle";

export async function selftest() {
  const r: Record<string, unknown> = {};
  const log = (m: string) => call("log", m).catch(() => {});

  // #selftest&only=<substring> runs a subset.
  const only = new URLSearchParams(location.hash.slice(1)).get("only");

  async function step(name: string, fn: () => Promise<Record<string, unknown> | void>) {
    if (only && !new RegExp(only).test(name)) return;
    const t0 = performance.now();
    try {
      r[name] = { ok: true, ...(await fn()), ms: Math.round(performance.now() - t0) };
    } catch (e) {
      const { status, debug, pausing } = session.getSnapshot();
      r[name] = { ok: false, error: String((e as Error).message ?? e), console: consoleText().slice(-400), session: { status, pausing, debug: debug && { reason: debug.reason, frames: debug.frames } } };
    }
    await log(`${name}: ${JSON.stringify(r[name])}`);
  }

  async function runFile(path: string, code?: string) {
    await app.openFile(path);
    await until(async () => (await app.currentFile()) === path && (await app.editorPath()) === path);
    if (code !== undefined) await editorCall("setText", code);
    session.clear();
    const t0 = performance.now();
    await app.run();
    await until(() => session.getSnapshot().status !== "idle" || performance.now() - t0 > 3000);
    const done = until(idle, 120000);
    done.catch(() => {});
    return { done, t0 };
  }

  // Breakpoints live in the web view's storage, which --reset does not clear.
  breakpoints.clearAll();
  await app.setSplit(false); // a split view restored from the last session

  await step("examples_seeded", async () => {
    const names = (await fs.list("Examples")).map((e) => e.name);
    if (!names.includes("Hello.py")) throw new Error(`examples: ${names}`);
    return { examples: names.length };
  });

  await step("edit_and_run", async () => {
    await fs.mkdir("Tests");
    await fs.writeText("Tests/edit.py", "");
    const { done, t0 } = await runFile("Tests/edit.py", "import sys\nprint('hi from', sys.version.split()[0])\nprint(sum(range(10)))\n");
    await done;
    await until(idle);
    const out = consoleText();
    if (!out.includes("hi from 3.14") || !out.includes("45")) throw new Error(out);
    const saved = await fs.readText("Tests/edit.py");
    if (!saved.includes("hi from")) throw new Error("edit was not saved before running");
    return { runMs: Math.round(performance.now() - t0) };
  });

  await step("input", async () => {
    await runFile("Examples/Hello.py");
    await until(() => session.getSnapshot().awaitingInput);
    session.submitInput("Armin");
    await until(idle);
    if (!consoleText().includes("Hello, Armin!")) throw new Error(consoleText());
  });

  await step("traceback", async () => {
    await fs.writeText("Tests/boom.py", "def f():\n    return 1 / 0\n\nf()\n");
    await runFile("Tests/boom.py");
    await until(idle);
    const out = consoleText();
    if (!out.includes("ZeroDivisionError") || !out.includes('File "boom.py", line 2')) throw new Error(out);
    if (out.includes("_pyodide")) throw new Error("pyodide frames not removed");
  });

  await step("console_repl", async () => {
    await runFile("Tests/edit.py", "x = 21\n");
    await until(idle);
    await session.runConsole("x * 2");
    await until(() => consoleText().includes("42"));
    await session.runConsole("import math; math.sqrt(x * 4 + 16)");
    await until(() => consoleText().includes("10.0"));
  });

  await step("files_write_back", async () => {
    await fs.remove("Examples/notes.txt").catch(() => {});
    await runFile("Examples/Files.py");
    await until(idle);
    const notes = await fs.readText("Examples/notes.txt");
    if (!notes.startsWith("Ran at")) throw new Error(`notes.txt: ${notes}`);
    return { notes: notes.trim().slice(0, 40) };
  });

  await step("sibling_import", async () => {
    await fs.writeText("Tests/helper.py", "def greet(n):\n    return f'hello {n}'\n");
    await fs.writeText("Tests/main.py", "from helper import greet\nprint(greet('module'))\n");
    await runFile("Tests/main.py");
    await until(idle);
    if (!consoleText().includes("hello module")) throw new Error(consoleText());
    // The folder is used in place: no bytecode next to the user's files.
    if (await fs.exists("Tests/__pycache__")) throw new Error("__pycache__ written into the project");
  });

  await step("project_files_in_place", async () => {
    // D35: the program works on the folder itself. Its writes are on disk
    // before it blocks, it sees edits made meanwhile, renames and deletions
    // happen right away, and SQLite leaves no journal behind.
    const dir = "Tests/live";
    await fs.mkdir(dir);
    await fs.writeText(`${dir}/live.py`, [
      "import os, sqlite3",
      "open('live.txt', 'w').write('one')",
      "print('read:', open('live.txt').read())",
      "db = sqlite3.connect('live.db')",
      "db.execute('create table if not exists t (x)')",
      "db.executemany('insert into t values (?)', [(i,) for i in range(1000)])",
      "db.commit()",
      "input('go? ')",
      "print('reread:', open('live.txt').read())",
      "os.rename('live.txt', 'moved.txt')",
      "os.makedirs('sub/deeper', exist_ok=True)",
      "open('sub/deeper/x.txt', 'w').write('x')",
      "os.remove('moved.txt')",
      "print('rows:', db.execute('select count(*) from t').fetchone()[0])",
      "",
    ].join("\n"));
    await runFile(`${dir}/live.py`);
    await until(() => session.getSnapshot().awaitingInput);
    if ((await fs.readText(`${dir}/live.txt`)) !== "one") throw new Error("live.txt not on disk while the program waits");
    if (!(await fs.exists(`${dir}/live.db`)) || (await fs.exists(`${dir}/live.db-journal`))) throw new Error("live.db missing, or a journal left behind");
    await fs.writeText(`${dir}/live.txt`, "two"); // like the editor saving it
    session.submitInput("");
    await until(idle);
    const out = consoleText();
    if (!out.includes("read: one") || !out.includes("reread: two") || !out.includes("rows: 1000")) throw new Error(out);
    const names = (await fs.list(dir)).map((e) => e.name).sort();
    if (names.join(",") !== "live.db,live.py,sub") throw new Error(`files: ${names}`);
    if ((await fs.readText(`${dir}/sub/deeper/x.txt`)) !== "x") throw new Error("sub/deeper/x.txt");
  });

  await step("plot", async () => {
    await runFile("Examples/Plot.py");
    await until(idle, 30000);
    const images = session.getSnapshot().lines.filter((l) => l.kind === "image");
    if (!images.length) throw new Error(`no image; ${consoleText().slice(-300)}`);
    return { images: images.length, pngBytes: Math.round((images[0].text.length * 3) / 4) };
  });

  await step("stop", async () => {
    await runFile("Examples/Countdown.py");
    await until(() => consoleText().includes("9"));
    session.stop();
    await until(idle);
    const run = Object.values(session.getSnapshot().runs).at(-1);
    if (run?.status !== "stopped" || consoleText().includes("crashed")) throw new Error(`${run?.status}: ${consoleText()}`);
  });

  // -- turtle graphics (D29) ----------------------------------------------------------

  const lastScene = () => [...turtleScenes.values()].at(-1);
  /** The native turtle view: the color at turtle coordinates (x, y), and taps there. */
  const turtlePixel = (x: number, y: number) => call<number[]>("test.turtle", { action: "pixel", key: lastScene()!.key, x, y });
  const turtleTap = (x: number, y: number) => call("test.turtle", { action: "tap", key: lastScene()!.key, x, y });
  const turtleKey = (key: string) => call("test.turtle", { action: "key", key: lastScene()!.key, name: key });

  await step("turtle_draw_and_events", async () => {
    await fs.mkdir("Tests").catch(() => {});
    await fs.writeText("Tests/turtle_check.py", [
      "import turtle",
      "t = turtle.Turtle()",
      "t.speed(0)",
      "t.color('red', 'yellow')",
      "t.begin_fill()",
      "for _ in range(4):",
      "    t.forward(100)",
      "    t.left(90)",
      "t.end_fill()",
      "t.write('hi', font=('Arial', 16, 'bold'))",
      "screen = turtle.Screen()",
      "screen.onclick(lambda x, y: print(f'click {round(x)} {round(y)}'))",
      "def up():",
      "    print('key Up')",
      "    screen.bye()",
      "screen.onkey(up, 'Up')",
      "screen.listen()",
      "print('ready')",
      "turtle.done()",
      "print('after done')",
    ].join("\n"));
    const { done } = await runFile("Tests/turtle_check.py");
    await until(() => consoleText().includes("ready"));
    await until(() => lastScene()?.listening.keys);
    await sleep(300); // the host has the ops
    const inside = await turtlePixel(50, 50);
    const outside = await turtlePixel(-150, -150);
    if (!(inside[0] > 200 && inside[1] > 200 && inside[2] < 80)) throw new Error(`not yellow inside the square: ${inside}`);
    if (!outside.every((c) => c > 240)) throw new Error(`not white outside: ${outside}`);
    await turtleTap(-120, 80);
    await until(() => consoleText().includes("click -120 80"), 5000);
    await turtleKey("Up");
    await until(() => consoleText().includes("after done"), 5000);
    await done;
    await until(idle);
    const run = Object.values(session.getSnapshot().runs).at(-1);
    if (run?.status !== "ok") throw new Error(`${run?.status}: ${consoleText()}`);
    return { items: lastScene()!.items.size, inside, outside };
  });

  await step("turtle_timer_keeps_running_and_stop", async () => {
    // Handlers without done(): the program keeps running, as in IDLE.
    await fs.writeText("Tests/turtle_timer.py", "import turtle\nn = 0\ndef tick():\n    global n\n    n += 1\n    print('tick', n)\n    turtle.ontimer(tick, 50)\ntick()\n");
    await runFile("Tests/turtle_timer.py");
    await until(() => consoleText().includes("tick 4"));
    if (idle()) throw new Error("the program ended");
    session.stop();
    await until(idle);
    const run = Object.values(session.getSnapshot().runs).at(-1);
    if (run?.status !== "stopped" || consoleText().includes("Traceback")) throw new Error(`${run?.status}: ${consoleText()}`);
  });

  await step("turtle_example", async () => {
    const t0 = performance.now();
    await runFile("Examples/Turtle.py");
    await until(idle, 60000);
    const run = Object.values(session.getSnapshot().runs).at(-1);
    if (run?.status !== "ok") throw new Error(`${run?.status}: ${consoleText()}`);
    const scene = lastScene()!;
    if (scene.items.size < 10) throw new Error(`${scene.items.size} items`);
    return { ms: Math.round(performance.now() - t0), items: scene.items.size };
  });

  await step("turtle_catch_example", async () => {
    await runFile("Examples/Catch the Turtle.py");
    const scene = await until(() => lastScene()?.listening.pointer && lastScene());
    const score = () => [...scene.items.values()].filter((i) => i.type === "text").map((i) => i.o.text).join();
    await until(() => score().includes("Score: 0"));
    // Tap the middle of the turtle's shape (it hops every 1.3 s; try again if it moved away).
    for (let i = 0; i < 5 && !score().includes("Score: 1"); i++) {
      const shell = [...scene.items.values()].find((it) => it.type === "polygon" && it.o.fill === "#006400")!;
      const xs = shell.xy.filter((_, j) => j % 2 === 0), ys = shell.xy.filter((_, j) => j % 2 === 1);
      await turtleTap(xs.reduce((a, b) => a + b) / xs.length, -ys.reduce((a, b) => a + b) / ys.length);
      await sleep(400);
    }
    if (!score().includes("Score: 1")) throw new Error(`score: ${score()}`);
    session.stop();
    await until(idle);
    return { score: score() };
  });

  await step("ui_app", async () => {
    await runFile("Examples/Counter App.py");
    await until(() => session.getSnapshot().uiOpen);
    const plus = await untilNode((n) => n.t === "Button" && n.p.label === "+1");
    for (let i = 0; i < 5; i++) {
      await nativeEvent(plus.i, "click");
      await sleep(30);
    }
    await untilNode((n) => n.t === "Text" && n.p.font === "largeTitle" && n.p.text === "5");
    const { ops, ms } = await nativeRenderStats();
    await call("test.ui", { action: "close" });
    await until(() => !session.getSnapshot().uiOpen);
    return { lastRender: { ops, ms } };
  });

  await step("ui_todo", async () => {
    // The full example: navigation, a text field, and saving into SQLite
    // while the app keeps running (the worker flushes files when idle).
    for (const f of ["todos.db", "todos.db-journal", "todos.json"]) if (await fs.exists(`Examples/${f}`)) await fs.remove(`Examples/${f}`);
    await runFile("Examples/Todo App.py");
    const inboxRow = (n: NativeNode) => n.t === "Row" && n.p.title === "Inbox";
    await nativeEvent((await untilNode(inboxRow)).i, "click");
    const stack = () => nativeTree().then((t) => findNodes(t.tree, (n) => n.t === "NavigationStack")[0]);
    const top = async () => (await stack())?.c?.at(-1);
    await until(async () => (await stack())?.c?.length === 2 && (await top())?.p.title === "Inbox");
    const field = findNodes((await top())!, (n) => n.t === "TextField" && n.p.placeholder === "New To-Do")[0];
    await nativeEvent(field.i, "change", ["Selftest to-do"]);
    await nativeEvent(field.i, "submit", ["Selftest to-do"]);
    await until(async () => findNodes((await top())!, (n) => n.t === "Row" && n.p.title === "Selftest to-do").length > 0);
    await nativeEvent((await top())!.i, "back");
    await untilNode((n) => inboxRow(n) && String(n.p.detail) === "2");
    // SQLite stores short text as is, so the title shows up in the file's bytes.
    const saved = async () =>
      (await fs.exists("Examples/todos.db")) &&
      new TextDecoder("latin1").decode(base64ToBytes(await fs.readBase64("Examples/todos.db"))).includes("Selftest to-do");
    // On disk while the app is still open: 0.5 s of quiet, then the next flush.
    const t0 = performance.now();
    for (let i = 0; i < 40 && !(await saved()); i++) await sleep(100);
    if (!(await saved())) throw new Error("todos.db not written back while the app runs");
    const savedMs = Math.round(performance.now() - t0);
    if (!session.getSnapshot().uiOpen) throw new Error("the app closed");
    await call("test.ui", { action: "close" });
    await until(() => !session.getSnapshot().uiOpen);
    await sleep(300);
    if (await fs.exists("Examples/todos.db-journal")) throw new Error("a journal was left behind");
    // A second run reads the database back.
    await runFile("Examples/Todo App.py");
    await untilNode((n) => inboxRow(n) && String(n.p.detail) === "2");
    await call("test.ui", { action: "close" });
    await until(() => !session.getSnapshot().uiOpen);
    await sleep(300);
    await fs.remove("Examples/todos.db");
    return { savedMs };
  });

  await step("ui_navigation", async () => {
    // Native navigation, dialogs and sheets (D30), driven through the host's renderer.
    const slow = location.hash.includes("slow") ? 2500 : 0;
    await fs.writeText("Tests/Navigation.py", navigationExample);
    await runFile("Tests/Navigation.py");
    const ada = await untilNode((n) => n.t === "Row" && n.p.title === "Ada Lovelace");
    await sleep(slow);
    await nativeEvent(ada.i, "click");
    const stack = () => nativeTree().then((t) => findNodes(t.tree, (n) => n.t === "NavigationStack")[0]);
    const top = async () => (await stack())?.c?.at(-1);
    await until(async () => (await stack())?.c?.length === 2 && (await top())?.p.title === "Ada Lovelace");
    await sleep(slow);
    const rename = findNodes((await top())!, (n) => n.t === "Button" && n.p.label === "Rename…")[0];
    await nativeEvent(rename.i, "click");
    await until(async () => (await nativeTree()).dialogs?.[0]?.kind === "prompt");
    await sleep(slow);
    await call("test.ui", { action: "dialog", value: "Ada L." });
    await until(async () => (await top())?.p.title === "Ada L.");
    await nativeEvent((await top())!.i, "back");
    await until(async () => (await stack())?.c?.length === 1);
    const add = await untilNode((n) => n.t === "Button" && n.p.a11y === "Add");
    await nativeEvent(add.i, "click");
    await until(async () => (await nativeTree()).sheets?.length === 1);
    const sheet = await untilNode((n) => n.t === "Sheet" && n.p.open === true);
    const [name] = findNodes(sheet, (n) => n.t === "TextField");
    await nativeEvent(name.i, "change", ["Margaret Hamilton"]);
    await sleep(slow);
    const save = findNodes(sheet, (n) => n.t === "Button" && n.p.label === "Save")[0];
    await until(async () => findNodes((await nativeTree()).tree, (n) => n.i === save.i && !n.p.disabled).length > 0);
    await nativeEvent(save.i, "click");
    await until(async () => (await nativeTree()).sheets?.length === 0);
    await untilNode((n) => n.t === "Row" && n.p.title === "Margaret Hamilton");
    await sleep(slow);
    await call("test.ui", { action: "close" });
    await until(() => !session.getSnapshot().uiOpen);
  });

  await step("linked_folder", async () => {
    // A folder outside Documents, linked like one picked from iCloud Drive
    // (the picker itself cannot be driven from here): browse, edit, run, write back.
    const loc = await call<{ name: string; path: string }>("test.link", { name: "Selftest Cloud" });
    const dir = `${loc.path}/app`;
    try {
      const listed = await locations.list();
      if (!listed.some((l) => l.path === loc.path && l.available)) throw new Error(`not listed: ${JSON.stringify(listed)}`);
      if ((await fs.list("")).some((e) => e.path === loc.path)) throw new Error("linked folder listed in Documents");
      await fs.writeText(`${dir}/helper.py`, "NAME = 'linked'\n");
      await fs.writeText(`${dir}/main.py`, "");
      await runFile(`${dir}/main.py`, "import os\nfrom helper import NAME\nopen('out.txt', 'w').write(NAME)\nos.makedirs('data', exist_ok=True)\nopen('data/x.txt', 'w').write('x')\nos.remove('helper.py')\nprint('hello from', NAME)\n");
      await until(idle);
      if (!consoleText().includes("hello from linked")) throw new Error(consoleText());
      for (let i = 0; i < 30 && !(await fs.exists(`${dir}/out.txt`)); i++) await sleep(100);
      const out = await fs.readText(`${dir}/out.txt`);
      if (out !== "linked") throw new Error(`out.txt: ${out}`);
      // It ran on a local copy (D35); new folders and deletions went back too.
      if ((await fs.readText(`${dir}/data/x.txt`)) !== "x") throw new Error("data/x.txt not synced back");
      if (await fs.exists(`${dir}/helper.py`)) throw new Error("helper.py not deleted in the linked folder");
      if (!(await fs.list(loc.path)).some((e) => e.name === "app" && e.dir)) throw new Error("app folder not listed");
      let refused = false;
      await fs.remove(loc.path).catch(() => (refused = true));
      if (!refused) throw new Error("deleting a linked folder's root was allowed");
      await fs.remove(dir);
    } finally {
      await locations.remove(loc.path);
    }
    if (await fs.exists(`${dir}/main.py`)) throw new Error("still reachable after removing the location");
    if ((await locations.list()).some((l) => l.path === loc.path)) throw new Error("still listed");
  });

  await step("crash_recovery", async () => {
    await fs.writeText("Tests/deep.py", "x = []\nfor _ in range(50000): x = [x]\nprint(len(repr(x)))\n");
    await runFile("Tests/deep.py");
    await until(idle);
    if (!consoleText().includes("Python crashed")) throw new Error(consoleText());
    await runFile("Tests/edit.py", "print('alive again')\n");
    await until(idle);
    if (!consoleText().includes("alive again")) throw new Error(consoleText());
  });

  // -- code intelligence and dependencies -------------------------------------------

  const diagnostics = () => editorCall<{ source: string; message: string; actions: string[] }[]>("diagnostics");
  const editorText = () => editorCall<string>("text");

  async function openWith(path: string, code: string) {
    await fs.writeText(path, code);
    await app.openFile(path);
    await until(async () => (await app.currentFile()) === path && (await app.editorPath()) === path);
    if ((await editorText()) !== code) await editorCall("setText", code);
  }

  await step("analysis_ready", async () => {
    const info = await analysis.init();
    return { ruff: info.ruff, ruffInitMs: Math.round(info.ruffMs), tyInitMs: Math.round(info.tyMs) };
  });

  await step("lint_and_types", async () => {
    await openWith("Tests/lint.py", 'import os\n\n\ndef add(a: int, b: int) -> int:\n    return a + b\n\n\nadd(1, "two")\nprint(undefined_name)\n');
    const t0 = performance.now();
    const ds = await until(async () => { const d = await diagnostics(); return d.length >= 3 && d; }, 20000);
    const sources = ds.map((d) => d.source.replace(" ", ":"));
    for (const w of ["ruff:F401", "ty:invalid-argument-type", "ty:unresolved-reference"]) if (!sources.includes(w)) throw new Error(`missing ${w}: ${sources}`);
    const f401Actions = ds.find((d) => d.source === "ruff F401")!.actions;
    return { firstCheckMs: Math.round(performance.now() - t0), sources, f401Actions };
  });

  await step("pyodide_imports_not_flagged", async () => {
    await openWith("Tests/np.py", "import numpy as np\nimport matplotlib.pyplot as plt\nprint(np.pi, plt)\n");
    await sleep(1500);
    const unresolved = (await diagnostics()).filter((d) => d.source.includes("unresolved-import"));
    if (unresolved.length) throw new Error(JSON.stringify(unresolved));
  });

  await step("completions", async () => {
    const t0 = performance.now();
    const items = await analysis.complete("Tests/c.py", "import math\nmath.sq", 2, 8);
    const names = items.map((i) => i.name);
    if (!names.includes("sqrt")) throw new Error(names.slice(0, 20).join(","));
    return { ms: Math.round(performance.now() - t0), first: names.slice(0, 5) };
  });

  await step("format", async () => {
    await openWith("Tests/fmt.py", "x=[1,2,\n3]\ndef f( a ):\n  return a\n");
    await app.format();
    const out = await editorText();
    if (out !== "x = [1, 2, 3]\n\n\ndef f(a):\n    return a\n") throw new Error(JSON.stringify(out));
  });

  await step("add_dependency_quickfix_and_run", async () => {
    await openWith("Tests/cow.py", 'import cowsay\n\ncowsay.cow("moo from PyPI")\n');
    const d = await until(async () => (await diagnostics()).find((x) => x.source.includes("unresolved-import")), 20000);
    if (!(await editorCall("applyFixNamed", "cowsay"))) throw new Error("no quick fix");
    const text = await editorText();
    if (!text.startsWith('# /// script\n# dependencies = [\n#     "cowsay",\n# ]\n# ///')) throw new Error(text);
    session.clear();
    const t0 = performance.now();
    await app.run();
    await until(idle, 60000);
    const out = consoleText();
    if (!out.includes("moo from PyPI")) throw new Error(out);
    return { action: d.actions, installRunMs: Math.round(performance.now() - t0), status: out.split("\n").filter((l) => l.startsWith("Install")) };
  });

  await step("dependencies_cached_rerun", async () => {
    session.clear();
    const t0 = performance.now();
    await app.run();
    await until(idle, 60000);
    if (!consoleText().includes("moo from PyPI")) throw new Error(consoleText());
    return { rerunMs: Math.round(performance.now() - t0) };
  });

  await step("requires_python", async () => {
    await openWith("Tests/old.py", '# /// script\n# requires-python = "<3.10"\n# ///\nprint("should not run")\n');
    session.clear();
    await app.run();
    await until(idle);
    const out = consoleText();
    if (!out.includes("requires Python <3.10") || out.includes("should not run")) throw new Error(out);
  });

  // -- Python versions and docs (D37) -----------------------------------------------

  const lastRun = () => Object.values(session.getSnapshot().runs).at(-1);

  await step("python_versions", async () => {
    await fs.mkdir("Tests/py").catch(() => {});
    await fs.remove("Tests/py/.python-version").catch(() => {});
    const code = "import sys\nprint('on', sys.version.split()[0])\n";
    await fs.writeText("Tests/py/v.py", code);
    let { done } = await runFile("Tests/py/v.py");
    await done;
    if (!consoleText().includes("on 3.14.2") || lastRun()?.python !== "3.14.2") throw new Error(`default: ${consoleText()} ${lastRun()?.python}`);
    // The folder pins 3.15, as the ⋯ menu writes it.
    await appCall("setFolderPython", "3.15");
    if ((await fs.readText("Tests/py/.python-version")).trim() !== "3.15") throw new Error("no .python-version");
    const native = await appCall("filePython");
    if (native.python !== "3.15" || native.pin !== "3.15") throw new Error(`native: ${JSON.stringify(native)}`);
    ({ done } = await runFile("Tests/py/v.py"));
    await done;
    if (!consoleText().includes("on 3.15.0rc1") || lastRun()?.python !== "3.15.0rc1") throw new Error(`pinned: ${consoleText()}`);
    // 3.15's packages come from its own CDN folder and cache.
    ({ done } = await runFile("Tests/py/v.py", "import numpy, sys\nprint('numpy', numpy.__version__, 'on', sys.version_info[:2])\n"));
    await done;
    if (!/numpy \S+ on \(3, 15\)/.test(consoleText())) throw new Error(`numpy on 3.15: ${consoleText()}`);
    await appCall("setFolderPython", null);
    if (await fs.exists("Tests/py/.python-version")) throw new Error(".python-version not removed");
    // requires-python picks a version: >=3.15 needs the preview, >=3.10 keeps the default.
    ({ done } = await runFile("Tests/py/v.py", '# /// script\n# requires-python = ">=3.15"\n# ///\n' + code));
    await done;
    if (!consoleText().includes("on 3.15.0rc1")) throw new Error(`requires >=3.15: ${consoleText()}`);
    ({ done } = await runFile("Tests/py/v.py", '# /// script\n# requires-python = ">=3.10"\n# ///\n' + code));
    await done;
    if (!consoleText().includes("on 3.14.2")) throw new Error(`requires >=3.10: ${consoleText()}`);
    // The default from Settings.
    await appCall("setDefaultPython", "3.15");
    await until(async () => (await appCall("filePython")).python === "3.15", 5000);
    ({ done } = await runFile("Tests/py/v.py", code));
    await done;
    const onDefault = consoleText();
    await appCall("setDefaultPython", "3.14");
    if (!onDefault.includes("on 3.15.0rc1")) throw new Error(`default 3.15: ${onDefault}`);
    await until(async () => (await appCall("filePython")).python === "3.14", 5000);
  });

  await step("docs_index", async () => {
    const search = (query: string, version = "3.14") => call<{ ref: string; title: string; link: string }[]>("docs.search", { query, version, limit: 8 });
    const loads = await search("json.loads");
    if (loads[0]?.ref !== "library/json.html#json.loads" || loads[0].link !== "docs:3.14/library/json.html#json.loads") throw new Error(JSON.stringify(loads.slice(0, 3)));
    const words = await search("template strings");
    if (!words.some((h) => h.ref.startsWith("library/string.templatelib.html"))) throw new Error(`words: ${JSON.stringify(words.map((h) => h.ref))}`);
    const page = await call<{ title: string; markdown: string } | null>("docs.read", { ref: "library/json.html#json.loads", version: "3.14" });
    if (!page?.markdown.includes("Deserialize") && !page?.markdown.includes("deserialize")) throw new Error(`read: ${page?.markdown.slice(0, 200)}`);
    const section = await call<{ markdown: string } | null>("docs.read", { ref: "library/json.html#basic-usage", version: "3.14" });
    if (!section?.markdown.includes("`json.dump(")) throw new Error(`section: ${section?.markdown.slice(0, 300)}`);
    const v315 = await search("json.loads", "3.15");
    if (v315[0]?.ref !== "library/json.html#json.loads") throw new Error(`3.15: ${JSON.stringify(v315.slice(0, 2))}`);
    return { results: words.length, sectionChars: section.markdown.length };
  });

  await step("docs_viewer", async () => {
    await appCall("showDocs", "3.14", "library/json.html#json.loads");
    let state = await until(async () => {
      const s = await appCall("docsState");
      return s.shown && s.ref === "library/json.html#json.loads" && /json/.test(s.title ?? "") ? s : null;
    }, 10000);
    const hits = await appCall<string[]>("docsSearch", "pathlib.Path.glob");
    if (hits[0] !== "library/pathlib.html#pathlib.Path.glob") throw new Error(`viewer search: ${JSON.stringify(hits)}`);
    // An agent's docs: link opens the viewer at the other version.
    await appCall("docsLink", "docs:3.15/library/os.html#os.listdir");
    state = await until(async () => {
      const s = await appCall("docsState");
      return s.version === "3.15" && s.ref === "library/os.html#os.listdir" ? s : null;
    }, 10000);
    await appCall("closeDocs");
    await until(async () => !(await appCall("docsState")).shown, 5000);
    return { title: state.title };
  });

  await step("help_opens_docs", async () => {
    await fs.writeText("Tests/py/h.py", "import json, pathlib\n");
    const { done } = await runFile("Tests/py/h.py");
    await done;
    const expectDocs = async (source: string, ref: string) => {
      await session.runConsole(source);
      await until(idle);
      await until(async () => (await appCall("docsState")).ref === ref, 8000).catch(async () => {
        throw new Error(`${source}: ${JSON.stringify(await appCall("docsState"))} ${consoleText().slice(-300)}`);
      });
    };
    await expectDocs("help(json.loads)", "library/json.html#json.loads");
    if (!consoleText().includes("Opened the Python 3.14 documentation")) throw new Error(consoleText());
    await expectDocs("help(pathlib.Path.glob)", "library/pathlib.html#pathlib.Path.glob");
    await expectDocs("help(str.split)", "builtins/stdtypes.html#str.split");
    await expectDocs("help('json')", "library/json.html#module-json");
    await appCall("closeDocs");
    // Not the standard library: pydoc's text, as before.
    await session.runConsole("class Mine:\n    'My own class.'\nhelp(Mine)");
    await until(idle);
    if (!consoleText().includes("My own class.") || (await appCall("docsState")).shown) throw new Error(`pydoc: ${consoleText().slice(-300)}`);
  });

  await step("show_info_docs", async () => {
    const text = "import json\nimport pathlib\njson.loads('1')\npathlib.Path('.').glob('*')\n";
    await openWith("Tests/py/info.py", text);
    const loads = await appCall("docsTarget", "Tests/py/info.py", text, 3, 8);
    if (loads?.ref !== "library/json.html#json.loads") throw new Error(`json.loads: ${JSON.stringify(loads)}`);
    const glob = await appCall("docsTarget", "Tests/py/info.py", text, 4, 20);
    if (glob?.ref !== "library/pathlib.html#pathlib.Path.glob") throw new Error(`glob: ${JSON.stringify(glob)}`);
    const module = await appCall("docsTarget", "Tests/py/info.py", text, 1, 9);
    if (module?.ref !== "library/json.html#module-json") throw new Error(`module: ${JSON.stringify(module)}`);
  });

  // -- debugger (D23) --------------------------------------------------------------

  await fs.mkdir("Tests").catch(() => {});
  const stopped = (prev = -1) => () => {
    const d = session.getSnapshot().debug;
    return d && d.stopId !== prev ? d : null;
  };

  await step("debugger_breakpoint_step_inspect", async () => {
    const code = "def greet(name):\n    message = f'Hello {name}'\n    return message\n\n\nfor who in ['Ada', 'Guido']:\n    print(greet(who))\n";
    await fs.writeText("Tests/debug.py", code);
    breakpoints.set("Tests/debug.py", [{ line: 3, enabled: true }]);
    const t0 = performance.now();
    await runFile("Tests/debug.py");
    let d = await until(stopped());
    const stopMs = Math.round(performance.now() - t0);
    const where = `${d.frames[0].name}:${d.frames[0].line}/${d.frames[1]?.name}:${d.frames[1]?.line}`;
    if (where !== "greet:3/<module>:7") throw new Error(`stopped at ${where}`);
    const message = d.scopes[0].variables.find((v) => v.name === "message")?.value;
    if (message !== "'Hello Ada'") throw new Error(`message = ${message}`);
    const evaluated = await session.debugEvaluate("name.upper()");
    if (evaluated.value?.value !== "'ADA'") throw new Error(JSON.stringify(evaluated));
    await session.debugConsole("message = 'Hi Ada'"); // the program sees the change
    session.resume("next");
    d = await until(stopped(d.stopId));
    if (d.frames[0].name !== "<module>") throw new Error(`next went to ${d.frames[0].name}:${d.frames[0].line}`);
    breakpoints.clear("Tests/debug.py"); // sent to the paused program
    session.resume("continue");
    await until(idle);
    const out = consoleText();
    if (!out.includes("Hi Ada") || !out.includes("Hello Guido")) throw new Error(out);
    return { stopMs };
  });

  await step("debugger_pause_and_stop", async () => {
    await fs.writeText("Tests/loop.py", "import time\nn = 0\nwhile True:\n    n += 1\n    if n % 1000 == 0:\n        time.sleep(0.05)\n");
    await runFile("Tests/loop.py");
    await until(() => session.getSnapshot().status === "running");
    await sleep(800);
    const t0 = performance.now();
    session.pause();
    const d = await until(stopped());
    const pauseMs = Math.round(performance.now() - t0);
    if (d.reason !== "pause" || d.frames[0].file !== "Tests/loop.py") throw new Error(JSON.stringify(d.frames));
    session.stop();
    await until(idle);
    const run = Object.values(session.getSnapshot().runs).at(-1);
    if (run?.status !== "stopped") throw new Error(`run ${run?.status}: ${consoleText()}`);
    return { pauseMs, line: d.frames[0].line };
  });

  await step("debugger_breakpoint_while_running", async () => {
    await fs.writeText("Tests/late.py", "import time\ntotal = 0\nfor i in range(400):\n    total += i\n    time.sleep(0.01)\nprint('total', total)\n");
    await runFile("Tests/late.py");
    await until(() => session.getSnapshot().status === "running");
    await sleep(500);
    breakpoints.set("Tests/late.py", [{ line: 4, enabled: true }]);
    const d = await until(stopped(), 5000);
    breakpoints.clear("Tests/late.py");
    session.resume("continue");
    await until(idle);
    if (!consoleText().includes("total 79800")) throw new Error(consoleText());
    return { line: d.frames[0].line, i: d.scopes[0].variables.find((v) => v.name === "i")?.value };
  });

  await step("debugger_inspect_error", async () => {
    await fs.writeText("Tests/avg.py", "def average(xs):\n    total = sum(xs)\n    return total / len(xs)\n\nprint(average([]))\n");
    const { done } = await runFile("Tests/avg.py");
    await done;
    await until(idle);
    if (!session.canInspect) throw new Error("cannot inspect");
    void session.inspectError();
    const d = await until(stopped());
    if (!d.postMortem || !d.exception?.startsWith("ZeroDivisionError") || d.frames[0].name !== "average") throw new Error(JSON.stringify(d));
    const xs = d.scopes[0].variables.find((v) => v.name === "xs")?.value;
    session.resume("continue");
    await until(() => !session.getSnapshot().debug && idle());
    return { xs };
  });

  await step("breakpoint_builtin", async () => {
    await fs.writeText("Tests/bp.py", "x = 41\nbreakpoint()\nx += 1\nprint('x is', x)\n");
    await runFile("Tests/bp.py");
    const d = await until(stopped());
    if (d.reason !== "breakpoint()" || d.frames[0].line !== 2) throw new Error(JSON.stringify(d.frames));
    session.resume("continue");
    await until(idle);
    if (!consoleText().includes("x is 42")) throw new Error(consoleText());
  });

  // -- navigation: traceback links, go to definition, tabs, split view --------------

  const editorInfo = () => editorCall<{ path: string | null; readOnly: boolean; line: number; lineText: string }>("info");

  await step("traceback_link", async () => {
    await fs.mkdir("Tests").catch(() => {});
    await fs.mkdir("Tests/nav").catch(() => {});
    await fs.writeText("Tests/nav/helper.py", "def average(xs):\n    total = sum(xs)\n    return total / len(xs)\n");
    await fs.writeText("Tests/nav/main.py", "from helper import average\n\nprint(average([1, 2]))\nprint(average([]))\n");
    const { done } = await runFile("Tests/nav/main.py");
    await done;
    await until(idle);
    const links = await app.tapTraceback('File "helper.py", line 3');
    if (!links) throw new Error("no link");
    await until(async () => { const i = await editorInfo(); return i.path === "Tests/nav/helper.py" && i.line === 3; });
    return { links };
  });

  await step("go_to_definition", async () => {
    await app.openFile("Tests/nav/main.py");
    await until(async () => (await app.editorPath()) === "Tests/nav/main.py");
    await editorCall("setCursor", 3, 1 + "print(".length + 2); // in "average"
    const t0 = performance.now();
    const asked = await app.goToDefinition();
    try {
      await until(async () => { const i = await editorInfo(); return i.path === "Tests/nav/helper.py" && i.line === 1; }, 5000);
    } catch {
      throw new Error(`went to ${JSON.stringify(await editorInfo())} (${JSON.stringify(asked)})`);
    }
    const projectMs = Math.round(performance.now() - t0);
    await app.openFile("Tests/nav/main.py");
    await until(async () => (await app.editorPath()) === "Tests/nav/main.py");
    await editorCall("setCursor", 3, 3); // print
    await app.goToDefinition();
    await until(async () => (await app.editorPath())?.endsWith("builtins.pyi"));
    const info = await editorInfo();
    if (!info.readOnly || !info.lineText.startsWith("def print(")) throw new Error(`not at def print: ${JSON.stringify(info)}`);
    await app.closeTab((await app.currentFile())!);
    return { projectMs };
  });

  await step("tabs", async () => {
    const pane = async () => {
      const [panes, current] = [await app.panes(), await app.currentFile()];
      return panes.find((p) => p.active === current) ?? panes[0];
    };
    const tabs = (await pane()).tabs;
    if (!tabs.includes("Tests/nav/main.py") || !tabs.includes("Tests/nav/helper.py")) throw new Error(JSON.stringify(tabs));
    if (tabs.some((t) => t.startsWith("ext:"))) throw new Error("closed tab still open");
    await app.closeTab("Tests/nav/helper.py");
    await until(async () => !(await pane()).tabs.includes("Tests/nav/helper.py"));
    return { open: (await pane()).tabs.length };
  });

  await step("split_view", async () => {
    if (!(await app.wide())) return { skipped: "iPhone" };
    await app.openFile("Tests/nav/main.py");
    await app.setSplit(true);
    await until(async () => (await app.panes()).length === 2);
    await app.openFile("Tests/nav/helper.py"); // opens in the focused (right) pane
    await until(async () => (await app.panes())[1]?.active === "Tests/nav/helper.py");
    await app.openLocation("Tests/nav/main.py");
    await app.setSplit(false);
    await until(async () => (await app.panes()).length === 1);
  });

  // -- HTTP through the host's proxy (D25) -------------------------------------------

  await step("http", async () => {
    await fs.mkdir("Tests").catch(() => {});
    await fs.writeText("Tests/webcheck.py", [
      "import requests, urllib.request",
      "r = requests.get('https://httpbin.org/get', params={'q': 'x'}, headers={'User-Agent': 'pyslop-test/1'}, timeout=20)",
      "print('get', r.status_code, r.json()['args'], r.json()['headers']['User-Agent'])",
      "r = requests.post('https://httpbin.org/post', json={'a': 1}, timeout=20)",
      "print('post', r.status_code, r.json()['json'])",
      "print('urllib', urllib.request.urlopen('https://httpbin.org/status/201').status)",
      "import httpx",
      "print('httpx', httpx.get('https://httpbin.org/status/202').status_code)",
      "from pyodide.http import pyfetch",
      "print('pyfetch', (await pyfetch('https://httpbin.org/status/203')).status)",
      "try:",
      "    requests.get('https://does-not-exist.invalid/', timeout=5)",
      "except requests.ConnectionError:",
      "    print('connection error ok')",
      "",
    ].join("\n"));
    const t0 = performance.now();
    const { done } = await runFile("Tests/webcheck.py");
    await done;
    await until(idle, 60000);
    const out = consoleText();
    for (const want of ["get 200 {'q': 'x'} pyslop-test/1", "post 200 {'a': 1}", "urllib 201", "httpx 202", "pyfetch 203", "connection error ok"]) {
      if (!out.includes(want)) throw new Error(out.slice(-600));
    }
    return { ms: Math.round(performance.now() - t0) };
  });

  // -- typing through iOS text input into the native console fields ------------------

  const typeNative = (text: string) => call<string>("test.type", { text });

  await step("typing_console", async () => {
    await fs.writeText("Tests/typing.py", "x = 1\n");
    const { done } = await runFile("Tests/typing.py");
    await done;
    await until(idle);
    await app.showPane("console");
    await app.focusField("console");
    await sleep(600);
    const responder = await typeNative("x + 41");
    await sleep(300);
    const value = await app.fieldValue("console");
    if (value !== "x + 41") throw new Error(`typed "x + 41", field has ${JSON.stringify(value)} (${responder})`);
    await app.submitField("console");
    await until(() => consoleText().includes("42"));
  });

  type KeyBar = { shown: boolean } | string;
  const keyBar = (keys: string[]) => call<KeyBar>("test.keybar", { keys });

  await step("keybar_console", async () => {
    // The code keys above the keyboard work in the native >>> field too.
    await app.showPane("console");
    await app.focusField("console");
    await sleep(600);
    try {
      await typeNative("len");
      const tapped = await keyBar(["("]);
      if (typeof tapped === "string") throw new Error(tapped);
      await typeNative("[1, 2");
      await keyBar(["]"]);
      await sleep(200);
      const value = await app.fieldValue("console");
      if (value !== "len([1, 2])") throw new Error(`field has ${JSON.stringify(value)}`);
      await app.submitField("console");
      await until(() => consoleText().includes("len([1, 2])2"));
      return { shown: tapped.shown };
    } finally {
      await app.clearField("console");
    }
  });

  await step("keybar_only_with_software_keyboard", async () => {
    // The bar shows only with the software keyboard: not with a hardware
    // keyboard, and not after the software keyboard's own hide key (iPad),
    // which keeps the field focused.
    await app.showPane("console");
    await app.focusField("console");
    await sleep(1000);
    const before = await keyBar([]);
    if (typeof before === "string") throw new Error(before);
    if (!before.shown) {
      await app.blurFields();
      return { hardwareKeyboard: true };
    }
    if (!(await app.wide())) {
      await app.blurFields();
      return { shown: true, skipped: "no hide key on iPhone" };
    }
    const hidden = await call<unknown>("test.hideKeyboard", {});
    if (hidden !== true) throw new Error(String(hidden));
    await sleep(1200);
    const after = await keyBar([]);
    await app.blurFields();
    if (typeof after === "string" || after.shown) throw new Error(`after hiding: ${JSON.stringify(after)}`);
    return { collapsedAfterHide: true };
  });

  await step("typing_plain_traits", async () => {
    await app.showPane("console");
    await app.focusField("console");
    await sleep(800);
    const notes = await typeNative("");
    // UITextAutocapitalizationType.none = 0, UITextAutocorrectionType.no = 1, UITextSmartQuotesType.no = 1
    if (!/autocap=0 autocorrect=1 quotes=1/.test(notes)) throw new Error(notes);
    await app.blurFields();
    return { notes };
  });

  await step("typing_input", async () => {
    await runFile("Examples/Hello.py");
    await until(() => session.getSnapshot().awaitingInput);
    await sleep(800);
    const responderInput = await typeNative("Armin");
    await sleep(300);
    const value = await app.fieldValue("input");
    if (value !== "Armin") throw new Error(`typed "Armin", field has ${JSON.stringify(value)} (${responderInput})`);
    await app.submitField("input");
    await until(idle);
    if (!consoleText().includes("Hello, Armin!")) throw new Error(consoleText());
  });

  await step("typing_debugger_console", async () => {
    await fs.writeText("Tests/typing2.py", "def f(a):\n    b = a * 2\n    return b\n\nprint(f(21))\n");
    breakpoints.set("Tests/typing2.py", [{ line: 3, enabled: true }]);
    await runFile("Tests/typing2.py");
    await until(stopped());
    await app.showPane("console");
    await app.focusField("console");
    await sleep(600);
    await typeNative("b + 1");
    await sleep(300);
    const value = await app.fieldValue("console");
    if (value !== "b + 1") throw new Error(`typed "b + 1", field has ${JSON.stringify(value)}`);
    await app.submitField("console");
    await until(() => consoleText().includes("43"));
    breakpoints.clear("Tests/typing2.py");
    session.resume("continue");
    await until(idle);
  });

  // The coding agent (D34) with a scripted model: every tool against a real
  // project folder, the edited file open in the editor, the native transcript.
  await step("agent", async () => {
    const { agent } = await import("./agent/service");
    const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const dir = "Tests/agent";
    await fs.mkdir(dir);
    await fs.writeText(`${dir}/greet.py`, 'def greet(name):\n    return "Hello " + name\n\n\nif __name__ == "__main__":\n    print(greet("world"))\n');
    await fs.remove(`${dir}/out.txt`).catch(() => {});
    await fs.remove(`${dir}/data`).catch(() => {});
    await app.openFile(`${dir}/greet.py`);
    await appCall("openAgent", dir);
    await until(async () => (await agent.state()).project === dir, 30000);
    const faux = agent.useFaux();
    await agent.newConversation(dir);
    await agent.setModel("selftest", "faux-1");
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
      fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
    let firstPrompt = "";
    faux.setResponses([
      (context) => {
        const first = context.messages.find((m) => m.role === "user");
        firstPrompt = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content);
        return tool("ls", {}, "ls");
      },
      tool("read", { path: "greet.py" }, "read"),
      tool("edit", { path: "greet.py", edits: [{ oldText: '"Hello " + name', newText: 'f"Hello, {name}!"' }] }, "edit"),
      tool("write", { path: "data/notes.py", content: "import os\nx=1\n" }, "write"),
      tool("run_python", { code: "from greet import greet\nopen('out.txt', 'w').write(greet('agent'))\nprint(greet('agent'))" }, "run"),
      tool("grep", { pattern: "Hello", glob: "*.py" }, "grep"),
      tool("find", { pattern: "*.txt" }, "find"),
      tool("check", { paths: ["data/notes.py"] }, "check"),
      tool("format", { paths: ["data/notes.py"] }, "format"),
      tool("read", { path: "../secret.txt" }, "outside"),
      fauxAssistantMessage([fauxText("Done: greet() now uses an f-string.")]),
    ]);
    await agent.submit("Make greet friendlier", await appCall("agentIDEState"));
    const state = await until(async () => {
      const s = await agent.state();
      return !s.busy && s.items.at(-1)?.text.startsWith("Done") ? s : null;
    }, 120000);
    const tools = Object.fromEntries(state.items.filter((i) => i.kind === "tool").map((i) => [i.id, i]));
    const expect = (cond: unknown, what: string) => {
      if (!cond) throw new Error(`${what}: ${JSON.stringify(state.items.map((i) => [i.id, i.status, (i.output ?? i.text).slice(0, 160)]))}`);
    };
    expect(Object.values(tools).every((t) => (t.id === "outside" ? t.status === "error" : t.status === "done")), "tool statuses");
    expect(tools.ls.output?.includes("greet.py"), "ls");
    expect(tools.write.output?.includes("F401"), "lint feedback after write");
    expect(tools.run.output?.includes("Hello, agent!"), "run_python output");
    expect(tools.grep.output?.includes("greet.py:2:"), "grep");
    expect(tools.find.output?.includes("out.txt"), "find sees run_python's file");
    expect(tools.check.output?.includes("F401"), "check");
    expect(tools.format.output?.includes("1 file reformatted") && tools.format.diff, "format");
    expect(tools.edit.diff, "edit diff");
    expect(firstPrompt.includes("<ide>") && firstPrompt.includes("Active file: greet.py") && firstPrompt.endsWith("Make greet friendlier"), `IDE context in the prompt (${firstPrompt.slice(0, 300)})`);
    const user = state.items.find((i) => i.kind === "user");
    expect(user?.text === "Make greet friendlier" && user.path === "greet.py", "the transcript shows the message and its file");
    const greet = await fs.readText(`${dir}/greet.py`);
    if (!greet.includes('f"Hello, {name}!"')) throw new Error(`greet.py: ${greet}`);
    const out = await fs.readText(`${dir}/out.txt`);
    if (out !== "Hello, agent!") throw new Error(`out.txt: ${out}`);
    const notes = await fs.readText(`${dir}/data/notes.py`);
    if (notes !== "import os\n\nx = 1\n") throw new Error(`notes.py: ${JSON.stringify(notes)}`);
    // The open editor shows the agent's edit.
    await until(async () => String(await editorCall("text")).includes('f"Hello, {name}!"'), 5000);
    // The native view has the same transcript.
    const native = await until(async () => {
      const s = await appCall("agentState");
      return s.items === state.items.length && !s.busy ? s : null;
    }, 5000);
    await appCall("closeSheet");
    return { items: state.items.length, tools: native.tools.length, model: native.model };
  });

  // The IDE tools (D36) in the same conversation: the context is not repeated
  // when it did not change, ide_* act on the editor, and the user moving to
  // another file mid-turn reaches the model at the next step.
  await step("agent-ide", async () => {
    const { agent } = await import("./agent/service");
    const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const dir = "Tests/agent";
    const faux = agent.useFaux();
    await fs.writeText(`${dir}/messy.py`, "import os\nx=1\n");
    await app.openFile(`${dir}/greet.py`);
    await appCall("openAgent", dir);
    await until(async () => (await appCall("agentState")).sheet);
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
      fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
    const lastUser = (messages: any[]) => {
      const m = [...messages].reverse().find((x) => x.role === "user");
      return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
    };
    let prompt = "";
    let afterMove = "";
    let detent = "";
    faux.setResponses([
      (context) => {
        prompt = lastUser(context.messages);
        return tool("ide_state", {}, "state");
      },
      tool("ide_open", { path: "messy.py", line: 1, end_line: 2 }, "open"),
      async () => {
        detent = await appCall("agentDetent");
        return tool("ide_lint", {}, "lint");
      },
      tool("ide_format", {}, "format"),
      async () => {
        // The user goes back to greet.py while the agent works.
        await app.openFile(`${dir}/greet.py`);
        await sleep(1500);
        return tool("ls", {}, "ls");
      },
      (context) => {
        afterMove = lastUser(context.messages);
        return tool("ide_close", { path: "messy.py" }, "close");
      },
      tool("ide_open", { path: "nope.py" }, "missing"),
      fauxAssistantMessage([fauxText("Done in the IDE.")]),
    ]);
    await agent.submit("Tidy messy.py", await appCall("agentIDEState"));
    const state = await until(async () => {
      const s = await agent.state();
      return !s.busy && s.items.at(-1)?.text.startsWith("Done in the IDE") ? s : null;
    }, 60000);
    const tools = Object.fromEntries(state.items.filter((i) => i.kind === "tool").map((i) => [i.id, i]));
    const expect = (cond: unknown, what: string) => {
      if (!cond) throw new Error(`${what}: ${JSON.stringify(state.items.slice(-12).map((i) => [i.id, i.kind, i.status, (i.output ?? i.text).slice(0, 160)]))}`);
    };
    expect(!prompt.includes("<ide>") && prompt === "Tidy messy.py", `no IDE context when nothing changed (${prompt.slice(0, 200)})`);
    expect(tools.state.ide && tools.state.output?.includes("Active file: greet.py"), "ide_state");
    expect(tools.open.output?.startsWith("Opened messy.py at lines 1-2"), "ide_open");
    expect((await app.wide()) || detent === "medium", `the sheet makes room on iPhone (${detent})`);
    expect(tools.lint.output?.includes("F401"), "ide_lint");
    expect(tools.format.output?.startsWith("Formatted messy.py in the editor"), "ide_format");
    expect(afterMove.includes("<ide>") && afterMove.includes("Active file: greet.py"), `the move reaches the model (${afterMove.slice(0, 300)})`);
    expect(state.items.some((i) => i.kind === "context" && i.path === "greet.py"), "the move shows in the transcript");
    expect(tools.close.status === "done" && !(await app.panes()).some((p) => p.tabs.includes(`${dir}/messy.py`)), "ide_close");
    expect(tools.missing.status === "error" && tools.missing.output?.includes("No such file"), "ide_open of a missing file");
    const messy = await fs.readText(`${dir}/messy.py`);
    if (messy !== "import os\n\nx = 1\n") throw new Error(`messy.py: ${JSON.stringify(messy)}`);
    return { tools: Object.keys(tools).length };
  });

  // Several conversations per project (D36): a new one, one that keeps running
  // in the background (its IDE tools do nothing there), unread, archive, rename,
  // and a renamed folder.
  await step("agent-conversations", async () => {
    const { agent } = await import("./agent/service");
    const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const dir = "Tests/agent";
    const faux = agent.useFaux();
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
      fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
    const first = (await agent.state()).conversationId!;
    await agent.newConversation(dir);
    await agent.setModel("selftest", "faux-1");
    const second = (await agent.state()).conversationId!;
    if (second === first) throw new Error("no new conversation");
    faux.setResponses([
      tool("run_python", { code: "import time\ntime.sleep(2)\nprint('slept')" }, "sleep"),
      tool("ide_open", { path: "greet.py" }, "open"),
      fauxAssistantMessage([fauxText("Background done.")]),
    ]);
    await agent.submit("Wait, then open greet.py", null);
    await until(async () => (await agent.state()).busy);
    await agent.switchTo(first);
    const back = await until(async () => {
      const s = await agent.state();
      const c = s.conversations.find((x) => x.id === second);
      return c && !c.running && c.unread ? s : null;
    }, 60000);
    if (back.conversationId !== first) throw new Error("switched away");
    await agent.switchTo(second);
    const s2 = await agent.state();
    const open = s2.items.find((i) => i.id === "open");
    if (open?.status !== "error" || !open.output?.includes("not looking at this conversation")) throw new Error(`background ide_open: ${JSON.stringify(open)}`);
    if (s2.conversations.find((x) => x.id === second)?.unread) throw new Error("still unread on screen");
    const titles = s2.conversations.map((c) => c.title);
    if (!titles.includes("Make greet friendlier") || !titles.includes("Wait, then open greet.py")) throw new Error(`titles: ${JSON.stringify(titles)}`);
    // Archiving the one on screen shows the latest other one; it can come back.
    await agent.archive(second, true);
    let s = await agent.state();
    if (s.conversationId !== first || !s.conversations.find((x) => x.id === second)?.archived) throw new Error(`archive: ${JSON.stringify(s.conversations)}`);
    await agent.archive(second, false);
    await agent.rename(first, "Greeting work");
    s = await agent.state();
    if (s.conversations.find((x) => x.id === first)?.title !== "Greeting work") throw new Error("rename");
    // A renamed folder: the conversations follow.
    await agent.renamed(dir, `${dir}-moved`);
    s = await agent.state();
    const moved = s.project === `${dir}-moved` && s.root === `${dir}-moved` && s.conversations.every((c) => c.project === `${dir}-moved`);
    await agent.renamed(`${dir}-moved`, dir);
    if (!moved) throw new Error(`renamed: ${JSON.stringify({ project: s.project, root: s.root })}`);
    const native = await until(async () => {
      const n = await appCall("agentState");
      return n.conversations >= 2 ? n : null;
    }, 5000);
    await appCall("closeSheet");
    return { conversations: s.conversations.length, native: native.conversations };
  });

  // The docs tools (D37): search, read, and show the user.
  await step("agent-docs", async () => {
    const { agent } = await import("./agent/service");
    const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const dir = "Tests/agentdocs";
    await fs.mkdir(dir).catch(() => {});
    await fs.writeText(`${dir}/main.py`, "print('hi')\n");
    await app.openFile(`${dir}/main.py`);
    await appCall("openAgent", dir);
    await until(async () => (await agent.state()).project === dir, 30000);
    const faux = agent.useFaux();
    await agent.newConversation(dir);
    await agent.setModel("selftest", "faux-1");
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
      fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
    faux.setResponses([
      tool("docs_search", { query: "json.loads" }, "search"),
      tool("docs_read", { ref: "library/json.html#json.loads" }, "read"),
      tool("docs_search", { query: "template strings", version: "3.15" }, "search315"),
      tool("ide_show_docs", { ref: "library/json.html#json.loads" }, "show"),
      fauxAssistantMessage([fauxText("Done: see [json.loads](docs:3.14/library/json.html#json.loads).")]),
    ]);
    await agent.submit("How do I parse JSON?", await appCall("agentIDEState"));
    const state = await until(async () => {
      const s = await agent.state();
      return !s.busy && s.items.at(-1)?.text.startsWith("Done") ? s : null;
    }, 60000);
    const tools = Object.fromEntries(state.items.filter((i) => i.kind === "tool").map((i) => [i.id, i]));
    const expect = (cond: unknown, what: string) => {
      if (!cond) throw new Error(`${what}: ${JSON.stringify(state.items.map((i) => [i.id, i.status, (i.output ?? i.text).slice(0, 200)]))}`);
    };
    expect(Object.values(tools).every((t) => t.status === "done"), "tool statuses");
    expect(tools.search.output?.includes("ref: library/json.html#json.loads") && tools.search.output.includes("Python 3.14"), "docs_search");
    expect(tools.read.output?.includes("docs:3.14/library/json.html#json.loads") && /deserialize/i.test(tools.read.output), "docs_read");
    expect(tools.search315.output?.includes("Python 3.15") && tools.search315.output.includes("string.templatelib"), "docs_search 3.15");
    expect(tools.show.output?.includes("Showing the Python 3.14 docs"), "ide_show_docs");
    await until(async () => {
      const docs = await appCall("docsState");
      return docs.shown && docs.ref === "library/json.html#json.loads" && /json/.test(docs.title ?? "");
    }, 8000).catch(async () => {
      throw new Error(`viewer: ${JSON.stringify(await appCall("docsState"))}`);
    });
    await appCall("closeDocs");
    await until(async () => !(await appCall("docsState")).shown, 5000);
    await appCall("closeSheet");
  });

  await fs.remove("Tests").catch(() => {});
  await call("result", JSON.stringify(r, null, 2));
}
