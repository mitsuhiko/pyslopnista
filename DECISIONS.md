# Decisions

Append-only. Never rewrite a decision: add a new one that supersedes it and mark
the old one `Superseded by D<n>`.

## D1: Product scope: learn, build, publish, with an agent

2026-10-13 · Accepted

The app exists so people can learn Python, build apps with it, and publish them.
A coding agent based on pi-durable ships with it. Every other decision follows
from these three goals.

## D2: Python runs on Pyodide (CPython compiled to wasm) inside WebKit

2026-10-13 · Accepted

Do not embed native CPython (`Python.xcframework`).

Why:
- iOS forbids loading native code at runtime. Native CPython can only use
  compiled packages that were signed into the app bundle at build time.
- Pyodide loads compiled extensions (wasm side modules) at runtime, so
  numpy, pandas and similar packages can be installed on demand.
- WebKit is the only place on iOS where JIT is allowed, and its WebContent
  process gives us crash and memory isolation for free.
- The same runtime runs in any browser, which makes publishing possible (D5).

Costs we accept: no threads (pthreads build pending), no raw sockets (needs a
shim), a filesystem bridge, startup and speed costs of wasm, WebKit suspending
work in the background, and Python versions lagging behind CPython releases.

Evidence: `spikes/webkit-probe/` (iOS 27 Safari, simulator).

## D3: Rejected: native CPython with wasm extension modules

2026-10-13 · Rejected

Idea: run the interpreter natively and run extension modules as wasm inside
WebKit, with calls passed between the two.

Rejected because the CPython C API needs the extension and the interpreter in
one address space: extensions read object fields and buffers directly through
raw pointers and macros. Separating them needs a cpyext-style proxy layer (as in
PyPy) plus a process round trip for every C API call, which is orders of
magnitude too slow. Running a wasm interpreter inside the app process instead
is too slow without JIT.

## D4: Web stack for the whole app; Swift is only a thin host

2026-10-13 · Accepted

The IDE, the agent and the runtime are a TypeScript web app inside a WKWebView.
The Swift host only provides:
- `app://` file serving (with the COOP/COEP isolation headers)
- a package cache
- a network proxy (no CORS problems)
- the native bridge: Keychain, files, SQLite, share sheet, App Intents, OAuth

Why: one codebase for iOS and the browser, reuse of pi-durable/pi-mobile
(TypeScript, React), and published apps that match what runs in the IDE.

## D5: Publishing means static web apps

2026-10-13 · Accepted

A published project is static files: the user's code, a pinned Pyodide version
and its packages. It is hosted at a URL and installable as a PWA. Published
apps use only web capabilities. The native bridge is a bonus for the user's own
code inside our app; this keeps the App Store risk under guideline 4.7 low.

Consequence: device APIs exposed to Python have two implementations, the
native bridge and browser APIs (or graceful degradation).

## D6: Python runs in Web Workers, one interpreter per run

2026-10-13 · Accepted

Each run gets its own worker (from a warm pool). Reset means `worker.terminate()`.
Interrupts use Pyodide's interrupt buffer (a SharedArrayBuffer). Blocking-style
calls use JSPI, or Atomics on a SharedArrayBuffer as the fallback.

## D7: The agent is pi-durable running in the web app

2026-10-13 · Accepted

- `ExecutionEnv.FileSystem` is implemented over the project filesystem.
- `Shell` is replaced by `python` and `pip` tools that run in Pyodide workers.
- Storage goes through the `SqliteDatabase` adapter: native SQLite through the
  bridge on iOS, SQLite compiled to wasm on OPFS in the browser.
- Provider HTTP goes through the native host on iOS.

Moving the agent loop to the cloud (Durable Objects) stays open (see Q4).

## D8: The pi-durable agent is built last

2026-10-13 · Accepted

The coding agent is the last phase in every plan. It is built on top of the
runtime, project files, packages, UI toolkit and publishing, and only after
those are validated on a device. Its tools (`python`, `pip`, the filesystem)
wrap features that must already work for people writing code by hand.

## D9: Serve the web app from `app://` and polyfill `SharedArrayBuffer`

2026-10-13 - Accepted

A `WKURLSchemeHandler` serves the app's web files from `app://app/` with the
COOP/COEP/CORP isolation headers. On the simulator this gives a secure,
cross-origin-isolated context with JSPI and shared wasm memory. WKWebView hides
the global `SharedArrayBuffer` constructor, but the one from shared wasm memory
works, so the page and every worker install it as a polyfill before any
Pyodide code runs. Evidence: `spikes/ios-host/`.

## D10: Blocking Python uses Atomics, not JSPI

2026-10-13 - Superseded by D13

WebKit exposes JSPI, but Pyodide's `run_sync` (and therefore its JSPI-based
`time.sleep`) hangs in it. Workers hide `WebAssembly.Suspending` and
`WebAssembly.promising` before `loadPyodide`. Everything that has to look
blocking to Python goes through a SharedArrayBuffer channel with
`Atomics.wait`: `input()`, synchronous host/device calls (`host.call_sync`,
about 0.14 ms per round trip on the simulator) and `time.sleep` (which waits on
the interrupt buffer, so Stop wakes it). Async code can still use `await`.
Revisit when WebKit's JSPI works with Pyodide. Evidence:
`spikes/pyodide-worker/`.

## D11: Stop escalates from KeyboardInterrupt to killing the worker

2026-10-13 - Accepted

Stop sets Pyodide's interrupt buffer, re-asserts it every 50 ms, and wakes any
blocked stdin, sleep or host call. If the run hasn't ended after 1.5 s, the
worker is terminated and the next run takes a fresh one from the pool.

## D12: Packages go through a native, on-disk cache

2026-10-13 - Accepted

Pyodide's `packageBaseUrl` points at `app://app/pkgs/`. The Swift scheme
handler serves wheels from Application Support and downloads misses from the
CDN of the pinned Pyodide version. PyPI installs (micropip) should be routed
through the same mechanism (not done yet).

## D13: Use the wasm-GC call trampoline and enable JSPI; keep Atomics for our own blocking calls

2026-10-13 - Accepted (device check passed on iPhone 14 Pro / iOS 27, `spikes/device-perf/`)

The JSPI "hang" was not a WebKit bug. CPython's Emscripten build sniffs the
iOS user agent and falls back to a JavaScript call trampoline (gh-130418, for
WebKit bug 293113, which was fixed in 2025). That puts a JS frame on every C
function-pointer call, so suspension is impossible. Pyodide then loses the
resulting `SuspendError` and hangs.

The Python worker hides the iOS user agent before `loadPyodide`, which selects
the wasm-GC trampoline. JSPI then works in WKWebView: `run_sync`,
`run_sync(asyncio.sleep())`, `can_run_sync() == True`. So:
- the worker keeps JSPI enabled (no more deleting `WebAssembly.Suspending`);
- stdin, synchronous host calls and `time.sleep` stay on the Atomics channel
  (D10's mechanism), because it is interruptible and doesn't depend on JSPI;
- if the device check (Q12) fails, fall back to D10 (JS trampoline, JSPI hidden).

Evidence: `spikes/jspi-repro/`.

## D14: User UI is a declarative Python tree rendered by a JS renderer

2026-10-13 - Accepted (was P2)

Python apps describe their UI with `ui.state()` plus a `view()` function that
returns components. Each state change re-runs `view()`; the whole tree goes to
the page as JSON, and a keyed JS renderer patches the DOM with iOS styling.
Callback ids are positional so they stay stable across renders. The same
renderer and runtime power the IDE playground and exported apps. Evidence:
`spikes/ui-toolkit/` (about 0.25 ms per tap round trip; 1,000 rows re-rendered
in about 25 ms).

## D15: Published apps are plain static sites with Pyodide from a CDN

2026-10-13 - Accepted (refines D5)

An export contains the app code, `ui.py`, the renderer, the worker runtime, a
manifest and an icon (37 KiB). Pyodide comes from jsDelivr at the pinned
version. No special headers are required: without cross-origin isolation the
app runs without SharedArrayBuffer (no `input()`, no Stop), which UI apps don't
need. Offline support and self-hosted Pyodide come later.

## D16: Python stays in Web Workers; an escaped error counts as a crash

2026-10-13 - Accepted

On devices, WebKit worker threads have a 512 KB native stack (about 544 wasm
frames). The main thread has only about 2x more on iOS (simulators overstate
this, since they use macOS's 8 MB main-thread stack). Recursion through C code
(e.g. `json.loads` of deeply nested data, `repr`, recursion via `map`)
overflows the native stack after 100-1,000 levels and Pyodide dies with a
fatal `RangeError`, because CPython's guard only measures Emscripten's
linear-memory stack. Moving Python to a main thread would cost JSPI-only
blocking and a more complex Stop for 2-4x more depth, so workers stay (D6).
Any error escaping the worker ends the run as "Python crashed" and the worker
is replaced. Making CPython raise `RecursionError` in time is Q14. Evidence:
`spikes/device-perf/`.

## D17: The editor is CodeMirror 6

2026-10-13 - Accepted (was P1)

CodeMirror 6 with lang-python, soft wrapping with a hanging indent, our own
key bar above the keyboard, and one cached EditorState per open file (undo
history survives file switches). Works in WKWebView on the simulator. Real
typing on a device still needs to be tried.

## D18: The web app is React + Vite + TypeScript

2026-10-13 - Accepted (was P3)

Same stack as pi-mobile. The Python worker, `_pyslop.py` and `ui.py` are served
as static files (`public/runtime/`), not bundled. `npm run dev` runs the app in
a desktop browser with a localStorage mock of the host bridge.

## D19: The Xcode project is hand-written, no generator

2026-10-13 - Accepted (replaces P4)

A minimal `project.pbxproj` (objectVersion 77, synchronized source folder,
generated Info.plist, automatic signing) is small enough to maintain by hand.
`run.sh` drives `xcodebuild`, `simctl` and `devicectl`.

## D20: Product code lives in `app/`; projects live in Documents

2026-10-13 - Accepted

`app/` holds the real app; spikes stay frozen as evidence. User projects are
plain files in the app's Documents folder (shown in the Files app). Running a
file copies its folder into the interpreter as the working directory and
writes new or changed files back afterwards.

## D21: ruff and ty run as WebAssembly in an analysis worker

2026-10-13 - Accepted

ruff comes from npm (`@astral-sh/ruff-wasm-web`, 11 MB wasm). ty has no npm
wasm package, so `app/scripts/build-ty.sh` builds `crates/ty_wasm` from a
pinned astral-sh/ruff commit (19.6 MB wasm including typeshed), the same way the
ty playground does. Both run in one module worker. ruff runs its CLI default
rules plus bugbear, plus formatting. ty provides type checking and completions
(hover, go-to-definition and inlay hints are available for later). Undefined
names come only from ty (ruff F821 is dropped), and `unresolved-import` is
suppressed for modules Pyodide can install itself or that are already declared.

## D22: Dependencies are declared with PEP 723 and installed with micropip

2026-10-13 - Accepted

Scripts declare dependencies in a `# /// script` block (PEP 723, as `uv run`
does); otherwise `pyproject.toml` in the folder is used. Before each run the
worker installs them with micropip (patched to accept `app://` URLs) against
the host's PyPI proxy: Simple JSON API cached for 10 minutes with an offline
fallback, files cached forever. Pyodide's own packages still come from
`/pkgs/`. `requires-python` is enforced.

uv is not used inside the app: it cannot run in the browser sandbox without a
large port (tokio, rayon, real file system), and its Pyodide targets stop at
3.13 (`wasm32-pyodide2025`) while we run 3.14 (`pyemscripten_2026_0`). We keep
the formats uv understands (PEP 723 now, possibly `pylock.toml` later), so the
same scripts run with `uv run` on a desktop. Resolution or locking with uv
(natively in the host or as a service) stays open (Q16).

## Proposed (not yet decided)

(none)

## Open questions

- **Q2:** Can WebKit evict `app://` web storage? It survives relaunch and reinstall, but `persist()` is denied (`spikes/ios-host/`).
- **Q4:** Should the agent run locally, in the cloud, or both, given background suspension?
- **Q6:** Can Python run when triggered from App Intents / Shortcuts while the app is in the background? (Known: a running script is paused while the app is in the background and resumes afterwards, `spikes/device-perf/`.)
- **Q7:** Do Pyodide's packages cover typical teaching material? Does PyPI accept Emscripten wheels? (Pyodide's version numbers now follow CPython: 314.x is 3.14, 315 is in alpha; 357 packages; wheels tagged `pyemscripten_2026_0_wasm32`.)
- **Q8:** JSPI support in Chrome and Firefox (matters for published apps).
- **Q9:** App Review: guideline 2.5.2 (learning-to-code exception), 4.7 (gallery of user apps), 1.2 (user-generated content).
- **Q10:** Model access for learners: hosted gateway, billing, in-app purchase rules.
- **Q13:** File the upstream reports listed in `spikes/jspi-repro/README.md` (CPython UA check, Pyodide lost `SuspendError`, WebKit `Suspending` callable).
- **Q14:** Make CPython raise `RecursionError` before the worker's native stack overflows, e.g. by lowering `c_stack_soft_limit` to match the measured native capacity, or report it to Pyodide/CPython (`spikes/device-perf/`).
- **Q16:** Lock files / reproducible installs: write a lock (e.g. PEP 751 `pylock.toml` or micropip's freeze) per script, and decide whether uv resolves it (linked into the iOS host, or as a service), which needs a 3.14 Pyodide target in uv.
- **Q17:** Type information for third-party packages in ty: feed installed packages (or their stubs) into ty's in-memory file system as `extra-paths`.
- **Q18:** ty in a WebKit worker on larger files: watch for native stack overflows (D16); fall back to running ty on the main thread if needed.
- **Q15:** Memory: iOS kills WebContent at about 1.9 GB (iPhone 14 Pro) without a `MemoryError`. Cap the wasm heap below the jetsam limit, and have the host recover from WebContent termination (recreate the web view, report "out of memory").
