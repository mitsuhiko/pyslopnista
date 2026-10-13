# jspi-repro

2026-10-13 - iOS 27 simulator (Safari and our WKWebView), Node 25 (V8) as baseline.

**Question:** Why does Pyodide's `run_sync` (and its JSPI-based `time.sleep`)
hang in WebKit (Q11)? Is it a WebKit bug or a Pyodide bug?

## Answer

Neither, directly: **CPython's Emscripten build turns off its wasm call
trampoline on iOS, which puts a JavaScript frame on every C function-pointer
call.** WebKit then correctly refuses to suspend, and Pyodide loses the error.

1. `Python/emscripten_trampoline.c` (`getPyEMTrampolinePtr`) checks the user
   agent for `iPad|iPhone|iPod` (and iPadOS's `MacIntel` + touch points). On a
   match it returns 0, so every call CPython makes through a C function pointer
   goes through the JS fallback `_PyEM_TrampolineCall_JS`
   (`wasmTable.get(func)(...)`). This was added in gh-130418 (February 2025)
   because of WebKit bug 293113 (`ref.cast` failing in hot functions, device
   only), which was **fixed in June 2025** (295902@main, backported to a Safari
   branch).
2. Every Python → builtin call (e.g. `run_sync` itself) therefore crosses
   wasm → JS → wasm. WebKit's JSPI stack slicer (`EvacuatedStack.cpp`,
   `SlabSlicer`) sees a second `JSToWasm` frame before the `promising` frame
   and throws `SuspendError: JavaScript frames found between
   WebAssembly.Suspending and WebAssembly.promising`. That is correct per spec.
   V8 never hits this because desktop and Android user agents get the wasm-GC
   trampoline.
3. Pyodide doesn't surface that `SuspendError`. The suspending handler keeps
   running and the Python call never settles, so it looks like a hang.
4. Unrelated WebKit quirk found on the way: `new WebAssembly.Suspending(fn)`
   returns a callable function (`typeof` is `"function"`, not `instanceof
   WebAssembly.Suspending`). In V8 it is an object, as in the spec. It doesn't
   affect Pyodide.

**Workaround (works on the simulator):** hide the iOS UA in the Python worker
before `loadPyodide`:

```js
Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
```

CPython then installs the wasm-GC trampoline and JSPI works in WKWebView:
`run_sync()` on JS promises and host calls, `run_sync(asyncio.sleep())`,
`can_run_sync() == True`. All other spike checks still pass
(`spikes/pyodide-worker`, `QUERY="gc=1&jspi=1" ./run.sh --selftest`).

**Still to verify on a real device:** WebKit bug 293113 only reproduced on
devices, never in the simulator. Before relying on the wasm-GC trampoline,
run a heavy workload on an iOS 27 device with `gc=1`.

## Evidence

- `jspi.wat`, `jspi-eh.wat`, `jspi-table.wat`, `jspi-tier.wat`, `jspi-other.wat`
  with `web/tests.js`: minimal JSPI cases that mirror Pyodide's usage (Suspending
  with `(externref, externref) -> externref`, `promising` called with a leading
  `null`). They cover timers and microtasks, call_indirect, JS-filled and imported
  tables, cross-instance calls, deep recursion, loops of 1000 suspensions,
  concurrent tasks, re-entry, exceptions (exnref) across suspension, hot and OSR
  frames, and every instantiation path. **All pass in WebKit** (worker and main
  thread), identical to V8. The only failures are 20,000-frame recursion
  (stack limit, both engines) and Node lacking `fetch` for file URLs.
- `web/pyodide-debug.html` + `pyodide-debug-worker.js`: Pyodide in a worker
  with logging wrappers around `Suspending`/`promising`, stack capture at the
  suspension point, a heartbeat (spinning vs. never settled), import patching
  (`?patch=fake_state|capture_only|inspect`) and `?ua=mac`. Bisection:
  `promising(JsvPromise_Syncify)` alone works; `callPromising(run_sync)` fails;
  the frame between is `_PyEM_TrampolineCall` (wasm function 5209).

```sh
node node-run.mjs                    # V8 baseline
uv run server.py                     # then in the simulator:
xcrun simctl openurl booted "http://127.0.0.1:18767/?r=$RANDOM"
xcrun simctl openurl booted "http://127.0.0.1:18767/pyodide-debug.html?r=$RANDOM&cases=run_sync_resolved,time_sleep"
xcrun simctl openurl booted "http://127.0.0.1:18767/pyodide-debug.html?r=$RANDOM&ua=mac&cases=run_sync_resolved,run_sync_timer,time_sleep"
cat out/log.txt
```

## Upstream reports to file

- **CPython:** the iOS UA check in `Python/emscripten_trampoline.c` is stale
  (WebKit 293113 is fixed). It also disables JSPI for every Emscripten Python on
  iOS. Gate it on the WebKit version or a feature test instead.
- **Pyodide:** a `SuspendError` from the promising call is lost and the run
  hangs instead of raising. Also `can_run_sync()` returns True even though
  suspension can't work with the JS trampoline.
- **WebKit:** `new WebAssembly.Suspending(fn)` is callable and not
  `instanceof WebAssembly.Suspending` (spec deviation).
