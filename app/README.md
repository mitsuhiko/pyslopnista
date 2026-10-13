# Pyslopnista app

The actual app (not a spike): a Pythonista-style Python IDE for iPhone and
iPad. Swift host + web app (D4), Python in Pyodide workers (D2, D6).

## Features (first version)

- **Files**: projects live in the app's Documents folder, which also shows up
  in the Files app ("On My iPhone"). Create, rename, duplicate and delete files
  and folders (native dialogs). Examples are copied into `Examples/` on first
  launch.
- **Linked folders** (D28): "Open Folder…" (⋯ menu, or under Locations at the
  top level) adds a folder from iCloud Drive, another app (e.g. Working Copy),
  a file provider or a drive. It works like a folder in Documents: edit, run,
  write back. Files that are only in iCloud are downloaded when opened.
  Swipe a location to remove it (its files stay).
- **Editor**: CodeMirror 6 with Python highlighting, autocompletion, auto-indent,
  bracket closing, search, undo history per file, soft wrapping with hanging
  indent, light/dark themes. Saves automatically. A row of extra keys sits above
  the keyboard (indent/dedent, brackets and quotes with the cursor placed
  inside, operators, undo/redo, comment), with a strip to swipe the cursor.
- **Code intelligence** (ruff + ty as WebAssembly in their own worker):
  wavy underlines for real mistakes (ruff's default rules + bugbear, ty's type
  checks), a problem bar above the keyboard that shows the problem at the
  cursor with its quick fixes (touch has no hover), a problem count badge,
  ty-powered completions, and "Format Code" (ruff format) in the ⋯ menu.
  Imports that Pyodide can install by itself are not flagged.
- **Dependencies**: a PEP 723 block (`# /// script` … `dependencies = [...]`),
  the format `uv run` uses, or `pyproject.toml` in the folder. They are
  installed with micropip before the program runs; `requires-python` is
  checked. An unresolved import offers "Add “x” to dependencies", which writes
  the block. PyPI goes through the host's cache (offline after the first
  install).
- **Tabs and split view**:
  - Every pane has tabs; opening a file adds a tab after the current one, up
    to 10 per pane (the least recently used one closes).
  - Long-press a tab for Close, Close Others and Open in Split View.
  - On iPad, split view shows two panes with a draggable divider. Each pane
    has its own tabs, and the same file in both panes stays in sync.
  - Tabs come back after a relaunch. On iPhone the tab strip appears once
    two files are open.
- **Go to definition** (ty): "Jump to Definition" in the text selection menu
  (next to Copy/Paste), in the ⋯ menu, on F12 or with ⌘-click. It works across
  the program's folder (sibling modules) and into the standard library and the
  `ui` module, which open as read-only tabs.
- **Getting around**:
  - Tap the file name in the nav bar for an outline of its classes and
    functions with a filter. Typing a number offers "Go to Line N".
  - Find in Folder searches the text files of the current folder.
  - Show Info shows ty's signature and docstring for a name. It's in the
    selection menu and the ⋯ menu, or ⌥-click.
- **Settings** (⌘, or the ⋯ menus): editor font size, line wrapping.
- **Hardware keyboard**:

  | Action | Shortcut |
  |---|---|
  | Run | ⌘R or F5 |
  | Stop | ⌘. |
  | Go to line | ⌘L |
  | Go to symbol | ⌘⇧O |
  | Find in folder | ⌘⇧F |
  | Settings | ⌘, |
  | Close tab | ⌘W |
  | Split view | ⌘\ |
  | Previous / next tab | ⌘⇧[ / ⌘⇧] |
  | Toggle breakpoint | F9 |
  | Step over | F6 or F10 |
  | Step in | F7 or F11 |
  | Step out | F8 or ⇧F11 |
  | Continue | F5 or ⌃⌘Y |

- **Code fields** (editor, `>>>`, `input()`): no auto-capitalization,
  autocorrection or smart punctuation, enforced natively.
- **HTTP** (D25): `requests`, `urllib`, `httpx` and `pyfetch` work without
  CORS limits. Cross-origin requests from Python go through the host, which
  makes them with `URLSession`; a custom `User-Agent` works too. Example:
  `Web Requests.py`.
- **Run / Stop**: the file's folder is copied into the interpreter as the
  working directory, so `open()`, `sqlite3` and imports of sibling modules
  work. Files the program creates, changes or deletes are written back while
  it idles (within about a second) and when it ends (D27). Stop raises `KeyboardInterrupt`
  and kills the program after 1.5 s (D11).
- **Console**: streaming output, `input()`, tracebacks without Pyodide's
  internal frames whose `File "x.py", line N` entries open that line, inline matplotlib plots (`plt.show()`), and a `>>>` prompt
  that runs in the program's globals after it finishes (last expression is
  shown, top-level `await` works).
- **Debugger** (D23):
  - Long-press a line number to set a breakpoint. Long-press it again to
    disable or remove it.
  - Run as usual: the program stops there and the editor turns read-only
    with the line highlighted.
  - Step over, in or out from the console header (iPhone) or the nav bar
    (iPad), and Continue from the Run button.
  - The console shows the stack and the variables. Tap a name in the editor
    for its value, and `>>>` runs in the paused function.
  - Pause (in the console header) stops a running program, e.g. an endless
    loop.
  - `breakpoint()` works too.
  - After an error, Inspect opens the same view on the failing line.
  - Breakpoints cost nothing while they are not hit.
- **UI apps**: programs using `import ui` open full screen; "Done" ends
  the program. The module is Solid-style (D26): components run once, and
  signals and lambdas update exactly what changed. It includes navigation,
  tabs, sheets, dialogs, lists, all common inputs and a canvas (see
  `uikit/README.md`). Files the app writes while it runs (e.g. saved data)
  reach the disk within about a second (D27). `Examples/Todo App.py` is a
  complete Reminders-style app that keeps its data in an SQLite database
  (`todos.db`).
- **Crashes**: a native stack overflow ends the run with "Python crashed" and
  the next run gets a fresh interpreter (D16).
- **Layouts**: on iPhone, Files → Code/Console; on iPad, a sidebar with the
  editor and console side by side (stacked in portrait).

## Layout

```
app/
  run.sh                  build + run (simulator or --device), --selftest, --reset
  scripts/fetch-pyodide.sh
  scripts/build-ty.sh       builds ty's wasm (not on npm) from a pinned ruff commit
  vendor/                 Pyodide core (gitignored)
  ios/                    Swift host: Pyslopnista.xcodeproj (hand-written, D19)
    Sources/App.swift          WKWebView, bridge, native dialogs
    Sources/AppSchemeHandler.swift  app:// with COOP/COEP, package cache (D9, D12)
    Sources/FileStore.swift    file operations on Documents and linked folders (D28)
    Sources/Locations.swift    linked folders: bookmarks from the folder picker
    copy-web.sh                build phase: web/dist + Pyodide into the bundle
  web/                    React + Vite + TypeScript (D18)
    public/runtime/       py-worker.js, sab-polyfill.js, python/_pyslop.py, python/ui.py (from uikit/),
                          python/_pyslop_debug.py (debugger)
    public/examples/      seeded into Documents/Examples
    src/                  App, Editor (CodeMirror), KeyBar, Console, FileBrowser,
                          UIAppView, ProblemBar, session (run/console/UI state),
                          python (worker pool), host (bridge + browser mock), selftest
    src/analysis/         ruff + ty worker, client, CodeMirror lint/completions/fixes
    src/debug/            breakpoints store, CodeMirror gutter/paused line/inspect, debugger views
                          (App: panes and tabs, TabBar, navigation for links into files)
```

## Running

```sh
./run.sh                                  # booted simulator
./run.sh --selftest                       # end-to-end checks in the simulator (JSON)
./run.sh --device                         # on the paired iPhone (unlocked)
./run.sh --device --selftest
SIM=<udid> ./run.sh                       # a specific simulator (e.g. an iPad)
FRAGMENT="open=Examples/Plot.py&run" ./run.sh   # launch hooks: open, bp=<lines>, split=<path>, run, pane, focus, keybar
FRAGMENT="selftest&only=debugger" ./run.sh --selftest   # a subset of the checks
cd web && npm run dev                     # desktop browser; files in localStorage
```

## Status (2026-10-13)

`./run.sh --selftest` passes all 35 checks in the iPhone 17 simulator
(2026-10-13). In the iPad Pro 11 simulator, 34 pass; `stop` fails only
because that simulator's `Examples/Countdown.py` was edited to raise. The
33 checks before D27/D28 passed in both. An earlier set of 19 also passed on the iPhone 14 Pro
(`--device`). The checks are: examples seeded, edit → autosave → run,
`input()`, traceback cleanup, `>>>` console, file write-back, sibling
imports, inline plot, Stop, UI app, todo app (navigation, typing, saving
into `todos.db` while the app runs, reading it back), linked folder (bookmark,
list, run, write-back, remove), crash recovery, ruff/ty startup,
diagnostics (F401, invalid-argument-type, unresolved-reference), completions,
formatting, Pyodide imports not flagged, add-dependency quick fix + install
from PyPI, cached rerun, requires-python, debugger (breakpoint → evaluate →
assignment → step → continue, Pause + Stop, breakpoint added while running,
Inspect after an error, `breakpoint()`), traceback links, go to definition
(project and stdlib), tabs, split view (iPad), HTTP (requests, urllib, httpx,
pyfetch, connection errors), plain keyboard traits in code fields, and typing
into the console fields through UIKit's text input.

On the iPhone 14 Pro: ruff/ty start in 120-140 ms, the first check of a file
takes about 400 ms, completions 44 ms, formatting 57 ms; installing a small
PyPI package and running takes 0.8 s (1.3 s when cached).

## Known gaps

- iPadOS does not list our shortcuts in the ⌘-hold overlay (they are handled
  in the web view, not as UIKeyCommands).
- HTTP is request/response only: no WebSockets or raw sockets; responses are
  buffered, not streamed.
- Typing into the console fields was reported broken on a device (not
  reproduced yet). Focusing a field from code (`input()`) may not bring up the
  keyboard by itself.
- No package UI beyond the script block (imports of Pyodide packages
  auto-load; `micropip` works from the console). No lock files yet.
- ty has no type information for installed third-party packages (it only
  knows the standard library); their imports are simply not flagged.
- "Jump to Definition" and "Show Info" in the selection menu have not been
  tried on a device yet.
