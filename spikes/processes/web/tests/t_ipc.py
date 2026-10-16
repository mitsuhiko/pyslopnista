"""Pipes and queues between processes."""
import multiprocessing as mp
import os
import queue
import time

from _check import check, metric, report, timed


def echo(conn):
    while True:
        msg = conn.recv()
        if msg is None:
            break
        conn.send(msg)
    conn.close()


def big_sender(conn, n):
    data = os.urandom(16) + bytes(n)
    conn.send("ready")
    conn.send_bytes(data)
    conn.close()


def oneway(w):
    w.send({"from": os.getpid()})
    w.close()


def producer(q, n):
    for i in range(n):
        q.put(i)
    q.put(None)


def consumer(q, out):
    total = 0
    while True:
        item = q.get()
        if item is None:
            break
        total += len(item)
    out.put(total)


def joinable_worker(q):
    while True:
        item = q.get()
        q.task_done()
        if item is None:
            break


def results_then_exit(q, n):
    for i in range(n):
        q.put("x" * 1000)


def _raises(fn, exc):
    try:
        fn()
    except exc:
        return True
    return False


if __name__ == "__main__":
    a, b = mp.Pipe()
    p = mp.Process(target=echo, args=(b,))
    p.start()
    b.close()
    for msg in [1, "two", [3.0, {"four": (5,)}], b"six" * 1000]:
        a.send(msg)
        check(f"duplex echo {type(msg).__name__}", a.recv() == msg)
    with timed() as t:
        for i in range(200):
            a.send(i)
            a.recv()
    metric("pipe round trip ms", round(t.ms / 200, 3))
    a.send(None)
    p.join()
    check("echo exited", p.exitcode == 0, p.exitcode)
    check("EOF after the child exits", a.poll(1) and _raises(a.recv, EOFError))

    for size in (1 << 20, 5 << 20):
        a, b = mp.Pipe(duplex=False)
        p = mp.Process(target=big_sender, args=(b, size))
        p.start()
        b.close()
        a.recv()
        with timed() as t:
            data = a.recv_bytes()
        p.join()
        check(f"{size >> 20} MB through a pipe", len(data) == size + 16, len(data))
        metric(f"pipe {size >> 20} MB ms", t.ms)

    r, w = mp.Pipe(duplex=False)
    p = mp.Process(target=oneway, args=(w,))
    p.start()
    w.close()
    msg = r.recv()
    p.join()
    check("one-way pipe", msg == {"from": p.pid}, msg)

    q = mp.Queue()
    p = mp.Process(target=producer, args=(q, 2000))
    p.start()
    got = []
    with timed() as t:
        while (item := q.get()) is not None:
            got.append(item)
    p.join()
    check("queue: 2000 items in order", got == list(range(2000)), got[:10])
    metric("queue items per ms", round(2000 / t.ms, 1))

    # More than the pipe holds, put before anyone reads: CPython's feeder
    # thread buffers this; here put() keeps it and sends it while we wait.
    q = mp.Queue()
    out = mp.Queue()
    with timed() as t:
        for i in range(40):
            q.put("y" * 100_000)
    metric("40 x 100 KB put before a reader ms", t.ms)
    q.put(None)
    p = mp.Process(target=consumer, args=(q, out))
    p.start()
    total = out.get(timeout=60)
    p.join()
    check("queue: 4 MB put before the reader started", total == 4_000_000, total)

    q = mp.Queue()
    try:
        q.get(timeout=0.2)
        check("queue.Empty after a timeout", False, "no exception")
    except queue.Empty:
        check("queue.Empty after a timeout", True)
    q.put(1)
    q.put(2)
    check("qsize", q.qsize() == 2, q.qsize())
    check("get_nowait", q.get_nowait() == 1)

    bq = mp.Queue(maxsize=1)
    bq.put(1)
    try:
        bq.put(2, timeout=0.2)
        check("queue.Full", False, "no exception")
    except queue.Full:
        check("queue.Full", True)

    sq = mp.SimpleQueue()
    p = mp.Process(target=producer, args=(sq, 100))
    p.start()
    items = []
    while (item := sq.get()) is not None:
        items.append(item)
    p.join()
    check("SimpleQueue", items == list(range(100)), items[:5])

    jq = mp.JoinableQueue()
    workers = [mp.Process(target=joinable_worker, args=(jq,)) for _ in range(2)]
    for w_ in workers:
        w_.start()
    for i in range(50):
        jq.put(i)
    jq.join()
    check("JoinableQueue.join()", True)
    for w_ in workers:
        jq.put(None)
    for w_ in workers:
        w_.join()

    # The child's puts are sent before it exits (CPython joins the feeder).
    q = mp.Queue()
    p = mp.Process(target=results_then_exit, args=(q, 50))
    p.start()
    items = [q.get(timeout=30) for _ in range(50)]
    p.join()
    check("child's queued results arrive", len(items) == 50 and p.exitcode == 0, (len(items), p.exitcode))
    report()

