"""Speed: process start latency and CPU-bound speedup."""
import multiprocessing as mp
import os
import time

from _check import check, metric, report, timed


def nothing():
    pass


_barrier = None


def init(barrier):
    global _barrier
    _barrier = barrier


def all_up(_):
    _barrier.wait(120)


def count_primes(bounds):
    lo, hi = bounds
    n = 0
    for x in range(max(lo, 2), hi):
        for d in range(2, int(x**0.5) + 1):
            if x % d == 0:
                break
        else:
            n += 1
    return n


if __name__ == "__main__":
    times = []
    for _ in range(8):
        t0 = time.perf_counter()
        p = mp.Process(target=nothing)
        p.start()
        p.join()
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    metric("start+join of an empty process, median ms", round(times[len(times) // 2], 1))
    metric("start+join of an empty process, min ms", round(times[0], 1))

    N = int(os.environ.get("PRIMES_N", "400000"))
    chunks = [(i, i + N // 64) for i in range(0, N, N // 64)]
    with timed() as t:
        serial = sum(count_primes(c) for c in chunks)
    metric("serial ms", t.ms)
    base = t.ms
    cpus = os.cpu_count()
    metric("cpu_count", cpus)
    for n in sorted({1, 2, 4, min(cpus, 6), min(cpus, 8)}):
        with mp.Pool(n, initializer=init, initargs=(mp.Barrier(n),)) as pool:
            pool.map(all_up, range(n), chunksize=1)  # every worker is running
            with timed() as t:
                total = sum(pool.map(count_primes, chunks, chunksize=1))
        check(f"pool({n}) result", total == serial, (total, serial))
        metric(f"pool({n}) ms", t.ms)
        metric(f"pool({n}) speedup", round(base / t.ms, 2))
    report()
