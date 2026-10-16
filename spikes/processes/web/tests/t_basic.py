"""Process basics: start, join, exit codes, terminate, identity, sentinels."""
import multiprocessing as mp
import os
import sys
import time
from multiprocessing.connection import wait

from _check import attempt, check, report


def say(x):
    print(f"child {os.getpid()} says {x}")


def exit_with(code):
    sys.exit(code)


def boom():
    raise ValueError("boom")


def sleeper():
    time.sleep(60)


def info(conn):
    parent = mp.parent_process()
    conn.send((os.getpid(), os.getppid(), mp.current_process().name, parent.pid if parent else None,
               parent.is_alive() if parent else None))
    conn.close()


def grandparent(conn):
    # A child that starts its own child.
    a, b = mp.Pipe()
    p = mp.Process(target=info, args=(b,))
    p.start()
    b.close()
    conn.send(a.recv())
    p.join()
    conn.send(p.exitcode)


if __name__ == "__main__":
    check("start methods", mp.get_all_start_methods() == ["spawn"], mp.get_all_start_methods())
    check("start method", mp.get_start_method() == "spawn", mp.get_start_method())
    try:
        mp.get_context("fork")
        check("fork context refused", False, "no error")
    except ValueError as e:
        check("fork context refused", "spawn" in str(e), e)
    try:
        os.fork()
        check("os.fork refused", False, "no error")
    except OSError:
        check("os.fork refused", True)

    p = mp.Process(target=say, args=("hi",))
    p.start()
    p.join()
    check("exit 0", p.exitcode == 0, p.exitcode)
    check("pid is a child pid", p.pid != os.getpid() and p.pid > 0, p.pid)

    p = mp.Process(target=exit_with, args=(3,))
    p.start()
    p.join()
    check("sys.exit(3)", p.exitcode == 3, p.exitcode)

    p = mp.Process(target=boom)
    p.start()
    p.join()
    check("exception -> exit 1", p.exitcode == 1, p.exitcode)

    p = mp.Process(target=sleeper)
    p.start()
    p.join(0.3)
    check("join(timeout) while running", p.exitcode is None and p.is_alive(), (p.exitcode, p.is_alive()))
    p.terminate()
    p.join(5)
    check("terminate -> -SIGTERM", p.exitcode == -15, p.exitcode)
    check("not alive after terminate", not p.is_alive())

    p = mp.Process(target=sleeper)
    p.start()
    p.kill()
    p.join(5)
    check("kill -> -SIGKILL", p.exitcode == -9, p.exitcode)

    a, b = mp.Pipe()
    p = mp.Process(target=info, args=(b,), name="Worker-7")
    p.start()
    b.close()
    pid, ppid, name, parent, parent_alive = a.recv()
    p.join()
    check("child getpid", pid == p.pid, (pid, p.pid))
    check("child getppid", ppid == os.getpid(), (ppid, os.getpid()))
    check("child name", name == "Worker-7", name)
    check("parent_process()", parent == os.getpid() and parent_alive, (parent, parent_alive))

    a, b = mp.Pipe()
    p = mp.Process(target=grandparent, args=(b,))
    p.start()
    b.close()
    gpid, gppid, _, gparent, _ = a.recv()
    gcode = a.recv()
    p.join()
    check("grandchild", gppid == p.pid and gparent == p.pid and gcode == 0, (gppid, gparent, p.pid, gcode))

    ps = [mp.Process(target=time.sleep, args=(0.2 * i,)) for i in range(1, 4)]
    for q in ps:
        q.start()
    order = []
    pending = {q.sentinel: q for q in ps}
    while pending:
        for s in wait(list(pending), timeout=10):
            order.append(pending.pop(s).pid)
    check("connection.wait on sentinels, in exit order", order == [q.pid for q in ps], order)
    for q in ps:
        q.join()

    check("active_children empty", mp.active_children() == [], mp.active_children())
    check("cpu_count", mp.cpu_count() >= 1, mp.cpu_count())

    # A daemon left running is terminated when the program ends.
    d = mp.Process(target=sleeper, daemon=True)
    d.start()
    report()
