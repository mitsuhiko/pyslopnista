"""Pool and ProcessPoolExecutor."""
import concurrent.futures as cf
import multiprocessing as mp
import os
import time

from _check import attempt, check, report, timed

_init_value = None


def square(x):
    return x * x


def add(a, b):
    return a + b


def whoami(_):
    return os.getpid()


def slow_whoami(_):
    time.sleep(0.05)
    return os.getpid()


_barrier = None


def init_barrier(barrier):
    global _barrier
    _barrier = barrier


def all_up(_):
    _barrier.wait(120)


def fail(x):
    if x == 3:
        raise ZeroDivisionError(f"bad {x}")
    return x


def init(value):
    global _init_value
    _init_value = value


def get_init(_):
    return _init_value


if __name__ == "__main__":
    with mp.Pool(4) as pool:
        check("map", pool.map(square, range(100)) == [x * x for x in range(100)])
        check("map chunksize=7", pool.map(square, range(50), chunksize=7) == [x * x for x in range(50)])
        check("imap", list(pool.imap(square, range(20))) == [x * x for x in range(20)])
        check("imap chunksize=3", list(pool.imap(square, iter(range(20)), 3)) == [x * x for x in range(20)])
        check("imap_unordered", sorted(pool.imap_unordered(square, range(20))) == [x * x for x in range(20)])
        check("starmap", pool.starmap(add, [(1, 2), (3, 4)]) == [3, 7])
        check("apply", pool.apply(add, (2, 3)) == 5)
        seen = []
        r = pool.apply_async(square, (9,), callback=seen.append)
        check("apply_async + callback", r.get(10) == 81 and seen == [81], seen)
        r = pool.map_async(square, range(10))
        r.wait(10)
        check("map_async ready", r.ready() and r.successful())
        check("empty map", pool.map(square, []) == [])

    with mp.Pool(4, initializer=init_barrier, initargs=(mp.Barrier(4),)) as pool:
        pool.map(all_up, range(4), chunksize=1)  # all four running
        pids = set(pool.map(slow_whoami, range(40), chunksize=1))
        check("work spread over workers", len(pids) == 4, len(pids))

    with mp.Pool(4) as pool:
        try:
            pool.map(fail, range(6))
            check("map raises the worker's exception", False, "no error")
        except ZeroDivisionError as e:
            check("map raises the worker's exception", "bad 3" in str(e), e)
            check("remote traceback attached", "Traceback" in str(e.__cause__), e.__cause__)
        errors = []
        r = pool.apply_async(fail, (3,), error_callback=errors.append)
        r.wait(10)
        check("error_callback", len(errors) == 1 and not r.successful(), errors)

    with mp.Pool(2, maxtasksperchild=2) as pool:
        pids = set(pool.map(whoami, range(12), chunksize=1))
        check("maxtasksperchild replaces workers", len(pids) >= 6, len(pids))

    with mp.Pool(2, initializer=init, initargs=("ready",)) as pool:
        check("initializer", set(pool.map(get_init, range(4))) == {"ready"})

    pool = mp.Pool(2)
    results = [pool.apply_async(square, (i,)) for i in range(10)]
    pool.close()
    pool.join()
    check("close + join finishes queued work", [r.get(0) for r in results] == [i * i for i in range(10)])

    with cf.ProcessPoolExecutor(max_workers=3) as ex:
        check("executor.map", list(ex.map(square, range(20))) == [x * x for x in range(20)])
        futures = [ex.submit(square, i) for i in range(10)]
        done = sorted(f.result() for f in cf.as_completed(futures, timeout=30))
        check("submit + as_completed", done == sorted(i * i for i in range(10)), done)
        d, nd = cf.wait([ex.submit(square, 5)], timeout=30)
        check("wait", len(d) == 1 and not nd)
        f = ex.submit(fail, 3)
        check("future.exception()", isinstance(f.exception(30), ZeroDivisionError), f.exception())
        calls = []
        f = ex.submit(square, 4)
        f.add_done_callback(lambda fut: calls.append(fut.result()))
        f.result(30)
        check("add_done_callback", calls == [16], calls)
    check("executor shut down", True)
    check("no children left", mp.active_children() == [], mp.active_children())
    report()
