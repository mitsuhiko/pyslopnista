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

2026-10-13 · Superseded by D31

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

2026-10-13 - Superseded by D26 (was P2)

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

2026-10-13 - Superseded by D31 (was P3)

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

## D23: A visual debugger on bdb's `monitoring` backend, shown only when a program stops

2026-10-13 - Accepted (was P1; `spikes/debugger/`)

`_pyslop_debug.py` subclasses `bdb.Bdb(backend="monitoring")`, new in 3.14.
With breakpoints set but not hit, programs run as fast as without the
debugger, while settrace and pdb are 6-12x slower. That is why every run is
debuggable and there is no "Debug" mode. The other options considered were
text pdb in the console, which stays as a fallback, and debugpy, which needs
threads and sockets.

How it works:
- **Stopping:** at a stop the worker makes a blocking `debug` call through the
  Atomics channel (D10). It answers requests (scopes, variables, evaluate,
  setBreakpoints) until it gets a resume command. The messages follow DAP's
  shapes.
- **Stop while paused:** it uses the interrupt path of D11, because Stop
  already answers pending sync calls.
- **Signals through the interrupt buffer:**
  - `SIGUSR1` pauses at the next line of user code.
  - `SIGUSR2` makes the program fetch breakpoints that changed while it runs.
  - The worker's `time.sleep` wakes on any signal and runs its handler
    immediately via `checkInterrupt` (except for Stop). Pause ends the sleep;
    other signals sleep on.
- **Only project files stop.** The stdlib, site-packages and our runtime are
  skipped and hidden from the stack.
- **`breakpoint()`** uses the same debugger; `import pdb` still gives text pdb.
- **Inspect** after an error runs `post_mortem()` on `sys.last_exc` in the
  finished run's interpreter.

UI, aimed at staying out of the way:
- **Nothing new until the program stops.** Run stays the only button.
- **Breakpoints:**
  - Long-press a line number to add one; a plain tap does nothing, to avoid
    accidents while scrolling.
  - Long-pressing an existing breakpoint offers Disable and Remove.
  - On a blank or comment line, the breakpoint moves to the next line of code.
  - Breakpoints live in app state (not the source). They follow edits,
    renames and deletes.
  - They look like Xcode's blue tags behind the line number.
- **While paused, the editor is read-only.**
  - A green band marks the current line; a red band marks the failing line
    when inspecting an error.
  - Tapping a name or `a.b` chain shows its value in a popover with
    expandable children.
- **No inline values.**
- **While paused, controls and console:**
  - Run becomes Continue.
  - Step over, in and out and Stop sit in the console sheet's header on
    iPhone, so they work with the sheet collapsed, and in the nav bar on
    iPad.
  - The console gets a paused block at its end: reason and location, stack
    chips with only user frames (tap one to switch frame), and variables.
  - `>>>` runs in the selected frame, and assignments stick.
- **Pause** is a button in the console header while a program runs.
- **Inspect:** a run that ended with an error offers Inspect in its header;
  Done ends the inspection.
- **UI apps:** a stop inside a callback hides the app view until the program
  continues.

## D24: Panes with tabs, one way to open a place in a file

2026-10-13 - Accepted

- **Panes:** the editor area is one pane (iPhone) or two (iPad split view).
  Each pane has its own tabs and its own CodeMirror view. Edits to a file
  that is open in both panes are mirrored as remote transactions, which are
  not saved twice or added to the other pane's undo history.
- **Opening a place:** traceback links, go to definition and the debugger all
  use `openLocation(path, line)`. It focuses the pane where the file is
  already shown, otherwise adds a tab to the focused pane, and flashes the
  line.
- **Tab limit:** a pane keeps at most 10 tabs; the least recently used one
  closes.
- **Library files:** the standard library and our runtime stubs (ty's
  vendored files) open as read-only tabs (`ext:` paths) and are not linted.
- **Analysis root:** ty gets the running program's folder as an extra search
  path, so sibling modules resolve as they do at run time. That path is only
  applied once ty has a file from that folder, because it rejects search
  paths that don't exist in its in-memory file system.
- **Jump to Definition on touch:** a `WKWebView` subclass adds it to the text
  selection menu through `buildMenu(with:)`, which WebKit consults for that
  menu. It shows only while the editor (not `>>>`) has focus.
- **Loading:** an editor never shows a file before its text is loaded. It
  would otherwise create an empty document that saving writes back, which
  happened with restored tabs.

## D25: HTTP from Python goes through the native host

2026-10-13 - Accepted

Requests from the app's origin to other hosts would hit CORS. The worker
therefore routes cross-origin `XMLHttpRequest` and `fetch` calls to
`app://app/__http?url=…`, and the scheme handler makes the real request with
`URLSession`:
- It forwards the method, headers and body and follows redirects.
- The status and headers come back unchanged, except for headers that no
  longer apply (encoding, length) or would override our cross-origin isolation
  headers.
- Headers that browsers don't let scripts set, like `User-Agent` and `Cookie`,
  travel in `X-Pyslop-Headers`.
- A network failure answers 502 with `X-Pyslop-Error`, which the shim turns
  back into a network error.

On the Python side there is nothing app-specific:
- `requests` uses urllib3's Pyodide backend, which goes through fetch with
  JSPI. We empty its `HEADERS_TO_IGNORE` so `User-Agent` reaches the proxy.
- `urllib` gets pyodide-http's patch (sync XHR) when a program imports it.
- `httpx` and `pyfetch` work as they are.

The dev server implements the same `/__http` contract.

Published apps (D15) have no host, so they keep the browser's CORS rules; the
proxy only exists inside the app. Unhandled promise rejections in the worker
only count as crashes (D16) when they show a broken interpreter: urllib3
leaves a rejected promise behind in WebKit.

## D26: UI apps use Solid-style fine-grained reactivity

2026-10-13 - Accepted (was P1; supersedes D14; `uikit/`; in the app they render natively, D30)

The `ui` module works like SolidJS:
- Components are plain functions that run once.
- State lives in signals, computed values and deep reactive stores.
- Any function passed as a prop or child is a live binding that updates one
  DOM property.

Python keeps the element tree and sends batched ops (`mount`, `move`,
`unmount`, `set`). `For` reconciles keyed lists with minimal moves. Nothing is
re-rendered or diffed: text fields keep focus, and one change sends one op.
The library covers navigation stacks, tabs, sheets, dialogs, every common
input with two-way binding, canvas with a frame loop, async resources, and
raw HTML through `h()`.

D14 re-ran `view()` and resent and re-diffed the whole tree on every change
(23-26 ms for 1,000 rows). Its positional callback ids were fragile, and
controlled inputs needed care to keep the caret. Signals are also easier to
explain: "the lambda is what updates".

How it fits into the app:
- It uses the worker's existing `_uihost.render`/`set_dispatcher`.
- Every new renderer asks for a full snapshot (`resync`), so the app view can
  mount late or be re-created after the debugger hid it (D23). The session
  no longer replays messages.
- The source of truth is `uikit/`; `uikit/scripts/install.sh` copies
  `ui.py`, the renderer, the CSS and the todo example into `app/web`.
- Files a UI app writes after its script returned are written back when the
  app view closes (Done) or the app goes to the background. The worker
  answers a `sync` message with the files changed since the last sync.
- Examples in Documents are updated when the user hasn't edited them
  (checked by hash), so the D14-era examples get replaced.

Evidence: 88 host tests, plus 12 browser checks in desktop Chrome and
Playwright WebKit (0.1-0.23 ms per tap, 10-11 ms in Python for 1,000 rows,
one op and about 1 ms to toggle one row of 1,000). The `ui_app` and
`ui_todo` app selftests pass in WKWebView in the iPhone 17 simulator. Not yet
tried on a device.

## D27: Program files are written back while the program idles, deletions included

2026-10-13 - Accepted (extends D20, D26)

A program still works on a copy of its folder in the interpreter (D20), but
the copy no longer waits for the run to end:
- While the program idles (a 500 ms timer in the worker, which only fires
  between Python's tasks), the worker posts the files that changed. The page
  writes them back in order, one write-back after the other. A UI app's saved
  data reaches the disk within about a second, so a killed app, a crash or
  jetsam loses at most that. The end of a run, Done and going to the
  background still sync too.
- A change is a different mtime or size (mtimes are in milliseconds).
- A file the program wrote back and then deletes is deleted in the project
  too. Files the program did not write are never deleted, and if the program
  removes its working directory nothing is deleted at all.
- The order follows SQLite's: rollback journals (`-journal`, `-wal`) first,
  then the other files, then deletions. A database on disk is never newer than
  its journal, and the journal deleted at commit never stays behind as a "hot"
  journal that would roll the database back on the next open.

With that, `sqlite3` (in Pyodide's standard library here, SQLite 3.39) works
on project files like any other file: `Examples/Todo App.py` keeps its data
in `todos.db` and imports an old `todos.json` once. The whole database file is
copied on every change, which is fine for app-sized data (a few MB) but not
for big databases; a VFS that writes pages through the host would be the next
step if that matters.

Evidence: the `ui_todo` selftest adds a to-do and finds it in `todos.db` on
disk while the app is still open (0.7-0.9 s later), then reads it back in a
second run, with no journal left behind (iPhone 17 simulator, WKWebView).
Not yet tried on a device.

## D28: Linked folders (iCloud Drive, other apps) through security-scoped bookmarks

2026-10-13 - Accepted

"Open Folder…" in the file browser shows the system folder picker
(`UIDocumentPickerViewController` for `.folder`). The picked folder is kept as
a bookmark in the user defaults, opened with
`startAccessingSecurityScopedResource` at launch, and listed under Locations
at the top of the file browser. This covers iCloud Drive, other apps' folders
(Working Copy, ...), file providers (Dropbox, ...) and external drives, and
needs no entitlement.

- The web app addresses a linked folder as `@<name>/...` with the same `fs.*`
  bridge calls as Documents, so the editor, Run, write-back (D27), Find in
  Folder and ty work unchanged. Top-level names starting with `@` are reserved
  (hidden in Documents).
- Files in linked folders are read and written through `NSFileCoordinator`.
  Files that are only in iCloud are downloaded first (coordinated read, plus
  `startDownloadingUbiquitousItem` for `.name.icloud` placeholders).
- All file operations now run on one serial queue off the main thread, since
  a coordinated read may wait for a download.
- The root of a linked folder cannot be deleted or renamed from the app;
  "Remove" only forgets the bookmark.

The app's own iCloud container ("iCloud sync between devices" in GOALS) needs
the iCloud entitlement, which personal teams cannot use (Q20).

Evidence: the `linked_folder` selftest links a folder outside Documents
through the same bookmark code (the picker itself cannot be driven), lists,
writes, runs a script with a sibling import and file write-back, and removes
the link (iPhone 17 simulator). Not yet tried with iCloud Drive or a file
provider on a device.

## D29: `turtle` is CPython's module on a browser canvas, drawn inline in the console

2026-10-13 - Accepted

Pyodide ships neither `tkinter` nor `turtle`. We ship CPython's own
`turtle.py`, so the whole API and its behavior are the standard library's
(speeds, undo, stamps, shapes, `setworldcoordinates`, `Vec2D`, ...). Only its
Tkinter interface, which CPython keeps in one block (`TurtleScreenBase`,
`ScrolledCanvas`, `_Root`) for exactly this kind of port, is replaced by
`_pyslop_turtle.py`. `app/scripts/make-turtle.py` generates the app's
`turtle.py` from the host's 3.14 standard library.

- The backend keeps Tk's canvas model in Python (items with coordinates and
  options) and sends the changes as ops. The worker sends them on at most
  every 16 ms, and always before the program sleeps, blocks, prints or ends,
  so the console keeps the order and animation follows turtle's own delays.
- The page mirrors the items per screen (`TurtleScene`) and redraws them on
  a `<canvas>` once per frame. A screen is a console line, like a plot: it
  stays in the transcript after the run, fits the console (never scaled up),
  and >>> input can keep drawing on it. On iPhone the console sheet expands
  to full height when a drawing appears.
- Events: taps (screen and turtle clicks, drags, releases) and hardware
  keys are queued by the page while the program has handlers, and the
  program fetches them with a blocking call when it updates the screen (at
  most every 30 ms) or waits in `mainloop()`/`done()`, where Tk handles
  events too. Turtles get 10 canvas units of slack for fingers. Timers run in
  the same places. `textinput`/`numinput` use the native prompt dialog.
- Differences from Tk, on purpose: `done()`/`mainloop()`/`exitonclick()`
  return right away when nothing could happen (no handlers, no timers), since
  the drawing stays either way. A script that ends with handlers or timers
  keeps running as if it called `done()`, like in IDLE. `bye()` keeps the
  drawing and only ends its events. `save()` writes EPS from the items.

On the other hand, the window has no scrollbars (it always shows the middle
of the canvas), and there is no on-screen keyboard for key handlers on a
phone.

Evidence: the `turtle_*` selftests (draw a filled square and check its
pixels, a tap and a key reach the handlers, `bye()` ends `done()`, a timer
program keeps running until Stop, `Examples/Turtle.py`, and a tap that
catches the turtle in `Examples/Catch the Turtle.py`) pass in the iPhone 17
and iPad Pro 11 simulators (WKWebView). Not yet tried on a device.

## D30: In the app, ui apps are native SwiftUI views; the web renderer is for published apps

2026-10-14 - Accepted (extends D26)

`ui.py` keeps the element tree and its op stream (`mount`, `move`,
`unmount`, `set`, `call`, `dialog`, `toast`, `frame`, `reset`). In the app,
those ops drive a SwiftUI renderer (`app/ios/Sources/UIRenderer/`). Published
apps (D15) keep using `uikit/web/renderer.js`, and web pages only need to look
iOS-like, not like the native views.

How the native renderer works:
- **One observable node per element.** `UIStore` mirrors the tree as
  `@Observable` `UINode`s (type, props, children). A `set` op changes one
  node, so only the views that read that node update, the same fine-grained
  model as Solid. Event and value changes go back as `"<id>:<event>"` with
  JSON arguments.
- **Inputs echo nothing.** A change is written into the node before it is
  sent, and Python remembers it, so its echo is a no-op.
- **Native components where they exist:**
  - Screens are inset grouped `List`s. Sections become list sections, Rows
    become list rows (swipe to delete with `.swipeActions`). Any other child
    is a row on the background.
  - Navigation uses `NavigationStack(path:)`. The path leaves out screens the
    user already popped (back button or edge swipe) until Python unmounts
    them.
  - `TabView`, sheets with detents, alerts and confirmation dialogs, a toast
    overlay. Sheets, dialogs and toasts are presented from the topmost
    layer.
  - Controls: `Picker` (segmented and menu), `DatePicker`, `ColorPicker`,
    `Stepper`, `Slider`, `Toggle`, `TextField` (with keyboard kinds),
    `LabeledContent`.
  - Icon names map to SF Symbols, with emoji as the fallback.
- **Canvas** replays the recorded drawing calls (the browser's canvas 2D API)
  into Core Graphics. Paths are kept in canvas units, so `fill()` followed by
  `stroke()` works as in the browser. `on_frame` runs on `CADisplayLink`
  with one frame in flight. While the program listens for pointer events,
  touches on the canvas don't scroll the list.
- **The Done button** sits on the leading side of the app's first screen
  (each tab's first screen in a `TabView`).

The web-only escape hatches are gone: `h()`, `Html`, `css()`, `class_`,
`style` and arbitrary DOM events. Modifiers are now plain values that each
renderer translates:
- `padding` and `margin`: a number, (vertical, horizontal) or (top, right,
  bottom, left).
- Sizes: points, or `"fill"`.
- `flex`: a number.
- Colors: hex, `rgb()`, CSS names, iOS system colors (`red`, ..., `gray`) or
  semantic names (`primary`, `secondary`, `tertiary`, `tint`, `background`,
  `separator`, `fill`).
- `font_weight`: a name or a number.
- `text_align`: `leading`, `center` or `trailing`.
- `border`: a color, or (width, color).
- `shadow`: `True` or a radius.
- New: `tint`, and `accessibility_label` (`aria_label` still works).
The `Escape Hatches` example became `Async Data`.

Phase A wired this into the old React app as an overlay. D31 then made the
whole app native, and the renderer and its bridge carried over unchanged.

Evidence (iPhone 17 simulator, iOS 27):
- The `ui_app`, `ui_todo` and new `ui_navigation` selftests pass. They check
  push, the prompt dialog, back, and a sheet with a text field.
- Rendering a message takes 0.08 ms for 2 ops.
- Screenshots of every uikit example look like native iOS.
- `uikit/run.sh --selftest` passes (88 host tests, 12 browser checks).
Not yet tried on a device.

## D31: The IDE is a native SwiftUI app; web views only run Python and CodeMirror

2026-10-14 - Accepted (supersedes D4 and D18)

The React app is gone. Everything visible is SwiftUI:
- the file browser
- tabs and split view
- the navigation bar with Run, Stop and Continue, and native menus
- the console
- the debugger's controls and views
- the Find in Folder, Go to, Problems and Settings sheets
- ui apps (D30) and turtle screens

Pyodide still needs WebKit (D2), so two kinds of pages remain, built with Vite
and without a UI framework:
- **The engine** (`engine.html`) has no UI and never shows. It keeps the old
  session code: Python workers (D6, D10-D13, D16), the debugger protocol
  (D23), file write-back (D27), turtle scenes and their event queues (D29),
  and ruff and ty (D21).
  - The host sends commands through `window.__engine.command`. The engine
    reports session state through the bridge: the transcript goes as patches
    (new lines, appended text, the current order), the rest whole.
  - Its web view stays in the window as a 1-point view, with
    `WKPreferences.inactiveSchedulingPolicy = .none` so it is never throttled.
  - The self-test runs here and drives the native app through `app.*` hooks.
- **The editor** (`editor.html`) is one CodeMirror pane per web view (D17),
  two on iPad.
  - It is driven by `window.__editor.call`. It reports edits, focus,
    problem counts, breakpoints that moved, taps on names while paused,
    and long presses on line numbers.
  - Lint, completions, hover and go to definition go through the host to the
    engine. One ty instance serves both panes.
  - The problem bar with its quick fixes stays inside the page for now.
  - Edits are mirrored to the other pane right away. The text is saved after
    300 ms of quiet, and is flushed before a run.

The host owns breakpoints, settings and open tabs (in the user defaults) and
pushes them to the pages. Files are read and written natively through
`FileStore` (D20, D28). Linking a folder uses SwiftUI's `fileImporter`.

What this gets us:
- Real native controls: `NavigationStack`, swipe actions, context menus,
  `.searchable`, `Menu`, popovers anchored to code.
- Hardware shortcuts as `UIKeyCommand`s through `.keyboardShortcut`, which
  iPadOS lists in the ⌘ overlay.
- The console fields are `UITextField`s with no capitalization,
  autocorrection or smart punctuation, and ↑/↓ history.
- Turtle screens are drawn with Core Graphics from the scene ops.
- A crash of the engine's WebContent process no longer takes the editor
  with it.

What it costs:
- The IDE no longer runs in a desktop browser (`npm run dev` only serves the
  pages), and Android would need its own UI. GOALS is updated.
- There are three WebContent processes instead of one.
- Every editor and engine call is an IPC hop. Completions now take two.

Evidence: `./run.sh --selftest` passes all 40 checks in the iPhone 17 and
iPad Pro 13" simulators (iOS 27), including typing into the native console
fields through UIKit and pixel checks on the native turtle view. Not yet
tried on a device; the iPhone 14 Pro should be next (memory with three
WebContent processes, keyboard and focus behavior).

## D32: The agent's platform: native SQLite, a project ExecutionEnv, keys added by the proxy

2026-10-15 - Accepted (refines D7); the host-side key injection is superseded by D33

pi-durable and pi-ai run in a web view unmodified. What D7 left open is
decided like this:
- **Storage:** pi-durable's `SqliteStorage` on native SQLite. Every
  `SqliteDatabase` call is one bridge round trip. The page serializes the
  calls, so a transaction is `BEGIN IMMEDIATE` … `COMMIT` in call order.
  Whenever the page goes away, the host rolls back an open transaction.
  The database lives in Application Support, not in WebKit storage (Q2).
- **Files:** an `ExecutionEnv` over the project folder. The agent sees the
  folder as `/`, and paths that leave it are refused. There is no shell:
  `exec` answers `shell_unavailable`.
- **Provider HTTP:** a patched `fetch` sends it through `/__http` (D25),
  which streams. The host adds the API key header for the target host, but
  only for requests carrying a per-launch token that only the page's main
  thread holds. The page uses a placeholder key; Python workers can't
  borrow the credential.
- **Durability:** submissions use a `requestId`, and the page calls
  `harness.resume()` after a reload or crash. An interrupted answer retries.
  An interrupted tool that is not replay-safe becomes an error result the
  model sees.

Evidence: `spikes/agent/` (iPhone 17 simulator):
- pi-durable's storage conformance suite passes 24/24 on the bridge.
- Bridge round trip: 0.14 ms. Tool rounds cost about 20 ms of storage each
  (about 140 statements); streamed answers cost nothing extra.
- Server-sent events arrive in chunks as they are sent.
- The key is injected with the token (200) and not without it (401).
- After a reload in the middle of a stream and in the middle of a tool call,
  the turn continues as described above.

Not yet tried: a device, a real model, a real WebContent crash.

## D33: Sign-in runs pi-ai's own flows; credentials live in the engine page and the Keychain

2026-10-15 - Accepted (supersedes D32's key injection)

OAuth makes D32's "keys never enter the web view" impossible to keep: pi-ai
exchanges the code for tokens and refreshes them in JavaScript. One model
covers API keys and OAuth alike:
- **Credentials** are pi-ai's `CredentialStore` over page-only bridge ops,
  stored in the Keychain: one item per provider, this device only, readable
  after first unlock. While the app runs they are in the engine page's
  memory. The proxy only forwards; it adds no keys.
- **Who cannot reach them:**
  - Python workers (user or agent code) cannot read the page's memory or
    call the bridge.
  - The scheme handler never serves credentials.
  - Editor pages are refused: the `agent.*` ops are for the engine only.
- **Login flows** are pi-ai's own:
  - They are bundled through Vite aliases and registered with
    `registerBundledOAuthFlowLoaders`, as pi-ai's Bun build does.
  - `node:http` and `node:crypto` are shimmed. `node:http` runs on a native
    loopback listener (`LoopbackServer.swift`, 127.0.0.1 and ::1), so
    `startOAuthCallbackServer` and the ChatGPT flow's server run unmodified.
  - Auth URLs open in `ASWebAuthenticationSession`. Device-code flows open
    nothing: the sheet shows the code and the full address
    (`radius.earendil.com/pair`), so the user can sign in on another device
    or tap the address to open it in Safari (2026-10-15: changed from opening
    the link right away).
  - pi-ai's prompts (method, key, pasted code) are a native sheet. The
    bridge call stays pending until the user answers.
- **The proxy drops WebKit's own User-Agent.** Anthropic's token endpoint
  answers a browser or curl User-Agent with a fake 429 rate limit; a CFNetwork
  or node one is accepted. A User-Agent the code sets (pi-ai's `claude-cli/…`)
  travels in `X-Pyslop-Headers`, as Python's does (D25).
- **OpenAI Codex uses server-sent events** (`stream.transport: "sse"`): a
  browser WebSocket cannot carry auth headers.
- **Simulator:** unsigned simulator builds need their entitlements embedded
  for the Keychain (`__TEXT,__entitlements` via the linker, as Xcode does).
  That only works with `ENABLE_DEBUG_DYLIB = NO`.

Evidence: `spikes/agent/` (iPhone 17 simulator):
- `oauth-mock` passes end to end: the sign-in sheet, the redirect to
  localhost, the native listener, the code exchange, the Keychain, Bearer
  requests carrying the `claude-cli` User-Agent, a forced refresh, and a
  reload.
- A real Claude Pro/Max sign-in: requests, refresh, and after a reload.

The simulator shares the Mac's network, so whether the sign-in sheet reaches
the app's loopback listener on a device is still open (Q22).

## D34: The coding agent in the app

2026-10-15 - Accepted (from P1)

The agent runs in the engine page (`app/web/src/agent/`, loaded on first
use) on D32 and D33.
- **Tools:**
  - pi-durable's `read`, `write` and `edit` over the project folder.
  - `ls`, `find` and `grep` (there is no shell).
  - `run_python`: a fresh Pyodide worker per call, with the project folder
    copied in and written back (D27). It streams output and returns
    matplotlib figures as images. `input()` gets EOF; ui apps are stopped.
  - `check` (ruff + ty) and `format` (ruff format).
  - `write` and `edit` append new ruff/ty problems of Python files to their
    result.
- **Conversations:** one per project folder: the open file's folder, else
  the folder on screen. The host remembers the conversation and the last
  model in the user defaults.
- **System prompt:**
  - the environment: Pyodide, no shell, PEP 723 dependencies, turtle and
    ui apps only through Run;
  - the `ui` module's reference, from `uikit/README.md`.
- **UI:** a native sheet (`AgentViews.swift`) fed by the conversation's
  `viewState()` as a compact transcript (`agent.state`). It has:
  - collapsible tool calls with diffs and an "Open file" link;
  - a model menu;
  - Accounts: subscriptions, other sign-ins, API keys;
  - the sign-in sheet.
- **Editors:** the agent's first read in a tool call saves unsaved editor
  text. Its writes reach open editors and the file list through
  `files.changed`.

Not built yet from P1:
- refusing a write when the editor's buffer changed since the agent read it;
- per-turn undo;
- teaching mode;
- a docked panel on iPad instead of a sheet.

Evidence: the `agent` self-test check. A scripted model (pi-ai's faux
provider) drives every tool against a real folder. The check confirms:
- the files on disk;
- `run_python`'s write-back;
- lint feedback after `write`;
- the diffs;
- the open editor showing the edit;
- the native transcript.

It passes with the other 42 checks on the iPhone 17 simulator (2026-10-15).

## D35: Programs use the project's files in place; linked folders through a local copy

2026-10-15 - Accepted (supersedes D27; changes D20 and D28)

A run no longer copies its folder into MEMFS and writes changed files back.
The worker mounts the folder as `HOSTFS`, an Emscripten file system
(`app/web/public/runtime/hostfs.js`, modelled on NODEFS) whose operations
go to `HostFS.swift` as synchronous XHRs (`POST /__fs` on the scheme
handler). That handler does the real `open`/`pread`/`pwrite`/`fsync`. The
mount sits at the same path as the copy did (`/home/pyodide/project`), so
tracebacks, the debugger and `>>>` are unchanged.

What this changes:
- **Writes:** they land in the file itself, page by page. SQLite works on
  the real database with its journal, and a killed program is a crash that
  SQLite recovers from.
- **No copies:** nothing is copied at the start, so big folders cost
  nothing.
- **Gone:** the manifest, the write-back ordering and the 64 MB tree limit.

Every call is a round trip (0.1-0.2 ms on the simulator), so the worker
keeps three things (`spikes/host-fs/`):
- **A write-behind queue** for all files:
  - It goes to the host in one call before any other call, so the host
    sees every operation in program order.
  - It is also sent when the program idles (every 250 ms), blocks
    (`input()`, sleep, the debugger, turtle) or ends.
  - A killed worker loses at most what is queued, as if it had crashed a
    moment earlier. The spike's crash test confirms SQLite recovers from
    that.
- **A stat cache:** missing files included, entries live for 1 s.
- **A 64 KB block read cache:** checked against size and mtime when a file
  is opened, dropped where this worker writes.

Both caches are dropped when the mount's generation changes. The host
raises it when the app (editor, agent, file browser) or another interpreter
changes project files; each reply carries it.

Linked folders (iCloud Drive, file providers, other apps) are not used in
place: every operation would need `NSFileCoordinator`, and a file provider
can't be trusted with page-level writes into a database. Instead:
- **Mounting** copies the folder into `Caches/Staging/<mount>` with
  coordinated reads (downloading what is only in the cloud; 512 MB at
  most).
- **The program** works on that local copy.
- **Sync back:** `HostFS` records which paths the program changed, and
  writes them back with coordinated writes:
  - after 0.3 s of quiet (at least every 2 s while the program keeps
    writing);
  - when a run ends;
  - when the app goes to the background;
  - at unmount.
  Journals go first, then files, then folders and removals. The copy is
  cloned first (APFS), so the program can keep writing meanwhile.

Also:
- **Notifications:** the host tells the views about changed files itself
  (file list, open tabs, ty's folder). The page's write-back path is gone.
- **Agent:** `run_python` mounts the folder the same way and reports the
  files the host saw change.
- **`PYTHONDONTWRITEBYTECODE`:** imports of sibling modules no longer leave
  `__pycache__` in the user's folders.

What it costs, and what is open:
- **Many small files are slow:** creating, writing and closing one is
  about 6 calls, about 0.5 ms each on the simulator.
- **SQLite is close to MEMFS with the caches:** a todo-style save takes
  about 2 ms.
- **Outside edits during a run** (Files app, iCloud) are seen within 1 s
  for stats. Contents are only checked when a file is opened.
- **No real file locks:** Emscripten answers `F_SETLK` itself, so two
  interpreters writing the same database (a run and the agent's
  `run_python`) are not protected from each other.
- **Main thread:** both the scheme handler and the bridge run on the main
  thread, so a busy UI adds latency.

Evidence:
- `spikes/host-fs/` (iPhone 18 Pro simulator): the costs, the caches, and
  the crash and integrity tests.
- In the app, the new `project_files_in_place` check:
  - writes are on disk while the program waits in `input()`;
  - an edit made meanwhile is seen;
  - renames and deletions happen right away;
  - SQLite leaves no journal;
  - no `__pycache__` appears.
- The `linked_folder` check now also syncs back a new folder and a deletion.
- All 44 checks pass in the iPhone 18 Pro simulator (2026-10-15).
- Not yet tried on a device.

## D36: The agent's conversations per project, and IDE tools

2026-10-15 - Accepted (was P1; extends D34)

**Projects.** A conversation works on a project. Before, the project was
the open file's folder, so a file in a subfolder switched to another
conversation. Now the project is:
- the top-level folder in Documents;
- a linked folder's root (D28);
- Documents itself, for loose files.

The same project is used whether the agent is opened from a file or from
the file browser.

**Conversations.** A project has several. A conversation is never kept per
file, because the work spans files.
- **Opening the agent** shows the conversation on screen if it belongs to
  the project, else the project's most recent one, else a new one.
- **New** starts another one. A new conversation without messages is
  reused instead of making more empty ones.
- **The list** (tap the title) shows the project's conversations, newest
  first, each with a running spinner and an unread dot. Conversations can
  be renamed and archived.
- **Archived** conversations are kept, listed apart, and can be
  unarchived. Nothing is deleted.
- **Titles** are the first line of the first message.
- **In the background:** a conversation keeps running when another one is
  on screen (pi-durable runs them concurrently). The ✨ button pulses
  while any of them works.
- **Renaming or moving a folder in the app** moves its conversations'
  project and their `cwd` with it.

**Index.** pi-durable has no call that lists conversations, so the engine
keeps its own index (`app/web/src/agent/conversations.ts`), a second
SQLite database ("conversations") on the bridge from D32. Each row has:
- `id`, `project`, `title`;
- `created`, `updated`, `seen` (unread means updated after seen);
- `archived`;
- the IDE context the model last got.

The old user-defaults map (project -> conversation) is imported once.
Those conversations keep their folder as their project and show up under
the project that contains it.

**Two kinds of tools:**
- **Project tools** (D34): `read`, `write`, `edit`, `ls`, `find`, `grep`,
  `run_python`, `check`, `format`. They work on the files on disk; the user
  sees nothing happen.
- **IDE tools** (`app/web/src/agent/ide.ts`), all named `ide_*`, change what
  is on the user's screen:
  - `ide_state`: tabs per pane, the active file, cursor line, the
    selection with its text (cut at 4000 characters, and marked when cut),
    whether a program runs;
  - `ide_open(path, line?, end_line?, pane?)`: open or switch to a file,
    scroll to the line, and select and flash a range;
  - `ide_close(path)`: close its tabs. What was typed is saved first, as
    when the user closes a tab;
  - `ide_lint(path?)`: ruff + ty on the editor's text, typed text
    included. The problems show in the editor and come back in the result;
  - `ide_format(path?)`: ruff format in the editor, undoable there.

  `ide_lint` and `ide_format` work on files open in a tab (default: the
  active one). For other files they point the model to `check`/`format`
  or `ide_open`.

**Keeping the model from confusing them:**
- every IDE tool's description starts with the same sentence: it acts on
  the editor, not on files on disk, and names the project tools for those;
- results are short messages, never file contents (except the selection
  in `ide_state`), so an IDE tool can't be used to read code;
- the system prompt has a section on the two kinds: IDE tools are for
  showing the user something, or for acting in the editor when asked;
- the transcript shows an IDE call as one line with its message (the whole
  result when tapped), not as a call with a diff. The tools are told apart
  by the `ide_` prefix; there is no extra flag on the tool definitions.

**Behaviour:**
- **Only for the conversation on screen:** called from a background
  conversation, an IDE tool changes nothing. It answers that the user is
  not looking at this conversation.
- **No confirmations:** nothing here loses data.
- **Typing:** if the user typed in the focused editor in the last 3
  seconds, `ide_open` doesn't switch that pane away. It opens the file in
  the other pane (iPad) or adds a tab behind the current one (iPhone).
- **iPhone:** the agent sheet has medium and large detents and lets the
  editor behind it be used at medium. After `ide_open` it drops to medium,
  so the file shows.

**IDE context:** the open tabs, the active file, the cursor line, the
selection, a running program and the active file's last failed run. It is
sent only when it changed since the model last saw it:
- **With a message:** before the message, as an `<ide>` block. This
  replaces the `<editor>` block that D34 sent with every message.
- **Mid-turn:** when the tabs or the active file change while the
  conversation on screen works. The host tells the engine; 400 ms later
  the engine reads the state again and compares.
  - If it changed, a `pyslopnista.ide` entry is submitted as a write with
    a model message. pi-durable places it at the next boundary, like a
    steer.
  - pi-ai has no system role mid-conversation, so the block goes in as a
    user message. The transcript shows it as a note: "Now in greet.py ·
    line 1".
  - A queued entry the next message supersedes is withdrawn.
  - Changes made by the agent's own IDE tools are ignored: their results
    already told the model.

`ide_run` (Run in the app, so turtle and ui apps can be seen) stays for a
later decision.

Not built: recording which files a conversation touched (to list
conversations about a file), a filter across projects, and better titles
than the first line.

Evidence: the self-test's `agent-ide` and `agent-conversations` checks
(`app/web/src/selftest.ts`), with the scripted model of D34. They check:
- **`agent-ide`:**
  - no `<ide>` block when nothing changed;
  - each IDE tool's result and its effect on the editor, including the
    formatted file on disk after `ide_close`;
  - the medium detent on iPhone;
  - the user moving to another file mid-turn reaching the model at the
    next step, and the note in the transcript;
  - `ide_open` of a missing file failing.
- **`agent-conversations`:**
  - a second conversation;
  - a background run whose `ide_open` is refused;
  - unread;
  - titles;
  - archiving the conversation on screen and unarchiving it;
  - rename;
  - a renamed folder.

All 46 checks pass in the iPhone 18 Pro simulator. In the iPhone 17
simulator only `turtle_catch_example` fails, and it fails the same way
without this change. The three agent checks also pass in the iPad Pro 13"
simulator (2026-10-15). Nothing here has been tried on a device.

## Proposed (not yet decided)

(none)

## Open questions

- **Q21:** Provider terms and App Review for subscription sign-ins (Claude Pro/Max, ChatGPT) used from a third-party app.
- **Q22:** On a device, does `ASWebAuthenticationSession` reach the app's loopback listener (the simulator shares the Mac's network)? If not, Anthropic, Codex and Radius still have copy-code or device-code sign-ins; Sign in with ChatGPT and OpenRouter would not work.
- **Q2:** Can WebKit evict `app://` web storage? It survives relaunch and reinstall, but `persist()` is denied (`spikes/ios-host/`).
- **Q4:** Should the agent run locally, in the cloud, or both, given background suspension? (Local works and survives a page reload mid-turn, D32. Open: what happens when the app is suspended mid-stream, and whether running while the phone sleeps needs the cloud.)
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
- **Q19:** Debugger: run the overhead benchmark and the debugger self-tests on
  a device. Pause cannot interrupt a program that is suspended in JavaScript
  (JSPI `await`); it stops when Python resumes. Conditional breakpoints and
  hardware-keyboard shortcuts (⌘. / F6-F8) are not built yet.
- **Q20:** iCloud sync between devices: the app's own iCloud Drive container needs the iCloud entitlement (paid developer account). Until then, linked folders (D28) reach iCloud Drive.
- **Q15:** Memory: iOS kills WebContent at about 1.9 GB (iPhone 14 Pro) without a `MemoryError`. Cap the wasm heap below the jetsam limit, and have the host recover from WebContent termination (recreate the web view, report "out of memory").
