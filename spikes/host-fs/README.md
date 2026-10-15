# host-fs

2026-10-15 - Pyodide 314.0.7 in a WKWebView, iOS 27 simulator (iPhone 18
Pro). Not a real device.

**Question:** Can Python in the Pyodide worker use the project's real files
on the host directly, instead of a copy in MEMFS that is written back
afterwards (D20, D27)? That would affect all file IO, and SQLite most of
all. Is it correct, and what does it cost?

**Outcome:** built into the app as D35 (the `bestr` setup, XHR only), with
linked folders running on a local copy.

**Answer:** Yes, it works, and SQLite's crash recovery works on it. The cost
is a host round trip per file operation (0.1-0.2 ms here; a device is
probably about 2x that, since `device-perf` measured 0.30 vs 0.11-0.22 ms for
a blocking call). Without caching, SQLite pays for that heavily (5-50x
slower than MEMFS). With an ordered write-behind queue, a stat cache, a block
read cache and `locking_mode = exclusive`, SQLite workloads are within a
few milliseconds of MEMFS. Many small files stay slow at about 0.5 ms each.

## What it is

`./run.sh` builds a small SwiftUI app (with `swiftc`, like `ios-host`) with
one WKWebView and runs the benchmark in a Pyodide worker. It prints JSON
(`results-iphone18pro-sim.json`); `summarize.py` turns that into tables.

```sh
./run.sh                          # all steps
./run.sh transport,python         # some: probe, transport, python, check, copy, crash
SIM=<udid> ./run.sh               # a specific simulator
python3 summarize.py results-iphone18pro-sim.json
```

- **`Sources/HostFS.swift`**: the project folder (`Documents/project`) as
  POSIX calls:
  - `lstat`, `fstat`, `readdir` (with each entry's stat), `open`/`close`
    (file descriptors kept in a table), `pread`/`pwrite`, `writev` (several
    writes, in order), `ftruncate`, `fsync`, `mkdir`, `unlink`, `rename`, …
  - Errors come back as errno names.
  - Paths may not leave the folder.
- **`web/hostfs.js`**: `HOSTFS`, an Emscripten file system modelled on
  Emscripten's `NODEFS`, mounted next to MEMFS. Each operation is a
  synchronous call to the host. Its options are the variants below.
- **Two transports**, both blocking the worker:
  - **xhr**: synchronous XHR to `POST app://app/__fs`, served by the
    `WKURLSchemeHandler`. Metadata goes in headers and bytes in the body, so
    there is no base64.
  - **bridge**: `Atomics.wait` while the page calls the `WKScriptMessage`
    bridge (the app's `host.call_sync` path, D10/D13). Bytes are base64:
    `Uint8Array`s and `ArrayBuffer`s arrive in Swift as dictionaries, not
    `Data`.
- **`web/bench.py`**: file and SQLite workloads, each timed with its number
  of host round trips (Python's clocks only tick in whole milliseconds in
  WebKit workers, so small numbers are rough).
- **Correctness checks**:
  - `check` opens every database the workloads wrote with the system SQLite
    (`integrity_check` and a row count).
  - `crash` kills the worker in the middle of an uncommitted transaction that
    spilled pages into the database file, then opens the file natively.

## Results (iPhone 18 Pro simulator; runs vary by about ±30%)

Raw round trip (ms per call):

| | xhr | bridge |
|---|---|---|
| empty call | 0.11-0.18 | 0.07-0.09 |
| `stat` | 0.13-0.20 | 0.09-0.14 |
| read / write 4 KB | 0.17-0.19 / 0.18-0.23 | 0.09-0.14 / 0.10-0.14 |
| read / write 64 KB | 0.15-0.19 / 0.22-0.28 | 0.25-0.31 / 0.24-0.28 |
| read / write 1 MB | 0.4-0.6 / 0.5-0.6 | 2.6-3.1 / 2.0-2.4 |
| read / write 4 MB | 1.4-1.5 / 1.5-1.9 | 9.5-12 / 7-8.7 |

The bridge wins for small calls and base64 makes it lose for big ones.

The variants, all mounted at once:

| Mount | What |
|---|---|
| mem | MEMFS: what a program sees today, once its folder is copied in |
| xhr | HOSTFS, one XHR per operation |
| bridge | HOSTFS, one bridge call per operation |
| cache | xhr, plus a stat cache (including missing files) that this worker's own changes keep up to date |
| buf | xhr, plus ordered write-behind: writes to any file queue up in the worker and go out in one `writev` before any other call, so the host still sees every operation in program order |
| best | bridge for calls under 32 KB and XHR above, write-behind and stat cache |
| bestr | best, plus a 64 KB block read cache (this worker's writes drop the blocks they touch) |

ms (host round trips), from `results-iphone18pro-sim.json`:

| Workload | mem | xhr | bridge | best | bestr |
|---|---|---|---|---|---|
| `os.stat` × 500 | 1 | 76 (500) | 70 (500) | 1 (0) | 1 (0) |
| write 100 files of 1 KB | 3 | 143 (700) | 97 (700) | 109 (600) | 66 (600) |
| read 100 files of 1 KB | 0 | 87 (500) | 54 (500) | 51 (400) | 34 (300) |
| `scandir` 100 entries / `os.walk` | 1 / 0 | 2 (1) / 2 (3) | 2 / 1 | 2 / 1 | 1 / 2 |
| write 1 MB in 4 KB chunks | 0 | 4 (14) | 11 (14) | 3 (6) | 1 (6) |
| read 1 MB whole / in 4 KB chunks | 0 / 0 | 1 (5) / 2 (12) | 3 / 4 | 1 / 2 | 3 (19) / 1 (2) |
| import a sibling module | 1 | 3 (12) | 3 (12) | 2 (7) | 2 (6) |

SQLite (a 2.3 MB database, 10,100 rows):

| Workload | mem | xhr | bridge | best | bestr |
|---|---|---|---|---|---|
| **default journal mode, normal locking** | | | | | |
| insert 10,000 rows, one transaction | 6 | 191 (617) | 78 (617) | 11 (28) | 9 (27) |
| 100 single-row commits | 5 | 611 (2424) | 281 (2424) | 149 (1008) | 139 (1005) |
| 1,000 point queries | 24 | 1001 (4707) | 472 (4707) | 211 (1694) | 28 (40) |
| full scan | 2 | 111 (581) | 58 (581) | 67 (566) | 2 (2) |
| 20 × open, update a row, commit, close (the todo app) | 3 | 185 (875) | 90 (875) | 48 (361) | 40 (258) |
| **`locking_mode = exclusive`** | | | | | |
| 100 single-row commits | 0 | 254 (858) | 76 (858) | 29 (216) | 37 (214) |
| 1,000 point queries | 2 | 141 (703) | 71 (703) | 82 (693) | 8 (40) |
| 20 × todo save | 2 | 185 (835) | 88 (835) | 42 (361) | 43 (278) |
| **exclusive + WAL** | | | | | |
| insert 10,000 rows | 7 | 531 (2276) | 230 (2276) | 132 (1140) | 25 (98) |
| 100 single-row commits | 0 | 67 (270) | 27 (270) | 6 (36) | 6 (29) |
| 1,000 point queries | 2 | 306 (1715) | 157 (1715) | 76 (700) | 11 (46) |

What the numbers say:
- **Every file operation is a round trip.** Opening, writing and closing a
  small file is about 6 calls (lookup, create, open, fstat, write, close).
  With caching that's 0.5-0.7 ms per file on the simulator, against
  microseconds in MEMFS.
- **Plain SQLite is chatty:** about 24 calls per autocommit transaction,
  and 4-5 per point query in normal locking mode (it checks the file and the
  journal before every read transaction).
  - `locking_mode = exclusive` cuts point queries from 4.7 to 0.7 calls.
    Emscripten's locks are no-ops anyway (`fcntl` `F_SETLK` returns 0
    without reaching the file system), so normal mode protects nothing here.
  - WAL with exclusive locking makes commits cheap (6 ms for 100 commits).
- **Caching closes most of the gap:**
  - Write-behind turns a bulk insert from about 600 calls into about 30.
  - The block cache turns reads into almost nothing after the first pass.
  - With `bestr`, a todo-style save costs about 2 ms and a commit 0.06-0.4 ms.
- **What a host-backed FS saves:**
  - Today a run copies its whole folder into the interpreter (memory, plus
    the copy time) and writes changed files back whole. Copying the 2.3 MB
    database in or out costs 2-3 ms over XHR and 5-9 ms over the bridge,
    for every write-back of that database (D27).
  - With HOSTFS nothing is copied. Only changed pages reach the disk.
  - The D27 machinery (manifest, idle timer, journal-first ordering) goes
    away.

Correctness:
- **`check`:** every database the workloads wrote opens natively with
  `integrity_check = ok` and the expected 10,100 rows.
- **`crash`:** in xhr, cache, buf, best and bestr, the killed transaction
  leaves `crash.db-journal` on disk. The native open rolls it back: 100 rows,
  `ok`, journal gone. A killed program is a crash, and SQLite handles it.
- **Write-behind needs one queue for all files.** The first version
  buffered each file separately and flushed a file before reading it. A
  database page could then reach the disk before the journal entry that
  protects it, and the crash test came back with 103 rows and a journal
  SQLite no longer treated as hot. A single queue that is flushed before any
  other call keeps the program's order, and passes.
- **WAL works** on every mount (`journal_mode = wal`, data readable after
  reopening). It is only safe with exclusive locking, because HOSTFS's
  `mmap` is a copy, like NODEFS's: WAL's shared-memory index then lives in
  the heap.

## Caveats and open points

- **Caches assume the worker owns the files during a run.** Edits from the
  editor, the Files app or iCloud don't reach the stat and block caches. To
  fix that, the host could bump a generation number on every outside change
  and send it with each reply, and the caches could expire after a second
  (like NFS's attribute cache). Not built.
- **No real file locks:** Emscripten answers `F_SETLK` itself. Two
  interpreters (or native code) writing the same database could corrupt it.
  The host does hold real file descriptors, so locks could be forwarded, but
  that would need a change to Emscripten's `fcntl` (it's in Pyodide's build).
- **Both transports go through the main thread of the app process**: the
  scheme handler's callbacks and the script message handler run there. A
  busy SwiftUI main thread (a ui app animating, scrolling) adds latency.
  Not measured.
- **Linked folders (D28)** read and write through `NSFileCoordinator`. Doing
  that for every call would be much slower; coordinating once per file open
  might do. Not measured.
- **The block cache has no size limit** in the spike, and a whole-file read
  goes through 64 KB blocks (19 calls instead of 5). Large reads should skip
  the cache.
- **Device numbers are missing.** Run it on the iPhone 14 Pro before
  deciding.
