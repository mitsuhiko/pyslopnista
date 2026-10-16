"""A compiled package in the children: numpy arrays through a Pool."""
import multiprocessing as mp

from _check import check, metric, report, timed

try:
    import numpy as np
except ImportError:
    np = None


def stats(seed):
    rng = np.random.default_rng(seed)
    a = rng.standard_normal(200_000)
    return seed, float(a.mean()), a[:3]


if __name__ == "__main__":
    if np is None:
        check("numpy available", False, "numpy not installed (build/pkgs missing?)")
    else:
        with timed() as t:
            with mp.Pool(3) as pool:
                results = pool.map(stats, range(6))
        expected = [stats(s) for s in range(6)]
        check("numpy results match", all(r[0] == e[0] and abs(r[1] - e[1]) < 1e-12 and (r[2] == e[2]).all()
                                         for r, e in zip(results, expected)), results[:1])
        check("numpy arrays come back as arrays", isinstance(results[0][2], np.ndarray), type(results[0][2]))
        metric("Pool(3) with numpy, 6 tasks ms", t.ms)
    report()
