"""Locks, events, semaphores, conditions, barriers and shared values."""
import ctypes
import multiprocessing as mp
import time

from _check import check, metric, report, timed


def add(counter, n):
    for _ in range(n):
        with counter.get_lock():
            counter.value += 1


def fill(arr, i):
    arr[i] = i * i


def hold_lock(lock, ready, release):
    with lock:
        ready.set()
        release.wait(10)


def set_later(event):
    time.sleep(0.2)
    event.set()


def limited(sem, current, peak):
    with sem:
        with current.get_lock():
            current.value += 1
            peak.value = max(peak.value, current.value)
        time.sleep(0.1)
        with current.get_lock():
            current.value -= 1


def notify_after(cond, flag):
    time.sleep(0.2)
    with cond:
        flag.value = 1
        cond.notify_all()


def at_barrier(barrier, order, i):
    barrier.wait(10)
    order[i] = 1


def floats(v, a):
    v.value = 2.5
    a[0] = 1.25


if __name__ == "__main__":
    counter = mp.Value("i", 0)
    ps = [mp.Process(target=add, args=(counter, 300)) for _ in range(4)]
    with timed() as t:
        for p in ps:
            p.start()
        for p in ps:
            p.join()
    check("Value + lock: 4 x 300 increments", counter.value == 1200, counter.value)
    metric("4 x 300 locked increments ms", t.ms)

    arr = mp.Array("i", 8)
    ps = [mp.Process(target=fill, args=(arr, i)) for i in range(8)]
    for p in ps:
        p.start()
    for p in ps:
        p.join()
    check("Array written by 8 children", arr[:] == [i * i for i in range(8)], arr[:])

    v = mp.Value(ctypes.c_double, 0.0)
    a = mp.RawArray("d", [0.0, 0.0])
    p = mp.Process(target=floats, args=(v, a))
    p.start()
    p.join()
    check("c_double Value and RawArray", v.value == 2.5 and a[0] == 1.25, (v.value, a[:]))

    lock, ready, release = mp.Lock(), mp.Event(), mp.Event()
    p = mp.Process(target=hold_lock, args=(lock, ready, release))
    p.start()
    ready.wait(10)
    with timed() as t:
        got = lock.acquire(timeout=0.3)
    check("Lock held elsewhere: acquire(timeout) fails", got is False and 250 < t.ms < 2000, (got, t.ms))
    release.set()
    check("Lock free after release", lock.acquire(timeout=10))
    lock.release()
    p.join()

    event = mp.Event()
    p = mp.Process(target=set_later, args=(event,))
    p.start()
    check("Event set by a child", event.wait(10))
    p.join()

    sem = mp.Semaphore(2)
    current, peak = mp.Value("i", 0), mp.Value("i", 0)
    ps = [mp.Process(target=limited, args=(sem, current, peak)) for _ in range(5)]
    for p in ps:
        p.start()
    for p in ps:
        p.join()
    check("Semaphore(2) caps concurrency", peak.value == 2, peak.value)

    cond, flag = mp.Condition(), mp.Value("i", 0)
    p = mp.Process(target=notify_after, args=(cond, flag))
    p.start()
    with cond:
        ok = cond.wait_for(lambda: flag.value == 1, timeout=10)
    p.join()
    check("Condition notified by a child", ok)

    barrier = mp.Barrier(3)
    order = mp.Array("i", 3)
    ps = [mp.Process(target=at_barrier, args=(barrier, order, i)) for i in range(2)]
    for p in ps:
        p.start()
    time.sleep(0.3)
    early = order[:]
    barrier.wait(10)
    for p in ps:
        p.join()
    check("Barrier(3) releases all three together", early == [0, 0, 0] and order[:2] == [1, 1], (early, order[:]))

    rlock = mp.RLock()
    with rlock:
        with rlock:
            check("RLock is recursive", True)
    bsem = mp.BoundedSemaphore(1)
    try:
        bsem.release()
        check("BoundedSemaphore over-release raises", False, "no error")
    except ValueError:
        check("BoundedSemaphore over-release raises", True)

    try:
        mp.Manager()
        check("Manager explains", False, "no error")
    except NotImplementedError as e:
        check("Manager explains", "threads" in str(e), e)
    report()
