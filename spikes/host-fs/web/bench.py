"""File and SQLite workloads, timed on one mount (see worker.js).

Every function returns {"ms": ..., "calls": <host round trips>}.
"""

import importlib
import json
import os
import random
import sqlite3
import sys
import time

import hostfs

PAYLOAD = "x" * 200


def _timed(mount, f):
    hostfs.reset(mount)
    t0 = hostfs.now()
    extra = f()
    r = {"ms": round(hostfs.now() - t0, 2)}
    if mount != "/mem":
        r["calls"] = hostfs.calls(mount)
    if extra:
        r.update(extra)
    return r


def files(mount, tag):
    base = f"{mount}/{tag}"
    os.makedirs(f"{base}/small", exist_ok=True)
    out = {}

    with open(f"{base}/one.txt", "w") as f:
        f.write("hello")
    out["stat_x500"] = _timed(mount, lambda: [os.stat(f"{base}/one.txt") for _ in range(500)] and None)

    def small_write():
        for i in range(100):
            with open(f"{base}/small/f{i}.txt", "w") as f:
                f.write("y" * 1024)

    def small_read():
        for i in range(100):
            with open(f"{base}/small/f{i}.txt") as f:
                f.read()

    out["write_100_files_1k"] = _timed(mount, small_write)
    out["read_100_files_1k"] = _timed(mount, small_read)
    out["scandir_100"] = _timed(mount, lambda: [e.is_file() for e in os.scandir(f"{base}/small")] and None)
    out["walk"] = _timed(mount, lambda: sum(len(fs) for _, _, fs in os.walk(base)) and None)

    chunk = b"z" * 4096

    def big_write():
        with open(f"{base}/big.bin", "wb") as f:
            for _ in range(256):
                f.write(chunk)

    def big_read():
        with open(f"{base}/big.bin", "rb") as f:
            assert len(f.read()) == 1 << 20

    def big_read_chunks():
        with open(f"{base}/big.bin", "rb") as f:
            while f.read(4096):
                pass

    out["write_1mb_4k_chunks"] = _timed(mount, big_write)
    out["read_1mb"] = _timed(mount, big_read)
    out["read_1mb_4k_chunks"] = _timed(mount, big_read_chunks)

    with open(f"{base}/mod_{tag}.py", "w") as f:
        f.write("\n".join(f"def f{i}(x):\n    return x + {i}" for i in range(50)))

    def import_module():
        sys.path.insert(0, base)
        try:
            importlib.invalidate_caches()
            importlib.import_module(f"mod_{tag}")
        finally:
            sys.path.remove(base)

    out["import_sibling"] = _timed(mount, import_module)
    return out


CONFIGS = {
    "default": [],
    "exclusive": ["pragma locking_mode = exclusive"],
    "wal_exclusive": ["pragma locking_mode = exclusive", "pragma journal_mode = wal"],
}


def sqlite(mount, tag, config="default"):
    base = f"{mount}/{tag}"
    path = f"{base}/bench.db" if config == "default" else f"{base}/bench_{config}.db"
    pragmas = CONFIGS[config]

    def connect():
        db = sqlite3.connect(path)
        for p in pragmas:
            db.execute(p).fetchall()
        return db

    for suffix in ("", "-journal", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    out = {}

    def bulk():
        db = connect()
        db.execute("create table t (id integer primary key, name text, payload text)")
        db.executemany("insert into t (name, payload) values (?, ?)", ((f"n{i}", PAYLOAD) for i in range(10000)))
        db.commit()
        db.close()

    def autocommit():
        db = connect()
        for i in range(100):
            db.execute("insert into t (name, payload) values (?, ?)", (f"a{i}", PAYLOAD))
            db.commit()
        db.close()

    def query():
        db = connect()
        rnd = random.Random(1)
        for _ in range(1000):
            db.execute("select name, payload from t where id = ?", (rnd.randint(1, 10000),)).fetchone()
        n = db.execute("select count(*) from t").fetchone()[0]
        db.close()
        return {"rows": n}

    def full_scan():
        db = connect()
        n = db.execute("select count(*) from t where payload like '%y%'").fetchone()[0]
        db.close()
        return {"matches": n}

    def todo_saves():
        # The todo app: open, change one row, commit, close; 20 times.
        for i in range(20):
            db = connect()
            db.execute("update t set name = ? where id = ?", (f"todo{i}", i + 1))
            db.commit()
            db.close()

    out["bulk_insert_10k"] = _timed(mount, bulk)
    out["autocommit_100"] = _timed(mount, autocommit)
    out["point_queries_1000"] = _timed(mount, query)
    out["full_scan"] = _timed(mount, full_scan)
    out["todo_20_saves"] = _timed(mount, todo_saves)
    out["db_bytes"] = os.path.getsize(path)
    out["calls_by_op_last"] = json.loads(hostfs.by_op(mount)) if mount != "/mem" else None
    return out


def wal(mount, tag):
    """Does WAL work at all (it needs shared memory through mmap)?"""
    path = f"{mount}/{tag}/wal.db"
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    try:
        db = sqlite3.connect(path)
        mode = db.execute("pragma journal_mode=wal").fetchone()[0]
        db.execute("create table t (x)")
        db.executemany("insert into t values (?)", ((i,) for i in range(100)))
        db.commit()
        db.close()
        db = sqlite3.connect(path)
        n = db.execute("select count(*) from t").fetchone()[0]
        db.close()
        return {"journal_mode": mode, "rows": n}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


def run(mount, tag, which):
    os.makedirs(f"{mount}/{tag}", exist_ok=True)
    result = {}
    if "files" in which:
        result["files"] = files(mount, tag)
    for config in CONFIGS:
        if f"sqlite_{config}" in which:
            result[f"sqlite_{config}"] = sqlite(mount, tag, config)
    if "wal" in which:
        result["wal"] = wal(mount, tag)
    return json.dumps(result)


def crash_setup(mount, tag):
    """A committed table of 100 rows, then an uncommitted transaction big enough
    to spill pages into the database file. The caller kills the worker."""
    base = f"{mount}/{tag}"
    os.makedirs(base, exist_ok=True)
    path = f"{base}/crash.db"
    for suffix in ("", "-journal"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    db = sqlite3.connect(path)
    db.execute("create table t (id integer primary key, payload text)")
    db.executemany("insert into t (payload) values (?)", ((PAYLOAD,) for _ in range(100)))
    db.commit()
    db.execute("pragma cache_size = -64")  # 64 KB, so the transaction spills
    db.execute("begin")
    db.executemany("insert into t (payload) values (?)", (("w" * 1000,) for _ in range(5000)))
    db.execute("update t set payload = 'changed' where id <= 100")
    # No commit: the worker is killed with the transaction open.
    globals()["_keep"] = db
