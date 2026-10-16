// Shared memory layouts for processes (spike). Used by the manager (page or
// Node main thread) and by every worker.
//
// The control block (one SharedArrayBuffer per manager), Int32 slots:
//   [C_NEXT_PID]   pids handed out so far (pid = PID_BASE + n)
//   [C_NEXT_OBJ]   shared objects (pipes, buffers) handed out so far
//   [C_EPOCH]      bumped on every pipe change and process exit; select()
//                  and poll() wait on it
//   [C_NEXT_SEM]   semaphores handed out so far
//   PROC_BASE + 2*(pid-PID_BASE): [state, wait status] per process
//   SEM_BASE + sem: the semaphore's value
//
// A pipe is its own SharedArrayBuffer: an Int32 header, then a ring of bytes.
//   [P_LOCK] spin lock for ring updates, [P_READ]/[P_WRITE] byte counters
//   (uint32, wrapping), [P_SEQ] bumped on every change (blocked readers and
//   writers wait on it), [P_CAP] ring size (a power of two)
//   P_SLOTS..: MAX_HOLDERS slots of [pid, read ends, write ends], so a dead
//   process's ends can be dropped by the manager (EOF, EPIPE).

export const PID_BASE = 100;
export const MAX_PROCS = 4096;
export const MAX_SEMS = 16384;

export const C_NEXT_PID = 0;
export const C_NEXT_OBJ = 1;
export const C_EPOCH = 2;
export const C_NEXT_SEM = 3;
export const PROC_BASE = 16;
export const SEM_BASE = PROC_BASE + 2 * MAX_PROCS;
export const CONTROL_BYTES = 4 * (SEM_BASE + MAX_SEMS);

export const ST_NONE = 0;
export const ST_RUNNING = 1;
export const ST_EXITED = 2;

export const procIndex = (pid) => PROC_BASE + 2 * (pid - PID_BASE);

export const P_LOCK = 0;
export const P_READ = 1;
export const P_WRITE = 2;
export const P_SEQ = 3;
export const P_CAP = 4;
export const P_SLOTS = 8;
export const MAX_HOLDERS = 64;
export const P_DATA = 4 * (P_SLOTS + 3 * MAX_HOLDERS); // 800 bytes of header

// waitpid() status words, as on Linux.
export const exitedStatus = (code) => (code & 0xff) << 8;
export const signaledStatus = (sig) => sig & 0x7f;

/** Bump the epoch and wake everyone waiting in select()/poll(). */
export function bumpEpoch(control) {
  Atomics.add(control, C_EPOCH, 1);
  Atomics.notify(control, C_EPOCH);
}

/** Drop every end `pid` holds on a pipe (it exited). Returns true if it held any. */
export function releasePipeHolder(i32, pid) {
  let held = false;
  for (let s = 0; s < MAX_HOLDERS; s++) {
    const base = P_SLOTS + 3 * s;
    if (Atomics.load(i32, base) !== pid) continue;
    held = held || i32[base + 1] !== 0 || i32[base + 2] !== 0;
    Atomics.store(i32, base + 1, 0);
    Atomics.store(i32, base + 2, 0);
    Atomics.store(i32, base, 0); // free the slot
  }
  if (held) {
    Atomics.add(i32, P_SEQ, 1);
    Atomics.notify(i32, P_SEQ);
  }
  return held;
}
