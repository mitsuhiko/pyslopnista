// Page-side controller for Python workers (D6, D11, D13, D16): warm pool,
// output streaming, stdin, interrupt with escalation, host calls, UI messages,
// project file sync.
import { call } from "./host";

const encoder = new TextEncoder();
const CHANNEL_BYTES = 8 + 1024 * 1024;

export type Stream = "stdout" | "stderr" | "system" | "image";

export interface RunOptions {
  filename?: string;
  cwd?: string; // directory inside the interpreter's file system
  files?: { path: string; data: Uint8Array }[]; // synced into cwd before running
  repl?: boolean; // run as console input (shows the value of a final expression)
}

export interface RunResult {
  ok: boolean;
  error?: string;
  ms: number;
  killed?: boolean;
  changed?: { path: string; data: Uint8Array }[];
}

export interface WorkerInfo {
  bootMs: number;
  version: string;
  jspi: string;
  gcTrampoline: boolean;
  isolated: boolean;
}

function workerOptions() {
  const params = new URLSearchParams(location.search);
  return {
    indexURL: new URL("/pyodide/", location.href).href,
    packageBaseUrl: new URL("/pkgs/", location.href).href,
    jspi: params.get("jspi") !== "0",
    gcTrampoline: params.get("gc") !== "0",
    pythonFiles: {
      "_pyslop.py": new URL("/runtime/python/_pyslop.py", location.href).href,
      "ui.py": new URL("/runtime/python/ui.py", location.href).href,
    },
  };
}

export class PyWorker {
  readonly ready: Promise<WorkerInfo>;
  dead = false;
  onOutput: (stream: Stream, text: string) => void = () => {};
  onInput: () => Promise<string | null> = async () => null;
  onUIRender: (json: string) => void = () => {};
  onCrash: (error: string) => void = () => {};

  private worker: Worker;
  private interrupt: Int32Array | null;
  private channel: SharedArrayBuffer | null;
  private syncPending = false;
  private current: ((r: RunResult) => void) | null = null;
  private stopTimer: ReturnType<typeof setInterval> | null = null;
  private resolveReady!: (info: WorkerInfo) => void;
  private rejectReady!: (err: Error) => void;

  constructor() {
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
    this.worker.postMessage({ type: "boot", interrupt: this.interrupt?.buffer ?? null, channel: this.channel, ...workerOptions() });
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
      case "call":
        void this.handleCall(msg);
        break;
      case "done":
        this.finish(msg);
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
        }
        break;
      }
    }
  }

  private async handleCall(msg: any) {
    let reply: { value?: unknown; error?: string };
    try {
      if (msg.sync) this.syncPending = true;
      let value: unknown;
      if (msg.op === "stdin") value = await this.onInput();
      else if (msg.op === "host") value = await call(msg.value.op, msg.value.value);
      else throw new Error(`unknown call ${msg.op}`);
      reply = { value };
    } catch (e) {
      reply = { error: String((e as Error).message ?? e) };
    }
    if (msg.sync) {
      if (this.syncPending) this.replySync(reply);
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

  run(code: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.current) throw new Error("already running");
    if (this.interrupt) Atomics.store(this.interrupt, 0, 0);
    return new Promise((resolve) => {
      this.current = resolve;
      this.worker.postMessage({ type: "run", code, ...options });
    });
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
    this.finish({ ok: false, error: reason, ms: 0, killed: true });
  }
}

/** Keeps one booted worker in reserve so a fresh run starts instantly. */
export class WorkerPool {
  private spare = new PyWorker();

  get spareReady() {
    return this.spare.ready;
  }

  async take(): Promise<PyWorker> {
    const worker = this.spare;
    this.spare = new PyWorker();
    await worker.ready;
    return worker;
  }
}
