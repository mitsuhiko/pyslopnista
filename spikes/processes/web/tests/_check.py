"""Checks for the spike's test programs: each ends with one RESULT line."""
import json
import time
import traceback

_results = {}
_metrics = {}


def check(name, ok, detail=None):
    _results[name] = {"ok": bool(ok)} if ok else {"ok": False, "detail": repr(detail)[:500]}
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f": {detail!r}"[:300]))


def attempt(name, fn):
    """check() that fn() returns a true value; an exception is a failure."""
    try:
        value = fn()
    except BaseException as e:
        check(name, False, "".join(traceback.format_exception_only(e)).strip())
        return None
    check(name, value is not False and value is not None, value)
    return value


def metric(name, value):
    _metrics[name] = value
    print(f"metric {name} = {value}")


class timed:
    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.ms = round((time.perf_counter() - self.t0) * 1000, 1)


def report():
    print("RESULT " + json.dumps({"checks": _results, "metrics": _metrics}))
