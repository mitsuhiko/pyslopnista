"""Debugger feasibility probes, run inside Pyodide by node-run.mjs.

The host module `dbghost` is provided by the runner:
  dbghost.wait_command() -> str   blocks (Atomics.wait) until the page sends a command
  dbghost.report(str)             posts an event to the page
"""

import bdb
import json
import linecache
import signal
import sys
import time

import dbghost

results = {}


def report(kind, **data):
    dbghost.report(json.dumps({"kind": kind, **data}))


# A + B: capabilities and overhead (bench.py, shared with the in-app run) ---

exec(dbghost.read_file("bench.py"), bench_ns := {"__name__": "bench"})
results.update(bench_ns["results"])
results["sigusr1"] = int(getattr(signal, "SIGUSR1", 0))

# C: pause a running program with a signal written into the interrupt buffer -

paused = {}


def on_pause(signum, frame):
    paused["line"] = frame.f_lineno
    paused["func"] = frame.f_code.co_name
    paused["locals"] = sorted(k for k in frame.f_locals if not k.startswith("__"))


signal.signal(signal.SIGUSR1, on_pause)


def busy():
    i = 0
    deadline = time.perf_counter() + 2.0
    while not paused and time.perf_counter() < deadline:
        i += 1
    return i


report("ready-for-pause")
busy()
results["signal_pause"] = paused or "no signal delivered within 2s"

# D: stop at a breakpoint, block, let the page inspect, then continue ---------

STEP_SRC = """\
def greet(name):
    message = f"Hello {name}"
    return message

for who in ["Ada", "Guido"]:
    print(greet(who))
"""


class PageDebugger(bdb.Bdb):
    """Each stop blocks in wait_command() until the page says how to go on."""

    def __init__(self):
        super().__init__(backend="monitoring")
        self.trace = []
        self.started = False

    def interact(self, frame):
        report("stopped", line=frame.f_lineno, func=frame.f_code.co_name)
        while True:
            cmd = json.loads(dbghost.wait_command())
            if cmd["op"] == "eval":
                try:
                    value = repr(eval(cmd["expr"], frame.f_globals, frame.f_locals))
                except Exception as e:  # noqa: BLE001
                    value = f"{type(e).__name__}: {e}"
                report("value", expr=cmd["expr"], value=value)
            elif cmd["op"] == "step":
                return self.set_step()
            elif cmd["op"] == "next":
                return self.set_next(frame)
            elif cmd["op"] == "continue":
                return self.set_continue()

    def user_line(self, frame):
        if not self.started:  # bdb.run() starts by stepping; an IDE runs to a breakpoint
            self.started = True
            return self.set_continue()
        if frame.f_code.co_filename in ("<step>", "probe.py"):
            self.trace.append(frame.f_lineno)
            self.interact(frame)


dbg = PageDebugger()
linecache.cache["<step>"] = (len(STEP_SRC), None, STEP_SRC.splitlines(True), "<step>")
dbg.set_break("<step>", 2)
dbg.run(compile(STEP_SRC, "<step>", "exec"), {})
results["stepping_lines"] = dbg.trace

# E: Pause button -> debugger stops on the next line of the running code ------

pause_dbg = PageDebugger()
pause_dbg.started = True  # set_trace() should stop right away


def on_pause_debug(signum, frame):
    pause_dbg.set_trace(frame)


signal.signal(signal.SIGUSR1, on_pause_debug)


def spin():
    i = 0
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < 1.0:
        i += 1
    return i


report("ready-for-pause")
t0 = time.perf_counter()
spin()
results["pause_into_debugger"] = {"stops": pause_dbg.trace, "spin_ms": round((time.perf_counter() - t0) * 1000)}

report("results", **results)
