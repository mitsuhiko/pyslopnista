"""Processes: several Python interpreters working at once.

Every process is a Python interpreter of its own, so work spread over a
Pool runs on several CPU cores in parallel. multiprocessing and subprocess
work as on a computer, with one difference: processes are started fresh
(spawn), they can't be copied (fork). Keep the
`if __name__ == "__main__":` guard: each new process imports this file
again, and the guard keeps it from starting processes of its own.
"""

import multiprocessing as mp
import os
import subprocess
import sys
import time


def count_primes(bounds):
    """How many primes are in range(lo, hi)? Slow on purpose."""
    lo, hi = bounds
    count = 0
    for n in range(max(lo, 2), hi):
        for d in range(2, int(n**0.5) + 1):
            if n % d == 0:
                break
        else:
            count += 1
    return count


def gardener(name, steps, queue):
    """A process that reports to the main one through a queue."""
    for step in range(1, steps + 1):
        time.sleep(0.3)
        queue.put(f"{name} (process {os.getpid()}) watered bed {step}")
    queue.put(None)  # done


def wait_for_everyone(barrier):
    # Each pool process waits here until all of them (and the main process)
    # are ready: starting an interpreter takes a moment, and the timing below
    # should only measure the work.
    barrier.wait()


if __name__ == "__main__":
    print(f"This is process {os.getpid()}. Pools start {os.cpu_count()} processes.\n")

    # 1. Processes that talk to each other through a queue.
    queue = mp.Queue()
    gardeners = [
        mp.Process(target=gardener, args=(name, 3, queue)) for name in ("Ada", "Bo")
    ]
    for p in gardeners:
        p.start()
    finished = 0
    while finished < len(gardeners):
        message = queue.get()
        if message is None:
            finished += 1
        else:
            print(message)
    for p in gardeners:
        p.join()

    # 2. The same work in one process, then spread over a pool.
    limit = 300_000
    chunks = [(i, i + limit // 24) for i in range(0, limit, limit // 24)]
    start = time.perf_counter()
    primes = sum(count_primes(chunk) for chunk in chunks)
    alone = time.perf_counter() - start
    workers = os.cpu_count() or 1
    barrier = mp.Barrier(workers + 1)
    with mp.Pool(workers, initializer=wait_for_everyone, initargs=(barrier,)) as pool:
        barrier.wait()  # every pool process has started
        start = time.perf_counter()
        together = sum(pool.map(count_primes, chunks, chunksize=1))
        parallel = time.perf_counter() - start
    print(f"\nThere are {primes:,} primes below {limit:,}.")
    print(f"One process: {alone:.2f} s, {workers} processes: {parallel:.2f} s")
    print(f"That is {alone / parallel:.1f}x as fast.")

    # 3. Another Python program, run as a subprocess.
    hello = "import sys; print('Hello from Python', sys.version.split()[0])"
    result = subprocess.run(
        [sys.executable, "-c", hello],
        capture_output=True,
        text=True,
    )
    print(f"\nThe subprocess said: {result.stdout.strip()}")
