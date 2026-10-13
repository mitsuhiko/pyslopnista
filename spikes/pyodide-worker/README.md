# pyodide-worker

2026-10-13 - Pyodide 314.0.7 (CPython 3.14.2, Emscripten 5.0.3, ABI `2026_0`) in
WKWebView, iOS 27 simulator (iPhone 17). Not a real device.

**Question:** Can Pyodide in a worker inside our app give us a usable run loop:
output, `input()`, Stop, restart, packages from an offline cache, blocking calls
to Swift?

## What it is

- `Sources/`: the `ios-host` app plus a `/pkgs/<file>` route in the scheme
  handler. The route serves wheels from `Application Support/pyodide-packages/<version>/`,
  downloading them from the jsDelivr Pyodide CDN on a miss. Bridge ops: `echo`,
  `haptic`, `log`, `result`.
- `web/sab-polyfill.js`: the SharedArrayBuffer polyfill (D9).
- `web/py-worker.js`: one Pyodide per module worker.
  - stdout/stderr are streamed.
  - stdin and `host.call_sync` block the worker with `Atomics.wait` on a
    SharedArrayBuffer channel.
  - `time.sleep` is replaced with `Atomics.wait` on the interrupt buffer.
  - JSPI is hidden from Pyodide (see Findings).
- `web/runtime.js`: `PyWorker` (run, stop with escalation to kill, terminate)
  and `WorkerPool` (one booted worker kept in reserve).
- `web/app.js`, `index.html`: a minimal editor/console UI for trying it by hand.
- `web/selftest.js`: scripted checks. Each step runs in a fresh worker from the pool.
- `web/jspi.html`: minimal reproduction of the WebKit JSPI hang (main thread).
- `dev-server.py`: serves the same page to a plain browser (for Safari) with the
  same endpoints.

```sh
./run.sh                          # build, install, launch the UI
./run.sh --selftest               # run all checks, print JSON
./run.sh --selftest sleep,stdin   # run selected steps
QUERY="gc=1&jspi=1" ./run.sh --selftest   # wasm-gc trampoline + JSPI (D13)
uv run dev-server.py              # then open http://127.0.0.1:18766/#selftest
```

`run.sh` downloads the Pyodide core from npm into `vendor/` (gitignored). The core
is 13 MB: wasm 9.6 MB, stdlib zip 2.5 MB.

## Results (simulator)

| Check | Result |
|---|---|
| Worker boot (`loadPyodide`) | about 770 ms; taking a warm worker from the pool takes 0 ms |
| `print`/stdout streaming | Works |
| `input()` (two prompts, 50 ms simulated typing each) | 108 ms |
| Stop during a busy loop | `KeyboardInterrupt` 7 ms after stop |
| Stop during `input()` or `time.sleep(60)` | `KeyboardInterrupt` right away |
| Code that swallows `KeyboardInterrupt` | Worker killed 1.5 s after Stop; the next run gets a fresh worker |
| `time.sleep(0.5)` | 0.505 s, no CPU use |
| Top-level `await`, `await asyncio.sleep()` | Work (Pyodide's event loop) |
| Blocking Python → Swift call (`host.call_sync`) | 0.14 ms per round trip |
| `import numpy` (from the native cache) | load 160 ms; first download from the CDN about 400 ms |
| matplotlib + 11 dependencies, render a PNG | load 570 ms, run 2.1 s |
| `micropip.install(['cowsay', 'humanize'])` from PyPI | 0.69 s (cross-origin fetch from `app://` works) |
| `bytearray(1 GB)` | Works |

Speed against native CPython 3.14.6 (GIL build) on the same Mac, in seconds:

| | fib(30) | sum of squares 10M | dict 2M | json 300k | regex |
|---|---|---|---|---|---|
| Native | 0.037 | 0.27 | 0.34 | 0.13 | 0.016 |
| Pyodide in WKWebView | 0.095 | 0.79-0.88 | 0.47-0.50 | 0.28 | 0.036 |
| Slowdown | 2.6x | 3x | 1.4x | 2.1x | 2.3x |

## Findings

1. **JSPI "hangs" Pyodide on iOS, but not because of WebKit.** CPython's
   Emscripten build uses a JavaScript call trampoline when the user agent says
   iOS. That puts JS frames on every C function-pointer call, so WebKit refuses
   to suspend, and Pyodide loses the error. Root cause and workaround are in
   `spikes/jspi-repro/`. With `?gc=1&jspi=1` (hide the iOS UA, keep JSPI
   enabled), `run_sync`, `run_sync(asyncio.sleep())` and `can_run_sync()` work.
   The default (no query) hides JSPI instead and blocks only through Atomics.
2. **Pyodide's stdin must use `autoEOF: true`** (the default). With `false`,
   Pyodide calls the handler again and again to fill its read buffer, about
   1,300 round trips for one line.
3. **Stop must re-assert the interrupt and escalate.** If Stop arrives before
   the run actually starts, the interrupt is lost. Stop now re-sets the
   interrupt buffer every 50 ms and kills the worker after 1.5 s.
4. **`packageBaseUrl` must be an absolute URL** (`new URL("/pkgs/", location.href)`).
5. Pyodide's import scanner prefers its own repository over PyPI (`rich` came
   from Pyodide, not PyPI). micropip goes to PyPI only for packages Pyodide
   doesn't have.

## Not covered yet

- Real-device numbers (boot time, memory ceiling, JIT behaviour) (Q5).
- Packages installed from PyPI by micropip don't go through the native cache
  yet, so they aren't guaranteed offline. Route PyPI through the native host
  (e.g. an `app://app/pypi/` index proxy).
- A crash of the WebContent process (the host reloads, but this isn't tested).
- Whether WebKit's JSPI works on a real device, and filing a WebKit bug.
