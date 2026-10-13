// End-to-end checks for the app (run with #selftest): edit, run, input, plots,
// file write-back, console, UI apps, crash recovery. Reports via the bridge.
import type { AppController } from "./App";
import { call, fs } from "./host";
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

  async function step(name: string, fn: () => Promise<Record<string, unknown> | void>) {
    const t0 = performance.now();
    try {
      r[name] = { ok: true, ...(await fn()), ms: Math.round(performance.now() - t0) };
    } catch (e) {
      r[name] = { ok: false, error: String((e as Error).message ?? e), console: consoleText().slice(-400) };
    }
    await log(`${name}: ${JSON.stringify(r[name])}`);
  }

  async function runFile(path: string, code?: string) {
    await app.openFile(path);
    // Wait for React to render the newly opened file into the editor.
    await until(() => app.currentFile() === path && app.editor()?.view());
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
    if (!consoleText().includes("KeyboardInterrupt")) throw new Error(consoleText());
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

  await step("crash_recovery", async () => {
    await fs.writeText("Tests/deep.py", "x = []\nfor _ in range(50000): x = [x]\nprint(len(repr(x)))\n");
    await runFile("Tests/deep.py");
    await until(idle);
    if (!consoleText().includes("Python crashed")) throw new Error(consoleText());
    await runFile("Tests/edit.py", "print('alive again')\n");
    await until(idle);
    if (!consoleText().includes("alive again")) throw new Error(consoleText());
  });

  await fs.remove("Tests").catch(() => {});
  await call("result", JSON.stringify(r, null, 2));
}
