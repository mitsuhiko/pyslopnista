// The worker side of processes (spike): what `_procs` gives Python.
//
// - Pipes are SharedArrayBuffer rings (procs-shared.js) behind file
//   descriptors of a small Emscripten file system (MPFS), so os.read,
//   os.write, os.dup, os.close and fstat work on them, from Python and C.
//   A blocking read or write waits with Atomics.wait; Stop turns that into
//   EINTR, which CPython turns into KeyboardInterrupt.
// - Waiting with a timeout (select, poll, selectors) is done here, because
//   Emscripten's poll() ignores its timeout: wait on the control block's
//   epoch, which every pipe change and process exit bumps.
// - Semaphores are Int32s in the control block (multiprocessing's SemLock).
// - Shared buffers (Value, Array) are SharedArrayBuffers read and written
//   through calls (wasm memories can't be shared between workers).
// - Processes: pids from the control block, spawn/kill as messages to the
//   manager, waitpid on the process table.
import * as S from "./procs-shared.js";

const O_NONBLOCK = 2048;
const E = { EINTR: 27, EAGAIN: 6, EPIPE: 64, EBADF: 8, ESPIPE: 70 };
const POLLIN = 1, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;
const SLICE_MS = 50;
const WNOHANG = 1;

export function createProcs({ py, post, control: controlSab, interrupt: interruptSab, objects, pid, ppid, cpuCount }) {
  const FS = py.FS;
  const control = new Int32Array(controlSab);
  const intr = new Int32Array(interruptSab);
  const pipes = new Map(); // id -> Pipe, as opened in this worker
  const children = new Set(); // pids this process started and hasn't reaped
  const stats = { pipeWaits: 0, selectWaits: 0 };

  const interrupted = () => Atomics.load(intr, 0) !== 0;
  const fsInterrupt = () => {
    throw new FS.ErrnoError(E.EINTR);
  };
  // For calls from Python: raises KeyboardInterrupt in the caller (Stop).
  const ffiInterrupt = () => {
    py.checkInterrupt();
    if (interrupted()) throw new Error("interrupted");
  };

  /** Wait until i32[index] !== value or the deadline (performance.now()) passes.
   * Returns false on timeout. Checks for Stop every SLICE_MS, and first: a
   * Stop wins over what happened meanwhile (a parent stopped together with
   * its children raises KeyboardInterrupt in join(), as on POSIX). */
  function waitChange(i32, index, value, deadline, onInterrupt) {
    for (;;) {
      if (interrupted()) onInterrupt();
      if (Atomics.load(i32, index) !== value) return true;
      const left = deadline === Infinity ? SLICE_MS : Math.min(SLICE_MS, deadline - performance.now());
      if (left <= 0) return false;
      Atomics.wait(i32, index, value, left);
    }
  }
  const deadlineFor = (ms) => (ms < 0 ? Infinity : performance.now() + ms);

  class Pipe {
    constructor(id, sab) {
      this.id = id;
      this.i32 = new Int32Array(sab);
      this.cap = this.i32[S.P_CAP];
      this.mask = this.cap - 1;
      this.data = new Uint8Array(sab, S.P_DATA, this.cap);
    }
    lock() {
      while (Atomics.compareExchange(this.i32, S.P_LOCK, 0, 1) !== 0) Atomics.wait(this.i32, S.P_LOCK, 1, 1);
    }
    unlock() {
      Atomics.store(this.i32, S.P_LOCK, 0);
      Atomics.notify(this.i32, S.P_LOCK, 1);
    }
    changed() {
      Atomics.add(this.i32, S.P_SEQ, 1);
      Atomics.notify(this.i32, S.P_SEQ);
      S.bumpEpoch(control);
    }
    available() {
      return (Atomics.load(this.i32, S.P_WRITE) - Atomics.load(this.i32, S.P_READ)) >>> 0;
    }
    /** Open ends across all processes: 1 = read ends, 2 = write ends. */
    count(which) {
      let n = 0;
      for (let s = 0; s < S.MAX_HOLDERS; s++) {
        const b = S.P_SLOTS + 3 * s;
        if (Atomics.load(this.i32, b) !== 0) n += Atomics.load(this.i32, b + which);
      }
      return n;
    }
    /** Change the ends `forPid` holds (its slot is claimed on first use). */
    hold(forPid, dr, dw) {
      const a = this.i32;
      for (;;) {
        let free = -1;
        for (let s = 0; s < S.MAX_HOLDERS; s++) {
          const b = S.P_SLOTS + 3 * s;
          const p = Atomics.load(a, b);
          if (p === forPid) {
            Atomics.add(a, b + 1, dr);
            Atomics.add(a, b + 2, dw);
            this.changed();
            return;
          }
          if (p === 0 && free < 0) free = s;
        }
        if (free < 0) throw new Error("too many processes hold this pipe");
        const b = S.P_SLOTS + 3 * free;
        if (Atomics.compareExchange(a, b, 0, forPid) === 0) {
          Atomics.add(a, b + 1, dr);
          Atomics.add(a, b + 2, dw);
          this.changed();
          return;
        }
      }
    }
    /** Copy up to `length` bytes into dst (a Uint8Array); 0 if empty. */
    take(dst) {
      this.lock();
      const r = this.i32[S.P_READ] >>> 0;
      const avail = (this.i32[S.P_WRITE] - r) >>> 0;
      const n = Math.min(avail, dst.length);
      if (n > 0) {
        const start = r & this.mask;
        const first = Math.min(n, this.cap - start);
        dst.set(this.data.subarray(start, start + first));
        if (n > first) dst.set(this.data.subarray(0, n - first), first);
        Atomics.store(this.i32, S.P_READ, (r + n) | 0);
      }
      this.unlock();
      if (n > 0) this.changed();
      return n;
    }
    /** Copy as much of src as fits; returns the count. With `all`, only
     * writes if all of it fits (returns 0 otherwise). */
    put(src, all = false) {
      this.lock();
      const w = this.i32[S.P_WRITE] >>> 0;
      const space = this.cap - ((w - this.i32[S.P_READ]) >>> 0);
      const n = all && space < src.length ? 0 : Math.min(space, src.length);
      if (n > 0) {
        const start = w & this.mask;
        const first = Math.min(n, this.cap - start);
        this.data.set(src.subarray(0, first), start);
        if (n > first) this.data.set(src.subarray(first, n), 0);
        Atomics.store(this.i32, S.P_WRITE, (w + n) | 0);
      }
      this.unlock();
      if (n > 0) this.changed();
      return n;
    }
  }

  function newObject(kind, bytes, init) {
    const id = Atomics.add(control, S.C_NEXT_OBJ, 1) + 1;
    const sab = new SharedArrayBuffer(bytes);
    init?.(sab);
    objects.set(id, { kind, sab });
    post({ type: "share", id, kind, sab });
    return id;
  }
  function objectFor(id) {
    const obj = objects.get(id);
    if (!obj) {
      throw new Error(
        `shared object ${id} is unknown in process ${pid}: only pipes, locks and shared values that ` +
          `existed when a process started can be passed to it (pass them to Process(), not through a queue)`,
      );
    }
    return obj;
  }
  function pipeFor(id) {
    let p = pipes.get(id);
    if (!p) {
      p = new Pipe(id, objectFor(id).sab);
      pipes.set(id, p);
    }
    return p;
  }
  function newPipe(cap = 1 << 20) {
    return pipeFor(newObject("pipe", S.P_DATA + cap, (sab) => (new Int32Array(sab)[S.P_CAP] = cap)));
  }

  // ---- MPFS: pipe ends as file descriptors ----

  const pollMask = ({ rx, tx }) => {
    let m = 0;
    if (rx) {
      if (rx.available() > 0) m |= POLLIN;
      if (rx.count(2) === 0) m |= POLLIN | POLLHUP;
    }
    if (tx) {
      if (tx.count(1) === 0) m |= POLLOUT | POLLERR;
      else if (tx.available() < tx.cap) m |= POLLOUT;
    }
    return m;
  };

  const streamOps = {
    getattr(stream) {
      const t = new Date();
      return { dev: 14, ino: stream.node.id, mode: 4480, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, atime: t, mtime: t, ctime: t, blksize: 4096, blocks: 0 };
    },
    read(stream, buffer, offset, length) {
      const p = stream.node.mp.rx;
      if (!p) throw new FS.ErrnoError(E.EBADF);
      if (length === 0) return 0;
      const dst = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      for (;;) {
        const seq = Atomics.load(p.i32, S.P_SEQ);
        const n = p.take(dst);
        if (n > 0) return n;
        if (p.count(2) === 0 && p.available() === 0) return 0; // EOF
        if (stream.flags & O_NONBLOCK) throw new FS.ErrnoError(E.EAGAIN);
        stats.pipeWaits++;
        waitChange(p.i32, S.P_SEQ, seq, Infinity, fsInterrupt);
      }
    },
    write(stream, buffer, offset, length) {
      const p = stream.node.mp.tx;
      if (!p) throw new FS.ErrnoError(E.EBADF);
      const src = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      let done = 0;
      while (done < length) {
        const seq = Atomics.load(p.i32, S.P_SEQ);
        if (p.count(1) === 0) {
          if (done) return done;
          throw new FS.ErrnoError(E.EPIPE);
        }
        const n = p.put(src.subarray(done));
        if (n > 0) {
          done += n;
          continue;
        }
        if (stream.flags & O_NONBLOCK) {
          if (done) return done;
          throw new FS.ErrnoError(E.EAGAIN);
        }
        if (done && interrupted()) return done; // a short write; the next one raises
        stats.pipeWaits++;
        waitChange(p.i32, S.P_SEQ, seq, Infinity, fsInterrupt);
      }
      return done;
    },
    llseek() {
      throw new FS.ErrnoError(E.ESPIPE);
    },
    poll(stream) {
      return pollMask(stream.node.mp);
    },
    dup(stream) {
      const { rx, tx } = stream.node.mp;
      rx?.hold(pid, 1, 0);
      tx?.hold(pid, 0, 1);
    },
    close(stream) {
      const { rx, tx } = stream.node.mp;
      rx?.hold(pid, -1, 0);
      tx?.hold(pid, 0, -1);
    },
  };

  const MPFS = { mount: () => FS.createNode(null, "/", 16384 | 0o777, 0) };
  const root = FS.mount(MPFS, {}, null);
  let nodes = 0;
  /** A new fd for the given ends. `hold`: count the ends for this process
   * (false when adopting ends a parent already counted for us). */
  function openEnds(rx, tx, hold = true) {
    const node = FS.createNode(root, `mp${++nodes}`, 4096, 0);
    node.mp = { rx, tx };
    if (hold) {
      rx?.hold(pid, 1, 0);
      tx?.hold(pid, 0, 1);
    }
    const flags = rx && tx ? 2 : tx ? 1 : 0;
    return FS.createStream({ path: `pipe:[${rx?.id ?? ""}${tx ? "," + tx.id : ""}]`, node, flags, seekable: false, stream_ops: streamOps }).fd;
  }
  const endsOf = (fd) => {
    const stream = FS.getStream(fd);
    if (!stream) throw new FS.ErrnoError(E.EBADF);
    return stream;
  };

  const toList = (v) => (v?.toJs ? v.toJs() : v);
  const toBytes = (v) => (v?.toJs ? v.toJs() : v);

  function exitStatusOf(p) {
    return Atomics.load(control, S.procIndex(p)) === S.ST_EXITED ? Atomics.load(control, S.procIndex(p) + 1) : null;
  }

  const api = {
    pid,
    ppid,
    cpu_count: () => cpuCount,
    now: () => performance.now(),
    stats: () => JSON.stringify(stats),

    // ---- pipes ----
    pipe(cap) {
      const p = newPipe(cap ?? undefined);
      return [openEnds(p, null), openEnds(null, p)];
    },
    socketpair() {
      const a = newPipe();
      const b = newPipe();
      return [openEnds(a, b), openEnds(b, a)];
    },
    /** Count `fd`'s ends for process `to` and describe them (JSON) so it can
     * adopt them. /dev/null is passed by name. */
    transfer(fd, to) {
      const stream = endsOf(fd);
      if (!stream.node.mp) {
        if (stream.path === "/dev/null") return JSON.stringify({ devnull: true, flags: stream.flags });
        throw new Error(`fd ${fd} (${stream.path}) can't be passed to another process: only pipes and /dev/null can`);
      }
      const { rx, tx } = stream.node.mp;
      rx?.hold(to, 1, 0);
      tx?.hold(to, 0, 1);
      return JSON.stringify({ rx: rx?.id ?? null, tx: tx?.id ?? null });
    },
    /** Adopt ends as fd `target` (0, 1, 2) without closing what was there:
     * closing Pyodide's own stdio streams can fail (Node's stdin). */
    adopt_as(desc, target) {
      const fd = api.adopt(desc);
      const stream = FS.getStream(fd);
      FS.dupStream(stream, target);
      FS.close(stream);
      return target;
    },
    adopt(desc) {
      const d = JSON.parse(desc);
      if (d.devnull) return FS.open("/dev/null", d.flags & 3).fd;
      return openEnds(d.rx ? pipeFor(d.rx) : null, d.tx ? pipeFor(d.tx) : null, false);
    },
    /** A pipe nobody writes to, whose write end counts as held by `owner`:
     * it reads EOF once `owner` has exited (the manager drops its ends).
     * Returns [read fd for us, pipe id]. */
    life_pipe(owner) {
      const p = newPipe(16);
      p.hold(owner, 0, 1);
      return [openEnds(p, null), p.id];
    },
    /** A read end of an existing life pipe, counted for process `to`. */
    life_reader(id, to) {
      pipeFor(id).hold(to, 1, 0);
      return JSON.stringify({ rx: id, tx: null });
    },
    /** Write all of `data` to a pipe fd if it fits right now (true), else nothing (false). */
    try_write_all(fd, data) {
      const stream = endsOf(fd);
      const p = stream.node.mp?.tx;
      if (!p) throw new Error(`fd ${fd} is not a pipe's write end`);
      const bytes = toBytes(data);
      if (p.count(1) === 0) return undefined; // EPIPE (None in Python)
      if (bytes.length > p.cap) return false;
      return p.put(bytes, true) > 0 || bytes.length === 0;
    },
    /** Diagnostics: {available, readers, writers} of a pipe fd's ends. */
    pipe_info(fd) {
      const { rx, tx } = endsOf(fd).node.mp ?? {};
      const info = (p) => p && { id: p.id, available: p.available(), readers: p.count(1), writers: p.count(2) };
      return JSON.stringify({ rx: info(rx), tx: info(tx) });
    },
    pipe_capacity(fd) {
      return endsOf(fd).node.mp?.tx?.cap ?? 0;
    },

    /** poll(): fds and events are lists; returns [fd, revents, ...] of the
     * ready ones (empty on timeout). */
    wait_fds(fdsIn, eventsIn, timeoutMs) {
      const fds = toList(fdsIn);
      const events = toList(eventsIn);
      const deadline = deadlineFor(timeoutMs);
      for (;;) {
        const epoch = Atomics.load(control, S.C_EPOCH);
        const out = [];
        for (let i = 0; i < fds.length; i++) {
          const stream = FS.getStream(fds[i]);
          let mask;
          if (!stream) mask = POLLNVAL;
          else if (stream.stream_ops.poll) mask = stream.stream_ops.poll(stream, -1);
          else mask = POLLIN | POLLOUT;
          const rev = mask & (events[i] | POLLERR | POLLHUP | POLLNVAL);
          if (rev) out.push(fds[i], rev);
        }
        if (out.length || timeoutMs === 0) return out;
        stats.selectWaits++;
        if (!waitChange(control, S.C_EPOCH, epoch, deadline, ffiInterrupt)) return [];
      }
    },

    sleep(seconds) {
      const deadline = performance.now() + seconds * 1000;
      for (;;) {
        const left = deadline - performance.now();
        if (left <= 0) return;
        Atomics.wait(intr, 0, 0, left);
        if (interrupted()) ffiInterrupt();
      }
    },

    // ---- semaphores (SemLock) ----
    sem_new(value) {
      const id = Atomics.add(control, S.C_NEXT_SEM, 1);
      if (id >= S.MAX_SEMS) throw new Error("too many semaphores");
      Atomics.store(control, S.SEM_BASE + id, value);
      return id;
    },
    sem_acquire(id, block, timeoutMs) {
      const idx = S.SEM_BASE + id;
      const deadline = block ? deadlineFor(timeoutMs) : 0;
      for (;;) {
        const v = Atomics.load(control, idx);
        if (v > 0) {
          if (Atomics.compareExchange(control, idx, v, v - 1) === v) return true;
          continue;
        }
        if (!block) return false;
        if (!waitChange(control, idx, v, deadline, ffiInterrupt)) return false;
      }
    },
    /** 0 if released, 2 if the value is already at maxvalue. */
    sem_release(id, maxvalue) {
      const idx = S.SEM_BASE + id;
      for (;;) {
        const v = Atomics.load(control, idx);
        if (v >= maxvalue) return 2;
        if (Atomics.compareExchange(control, idx, v, v + 1) === v) {
          Atomics.notify(control, idx);
          return 0;
        }
      }
    },
    sem_value: (id) => Atomics.load(control, S.SEM_BASE + id),

    // ---- shared buffers (Value, Array) ----
    buf_new(size) {
      return newObject("buffer", Math.max(8, size));
    },
    buf_get(id, offset, n) {
      return new Uint8Array(objectFor(id).sab, offset, n).slice();
    },
    buf_set(id, offset, data) {
      new Uint8Array(objectFor(id).sab).set(toBytes(data), offset);
    },

    // ---- processes ----
    alloc_pid() {
      const n = Atomics.add(control, S.C_NEXT_PID, 1);
      if (n >= S.MAX_PROCS) throw new Error("too many processes in this run");
      const child = S.PID_BASE + n;
      Atomics.store(control, S.procIndex(child), S.ST_RUNNING);
      children.add(child);
      return child;
    },
    spawn(child, task, payload) {
      // Pyodide's own packages by name; ones from PyPI come as task.pypi
      // (loadPackage throws for names it doesn't know).
      const known = py._api?.lockfile_packages;
      const packages = Object.keys(py.loadedPackages ?? {}).filter((name) => !known || name in known);
      post({ type: "spawn", pid: child, task: JSON.parse(task), payload: payload ? toBytes(payload) : null, packages });
    },
    /** A pid that was allocated but never started (its pickling failed). */
    abandon(child) {
      post({ type: "abandon", pid: child });
      Atomics.store(control, S.procIndex(child) + 1, S.exitedStatus(255));
      Atomics.store(control, S.procIndex(child), S.ST_EXITED);
    },
    /** [pid, status], [0, 0] (WNOHANG and still running) or undefined (ECHILD). */
    waitpid(target, flags) {
      const mine = target <= 0 ? [...children] : children.has(target) ? [target] : [];
      if (!mine.length) return undefined;
      for (;;) {
        const epoch = Atomics.load(control, S.C_EPOCH);
        for (const p of mine) {
          const status = exitStatusOf(p);
          if (status !== null) {
            children.delete(p);
            return [p, status];
          }
        }
        if (flags & WNOHANG) return [0, 0];
        waitChange(control, S.C_EPOCH, epoch, Infinity, ffiInterrupt);
      }
    },
    /** Wait up to ms for a child to exit (without reaping it). */
    wait_exit(target, ms) {
      if (!children.has(target)) return true;
      const idx = S.procIndex(target);
      const deadline = deadlineFor(ms);
      for (;;) {
        const state = Atomics.load(control, idx);
        if (state === S.ST_EXITED) return true;
        if (!waitChange(control, idx, state, deadline, ffiInterrupt)) return false;
      }
    },
    /** false if there is no such process (ESRCH). */
    kill(target, sig) {
      if (target < S.PID_BASE || target >= S.PID_BASE + S.MAX_PROCS) return false;
      if (Atomics.load(control, S.procIndex(target)) !== S.ST_RUNNING) return false;
      if (sig !== 0) post({ type: "kill", pid: target, sig });
      return true;
    },
  };
  return { api, stats };
}
