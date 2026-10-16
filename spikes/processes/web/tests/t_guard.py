# Without the `if __name__ == "__main__":` guard: the child re-imports
# this file (as __mp_main__), reaches start() again and must fail with
# CPython's explanation instead of starting processes forever.
import multiprocessing as mp
import pickle

from _check import check, report


def work():
    pass


p = mp.Process(target=work)
p.start()  # in the child's re-import this raises RuntimeError
p.join()
check("unguarded start: child exits 1", p.exitcode == 1, p.exitcode)

try:
    mp.Process(target=lambda: None).start()
    check("lambda target: pickling error in the parent", False, "no error")
except (pickle.PicklingError, AttributeError, TypeError):
    check("lambda target: pickling error in the parent", True)
check("abandoned pid leaves nothing running", mp.active_children() == [], mp.active_children())
report()
