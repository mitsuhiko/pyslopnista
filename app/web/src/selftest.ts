// End-to-end checks for the app (run with #selftest): edit, run, input, plots,
// file write-back, console, UI apps, crash recovery. Reports via the bridge.
import type { AppController } from "./App";
import { forEachDiagnostic } from "@codemirror/lint";
import { analysis } from "./analysis/client";
import { base64ToBytes, call, fs, isNative, locations } from "./host";
import { breakpoints } from "./debug/breakpoints";
import { session } from "./session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | null | false, timeout = 15000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error("timed out");
    await sleep(50);
  }
}

const consoleText = () => session.getSnapshot().lines.filter((l) => l.kind !== "image").map((l) => l.text).join("");
const idle = () => session.getSnapshot().status === "idle";

export async function selftest(app: AppController) {
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
    // Wait for React to render the newly opened file into the editor.
    await until(() => app.currentFile() === path && app.editor()?.currentPath() === path);
    if (code !== undefined) {
      const view = app.editor()!.view()!;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    }
    session.clear();
    const t0 = performance.now();
    const done = app.run();
    await until(() => session.getSnapshot().status !== "idle" || performance.now() - t0 > 3000);
    return { done, t0 };
  }

  // Breakpoints live in the web view's storage, which --reset does not clear.
  breakpoints.clearAll();
  app.setSplit(false); // a split view restored from the last session

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

  await step("ui_app", async () => {
    await runFile("Examples/Counter App.py");
    await until(() => session.getSnapshot().uiOpen);
    const plus = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".ui-button")].find((b) => b.textContent === "+1"));
    for (let i = 0; i < 5; i++) {
      plus.click();
      await sleep(30);
    }
    await until(() => document.querySelector(".ui-text-largeTitle")?.textContent === "5");
    (document.querySelector(".ui-app-close") as HTMLButtonElement).click();
    await until(() => !session.getSnapshot().uiOpen);
  });

  await step("ui_todo", async () => {
    // The full example: navigation, a text field, and saving into SQLite
    // while the app keeps running (the worker flushes files when idle).
    for (const f of ["todos.db", "todos.db-journal", "todos.json"]) if (await fs.exists(`Examples/${f}`)) await fs.remove(`Examples/${f}`);
    await runFile("Examples/Todo App.py");
    const q = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
    const inbox = await until(() => q(".ui-row").find((r) => r.textContent?.includes("Inbox")));
    inbox.querySelector<HTMLElement>(".ui-row-inner")!.click();
    const top = () => q(".ui-nav > .ui-screen").at(-1)!;
    await until(() => q(".ui-nav > .ui-screen").length === 2 && top().querySelector(".ui-screen-title")?.textContent === "Inbox");
    const input = top().querySelector<HTMLInputElement>(".ui-textfield input")!;
    input.value = "Selftest to-do";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => [...top().querySelectorAll(".ui-row")].some((r) => r.textContent?.includes("Selftest to-do")));
    top().querySelector<HTMLElement>(".ui-navbar-back")!.click();
    await until(() => q(".ui-row").find((r) => r.textContent?.includes("Inbox"))?.querySelector(".ui-row-detail")?.textContent === "2");
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
    (document.querySelector(".ui-app-close") as HTMLButtonElement).click();
    await until(() => !session.getSnapshot().uiOpen);
    await sleep(300);
    if (await fs.exists("Examples/todos.db-journal")) throw new Error("a journal was left behind");
    // A second run reads the database back.
    await runFile("Examples/Todo App.py");
    await until(() => q(".ui-row").find((r) => r.textContent?.includes("Inbox"))?.querySelector(".ui-row-detail")?.textContent === "2");
    (document.querySelector(".ui-app-close") as HTMLButtonElement).click();
    await until(() => !session.getSnapshot().uiOpen);
    await sleep(300);
    await fs.remove("Examples/todos.db");
    return { savedMs };
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
      await runFile(`${dir}/main.py`, "from helper import NAME\nopen('out.txt', 'w').write(NAME)\nprint('hello from', NAME)\n");
      await until(idle);
      if (!consoleText().includes("hello from linked")) throw new Error(consoleText());
      for (let i = 0; i < 30 && !(await fs.exists(`${dir}/out.txt`)); i++) await sleep(100);
      const out = await fs.readText(`${dir}/out.txt`);
      if (out !== "linked") throw new Error(`out.txt: ${out}`);
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

  const diagnostics = () => {
    const out: { source: string; message: string; actions: string[] }[] = [];
    const view = app.editor()?.view();
    if (view) forEachDiagnostic(view.state, (d) => out.push({ source: d.source ?? "", message: d.message, actions: (d.actions ?? []).map((a) => a.name) }));
    return out;
  };

  async function openWith(path: string, code: string) {
    await fs.writeText(path, code);
    await app.openFile(path);
    await until(() => app.currentFile() === path && app.editor()?.currentPath() === path);
    const view = app.editor()!.view()!;
    if (view.state.doc.toString() !== code) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    return view;
  }

  await step("analysis_ready", async () => {
    const info = await analysis.init();
    return { ruff: info.ruff, ruffInitMs: Math.round(info.ruffMs), tyInitMs: Math.round(info.tyMs) };
  });

  await step("lint_and_types", async () => {
    await openWith("Tests/lint.py", 'import os\n\n\ndef add(a: int, b: int) -> int:\n    return a + b\n\n\nadd(1, "two")\nprint(undefined_name)\n');
    const t0 = performance.now();
    const ds = await until(() => { const d = diagnostics(); return d.length >= 3 && d; }, 20000);
    const sources = ds.map((d) => d.source.replace(" ", ":"));
    for (const w of ["ruff:F401", "ty:invalid-argument-type", "ty:unresolved-reference"]) if (!sources.includes(w)) throw new Error(`missing ${w}: ${sources}`);
    const f401Actions = ds.find((d) => d.source === "ruff F401")!.actions;
    return { firstCheckMs: Math.round(performance.now() - t0), sources, f401Actions };
  });

  await step("pyodide_imports_not_flagged", async () => {
    await openWith("Tests/np.py", "import numpy as np\nimport matplotlib.pyplot as plt\nprint(np.pi, plt)\n");
    await sleep(1500);
    const unresolved = diagnostics().filter((d) => d.source.includes("unresolved-import"));
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
    const view = await openWith("Tests/fmt.py", "x=[1,2,\n3]\ndef f( a ):\n  return a\n");
    await app.format();
    const out = view.state.doc.toString();
    if (out !== "x = [1, 2, 3]\n\n\ndef f(a):\n    return a\n") throw new Error(JSON.stringify(out));
  });

  await step("add_dependency_quickfix_and_run", async () => {
    const view = await openWith("Tests/cow.py", 'import cowsay\n\ncowsay.cow("moo from PyPI")\n');
    const d = await until(() => diagnostics().find((x) => x.source.includes("unresolved-import")), 20000);
    let applied = false;
    forEachDiagnostic(view.state, (diag, from, to) => {
      const action = diag.actions?.find((a) => a.name.includes("cowsay"));
      if (action && !applied) {
        action.apply(view, from, to);
        applied = true;
      }
    });
    const text = view.state.doc.toString();
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

  const cursorLine = () => {
    const view = app.editor()?.view();
    return view ? view.state.doc.lineAt(view.state.selection.main.head).number : -1;
  };

  await step("traceback_link", async () => {
    await fs.mkdir("Tests").catch(() => {});
    await fs.mkdir("Tests/nav").catch(() => {});
    await fs.writeText("Tests/nav/helper.py", "def average(xs):\n    total = sum(xs)\n    return total / len(xs)\n");
    await fs.writeText("Tests/nav/main.py", "from helper import average\n\nprint(average([1, 2]))\nprint(average([]))\n");
    const { done } = await runFile("Tests/nav/main.py");
    await done;
    await until(idle);
    const link = await until(() => [...document.querySelectorAll<HTMLElement>(".tb-link")].find((a) => a.textContent?.includes('"helper.py", line 3')));
    link.click();
    await until(() => app.editor()?.currentPath() === "Tests/nav/helper.py" && cursorLine() === 3);
    return { links: document.querySelectorAll(".tb-link").length };
  });

  await step("go_to_definition", async () => {
    await app.openFile("Tests/nav/main.py");
    await until(() => app.editor()?.currentPath() === "Tests/nav/main.py");
    const view = app.editor()!.view()!;
    const line3 = view.state.doc.line(3);
    view.dispatch({ selection: { anchor: line3.from + line3.text.indexOf("average") + 2 } });
    const t0 = performance.now();
    const asked = await app.goToDefinition();
    try {
      await until(() => app.editor()?.currentPath() === "Tests/nav/helper.py" && cursorLine() === 1, 5000);
    } catch {
      throw new Error(`went to ${app.editor()?.currentPath()}:${cursorLine()} (${JSON.stringify(asked)})`);
    }
    const projectMs = Math.round(performance.now() - t0);
    await app.openFile("Tests/nav/main.py");
    await until(() => app.editor()?.currentPath() === "Tests/nav/main.py");
    const v2 = app.editor()!.view()!;
    v2.dispatch({ selection: { anchor: v2.state.doc.line(3).from + 2 } }); // print
    await app.goToDefinition();
    await until(() => app.editor()?.currentPath()?.endsWith("builtins.pyi"));
    const v3 = app.editor()!.view()!;
    if (!v3.state.readOnly || !v3.state.doc.lineAt(v3.state.selection.main.head).text.startsWith("def print(")) throw new Error("not at def print");
    app.closeTab(app.currentFile()!);
    return { projectMs };
  });

  await step("tabs", async () => {
    const pane = () => app.panes().find((p) => p.active === app.currentFile()) ?? app.panes()[0];
    const tabs = pane().tabs;
    if (!tabs.includes("Tests/nav/main.py") || !tabs.includes("Tests/nav/helper.py")) throw new Error(JSON.stringify(tabs));
    if (tabs.some((t) => t.startsWith("ext:"))) throw new Error("closed tab still open");
    app.closeTab("Tests/nav/helper.py");
    await until(() => !pane().tabs.includes("Tests/nav/helper.py"));
    return { open: pane().tabs.length };
  });

  await step("split_view", async () => {
    if (!matchMedia("(min-width: 768px)").matches) return { skipped: "iPhone" };
    await app.openFile("Tests/nav/main.py");
    app.setSplit(true);
    await until(() => document.querySelectorAll(".editor-pane").length === 2);
    await app.openFile("Tests/nav/helper.py"); // opens in the focused (right) pane
    await until(() => app.panes()[1]?.active === "Tests/nav/helper.py");
    // The same file in both panes stays in sync.
    await app.openLocation("Tests/nav/main.py");
    app.setSplit(false);
    await until(() => document.querySelectorAll(".editor-pane").length === 1);
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

  // -- typing through iOS text input (native only) ---------------------------------

  const via = new URLSearchParams(location.hash.slice(1)).get("via") ?? "insert";
  const typeNative = (text: string) => call<string>("test.type", { text, via });
  const pressEnter = () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const replInput = () => document.querySelector<HTMLInputElement>(".repl input");

  await step("typing_console", async () => {
    if (!isNative) return { skipped: "browser" };
    await fs.writeText("Tests/typing.py", "x = 1\n");
    const { done } = await runFile("Tests/typing.py");
    await done;
    await until(idle);
    app.showPane("console");
    const input = await until(replInput);
    input.focus();
    await sleep(600);
    const responder = await typeNative("x + 41");
    await sleep(300);
    const value = replInput()?.value;
    if (value !== "x + 41") throw new Error(`typed "x + 41", field has ${JSON.stringify(value)} (${responder}, active ${document.activeElement?.tagName}.${document.activeElement?.className})`);
    pressEnter();
    await until(() => consoleText().includes("42"));
  });

  await step("typing_plain_traits", async () => {
    if (!isNative) return { skipped: "browser" };
    app.showPane("console");
    const input = await until(replInput);
    input.focus();
    await sleep(800);
    const notes = await typeNative("");
    // UITextAutocapitalizationType.none = 0, UITextAutocorrectionType.no = 1, UITextSmartQuotesType.no = 1
    if (!/autocap=0 autocorrect=1 quotes=1/.test(notes)) throw new Error(notes);
    input.blur();
    return { notes };
  });

  await step("typing_input", async () => {
    if (!isNative) return { skipped: "browser" };
    await runFile("Examples/Hello.py");
    await until(() => session.getSnapshot().awaitingInput);
    await sleep(600);
    const responderInput = await typeNative("Armin");
    await sleep(300);
    const value = document.querySelector<HTMLInputElement>(".inline-input")?.value;
    if (value !== "Armin") throw new Error(`typed "Armin", field has ${JSON.stringify(value)} (${responderInput}, active ${document.activeElement?.tagName}.${document.activeElement?.className})`);
    pressEnter();
    await until(idle);
    if (!consoleText().includes("Hello, Armin!")) throw new Error(consoleText());
  });

  await step("typing_debugger_console", async () => {
    if (!isNative) return { skipped: "browser" };
    await fs.writeText("Tests/typing2.py", "def f(a):\n    b = a * 2\n    return b\n\nprint(f(21))\n");
    breakpoints.set("Tests/typing2.py", [{ line: 3, enabled: true }]);
    await runFile("Tests/typing2.py");
    await until(stopped());
    app.showPane("console");
    const input = await until(replInput);
    input.focus();
    await sleep(600);
    await typeNative("b + 1");
    await sleep(300);
    const value = replInput()?.value;
    if (value !== "b + 1") throw new Error(`typed "b + 1", field has ${JSON.stringify(value)} (active ${document.activeElement?.tagName}.${document.activeElement?.className})`);
    pressEnter();
    await until(() => consoleText().includes("43"));
    breakpoints.clear("Tests/typing2.py");
    session.resume("continue");
    await until(idle);
  });

  await fs.remove("Tests").catch(() => {});
  await call("result", JSON.stringify(r, null, 2));
}
