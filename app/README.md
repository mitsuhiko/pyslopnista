# Pyslopnista app

The actual app (not a spike): a Pythonista-style Python IDE for iPhone and
iPad. Swift host + web app (D4), Python in Pyodide workers (D2, D6).

## Features (first version)

- **Files**: projects live in the app's Documents folder, which also shows up
  in the Files app ("On My iPhone"). Create, rename, duplicate and delete files
  and folders (native dialogs). Examples are copied into `Examples/` on first
  launch.
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
- **Run / Stop**: the file's folder is copied into the interpreter as the
  working directory, so `open()` and imports of sibling modules work. Files the
  program creates or changes are written back. Stop raises `KeyboardInterrupt`
  and kills the program after 1.5 s (D11).
- **Console**: streaming output, `input()`, tracebacks without Pyodide's
  internal frames, inline matplotlib plots (`plt.show()`), and a `>>>` prompt
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
- **UI apps**: programs using `import ui` (D14) open full screen; "Done" ends
  the program.
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
    Sources/FileStore.swift    Documents-backed file operations
    copy-web.sh                build phase: web/dist + Pyodide into the bundle
  web/                    React + Vite + TypeScript (D18)
    public/runtime/       py-worker.js, sab-polyfill.js, python/_pyslop.py, python/ui.py,
                          python/_pyslop_debug.py (debugger)
    public/examples/      seeded into Documents/Examples
    src/                  App, Editor (CodeMirror), KeyBar, Console, FileBrowser,
                          UIAppView, ProblemBar, session (run/console/UI state),
                          python (worker pool), host (bridge + browser mock), selftest
    src/analysis/         ruff + ty worker, client, CodeMirror lint/completions/fixes
    src/debug/            breakpoints store, CodeMirror gutter/paused line/inspect, debugger views
```

## Running

```sh
./run.sh                                  # booted simulator
./run.sh --selftest                       # end-to-end checks in the simulator (JSON)
./run.sh --device                         # on the paired iPhone (unlocked)
./run.sh --device --selftest
SIM=<udid> ./run.sh                       # a specific simulator (e.g. an iPad)
FRAGMENT="open=Examples/Plot.py&run" ./run.sh   # launch hooks: open, bp=<lines>, run, pane, focus, keybar
FRAGMENT="selftest&only=debugger" ./run.sh --selftest   # a subset of the checks
cd web && npm run dev                     # desktop browser; files in localStorage
```

## Status (2026-10-13)

`./run.sh --selftest` passes all 24 checks in the iPhone 17 simulator. The 19
checks without the debugger also pass on the iPhone 14 Pro (`--device`). The
checks are: examples seeded, edit → autosave → run,
`input()`, traceback cleanup, `>>>` console, file write-back, sibling
imports, inline plot, Stop, UI app, crash recovery, ruff/ty startup,
diagnostics (F401, invalid-argument-type, unresolved-reference), completions,
formatting, Pyodide imports not flagged, add-dependency quick fix + install
from PyPI, cached rerun, requires-python, debugger (breakpoint → evaluate →
assignment → step → continue, Pause + Stop, breakpoint added while running,
Inspect after an error, `breakpoint()`).

On the iPhone 14 Pro: ruff/ty start in 120-140 ms, the first check of a file
takes about 400 ms, completions 44 ms, formatting 57 ms; installing a small
PyPI package and running takes 0.8 s (1.3 s when cached).

## Known gaps

- Run results from UI apps that write files after the script returns are not
  written back.
- The iOS form accessory bar (prev/next/done) still appears above our key bar
  with the software keyboard.
- No tabs or multiple open files on iPad; no find-in-project; no settings
  (font size, wrapping).
- No package UI beyond the script block (imports of Pyodide packages
  auto-load; `micropip` works from the console). No lock files yet.
- ty has no type information for installed third-party packages (it only
  knows the standard library); their imports are simply not flagged.
- Hover (type info) and go-to-definition exist in ty but are not wired up for
  touch yet.
