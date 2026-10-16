// Processes (D47; from spikes/processes/): every process of a program is a
// Pyodide worker of its own. A ProcessTree belongs to the worker a program
// runs in (the root, pid 100) and starts the children its interpreter asks
// for (multiprocessing's spawn, Python subprocesses), from a few warm spare
// workers. It keeps the run's control block (pids, wait statuses, semaphores),
// the shared objects (pipes, buffers) every new process gets, and the tree:
// Stop interrupts all of it, and closing the root ends what is left.
import { PyWorker, type Stream } from "./python";

// The layout of the control block and pipes; keep in sync with
// public/runtime/procs-shared.js (the workers' side).
const PID_BASE = 100;
const MAX_PROCS = 4096;
const MAX_SEMS = 16384;
const C_NEXT_PID = 0;
const C_EPOCH = 2;
const PROC_BASE = 16;
const SEM_BASE = PROC_BASE + 2 * MAX_PROCS;
const CONTROL_BYTES = 4 * (SEM_BASE + MAX_SEMS);
const ST_RUNNING = 1;
const ST_EXITED = 2;
const P_SEQ = 3;
const P_SLOTS = 8;
const MAX_HOLDERS = 64;
const procIndex = (pid: number) => PROC_BASE + 2 * (pid - PID_BASE);
const exitedStatus = (code: number) => (code & 0xff) << 8;
const signaledStatus = (sig: number) => sig & 0x7f;

/** What a spare for children imports while it waits (like forkserver's preload). */
const PRELOAD = [
  "multiprocessing", "multiprocessing.connection", "multiprocessing.queues", "multiprocessing.pool",
  "multiprocessing.spawn", "multiprocessing.popen_fork", "concurrent.futures.process",
];
/** Booted spares kept for a program once it has started a process. */
const SPARES = 2;
/** Processes alive at once, the root included: each is a whole interpreter
 * (about 100 MB), and iOS ends the web view at about 1.9 GB (Q15, Q24). */
const MAX_LIVE = 10;
/** os.cpu_count(): Pool() and ProcessPoolExecutor() start this many. */
export const CPU_COUNT = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));
/** After Stop, a child that doesn't end gets SIGKILL (D11). */
const KILL_AFTER_MS = 1500;

interface Proc {
  pid: number;
  ppid: number;
  worker: PyWorker | null;
  started: boolean; // Python runs its task (so SIGINT is a KeyboardInterrupt)
  exited: boolean;
}

export class ProcessTree {
  readonly control = new SharedArrayBuffer(CONTROL_BYTES);
  private c = new Int32Array(this.control);
  private objects = new Map<number, { kind: string; sab: SharedArrayBuffer }>();
  private procs = new Map<number, Proc>();
  private spares: PyWorker[] = [];
  private stopping = false;
  private closed = false;
  readonly rootPid: number;
  /** The interpreter's working directory (the mounted project folder). */
  cwd = "/home/pyodide/project";

  constructor(readonly root: PyWorker) {
    this.rootPid = this.allocPid();
    this.procs.set(this.rootPid, { pid: this.rootPid, ppid: 1, worker: root, started: true, exited: false });
  }

  /** For the root's runs: what makes its interpreter process `rootPid`. */
  init() {
    return { control: this.control, pid: this.rootPid, ppid: 1, cpuCount: CPU_COUNT, objects: [] };
  }

  private allocPid() {
    const pid = PID_BASE + Atomics.add(this.c, C_NEXT_PID, 1);
    Atomics.store(this.c, procIndex(pid), ST_RUNNING);
    return pid;
  }

  private live() {
    let n = 0;
    for (const p of this.procs.values()) if (!p.exited) n++;
    return n;
  }

  /** A message from a worker in the tree (python.ts routes them here). */
  onMessage(from: PyWorker, msg: any) {
    const proc = this.procs.get(from === this.root ? this.rootPid : from.processPid);
    switch (msg.type) {
      case "share":
        this.objects.set(msg.id, { kind: msg.kind, sab: msg.sab });
        break;
      case "spawn":
        if (proc) void this.spawn(proc, msg);
        break;
      case "abandon":
        this.releaseHolds(msg.pid);
        break;
      case "kill":
        this.kill(msg.pid, msg.sig);
        break;
      case "process-started":
        if (proc) proc.started = true;
        // Stop came while it was starting.
        if (proc && this.stopping) this.kill(proc.pid, 2);
        break;
      case "process-exit":
        if (proc) this.exited(proc.pid, msg.code < 0 ? signaledStatus(-msg.code) : exitedStatus(msg.code));
        break;
    }
  }

  private output(stream: Stream, text: string) {
    // After Stop, the children's KeyboardInterrupt tracebacks are noise.
    if (this.stopping && stream === "stderr") return;
    this.root.onOutput(stream, text);
  }

  private async spawn(parent: Proc, msg: { pid: number; task: any; payload: Uint8Array | null; packages: string[] }) {
    const proc: Proc = { pid: msg.pid, ppid: parent.pid, worker: null, started: false, exited: false };
    this.procs.set(proc.pid, proc);
    if (this.closed) return this.exited(proc.pid, signaledStatus(9));
    if (this.live() > MAX_LIVE) {
      this.root.onOutput("stderr", `Could not start process ${proc.pid}: at most ${MAX_LIVE} processes can run at once.\n`);
      return this.exited(proc.pid, exitedStatus(1));
    }
    let worker: PyWorker;
    try {
      worker = await this.takeSpare();
      if (proc.exited) return worker.terminate("ended");
      // The same folder as the root, sharing a linked folder's copy (D35).
      await worker.attach(this.root.attachedPath ?? "", this.root.mountTokenForSharing);
    } catch (e) {
      this.root.onOutput("stderr", `Could not start process ${proc.pid}: ${(e as Error).message ?? e}\n`);
      return this.exited(proc.pid, exitedStatus(1));
    }
    if (proc.exited) return worker.terminate("ended");
    proc.worker = worker;
    worker.procs = this;
    worker.processPid = proc.pid;
    worker.allowDevice = this.root.allowDevice;
    worker.onOutput = (stream, text) => this.output(stream, text);
    worker.onInput = async () => null; // multiprocessing closes a child's stdin; input() gets end-of-file
    worker.onCrash = (error) => this.root.onOutput("stderr", `Process ${proc.pid} crashed: ${error}\n`);
    worker.startProcess({
      pid: proc.pid, ppid: proc.ppid, control: this.control, objects: [...this.objects], cpuCount: CPU_COUNT,
      task: msg.task, payload: msg.payload, packages: msg.packages, cwd: this.cwd,
    });
  }

  /** A booted spare (a new one if none is ready), and more spares behind it. */
  private async takeSpare(): Promise<PyWorker> {
    this.spares = this.spares.filter((w) => !w.dead);
    let worker = this.spares.shift();
    if (!worker) worker = new PyWorker(this.root.python, { preload: PRELOAD });
    while (this.spares.length < this.spareTarget) this.spares.push(new PyWorker(this.root.python, { preload: PRELOAD }));
    await worker.ready;
    if (this.closed) {
      worker.terminate("unused");
      throw new Error("the program has ended");
    }
    return worker;
  }

  /** A worker of the tree ended (exited, killed, crashed, closed). */
  workerGone(worker: PyWorker, crashed = false) {
    if (worker === this.root) return this.close();
    if (worker.processPid) this.exited(worker.processPid, signaledStatus(crashed ? 6 : 9));
  }

  private exited(pid: number, status: number) {
    const proc = this.procs.get(pid);
    if (!proc || proc.exited) return;
    proc.exited = true;
    const idx = procIndex(pid);
    Atomics.store(this.c, idx + 1, status);
    Atomics.store(this.c, idx, ST_EXITED);
    Atomics.notify(this.c, idx);
    this.releaseHolds(pid);
    if (proc.worker && proc.worker !== this.root && !proc.worker.dead) proc.worker.terminate("exited");
  }

  /** Drop the pipe ends a process held, as the kernel would (EOF, EPIPE). */
  private releaseHolds(pid: number) {
    for (const { kind, sab } of this.objects.values()) {
      if (kind !== "pipe") continue;
      const i32 = new Int32Array(sab);
      let held = false;
      for (let s = 0; s < MAX_HOLDERS; s++) {
        const base = P_SLOTS + 3 * s;
        if (Atomics.load(i32, base) !== pid) continue;
        held ||= i32[base + 1] !== 0 || i32[base + 2] !== 0;
        Atomics.store(i32, base + 1, 0);
        Atomics.store(i32, base + 2, 0);
        Atomics.store(i32, base, 0);
      }
      if (held) {
        Atomics.add(i32, P_SEQ, 1);
        Atomics.notify(i32, P_SEQ);
      }
    }
    Atomics.add(this.c, C_EPOCH, 1);
    Atomics.notify(this.c, C_EPOCH);
  }

  private kill(pid: number, sig: number) {
    const proc = this.procs.get(pid);
    if (!proc || proc.exited || pid === this.rootPid) return;
    if (sig === 0) return;
    if (sig === 2 && proc.started && proc.worker) {
      proc.worker.signal(2); // KeyboardInterrupt
      return;
    }
    // SIGINT before Python handles it, or any other signal: the process ends.
    this.exited(pid, signaledStatus(sig));
  }

  /** Stop (the root is stopped too): SIGINT to every child, SIGKILL after 1.5 s. */
  stop() {
    const children = [...this.procs.values()].filter((p) => !p.exited && p.pid !== this.rootPid);
    if (!children.length) return;
    this.stopping = true;
    for (const p of children) this.kill(p.pid, 2);
    setTimeout(() => {
      for (const p of children) if (!p.exited) this.kill(p.pid, 9);
    }, KILL_AFTER_MS);
  }

  /** A run starts in the root: output of children again (a new program or >>> line). */
  runStarted(cwd?: string) {
    this.stopping = false;
    if (cwd) this.cwd = cwd;
  }

  /** The root is gone: end every process and the spares. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.procs.values()) if (!p.exited && p.pid !== this.rootPid) this.exited(p.pid, signaledStatus(9));
    for (const w of this.spares) w.terminate("unused");
    this.spares = [];
  }

  /** Spares are only made while the program runs. */
  private get spareTarget() {
    return this.closed ? 0 : SPARES;
  }

  /** Processes started (the root included) and alive now; for the self-test. */
  get counts() {
    return { started: this.procs.size, alive: this.live() };
  }
}
