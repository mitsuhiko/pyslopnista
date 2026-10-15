// Page-side controller for Python workers (D6, D11, D13, D16): warm pool,
// output streaming, stdin, interrupt with escalation, host calls, UI messages,
// and the project folder the program works in (HostFS, D35).
import { call } from "./host";
import { getDefaultPython, runtimeFor } from "./runtimes";

const encoder = new TextEncoder();
const CHANNEL_BYTES = 8 + 1024 * 1024;

export type Stream = "stdout" | "stderr" | "system" | "image";

export interface RunOptions {
  filename?: string;
  cwd?: string; // directory inside the interpreter's file system (the mounted folder, see attach)
  repl?: boolean; // run as console input (shows the value of a final expression)
  breakpoints?: Record<string, number[]>; // project-relative path -> lines (D23)
}

/** Signals delivered through the interrupt buffer (see _pyslop_debug.py). */
export const SIGNAL = { interrupt: 2, pause: 10, breakpoints: 12 } as const;

export interface RunResult {
  ok: boolean;
  error?: string;
  ms: number;
  killed?: boolean;
}

export interface WorkerInfo {
  bootMs: number;
  version: string;
  jspi: string;
  gcTrampoline: boolean;
  isolated: boolean;
}

function workerOptions(python: string) {
  const params = new URLSearchParams(location.search);
  return {
    // Each bundled Python (D37) has its own core and package cache.
    indexURL: new URL(`/pyodide/${python}/`, location.href).href,
    packageBaseUrl: new URL(`/pkgs/${python}/`, location.href).href,
    jspi: params.get("jspi") !== "0",
    gcTrampoline: params.get("gc") !== "0",
    pythonFiles: {
      "_pyslop.py": new URL("/runtime/python/_pyslop.py", location.href).href,
      "ui.py": new URL("/runtime/python/ui.py", location.href).href,
      "_pyslop_debug.py": new URL("/runtime/python/_pyslop_debug.py", location.href).href,
      "turtle.py": new URL("/runtime/python/turtle.py", location.href).href,
      "_pyslop_turtle.py": new URL("/runtime/python/_pyslop_turtle.py", location.href).href,
    },
  };
}

export class PyWorker {
  readonly ready: Promise<WorkerInfo>;
  /** The runtime ("3.14"). */
  readonly python: string;
  dead = false;
  onOutput: (stream: Stream, text: string) => void = () => {};
  onInput: () => Promise<string | null> = async () => null;
  onUIRender: (json: string) => void = () => {};
  onCrash: (error: string) => void = () => {};
  /** A debugger message; the returned promise is the next command (D23). */
  onDebug: (message: any) => Promise<unknown> = async () => ({ op: "continue" });
  /** Turtle graphics ops: JSON strings of {id, ops} (D29). */
  onTurtle: (batches: string[]) => void = () => {};
  /** A blocking turtle call: events for a screen, or a dialog. */
  onTurtleCall: (request: any) => Promise<unknown> = async () => [];

  private worker: Worker;
  private interrupt: Int32Array | null;
  private channel: SharedArrayBuffer | null;
  private syncPending = false;
  private syncSeq = 0; // the blocking call being answered (a late answer to an interrupted one is dropped)
  private current: ((r: RunResult) => void) | null = null;
  private stopTimer: ReturnType<typeof setInterval> | null = null;
  private resolveReady!: (info: WorkerInfo) => void;
  private rejectReady!: (err: Error) => void;

  constructor(python = getDefaultPython()) {
    this.python = runtimeFor(python).python;
    this.worker = new Worker("/runtime/py-worker.js", { type: "module" });
    const isolated = self.crossOriginIsolated && typeof SharedArrayBuffer === "function";
    this.interrupt = isolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
    this.channel = isolated ? new SharedArrayBuffer(CHANNEL_BYTES) : null;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => this.rejectReady(new Error(e.message));
    this.worker.postMessage({ type: "boot", interrupt: this.interrupt?.buffer ?? null, channel: this.channel, ...workerOptions(this.python) });
  }

  get running() {
    return this.current !== null;
  }

  private handle(msg: any) {
    switch (msg.type) {
      case "ready":
        this.resolveReady(msg);
        break;
      case "boot-failed":
        this.rejectReady(new Error(msg.error));
        break;
      case "output":
        this.onOutput(msg.stream, msg.text);
        break;
      case "ui-render":
        this.onUIRender(msg.tree);
        break;
      case "turtle":
        this.onTurtle(msg.batches);
        break;
      case "call":
        void this.handleCall(msg);
        break;
      case "done":
        this.finish(msg);
        break;
      case "synced":
        this.syncs.get(msg.id)?.();
        this.syncs.delete(msg.id);
        break;
      case "worker-error": {
        // The interpreter is unusable afterwards; only report it as a crash
        // while something is running (a late error must not rewrite a run).
        const hint = /call stack/i.test(msg.error) ? " (recursion too deep)" : "";
        if (this.current) {
          this.onCrash(`${msg.error}${hint}`);
          this.terminate(`Python crashed: ${msg.error}${hint}`);
        } else {
          this.dead = true;
          this.worker.terminate();
          this.unmount();
        }
        break;
      }
    }
  }

  private async handleCall(msg: any) {
    let reply: { value?: unknown; error?: string };
    const seq = msg.sync ? ++this.syncSeq : 0;
    try {
      if (msg.sync) this.syncPending = true;
      let value: unknown;
      if (msg.op === "stdin") value = await this.onInput();
      else if (msg.op === "debug") value = await this.onDebug(msg.value);
      else if (msg.op === "turtle") value = await this.onTurtleCall(msg.value);
      else if (msg.op === "host") value = await call(msg.value.op, msg.value.value);
      else throw new Error(`unknown call ${msg.op}`);
      reply = { value };
    } catch (e) {
      reply = { error: String((e as Error).message ?? e) };
    }
    if (msg.sync) {
      if (this.syncPending && seq === this.syncSeq) this.replySync(reply);
    } else {
      this.worker.postMessage({ type: "call-reply", id: msg.id, ...reply });
    }
  }

  private replySync(reply: unknown) {
    this.syncPending = false;
    const bytes = encoder.encode(JSON.stringify(reply));
    const ints = new Int32Array(this.channel!, 0, 2);
    new Uint8Array(this.channel!, 8).set(bytes);
    ints[1] = bytes.length;
    Atomics.store(ints, 0, 1);
    Atomics.notify(ints, 0);
  }

  private mountToken: string | null = null;
  private unmounted: Promise<string[]> | null = null;

  /** Use a project folder (an app path) as the program's files: the host
   * mounts it (a linked folder via a local copy), and the next run sees it at
   * its cwd. */
  async attach(path: string) {
    const { token } = await call<{ token: string; staged: boolean }>("hostfs.mount", { path });
    this.mountToken = token;
  }

  run(code: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.current) throw new Error("already running");
    if (this.interrupt) Atomics.store(this.interrupt, 0, 0);
    return new Promise((resolve) => {
      this.current = resolve;
      this.worker.postMessage({ type: "run", code, mount: this.mountToken, ...options });
    });
  }

  /** Deliver a signal to the program (Pause, breakpoint updates). */
  signal(signal: number) {
    if (!this.interrupt || this.dead) return false;
    Atomics.store(this.interrupt, 0, signal);
    Atomics.notify(this.interrupt, 0);
    return true;
  }

  private syncs = new Map<number, () => void>();
  private nextSync = 0;

  /** The program's queued writes reach the host, and a linked folder's copy
   * goes back to it. Resolves with the files changed since the last sync (app
   * paths); the host also tells the app's views about them. */
  async syncFiles(timeoutMs = 1000): Promise<string[]> {
    if (!this.dead) {
      const id = this.nextSync++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.syncs.delete(id);
          resolve();
        }, timeoutMs);
        this.syncs.set(id, () => {
          clearTimeout(timer);
          resolve();
        });
        this.worker.postMessage({ type: "sync", id });
      });
    }
    if (!this.mountToken) return [];
    return call<string[]>("hostfs.sync", { token: this.mountToken }).catch(() => []);
  }

  /** Flush, end the worker and unmount its folder: every file the program
   * changed while it was mounted (app paths). */
  async release(): Promise<string[]> {
    await this.syncFiles();
    this.terminate("done");
    return this.unmounted ?? [];
  }

  sendUIEvent(id: string, args: string) {
    this.worker.postMessage({ type: "ui-event", id, args });
  }

  private finish(result: RunResult) {
    if (this.stopTimer) clearInterval(this.stopTimer);
    this.stopTimer = null;
    const done = this.current;
    this.current = null;
    done?.(result);
  }

  /** KeyboardInterrupt, re-asserted until the run ends; kill after killAfterMs (D11). */
  stop(killAfterMs = 1500) {
    if (!this.current) return;
    if (!this.interrupt) {
      this.terminate("killed");
      return;
    }
    const assert = () => {
      Atomics.store(this.interrupt!, 0, 2);
      Atomics.notify(this.interrupt!, 0);
      if (this.syncPending) this.replySync({ interrupted: true });
    };
    assert();
    if (this.stopTimer) return;
    const started = performance.now();
    this.stopTimer = setInterval(() => {
      if (performance.now() - started > killAfterMs) this.terminate("Killed: the program did not respond to Stop");
      else assert();
    }, 50);
  }

  terminate(reason = "terminated") {
    this.dead = true;
    this.worker.terminate();
    this.unmount();
    this.finish({ ok: false, error: reason, ms: 0, killed: true });
  }

  private unmount() {
    // Writes still queued in the worker are lost, as in a crash.
    if (this.mountToken && !this.unmounted) {
      this.unmounted = call<string[]>("hostfs.unmount", { token: this.mountToken }).catch(() => []);
    }
  }
}

/**
 * Keeps a booted worker in reserve so a fresh run starts instantly: one for
 * the default Python, and one for the last other Python a program used.
 */
export class WorkerPool {
  private spares = new Map<string, PyWorker>();

  constructor() {
    this.spare(getDefaultPython());
  }

  /** The default runtime's spare (its boot time is shown in Settings). */
  get spareReady() {
    return this.spare(getDefaultPython()).ready;
  }

  private spare(python: string) {
    let worker = this.spares.get(python);
    if (!worker || worker.dead) {
      worker = new PyWorker(python);
      this.spares.set(python, worker);
    }
    return worker;
  }

  /** Only the default's spare and the one for `keep` stay. */
  private trim(keep: string) {
    for (const [python, worker] of this.spares) {
      if (python !== keep && python !== getDefaultPython()) {
        worker.terminate("unused");
        this.spares.delete(python);
      }
    }
  }

  /** The default changed (Settings). */
  setDefault(python: string) {
    this.spare(python);
    this.trim(python);
  }

  async take(python = getDefaultPython()): Promise<PyWorker> {
    const worker = this.spare(python);
    this.spares.delete(python);
    this.spare(python);
    this.trim(python);
    await worker.ready;
    return worker;
  }
}
