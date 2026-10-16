// The process manager (spike): owns the workers. Runs where the page's
// main thread is (or Node's), never blocks.
//
// - Every process is a fresh Pyodide worker, taken from a warm pool of
//   booted ones when there is one.
// - It knows each process's parent and root, so Stop and the end of a run
//   reach the whole tree.
// - It keeps every shared object (pipes, buffers) and gives a new process
//   all of them: objects are passed by inheritance, as with spawn.
// - When a process exits (or is killed), it records the wait status, drops
//   the pipe ends the process held (EOF/EPIPE for the others) and wakes
//   whoever waits.
import * as S from "./procs-shared.js";

const now = () => performance.now();

/** Modules a warm worker imports ahead of time (what a spawned child needs). */
export const PRELOAD = [
  "multiprocessing", "multiprocessing.connection", "multiprocessing.queues", "multiprocessing.pool",
  "multiprocessing.spawn", "multiprocessing.popen_fork", "concurrent.futures.process",
];

export class Manager {
  /**
   * @param {object} o
   * @param {() => {post(msg): void, terminate(): void, onmessage: (msg) => void}} o.createWorker
   * @param {object} o.boot  sent with every boot message (indexURL, runtime files, ...)
   * @param {number} o.cpuCount
   * @param {number} [o.warm]  booted workers to keep ready
   * @param {(line: string) => void} [o.log]
   */
  constructor({ createWorker, boot, cpuCount, warm = 0, log = () => {} }) {
    this.createWorker = createWorker;
    this.bootFields = boot;
    this.cpuCount = cpuCount;
    this.warm = warm;
    this.log = log;
    this.controlSab = new SharedArrayBuffer(S.CONTROL_BYTES);
    this.control = new Int32Array(this.controlSab);
    this.objects = new Map(); // id -> {kind, sab}
    this.procs = new Map(); // pid -> proc
    this.idle = []; // promises of booted workers
    this.files = {};
    this.events = []; // per-process timings
    this.bootTimes = [];
    this.preloadTimes = [];
  }

  /** Boot a worker (Pyodide loaded, nothing run yet). */
  bootWorker() {
    const t0 = now();
    const w = this.createWorker();
    const interrupt = new SharedArrayBuffer(4);
    return new Promise((resolve, reject) => {
      w.onmessage = (msg) => {
        if (msg.type === "booted") {
          this.bootTimes.push(now() - t0);
          this.preloadTimes.push(msg.preloadMs);
          resolve({ w, interrupt, bootMs: now() - t0, wasmBytes: msg.wasmBytes });
        } else if (msg.type === "fatal") reject(new Error(msg.error));
        else if (msg.type === "log") this.log(`[boot] ${msg.text}`);
      };
      w.post({ type: "boot", ...this.bootFields, control: this.controlSab, interrupt });
    });
  }

  refill() {
    while (this.idle.length < this.warm) {
      const entry = { booted: false };
      entry.promise = this.bootWorker().then((w) => ((entry.booted = true), w));
      entry.promise.catch((e) => this.log(`warm boot failed: ${e.message}`));
      this.idle.push(entry);
    }
  }

  /** A booted worker: from the warm pool if one is ready ("warm"), else the
   * one booting longest, else a new one ("cold"). */
  async takeWorker() {
    let i = this.idle.findIndex((e) => e.booted);
    if (i < 0 && this.idle.length) i = 0;
    if (i >= 0) {
      const [entry] = this.idle.splice(i, 1);
      const warm = entry.booted;
      this.refill();
      return { ...(await entry.promise), warm };
    }
    return { ...(await this.bootWorker()), warm: false };
  }

  /** Wait until the warm pool is booted. */
  async ready() {
    this.refill();
    await Promise.all(this.idle.map((e) => e.promise));
  }

  /**
   * Run a program as the root of a new process tree.
   * Resolves with {status, exitCode, output, ms, pids}.
   */
  run(path, { argv = [path], cwd = "/home/pyodide/project", timeoutMs = 120000, stopAfterMs = null, stopOnOutput = null } = {}) {
    const pid = this.allocPid();
    const root = { pid, output: [], pids: [], t0: now(), stopOnOutput };
    const done = new Promise((resolve) => (root.resolve = resolve));
    this.start(pid, 1, root, { kind: "main", path, argv, cwd }, [], null, now());
    const timers = [];
    if (stopAfterMs != null) timers.push(setTimeout(() => this.stop(pid), stopAfterMs));
    timers.push(
      setTimeout(() => {
        root.output.push({ pid: 0, stream: "system", text: `timed out after ${timeoutMs} ms\n` });
        this.stop(pid);
      }, timeoutMs),
    );
    return done.then((r) => {
      timers.forEach(clearTimeout);
      return r;
    });
  }

  allocPid() {
    const n = Atomics.add(this.control, S.C_NEXT_PID, 1);
    const pid = S.PID_BASE + n;
    Atomics.store(this.control, S.procIndex(pid), S.ST_RUNNING);
    return pid;
  }

  async start(pid, ppid, root, task, packages, payload, requestedAt) {
    const proc = { pid, ppid, root, task, requestedAt, exited: false };
    this.procs.set(pid, proc);
    root.pids.push(pid);
    let worker;
    try {
      worker = await this.takeWorker();
    } catch (e) {
      root.output.push({ pid, stream: "system", text: `could not start process ${pid}: ${e.message}\n` });
      return this.exited(pid, S.exitedStatus(1));
    }
    if (proc.exited) return worker.w.terminate(); // killed while it was starting
    proc.worker = worker;
    proc.warm = worker.warm;
    worker.w.onmessage = (msg) => this.onMessage(proc, msg);
    worker.w.post({
      type: "start", pid, ppid, task, payload, packages,
      objects: [...this.objects], files: this.files, cpuCount: this.cpuCount,
    });
  }

  onMessage(proc, msg) {
    switch (msg.type) {
      case "output":
        proc.root.output.push({ pid: proc.pid, stream: msg.stream, text: msg.text });
        if (proc.root.stopOnOutput && msg.text.includes(proc.root.stopOnOutput)) {
          proc.root.stopOnOutput = null;
          proc.root.stopAt = now();
          this.stop(proc.root.pid);
        }
        break;
      case "share":
        this.objects.set(msg.id, { kind: msg.kind, sab: msg.sab });
        break;
      case "spawn":
        this.start(msg.pid, proc.pid, proc.root, msg.task, msg.packages, msg.payload, now());
        break;
      case "abandon":
        this.releaseHolds(msg.pid);
        break;
      case "kill":
        this.kill(msg.pid, msg.sig);
        break;
      case "started":
        proc.startedAt = now();
        proc.startInfo = msg;
        break;
      case "exit":
        this.exited(proc.pid, msg.code < 0 ? S.signaledStatus(-msg.code) : S.exitedStatus(msg.code));
        break;
      case "fatal":
        proc.root.output.push({ pid: proc.pid, stream: "system", text: `process ${proc.pid} crashed: ${msg.error}\n` });
        this.exited(proc.pid, S.signaledStatus(6));
        break;
      case "log":
        this.log(`[${proc.pid}] ${msg.text}`);
        break;
    }
  }

  releaseHolds(pid) {
    for (const { kind, sab } of this.objects.values()) {
      if (kind === "pipe") S.releasePipeHolder(new Int32Array(sab), pid);
    }
    S.bumpEpoch(this.control);
  }

  exited(pid, status) {
    const proc = this.procs.get(pid);
    if (!proc || proc.exited) return;
    proc.exited = true;
    proc.exitedAt = now();
    proc.status = status;
    proc.worker?.w.terminate();
    const idx = S.procIndex(pid);
    Atomics.store(this.control, idx + 1, status);
    Atomics.store(this.control, idx, S.ST_EXITED);
    Atomics.notify(this.control, idx);
    this.releaseHolds(pid);
    this.events.push({
      pid, ppid: proc.ppid, kind: proc.task.kind, warm: proc.warm ?? null,
      // request -> user code running (boot when cold, package loads, install)
      startMs: proc.startedAt != null ? round(proc.startedAt - proc.requestedAt) : null,
      setupMs: proc.startInfo?.setupMs ?? null,
      packagesMs: proc.startInfo?.packagesMs ?? null,
      installMs: proc.startInfo?.installMs ?? null,
      lifeMs: round(proc.exitedAt - proc.requestedAt),
      status,
    });
    const root = proc.root;
    if (root.pid === pid) {
      // The run is over: whatever is left of the tree goes too (like a closed terminal).
      for (const p of root.pids) if (p !== pid) this.kill(p, 9);
      const code = status & 0x7f ? -(status & 0x7f) : (status >> 8) & 0xff;
      root.resolve({
        status, exitCode: code, output: root.output, ms: round(now() - root.t0), pids: root.pids.length,
        stopToEndMs: root.stopAt != null ? round(now() - root.stopAt) : null,
      });
    }
  }

  interrupt(proc) {
    if (proc.startedAt == null) {
      // No Python handler yet (still booting or setting up): SIGINT's
      // default action, as on POSIX, ends the process.
      this.exited(proc.pid, S.signaledStatus(2));
      return;
    }
    const i = new Int32Array(proc.worker.interrupt);
    Atomics.store(i, 0, 2); // SIGINT
    Atomics.notify(i, 0);
  }

  kill(pid, sig) {
    const proc = this.procs.get(pid);
    if (!proc || proc.exited) return;
    if (sig === 2) return this.interrupt(proc);
    this.exited(pid, S.signaledStatus(sig));
  }

  /** Stop, as in the app: SIGINT to the whole tree, SIGKILL after 1.5 s. */
  stop(rootPid) {
    const tree = [...this.procs.values()].filter((p) => p.root.pid === rootPid && !p.exited);
    for (const p of tree) this.interrupt(p);
    setTimeout(() => {
      for (const p of tree) if (!p.exited) this.kill(p.pid, 9);
    }, 1500);
  }

  shutdown() {
    for (const p of this.procs.values()) if (!p.exited) p.worker?.w.terminate();
    for (const e of this.idle) e.promise.then((w) => w.w.terminate()).catch(() => {});
    this.idle = [];
  }
}

const round = (x) => Math.round(x * 10) / 10;
