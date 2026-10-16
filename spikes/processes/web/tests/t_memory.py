"""Memory: 0, 1, 2, 4 and 8 idle child processes, each phase held for 2 s
and marked with its time ("phase N at" metrics), so the runner can read
the WebContent RSS (simulator) per phase."""
import multiprocessing as mp
import time

from _check import check, metric, report


def idle(ready, done):
    ready.release()
    done.wait(120)


def phase(n):
    time.sleep(0.5)  # settle
    metric(f"phase {n} at", round(time.time() * 1000))
    time.sleep(2)


if __name__ == "__main__":
    ready, done = mp.Semaphore(0), mp.Event()
    ps = []
    phase(0)
    for target in (1, 2, 4, 8):
        while len(ps) < target:
            p = mp.Process(target=idle, args=(ready, done))
            p.start()
            ps.append(p)
            ready.acquire(timeout=120)
        phase(target)
    done.set()
    for p in ps:
        p.join()
    check("8 idle processes", all(p.exitcode == 0 for p in ps), [p.exitcode for p in ps])
    report()
