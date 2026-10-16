# xhr-wait

2026-10-16 - WKWebView on the iOS 27 simulator (iPhone 18 Pro Max). Not a
real device.

**Question (Q25):** Why is a worker's synchronous XHR to the app's scheme
handler (HostFS, D35) sometimes about a second slow? It showed up as a slow
Stop of programs with child processes (D47).

**Answer (so far):** WebKit sometimes delivers the response of a
synchronous XHR from a worker late.
- **How late:** about 1000 ms in the app, about 3000 ms in this spike's
  bare page. The scheme handler has answered within a millisecond by
  then.
- **What triggers it:** it follows `Atomics.wait` (a sleeping program) and
  never a busy loop.
- **Where:** in the app, about once or twice per program run, usually in
  its first seconds. In this spike only now and then (0-7 of 208 XHRs per
  run, none in some runs).
- **Not processes:** it isn't caused by processes, HostFS, the request
  method or the response.
- **The bridge is immune:** the page bridge (`host.call_sync`: postMessage,
  `WKScriptMessage`, Atomics) never stalled in the same programs.

## What it is

`./run.sh` builds a SwiftUI app with one WKWebView and no Pyodide.
- **The page** (`web/main.js`) runs each case in a fresh worker.
- **The worker** (`web/worker.js`) blocks the way a Python program does,
  then makes synchronous XHRs to `/__echo`.
- **Timing:** `/__echo` answers at once with `X-Handled-At`, so each XHR
  splits into request -> handler (`toHost`) and handler -> response back in
  the worker (`back`).

```sh
./run.sh                          # engine-like view (1×1, opacity 0.01, as the app's engine page)
VIEW=visible POLICY=none ./run.sh # full screen; inactiveSchedulingPolicy = .none (as the app)
VIEW=detached ./run.sh            # not in the window
CASES=focus HEARTBEAT=50 REPEAT=6 ./run.sh   # the stall-prone cases, a 50 ms timer on the page
node count.mjs build/*.json       # slow XHRs per case
node summarize.mjs build/x.json   # every case
```

Cases:
- **Waits:** one `Atomics.wait` of 0.1-5 s; 50 ms slices; a busy loop.
- **How the wait ends:** woken by a notify from the page; back to the
  event loop first (`setTimeout(0)`); an async `fetch` after the wait.
- **Repeats:** a sequence of waits in one worker.

## Results

This spike, slow XHRs (over 100 ms) of 208 per run (`REPEAT=4`), by how
the web view is hosted:

| view | inactiveSchedulingPolicy | slow | how slow |
|---|---|---|---|
| engine-like | .none | 0 | |
| engine-like | default | 7 | 3004-3006 ms, after waits of 2 s |
| visible | .none | 2 | 3003-3004 ms, after a 5 s wait |
| detached | .none | 4 | 3300-4438 ms; Atomics.wait and timers also overshoot by about 200 ms (a hidden page) |
| detached | default | 0 | |

With the focused cases (4 runs of 138 XHRs, with and without a 50 ms
heartbeat on the page) there were no stalls at all. It's too rare here to
test fixes.

In every stall, `toHost` was 1-2 ms and `back` was the whole delay: the
response arrived at the worker late. A `setTimeout(0)` in the same worker
was late too, so the whole worker waits, not only the XHR.

**In the app** it reproduces reliably. The tests were a temporary
self-test step, not committed. The program alternates `time.sleep(2)` with
one call.

| call after `time.sleep(2)` | slow / samples | how slow |
|---|---|---|
| HostFS `os.stat` (`POST /__fs`) | 6/30 (3 runs) | 1001-1008 ms, rounds 1-2 |
| page bridge `host.call_sync` | 0/30 | 0-3 ms |
| static `GET /runtime/…` | 1/20 | 1006 ms |
| `os.stat` after 12 s busy, then sleeps | 3/20 | 1001-1003 ms |

What didn't change it:
- `back` stayed 999-1002 ms with `toHost` 1-2 ms (`X-Handled-At` on
  `/__fs`), and the app's main thread had no gap over 100 ms.
- **Worker side:** the worker's own timer at 50 ms instead of 250 ms; a
  20 ms timer on the engine page; a no-op `postMessage` to the worker every
  50 ms.
- **The wait:** `host.sleep` waiting in 100 ms slices instead of one wait.
- **The request:** GET instead of POST; leaving out the empty
  `didReceive(Data())`.
- **Spares:** waiting until the spare workers had booted.

So the response isn't waiting in the worker's message queue (a message
would have woken it), and the app's main thread isn't busy. It is held in
WebKit between the scheme handler's answer and the worker. That is
probably the loader for the worker's synchronous request in the WebContent
process, but it can't be seen from outside.

## Next

- **A device:** try on a real device, with both this spike and the app
  (needs the phone).
- **Report it to WebKit** with this spike, next to Q13's reports.
- **Workarounds** (each changes D35):
  - HostFS over the bridge, which never stalled but costs about twice as
    much per call (`spikes/host-fs`), or only for metadata calls.
  - A helper worker that makes the requests asynchronously and hands the
    results back through a SharedArrayBuffer. That wait would be an
    `Atomics.wait`, not a synchronous XHR.
