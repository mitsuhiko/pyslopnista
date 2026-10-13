// The running Python session: one worker at a time, the console transcript,
// pending input(), the >>> console and UI apps. React subscribes via
// useSyncExternalStore.
import { base64ToBytes, basename, bytesToBase64, dirname, fs, join } from "./host";
import { PyWorker, WorkerPool, type Stream } from "./python";

export type LineKind = Stream | "input" | "prompt" | "info";

export interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

export type Status = "idle" | "starting" | "running";

export interface SessionState {
  lines: Line[];
  status: Status;
  awaitingInput: boolean;
  uiOpen: boolean;
  runningFile: string | null;
  bootMs: number | null;
}

const MAX_CHARS = 400_000;
const PROJECT_ROOT = "/home/pyodide/project";

export class Session {
  private state: SessionState = { lines: [], status: "idle", awaitingInput: false, uiOpen: false, runningFile: null, bootMs: null };
  private listeners = new Set<() => void>();
  private pool = new WorkerPool();
  private worker: PyWorker | null = null;
  private workerDir = "";
  private nextId = 1;
  private inputResolver: ((text: string | null) => void) | null = null;
  private uiListener: ((json: string | null) => void) | null = null;
  private lastUI: string | null = null;
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

  append(kind: LineKind, text: string) {
    let lines = this.state.lines;
    const last = lines.at(-1);
    // Merge consecutive text of the same kind so streaming output stays one node.
    if (last && last.kind === kind && kind !== "image" && kind !== "info" && kind !== "prompt" && kind !== "input") {
      lines = [...lines.slice(0, -1), { ...last, text: last.text + text }];
    } else {
      lines = [...lines, { id: this.nextId++, kind, text }];
    }
    let total = 0;
    for (const l of lines) total += l.kind === "image" ? 1000 : l.text.length;
    while (total > MAX_CHARS && lines.length > 1) {
      total -= lines[0].kind === "image" ? 1000 : lines[0].text.length;
      lines = lines.slice(1);
    }
    this.set({ lines });
  }

  clear() {
    this.set({ lines: [] });
  }

  // -- running ------------------------------------------------------------------------

  /** Run a saved file: its directory is synced into the interpreter as the cwd. */
  async runFile(path: string, code: string) {
    this.closeWorker();
    const dir = dirname(path);
    this.set({ status: "starting", runningFile: path });
    this.append("info", `▶ ${path}`);
    const tree = await fs.tree(dir);
    const files = tree.map((f) => ({ path: f.path, data: base64ToBytes(f.data) }));
    const worker = await this.takeWorker(dir);
    this.set({ status: "running" });
    const result = await worker.run(code, { filename: basename(path), cwd: PROJECT_ROOT, files });
    await this.finishRun(result);
  }

  /** Run console input in the current session (a fresh one if there is none). */
  async runConsole(source: string) {
    if (!source.trim()) return;
    this.append("prompt", source);
    if (this.state.status !== "idle") return;
    const worker = this.worker && !this.worker.dead ? this.worker : await this.takeWorker(this.workerDir);
    this.set({ status: "running" });
    const result = await worker.run(source, { repl: true, cwd: PROJECT_ROOT });
    await this.finishRun(result);
  }

  private async takeWorker(dir: string) {
    const worker = await this.pool.take();
    this.worker = worker;
    this.workerDir = dir;
    worker.onOutput = (stream, text) => this.append(stream, text);
    worker.onInput = () =>
      new Promise((resolve) => {
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

  private async finishRun(result: { ok: boolean; error?: string; changed?: { path: string; data: Uint8Array }[] }) {
    this.inputResolver = null;
    this.set({ status: "idle", awaitingInput: false });
    if (!result.ok && result.error) this.append("stderr", cleanTraceback(result.error) + "\n");
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

  submitInput(text: string) {
    const resolve = this.inputResolver;
    if (!resolve) return;
    this.inputResolver = null;
    this.append("input", text + "\n");
    this.set({ awaitingInput: false });
    resolve(text + "\n");
  }

  stop() {
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
    this.closeWorker();
  }
}

/** Drop Pyodide's own frames from a traceback. */
export function cleanTraceback(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  // Dependency problems are user errors, not program crashes: show just the message.
  const dep = /_pyslop\.DependencyError: ([\s\S]*)$/.exec(text.trim());
  if (dep) return `Dependency error: ${dep[1]}`;
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
