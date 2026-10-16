"""Stop while the whole tree is blocked. Once every child is in place the
program prints "all started"; the harness then stops the run: SIGINT to
every process (KeyboardInterrupt), SIGKILL after 1.5 s. Each child blocks
differently; the summary counts how they ended."""
import multiprocessing as mp
import subprocess
import sys
import time


def in_recv(conn, ready):
    ready.release()
    conn.recv()


def in_queue_get(q, ready):
    ready.release()
    q.get()


def in_sleep(ready):
    ready.release()
    time.sleep(600)


def in_lock(lock, ready):
    lock.acquire()
    ready.release()
    lock.acquire()


def in_busy_loop(ready):
    ready.release()
    n = 0
    while True:
        n += 1


if __name__ == "__main__":
    ready = mp.Semaphore(0)
    a, b = mp.Pipe()
    q = mp.Queue()
    lock = mp.Lock()
    ps = [
        mp.Process(target=in_recv, args=(b, ready)),
        mp.Process(target=in_queue_get, args=(q, ready)),
        mp.Process(target=in_sleep, args=(ready,)),
        mp.Process(target=in_lock, args=(lock, ready)),
        mp.Process(target=in_busy_loop, args=(ready,)),
    ]
    for p in ps:
        p.start()
    sub = subprocess.Popen([sys.executable, "-c", "import time; print('ready', flush=True); time.sleep(600)"],
                           stdout=subprocess.PIPE, text=True)
    for _ in ps:
        ready.acquire()
    sub.stdout.readline()
    time.sleep(0.3)  # let them reach their blocking calls
    print("all started", flush=True)
    for p in ps:
        p.join()
