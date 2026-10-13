"""Debugger overhead benchmark. Standalone: runs in the app (writes
debug-bench.json next to itself) and is also exec'd by probe.py."""

import bdb
import json
import linecache
import sys
import time

results = {}

# A: capabilities -----------------------------------------------------------

results["version"] = sys.version.split()[0]
results["has_sys_monitoring"] = hasattr(sys, "monitoring")
try:
    bdb.Bdb(backend="monitoring")
    results["bdb_monitoring_backend"] = True
except TypeError as e:
    results["bdb_monitoring_backend"] = str(e)

# B: overhead ---------------------------------------------------------------

USER_FILE = "<user>"
USER_SRC = """\
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)

def loop(n):
    total = 0
    for i in range(n):
        total += i % 7
    return total

def never_called():
    return 1

def work():
    fib(20)
    loop(200_000)
    return sorted(str(i) for i in range(50_000))[-1]
"""
NEVER_HIT_LINE = 11  # body of never_called(): debuggers stay armed but never stop
linecache.cache[USER_FILE] = (len(USER_SRC), None, USER_SRC.splitlines(True), USER_FILE)
ns = {}
exec(compile(USER_SRC, USER_FILE, "exec"), ns)
work = ns["work"]


def timed(fn, repeat=3):
    best = float("inf")
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return round(best * 1000, 1)


class QuietBdb(bdb.Bdb):
    def user_line(self, frame):
        self.set_continue()  # first stop happens on entry; then run to a breakpoint


def with_bdb(backend):
    def run():
        dbg = QuietBdb(backend=backend)
        dbg.set_break(USER_FILE, NEVER_HIT_LINE)
        try:
            dbg.runcall(work)
        finally:
            dbg.clear_all_breaks()

    return run


def settrace_minimal():
    """The cheapest possible settrace debugger: line events only in user code."""

    def local(frame, event, arg):
        if event == "line" and frame.f_lineno == NEVER_HIT_LINE:
            pass
        return local

    def global_(frame, event, arg):
        return local if frame.f_code.co_filename == USER_FILE else None

    sys.settrace(global_)
    try:
        work()
    finally:
        sys.settrace(None)


def monitoring_minimal():
    """sys.monitoring: LINE events, disabled per location unless it is a breakpoint."""
    mon = sys.monitoring
    tool = mon.DEBUGGER_ID
    mon.use_tool_id(tool, "probe")
    breakpoints = {(USER_FILE, NEVER_HIT_LINE)}

    def on_line(code, line):
        if (code.co_filename, line) in breakpoints:
            return None
        return mon.DISABLE

    mon.register_callback(tool, mon.events.LINE, on_line)
    mon.set_events(tool, mon.events.LINE)
    try:
        work()
    finally:
        mon.set_events(tool, 0)
        mon.register_callback(tool, mon.events.LINE, None)
        mon.free_tool_id(tool)
        mon.restart_events()


bench = {"baseline": timed(work)}
bench["settrace_minimal"] = timed(settrace_minimal)
bench["monitoring_minimal"] = timed(monitoring_minimal)
for backend in ("settrace", "monitoring"):
    try:
        bench[f"bdb_{backend}"] = timed(with_bdb(backend))
    except Exception as e:  # noqa: BLE001
        bench[f"bdb_{backend}"] = f"error: {e!r}"
results["bench_ms"] = bench

print(json.dumps(results, indent=2))
if __name__ == "__main__" and sys.platform == "emscripten":
    try:
        with open("debug-bench.json", "w") as f:
            json.dump(results, f, indent=2)
    except OSError:
        pass
