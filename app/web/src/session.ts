// The running Python session: one worker at a time, the console transcript
// (grouped into runs), pending input(), the >>> console and UI apps. React
// subscribes via useSyncExternalStore. Output is batched per animation frame.
import { basename, dirname, haptic, join } from "./host";
import { breakpoints } from "./debug/breakpoints";
import { PyWorker, SIGNAL, WorkerPool, type Stream } from "./python";
import { chooseFor, onDefaultPython, runtimeFor } from "./runtimes";
import { TurtleScene, turtleScenes } from "./turtle";

/** "turtle": a turtle screen; the line's text is the key of its scene (D29). */
export type LineKind = Stream | "input" | "prompt" | "run" | "turtle";

export interface Line {
  id: number;
  runId: number;
  kind: LineKind;
  text: string;
}

export type RunStatus = "running" | "ok" | "error" | "stopped" | "crashed";

export interface Run {
  id: number;
  file: string | null; // null: console input
  dir: string; // the folder the interpreter runs in (resolves traceback paths)
  python: string | null; // the runtime's full version ("3.14.2"), once chosen (D37)
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
}

export type Status = "idle" | "starting" | "running";

// -- debugger (D23) -------------------------------------------------------------------

export interface DebugFrame {
  name: string; // qualified function name, "<module>" for module level
  file: string; // app path
  line: number;
}

export interface DebugVariable {
  name: string;
  value: string; // reprlib-limited repr
  type: string;
  ref: number; // > 0: has children, fetch with session.debugVariables(ref)
}

export interface DebugScope {
  name: string;
  variables: DebugVariable[];
}

export interface DebugState {
  stopId: number; // changes on every stop; variable refs are only valid until the next
  /** Transcript lines from this id on were written while paused (>>> evaluations); the console shows them below the paused block. */
  firstLineId: number;
  reason: "breakpoint" | "step" | "pause" | "breakpoint()" | "exception" | string;
  postMortem: boolean;
  exception: string | null;
  frames: DebugFrame[];
  selected: number;
  scopes: DebugScope[];
}

export type DebugCommand =
  | { op: "continue" | "next" | "stepIn" | "stepOut" }
  | { op: "scopes"; frame: number }
  | { op: "variables"; ref: number }
  | { op: "evaluate"; expr: string; frame: number; context: "hover" | "repl" }
  | { op: "setBreakpoints"; breakpoints: Record<string, number[]> };

export interface SessionState {
  lines: Line[];
  runs: Record<number, Run>;
  status: Status;
  awaitingInput: boolean;
  uiOpen: boolean;
  runningFile: string | null;
  bootMs: number | null;
  /** Bumped when a run starts so the console can open itself. */
  runCounter: number;
  /** The program is stopped in the debugger. */
  debug: DebugState | null;
  /** Pause was requested and the program has not stopped yet. */
  pausing: boolean;
}

const MAX_CHARS = 400_000;
const PROJECT_ROOT = "/home/pyodide/project";

/** Apply carriage returns: text after a \r overwrites the current line. */
function applyCR(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
    .join("\n");
}

export class Session {
  private state: SessionState = {
    lines: [], runs: {}, status: "idle", awaitingInput: false, uiOpen: false, runningFile: null, bootMs: null, runCounter: 0,
    debug: null, pausing: false,
  };
  private listeners = new Set<() => void>();
  private pool = new WorkerPool();
  private worker: PyWorker | null = null;
  private workerDir = "";
  private workerSerial = 0; // scene keys are "<worker>:<screen>"
  private nextId = 1;
  private currentRun = 0;
  private stopRequested = false;
  private inputResolver: ((text: string | null) => void) | null = null;
  private uiListener: ((json: string | null) => void) | null = null;
  private pendingOutput: { kind: LineKind; text: string; runId: number }[] = [];
  private flushScheduled = false;
  // The worker blocks in the debugger until debugNext is called with a command.
  private debugNext: ((command: DebugCommand) => void) | null = null;
  private debugResult: ((message: any) => void) | null = null;
  private debugQueue: Promise<unknown> = Promise.resolve();
  private stopCounter = 0;

  constructor() {
    this.pool.spareReady.then((info) => this.set({ bootMs: info.bootMs }), () => {});
    onDefaultPython((python) => {
      this.pool.setDefault(python);
      this.pool.spareReady.then((info) => this.set({ bootMs: info.bootMs }), () => {});
    });
    breakpoints.subscribe(() => this.syncBreakpoints());
  }

  /** The app goes to the background, where it may be killed: what the
   * program queued goes to disk (the host calls this). */
  async syncInBackground() {
    if (this.worker && !this.worker.dead && !this.state.debug) await this.worker.syncFiles();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // -- console transcript -----------------------------------------------------------

  /** Queue output; it is merged into the transcript once per frame. */
  append(kind: LineKind, text: string, runId = this.currentRun) {
    this.pendingOutput.push({ kind, text, runId });
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      this.flushOutput();
    };
    setTimeout(flush, 16);
  }

  /** Apply queued output now (also used before state changes that depend on it). */
  flushOutput() {
    if (!this.pendingOutput.length) return;
    let lines = this.state.lines.slice();
    for (const { kind, text, runId } of this.pendingOutput) {
      const last = lines.at(-1);
      const mergeable = kind === "stdout" || kind === "stderr" || kind === "system";
      // Output while paused must not merge into a line from before the stop:
      // the console shows the two on different sides of the paused block.
      const boundary = this.state.debug?.firstLineId ?? 0;
      if (mergeable && last && last.kind === kind && last.runId === runId && last.id >= boundary) {
        lines[lines.length - 1] = { ...last, text: applyCR(last.text + text) };
      } else {
        lines.push({ id: this.nextId++, runId, kind, text: mergeable ? applyCR(text) : text });
      }
    }
    this.pendingOutput = [];
    const size = (l: Line) => (l.kind === "image" || l.kind === "turtle" ? 2000 : l.text.length);
    let total = 0;
    for (const l of lines) total += size(l);
    let drop = 0;
    while (total > MAX_CHARS && drop < lines.length - 1) {
      total -= size(lines[drop]);
      drop++;
    }
    if (drop) lines = lines.slice(drop);
    this.set({ lines });
    if (drop) this.pruneScenes();
  }

  /** Forget turtle scenes that are no longer in the transcript. */
  private pruneScenes() {
    const shown = new Set(this.state.lines.filter((l) => l.kind === "turtle").map((l) => l.text));
    for (const [key, scene] of turtleScenes) {
      if (!shown.has(key) && !scene.live) turtleScenes.delete(key);
    }
  }

  clear() {
    this.pendingOutput = [];
    const running = this.state.status !== "idle" ? this.state.runs[this.currentRun] : null;
    this.set({ lines: running ? [{ id: this.nextId++, runId: running.id, kind: "run", text: "" }] : [], runs: running ? { [running.id]: running } : {} });
    this.pruneScenes();
  }

  private startRun(file: string | null) {
    this.flushOutput();
    const dir = file ? dirname(file) : this.workerDir;
    const run: Run = { id: this.nextId++, file, dir, python: null, startedAt: Date.now(), endedAt: null, status: "running" };
    this.currentRun = run.id;
    this.stopRequested = false;
    this.set({ runs: { ...this.state.runs, [run.id]: run }, runCounter: this.state.runCounter + 1 });
    this.append("run", "", run.id);
    return run;
  }

  private setRunPython(python: string) {
    const run = this.state.runs[this.currentRun];
    if (run) this.set({ runs: { ...this.state.runs, [run.id]: { ...run, python: runtimeFor(python).version } } });
  }

  private endRun(status: RunStatus) {
    this.flushOutput();
    const run = this.state.runs[this.currentRun];
    if (!run) return;
    this.set({ runs: { ...this.state.runs, [run.id]: { ...run, status, endedAt: Date.now() } } });
  }

  // -- running ------------------------------------------------------------------------

  /** Run a saved file: its folder is the program's cwd, used in place (D35). */
  async runFile(path: string, code: string) {
    this.closeWorker();
    const dir = dirname(path);
    this.startRun(path);
    this.set({ status: "starting", runningFile: path });
    try {
      const choice = await chooseFor(dir, code);
      if (!choice.ok) throw new Error(`Python version: ${choice.error}`);
      this.setRunPython(choice.python);
      const worker = await this.takeWorker(dir, choice.python);
      this.set({ status: "running" });
      const result = await worker.run(code, { filename: basename(path), cwd: PROJECT_ROOT, breakpoints: breakpoints.forRun(dir) });
      await this.finishRun(result);
    } catch (e) {
      this.append("stderr", `${(e as Error).message ?? e}\n`);
      this.endRun("error");
      this.set({ status: "idle" });
    }
  }

  /** Run console input in the current session (a fresh one if there is none). */
  async runConsole(source: string) {
    if (!source.trim() || this.state.status !== "idle") return;
    this.flushOutput();
    // Console input continues the previous run's block when that program is still loaded.
    const reuse = this.worker && !this.worker.dead;
    if (!reuse || !this.state.runs[this.currentRun]) this.startRun(null);
    this.append("prompt", source);
    let worker = this.worker!;
    if (reuse) {
      this.setRunPython(worker.python);
    } else {
      const choice = await chooseFor(this.workerDir);
      const python = choice.ok ? choice.python : undefined;
      worker = await this.takeWorker(this.workerDir, python);
      this.setRunPython(worker.python);
    }
    this.setScenesActive(true);
    this.set({ status: "running" });
    const result = await worker.run(source, { repl: true, cwd: PROJECT_ROOT });
    await this.finishRun(result, true);
  }

  private async takeWorker(dir: string, python?: string) {
    const worker = await this.pool.take(python);
    try {
      await worker.attach(dir);
    } catch (e) {
      worker.terminate("closed");
      throw new Error(`Could not open the folder: ${(e as Error).message ?? e}`);
    }
    this.worker = worker;
    this.workerDir = dir;
    const serial = ++this.workerSerial;
    worker.onOutput = (stream, text) => this.append(stream, text);
    worker.onInput = () =>
      new Promise((resolve) => {
        this.flushOutput();
        this.inputResolver = resolve;
        this.set({ awaitingInput: true });
      });
    worker.onUIRender = (json) => {
      this.set({ uiOpen: true });
      this.uiListener?.(json);
    };
    worker.onCrash = (error) => this.append("stderr", `Python crashed: ${error}\n`);
    worker.onDebug = (message) => this.onDebugMessage(worker, message);
    worker.onTurtle = (batches) => {
      for (const json of batches) {
        const { id, ops } = JSON.parse(json) as { id: number; ops: any[] };
        const key = `${serial}:${id}`;
        let scene = turtleScenes.get(key);
        if (!scene) {
          scene = new TurtleScene(key);
          turtleScenes.set(key, scene);
          this.append("turtle", key);
        }
        scene.apply(ops);
      }
    };
    worker.onTurtleCall = async (request: { id: number; wait?: number; prompt?: { title: string; text: string; default: string } }) => {
      if (request.prompt) {
        const { title, text, default: value } = request.prompt;
        this.flushOutput();
        return window.prompt([title, text].filter(Boolean).join("\n\n"), value);
      }
      const scene = turtleScenes.get(`${serial}:${request.id}`);
      return scene ? scene.take(request.wait ?? 0) : [];
    };
    return worker;
  }

  /** Whether the worker's turtle screens take events (only while code runs). */
  private setScenesActive(active: boolean) {
    const prefix = `${this.workerSerial}:`;
    for (const [key, scene] of turtleScenes) if (key.startsWith(prefix)) scene.setActive(active);
  }

  /** The worker's turtle screens take no more events. */
  private endScenes() {
    const prefix = `${this.workerSerial}:`;
    for (const [key, scene] of turtleScenes) if (key.startsWith(prefix)) scene.end();
    this.pruneScenes();
  }

  // -- debugger -----------------------------------------------------------------------

  private onDebugMessage(worker: PyWorker, message: any): Promise<DebugCommand> {
    if (message.event === "breakpoints") {
      return Promise.resolve({ op: "setBreakpoints", breakpoints: breakpoints.forRun(this.workerDir) });
    }
    if (message.event === "stopped") {
      this.flushOutput();
      this.set({
        pausing: false,
        debug: {
          stopId: ++this.stopCounter,
          firstLineId: this.nextId,
          reason: message.reason,
          postMortem: !!message.postMortem,
          exception: message.exception ?? null,
          frames: (message.frames as { name: string; file: string; line: number }[]).map((f) => ({ ...f, file: join(this.workerDir, f.file) })),
          selected: 0,
          scopes: message.scopes ?? [],
        },
      });
      if (!message.postMortem) haptic();
    } else if (message.event === "result") {
      const resolve = this.debugResult;
      this.debugResult = null;
      resolve?.(message);
    }
    return new Promise((resolve) => {
      // A late message from a replaced worker must not take over.
      if (this.worker !== worker) return resolve({ op: "continue" });
      this.debugNext = resolve;
    });
  }

  /** Ask the paused program something; answers come back in order. */
  debugRequest(command: DebugCommand): Promise<any> {
    const result = this.debugQueue.then(
      () =>
        new Promise((resolve) => {
          // Checks the pending command, not state.debug: resume() hides the
          // paused UI right away, but requests queued before it still go first.
          const next = this.debugNext;
          if (!next) return resolve({ error: "The program is not paused." });
          this.debugNext = null;
          this.debugResult = resolve;
          next(command);
        }),
    );
    this.debugQueue = result.catch(() => {});
    return result;
  }

  /** Continue or step. */
  resume(op: "continue" | "next" | "stepIn" | "stepOut") {
    if (!this.state.debug) return;
    this.set({ debug: null });
    void this.debugQueue.then(() => {
      const next = this.debugNext;
      this.debugNext = null;
      next?.({ op });
    });
  }

  async selectFrame(index: number) {
    const debug = this.state.debug;
    if (!debug || index === debug.selected || index < 0 || index >= debug.frames.length) return;
    this.set({ debug: { ...debug, selected: index, scopes: [] } });
    const result = await this.debugRequest({ op: "scopes", frame: index });
    const now = this.state.debug;
    if (now && now.stopId === debug.stopId && now.selected === index) this.set({ debug: { ...now, scopes: result.scopes ?? [] } });
  }

  async debugVariables(ref: number): Promise<DebugVariable[]> {
    const result = await this.debugRequest({ op: "variables", ref });
    return result.variables ?? [];
  }

  /** The value of a name tapped in the editor. */
  async debugEvaluate(expr: string): Promise<{ value?: DebugVariable; error?: string }> {
    return this.debugRequest({ op: "evaluate", expr, frame: this.state.debug?.selected ?? 0, context: "hover" });
  }

  /** >>> input while paused runs in the selected frame. */
  async debugConsole(source: string) {
    const debug = this.state.debug;
    if (!debug || !source.trim()) return;
    this.append("prompt", source);
    await this.debugRequest({ op: "evaluate", expr: source, frame: debug.selected, context: "repl" });
    // Assignments show up in the variables.
    const scopes = await this.debugRequest({ op: "scopes", frame: debug.selected });
    const now = this.state.debug;
    if (now && now.stopId === debug.stopId && scopes.scopes) this.set({ debug: { ...now, scopes: scopes.scopes } });
  }

  /** Stop at the next line of user code. */
  pause() {
    if (this.state.status !== "running" || this.state.debug || this.state.awaitingInput) return;
    if (this.worker?.signal(SIGNAL.pause)) this.set({ pausing: true });
  }

  get canInspect() {
    return !!this.worker && !this.worker.dead && this.state.status === "idle" && !this.state.debug;
  }

  /** Open the debugger on the frames of the last uncaught exception. */
  async inspectError() {
    const worker = this.worker;
    if (!worker || !this.canInspect) return;
    this.flushOutput();
    const result = await worker.run("import _pyslop_debug\n_pyslop_debug.post_mortem()", { repl: true, cwd: PROJECT_ROOT });
    if (this.worker !== worker) return;
    this.set({ debug: null });
    if (!result.ok && result.error) this.append("stderr", cleanTraceback(result.error) + "\n");
  }

  /** Breakpoints changed: tell a program that is running (or paused). */
  private syncBreakpoints() {
    const worker = this.worker;
    if (!worker || worker.dead) return;
    if (this.debugNext && !this.state.debug?.postMortem) {
      void this.debugRequest({ op: "setBreakpoints", breakpoints: breakpoints.forRun(this.workerDir) });
    } else if (this.state.status === "running" || this.state.uiOpen) {
      worker.signal(SIGNAL.breakpoints);
    }
  }

  private endDebug() {
    this.debugNext = null;
    const resolve = this.debugResult;
    this.debugResult = null;
    resolve?.({ error: "The program ended." });
    if (this.state.debug || this.state.pausing) this.set({ debug: null, pausing: false });
  }

  private async finishRun(
    result: { ok: boolean; error?: string; killed?: boolean },
    fromConsole = false,
  ) {
    this.inputResolver = null;
    this.setScenesActive(false);
    let status: RunStatus = "ok";
    if (!result.ok && result.error) {
      const interrupted = /KeyboardInterrupt\s*$/.test(result.error.trim()) || (result.killed && this.stopRequested);
      if (interrupted && this.stopRequested) {
        status = "stopped";
        this.dropInterruptTraceback();
      } else if (result.killed && /crashed/i.test(result.error)) {
        status = "crashed";
      } else {
        status = "error";
        this.append("stderr", cleanTraceback(result.error) + "\n");
      }
    }
    if (fromConsole) {
      // A failing console line does not change how the program itself ended.
      if (status === "crashed") this.endRun("crashed");
      else if (this.state.runs[this.currentRun]?.status === "running") this.endRun("ok");
    } else {
      this.endRun(status);
    }
    this.set({ status: "idle", awaitingInput: false, pausing: false });
    if (this.state.debug && !this.state.uiOpen) this.endDebug();
    if (status === "error" || status === "crashed") haptic();
    // A linked folder's copy goes back now; the host tells the views what changed.
    await this.worker?.syncFiles();
  }

  /** Pyodide prints the KeyboardInterrupt traceback when input() is interrupted; a stop is not an error. */
  private dropInterruptTraceback() {
    this.flushOutput();
    const lines = this.state.lines;
    const i = lines.findLastIndex((l) => l.runId === this.currentRun && l.kind === "stderr");
    if (i >= 0 && /KeyboardInterrupt\s*$/.test(lines[i].text)) {
      const text = lines[i].text.replace(/Traceback \(most recent call last\):[\s\S]*KeyboardInterrupt\s*$/, "");
      this.set({ lines: text ? lines.with(i, { ...lines[i], text }) : lines.filter((_, j) => j !== i) });
    }
  }

  submitInput(text: string) {
    const resolve = this.inputResolver;
    if (!resolve) return;
    this.inputResolver = null;
    this.append("input", text + "\n");
    this.flushOutput();
    this.set({ awaitingInput: false });
    resolve(text + "\n");
  }

  stop() {
    const debug = this.state.debug;
    if (debug?.postMortem) return this.resume("continue"); // just ends the inspection
    this.stopRequested = true;
    if (this.worker?.running) {
      this.worker.stop(); // also interrupts a paused debugger (its call is pending)
      this.endDebug();
    } else if (debug) {
      // Paused in a UI app's callback after the script returned: end the app.
      this.endDebug();
      this.closeUI();
    }
  }

  private closeWorker(keepAlive = false) {
    if (this.worker && !this.worker.dead && !keepAlive) this.worker.terminate("closed");
    if (this.worker) this.endScenes();
    this.endDebug();
    this.worker = null;
    this.set({ uiOpen: false, awaitingInput: false });
    this.uiListener?.(null);
  }

  // -- UI apps ------------------------------------------------------------------------

  /** The UI view registers here. Its renderer asks the program for a full
   * snapshot itself, so nothing needs replaying. */
  attachUI(fn: (json: string | null) => void) {
    this.uiListener = fn;
    return () => {
      if (this.uiListener === fn) this.uiListener = null;
    };
  }

  sendUIEvent(id: string, args: string) {
    this.worker?.sendUIEvent(id, args);
  }

  closeUI() {
    // Closing the app view ends the program, like Pythonista's close button.
    this.stopRequested = true;
    if (this.state.runs[this.currentRun]?.status === "running") this.endRun("stopped");
    const worker = this.worker;
    if (!worker || worker.dead || worker.running || this.state.debug) {
      this.closeWorker();
      return;
    }
    // Close the view right away, but let the program's queued writes (e.g.
    // saved data) reach the disk before it is killed.
    this.closeWorker(true);
    void worker.syncFiles().finally(() => worker.terminate("closed"));
  }
}

/** Drop Pyodide's own frames from a traceback. */
export function cleanTraceback(text: string): string {
  const dep = /_pyslop\.DependencyError: ([\s\S]*)$/.exec(text.trim());
  if (dep) return `Dependency error: ${dep[1]}`;
  // Project files are shown relative to the program's folder (its cwd).
  const lines = text.replace(/\n+$/, "").replaceAll(`File "${PROJECT_ROOT}/`, 'File "').split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('  File "') && (line.includes("/_pyodide/") || line.includes("_pyslop.py") || line.includes('"<dependencies>"'))) {
      while (i + 1 < lines.length && lines[i + 1].startsWith("    ")) i++;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export const session = new Session();
