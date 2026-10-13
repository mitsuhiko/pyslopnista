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
- **Run / Stop**: the file's folder is copied into the interpreter as the
  working directory, so `open()` and imports of sibling modules work. Files the
  program creates or changes are written back. Stop raises `KeyboardInterrupt`
  and kills the program after 1.5 s (D11).
- **Console**: streaming output, `input()`, tracebacks without Pyodide's
  internal frames, inline matplotlib plots (`plt.show()`), and a `>>>` prompt
  that runs in the program's globals after it finishes (last expression is
  shown, top-level `await` works).
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
  vendor/                 Pyodide core (gitignored)
  ios/                    Swift host: Pyslopnista.xcodeproj (hand-written, D19)
    Sources/App.swift          WKWebView, bridge, native dialogs
    Sources/AppSchemeHandler.swift  app:// with COOP/COEP, package cache (D9, D12)
    Sources/FileStore.swift    Documents-backed file operations
    copy-web.sh                build phase: web/dist + Pyodide into the bundle
  web/                    React + Vite + TypeScript (D18)
    public/runtime/       py-worker.js, sab-polyfill.js, python/_pyslop.py, python/ui.py
    public/examples/      seeded into Documents/Examples
    src/                  App, Editor (CodeMirror), KeyBar, Console, FileBrowser,
                          UIAppView, session (run/console/UI state), python (worker
                          pool), host (bridge + browser mock), selftest
```

## Running

```sh
./run.sh                                  # booted simulator
./run.sh --selftest                       # end-to-end checks in the simulator (JSON)
./run.sh --device                         # on the paired iPhone (unlocked)
./run.sh --device --selftest
SIM=<udid> ./run.sh                       # a specific simulator (e.g. an iPad)
FRAGMENT="open=Examples/Plot.py&run" ./run.sh   # launch hooks: open, run, pane, focus, keybar
cd web && npm run dev                     # desktop browser; files in localStorage
```

## Status (2026-10-13)

`./run.sh --selftest` passes all 11 checks in the iPhone 17 simulator:
examples seeded, edit → autosave → run, `input()`, traceback cleanup,
`>>>` console in the program's globals, file write-back, sibling imports,
inline plot, Stop, UI app, crash recovery. Screenshots were checked for
iPhone (files, editor with wrapping and key bar, console with plot) and
iPad Pro 11. The app installs on the iPhone 14 Pro; the device self-test
still needs an unlocked phone.

## Known gaps

- Run results from UI apps that write files after the script returns are not
  written back.
- The iOS form accessory bar (prev/next/done) still appears above our key bar
  with the software keyboard.
- No tabs or multiple open files on iPad; no find-in-project; no settings
  (font size, wrapping).
- No pip/package UI yet (imports of Pyodide packages auto-load; `micropip` works
  from the console).
