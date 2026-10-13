// The running Python session: one worker at a time, the console transcript
// (grouped into runs), pending input(), the >>> console and UI apps. React
// subscribes via useSyncExternalStore. Output is batched per animation frame.
import { base64ToBytes, basename, bytesToBase64, dirname, fs, haptic, join } from "./host";
import { PyWorker, WorkerPool, type Stream } from "./python";

export type LineKind = Stream | "input" | "prompt" | "run";

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
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
}

export type Status = "idle" | "starting" | "running";

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
  };
  private listeners = new Set<() => void>();
  private pool = new WorkerPool();
  private worker: PyWorker | null = null;
  private workerDir = "";
  private nextId = 1;
  private currentRun = 0;
  private stopRequested = false;
  private inputResolver: ((text: string | null) => void) | null = null;
  private uiListener: ((json: string | null) => void) | null = null;
  private lastUI: string | null = null;
  private pendingOutput: { kind: LineKind; text: string; runId: number }[] = [];
  private flushScheduled = false;
  /** Called after a run wrote files back into the project. */
  onFilesChanged: (paths: string[]) => void = () => {};

  constructor() {
    this.pool.spareReady.then((info) => this.set({ bootMs: info.bootMs }), () => {});
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
    if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  /** Apply queued output now (also used before state changes that depend on it). */
  flushOutput() {
    if (!this.pendingOutput.length) return;
    let lines = this.state.lines.slice();
    for (const { kind, text, runId } of this.pendingOutput) {
      const last = lines.at(-1);
      const mergeable = kind === "stdout" || kind === "stderr" || kind === "system";
      if (mergeable && last && last.kind === kind && last.runId === runId) {
        lines[lines.length - 1] = { ...last, text: applyCR(last.text + text) };
      } else {
        lines.push({ id: this.nextId++, runId, kind, text: mergeable ? applyCR(text) : text });
      }
    }
    this.pendingOutput = [];
    let total = 0;
    for (const l of lines) total += l.kind === "image" ? 2000 : l.text.length;
    let drop = 0;
    while (total > MAX_CHARS && drop < lines.length - 1) {
      total -= lines[drop].kind === "image" ? 2000 : lines[drop].text.length;
      drop++;
    }
    if (drop) lines = lines.slice(drop);
    this.set({ lines });
  }

  clear() {
    this.pendingOutput = [];
    const running = this.state.status !== "idle" ? this.state.runs[this.currentRun] : null;
    this.set({ lines: running ? [{ id: this.nextId++, runId: running.id, kind: "run", text: "" }] : [], runs: running ? { [running.id]: running } : {} });
  }

  private startRun(file: string | null) {
    this.flushOutput();
    const run: Run = { id: this.nextId++, file, startedAt: Date.now(), endedAt: null, status: "running" };
    this.currentRun = run.id;
    this.stopRequested = false;
    this.set({ runs: { ...this.state.runs, [run.id]: run }, runCounter: this.state.runCounter + 1 });
    this.append("run", "", run.id);
    return run;
  }

  private endRun(status: RunStatus) {
    this.flushOutput();
    const run = this.state.runs[this.currentRun];
    if (!run) return;
    this.set({ runs: { ...this.state.runs, [run.id]: { ...run, status, endedAt: Date.now() } } });
  }

  // -- running ------------------------------------------------------------------------

  /** Run a saved file: its directory is synced into the interpreter as the cwd. */
  async runFile(path: string, code: string) {
    this.closeWorker();
    const dir = dirname(path);
    this.startRun(path);
    this.set({ status: "starting", runningFile: path });
    try {
      const tree = await fs.tree(dir);
      const files = tree.map((f) => ({ path: f.path, data: base64ToBytes(f.data) }));
      const worker = await this.takeWorker(dir);
      this.set({ status: "running" });
      const result = await worker.run(code, { filename: basename(path), cwd: PROJECT_ROOT, files });
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
    const worker = reuse ? this.worker! : await this.takeWorker(this.workerDir);
    this.set({ status: "running" });
    const result = await worker.run(source, { repl: true, cwd: PROJECT_ROOT });
    await this.finishRun(result, true);
  }

  private async takeWorker(dir: string) {
    const worker = await this.pool.take();
    this.worker = worker;
    this.workerDir = dir;
    worker.onOutput = (stream, text) => this.append(stream, text);
    worker.onInput = () =>
      new Promise((resolve) => {
        this.flushOutput();
        this.inputResolver = resolve;
        this.set({ awaitingInput: true });
      });
    worker.onUIRender = (json) => {
      this.lastUI = json;
      this.set({ uiOpen: true });
      this.uiListener?.(json);
    };
    worker.onCrash = (error) => this.append("stderr", `Python crashed: ${error}\n`);
    return worker;
  }

  private async finishRun(
    result: { ok: boolean; error?: string; killed?: boolean; changed?: { path: string; data: Uint8Array }[] },
    fromConsole = false,
  ) {
    this.inputResolver = null;
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
    this.set({ status: "idle", awaitingInput: false });
    if (status === "error" || status === "crashed") haptic();
    if (result.changed?.length) {
      const written: string[] = [];
      for (const f of result.changed) {
        const target = join(this.workerDir, f.path);
        await fs.writeBase64(target, bytesToBase64(f.data));
        written.push(target);
      }
      this.onFilesChanged(written);
    }
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
    this.stopRequested = true;
    this.worker?.stop();
  }

  private closeWorker() {
    if (this.worker && !this.worker.dead) this.worker.terminate("closed");
    this.worker = null;
    this.lastUI = null;
    this.set({ uiOpen: false, awaitingInput: false });
    this.uiListener?.(null);
  }

  // -- UI apps ------------------------------------------------------------------------

  /** The UI view registers here; it gets the latest tree right away. */
  attachUI(fn: (json: string | null) => void) {
    this.uiListener = fn;
    if (this.lastUI) fn(this.lastUI);
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
    this.closeWorker();
  }
}

/** Drop Pyodide's own frames from a traceback. */
export function cleanTraceback(text: string): string {
  const dep = /_pyslop\.DependencyError: ([\s\S]*)$/.exec(text.trim());
  if (dep) return `Dependency error: ${dep[1]}`;
  const lines = text.replace(/\n+$/, "").split("\n");
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
