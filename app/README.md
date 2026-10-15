# Pyslopnista app

The actual app (not a spike): a Pythonista-style Python IDE for iPhone and
iPad. A native SwiftUI app (D31); Python runs in Pyodide workers (D2, D6) in a
web view without UI, the editor is CodeMirror in a web view per pane, and ui
apps are native views (D30).

## Features (first version)

- **Files**: projects live in the app's Documents folder, which also shows up
  in the Files app ("On My iPhone"). Create, rename, duplicate and delete files
  and folders (native dialogs). Examples are copied into `Examples/` on first
  launch.
- **Linked folders** (D28): "Open Folder…" (⋯ menu, or under Locations at the
  top level) adds a folder from iCloud Drive, another app (e.g. Working Copy),
  a file provider or a drive. It works like a folder in Documents: edit and
  run. A program runs on a local copy, and what it changes goes back with
  file coordination as it goes (D35). Files that are only in iCloud are
  downloaded when opened.
  Swipe a location to remove it (its files stay).
- **Editor**: CodeMirror 6 with Python highlighting, autocompletion, auto-indent,
  bracket closing, search, undo history per file, soft wrapping with hanging
  indent, light/dark themes. Saves automatically. A row of extra keys sits above
  the keyboard (indent/dedent, brackets and quotes with the cursor placed
  inside, operators, undo/redo, comment), also for the console's `>>>` and
  `input()` fields. It shows only with the software keyboard (not with a
  hardware keyboard, or after hiding the keyboard on iPad).
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
- **Run / Stop**: the file's folder is the program's working directory, used
  in place (D35): `open()`, `sqlite3` (with its journal, on the real
  database) and imports of sibling modules work, and what the program writes
  is on disk at once (at the latest when it idles or blocks, within a quarter
  second). Stop raises `KeyboardInterrupt` and kills the program after 1.5 s
  (D11).
- **Console**: Return in `>>>` or `input()` scrolls to the end; streaming output, `input()`, tracebacks without Pyodide's
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
- **Turtle graphics** (D29): `import turtle` is CPython's own module, drawn
  on a canvas inline in the console, animated at turtle's speeds. Taps
  (`onclick`, `onscreenclick`, drag and release), hardware keys (`onkey`),
  timers and `textinput`/`numinput` work. A program with handlers keeps
  running until Stop (or `bye()`), even without `done()`. Examples:
  `Turtle.py`, `Catch the Turtle.py`.
- **UI apps**: programs using `import ui` open full screen as native SwiftUI
  views (D30); "Done" ends the program. The module is Solid-style (D26): components run once, and
  signals and lambdas update exactly what changed. It includes navigation,
  tabs, sheets, dialogs, lists, all common inputs and a canvas (see
  `uikit/README.md`). Files the app writes while it runs (e.g. saved data)
  reach the disk right away (D35). `Examples/Todo App.py` is a
  complete Reminders-style app that keeps its data in an SQLite database
  (`todos.db`).
- **Coding agent** (D34, D36): the ✨ button (in the editor and the file
  browser, or ⌘⇧A) opens a conversation about the current project (the
  top-level folder, or a linked folder).
  - **What it can do:** read, write and edit files; ls, find and grep;
    run Python (a fresh interpreter with the folder copied in; written
    files are saved back, plots come back as images); check with ruff and
    ty; format with ruff.
  - **In the IDE** (D36): `ide_*` tools open a file at some lines to show
    you something, close tabs, and lint or format what is in the editor
    (undoable). They act only for the conversation on screen and don't
    switch away from a file you are typing in. On iPhone the sheet drops
    to half height when the agent opens a file.
  - **Where you are:** your active file, cursor, selection, tabs and a
    failed run reach the agent when they change: with your message, or
    at its next step while it works ("Now in greet.py").
  - **What you see:** tool calls fold out to show their output or diff,
    with a link to the file. IDE tools are one line each. Its edits show
    up in open editors.
  - **Conversations:** several per project (tap the title for the list,
    ✎ for a new one), with running and unread marks; rename and archive.
    Other conversations keep running in the background.
  - **Durable:** conversations are pi-durable on native SQLite (D32), with
    the app's index next to it. A turn the engine was in the middle of
    continues after a crash or relaunch.
  - **Accounts (⋯ → Accounts):**
    - Radius first (sign-in or API key); its models are the default once
      you're signed in, and its model list is fetched from the gateway;
    - subscriptions: Claude Pro/Max, ChatGPT (Codex), Sign in with
      ChatGPT, GitHub Copilot, xAI, Kimi, Meta;
    - OpenRouter;
    - API keys for Anthropic, OpenAI, Google, Mistral, Groq and DeepSeek.
  - **Sign-in** runs pi-ai's own flows in a browser sheet. Credentials stay
    in the Keychain (D33).
  - Pick the model from ⋯ → Model.
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
  scripts/make-turtle.py    turtle.py from CPython's, with the Tk part swapped (D29)
  vendor/                 Pyodide core (gitignored)
  ios/                    the native app: Pyslopnista.xcodeproj (hand-written, D19)
    Sources/App.swift          entry point
    Sources/Shell/             the IDE in SwiftUI (D31): AppModel (state and actions), WebHost (web views
                               and their bridge), SessionMirror (the engine's session), RootView,
                               FileBrowserView, EditorViews (panes, tabs, nav bar), ConsoleView,
                               DebugViews, Panels (find, go to, problems, settings), Turtle, SelfTest
    Sources/UIRenderer/        ui apps as SwiftUI views (D30): UIStore (op stream), views, canvas
    Sources/Agent/             the agent's host side (D32, D33): SQLite, Keychain, loopback listener for OAuth,
                               the sign-in browser and prompts (AgentHost)
    Sources/AppSchemeHandler.swift  app:// with COOP/COEP, package cache, streaming HTTP proxy, /__fs (D9, D12, D25, D35)
    Sources/FileStore.swift    file operations on Documents and linked folders (D28), staging copies
    Sources/HostFS.swift       programs' file operations on their folder; linked folders' sync back (D35)
    Sources/Locations.swift    linked folders: security-scoped bookmarks
    Sources/KeyboardAccessory.swift, CodeWebView.swift   key bar and selection menu for the editor
    copy-web.sh                build phase: web/dist + Pyodide into the bundle
  web/                    two pages, Vite + TypeScript, no UI framework (D31)
    engine.html           Python and analysis, never shown (src/engine/: commands, state sync)
    editor.html           one CodeMirror pane (src/editor/)
    public/runtime/       py-worker.js, hostfs.js (the project folder in Pyodide, D35), sab-polyfill.js,
                          python/_pyslop.py, python/ui.py (from uikit/),
                          python/_pyslop_debug.py (debugger), python/turtle.py (generated by
                          scripts/make-turtle.py) + python/_pyslop_turtle.py (its backend)
    public/examples/      seeded into Documents/Examples
    src/                  session (runs, console, debugger), python (worker pool), turtle (scenes and
                          events), host (bridge), selftest (runs in the engine, drives the app)
    src/analysis/         ruff + ty worker, client, CodeMirror lint/completions/fixes
    src/debug/            breakpoints, CodeMirror gutter/paused line/inspect
    src/agent/            the coding agent (D34, D36): service (Harness, conversations, state for the host),
                          conversations (the index), tools (project tools), ide (IDE tools and context),
                          env (the project as an ExecutionEnv), sqlite (bridge adapter), credentials, login
                          (pi-ai's flows; shims/ for node:http and node:crypto), prompt, proxy (fetch via /__http)
```

## Running

```sh
./run.sh                                  # booted simulator
./run.sh --selftest                       # end-to-end checks in the simulator (JSON)
./run.sh --device                         # on the paired iPhone (unlocked)
./run.sh --device --selftest
SIM=<udid> ./run.sh                       # a specific simulator (e.g. an iPad)
FRAGMENT="open=Examples/Plot.py&run" ./run.sh   # launch hooks: open, bp=<lines>, split=<path>, run, pane, focus, agent[=accounts|conversations]
FRAGMENT="selftest&only=debugger" ./run.sh --selftest   # a subset of the checks
```

The pages can be inspected with Safari's Web Inspector (Develop → Simulator):
"Engine" and one "Editor" per pane.
```

## Status (2026-10-15)

Since D31 the app is native SwiftUI. `./run.sh --selftest` passes all 46
checks in the iPhone 18 Pro simulator, including `agent` (D34),
`project_files_in_place` (D35), `agent-ide` and `agent-conversations` (D36)
(2026-10-15). In the iPhone 17 simulator `turtle_catch_example` fails (also
without D36); before D35, 43 passed there.

In the iPad Pro 13" simulator 43 pass and `keybar_only_with_software_keyboard`
fails (the bar stays after the keyboard's own hide key); it failed the same
way before the agent and D35. Before the agent, all
42 passed in the iPhone 18 Pro and iPad Pro 13" simulators (2026-10-15), and
40 in the iPhone 17 (2026-10-14). The new ones tap the key bar in the `>>>` field
and check that it shows only with the software keyboard. The
self-test runs in the engine page and drives the native views through hooks
(`Shell/SelfTest.swift`): ui apps through the renderer's tree, typing through
UIKit into the native console fields, turtle checks on the native drawing.
None of the native shell has been tried on a device yet.

Before D31: `./run.sh --selftest` passed all 39 checks in the iPhone 17 simulator
(2026-10-13), including the four turtle checks, which also pass in the iPad
Pro 11 simulator. Of the 35 before turtle, 34 passed in the iPad Pro 11
simulator; `stop` failed only because that simulator's
`Examples/Countdown.py` was edited to raise. The 33 checks before D27/D28 passed in both. An earlier set of 19 also passed on the iPhone 14 Pro
(`--device`). The checks are: examples seeded, edit → autosave → run,
`input()`, traceback cleanup, `>>>` console, file write-back, sibling
imports, project files used in place (live writes, outside edits, renames,
no `__pycache__`), inline plot, Stop, UI app, todo app (navigation, typing, saving
into `todos.db` while the app runs, reading it back), linked folder (bookmark,
list, run, write-back, remove), crash recovery, ruff/ty startup,
diagnostics (F401, invalid-argument-type, unresolved-reference), completions,
formatting, Pyodide imports not flagged, add-dependency quick fix + install
from PyPI, cached rerun, requires-python, debugger (breakpoint → evaluate →
assignment → step → continue, Pause + Stop, breakpoint added while running,
Inspect after an error, `breakpoint()`), traceback links, go to definition
(project and stdlib), tabs, split view (iPad), turtle (drawing pixels, a tap
and a key reaching handlers, `bye()`, a timer program until Stop, both
examples, catching the turtle with a tap), HTTP (requests, urllib, httpx,
pyfetch, connection errors), plain keyboard traits in code fields, and typing
into the console fields through UIKit's text input.

On the iPhone 14 Pro: ruff/ty start in 120-140 ms, the first check of a file
takes about 400 ms, completions 44 ms, formatting 57 ms; installing a small
PyPI package and running takes 0.8 s (1.3 s when cached).

## Known gaps

- Agent (D34):
  - Not tried on a device. Whether the sign-in sheet reaches the loopback
    listener there is Q22.
  - Only Claude Pro/Max has been signed in to for real (in the spike).
  - It is a sheet, not a panel on iPad.
  - IDE tools can't run a program in the app (`ide_run`, for turtle and
    ui apps, is not built).
  - No per-turn undo.
  - A write to a file you are typing in replaces the editor's text.
  - No teaching mode.

- Native shell (D31), not tried on a device yet: memory with three
  WebContent processes, the editor's keyboard and focus, the key bar.
- The problem bar is still HTML inside the editor page.
- Turtle screens in the console fit the width but not the console's height.
- HTTP is request/response only: no WebSockets or raw sockets; responses are
  buffered, not streamed.
- No package UI beyond the script block (imports of Pyodide packages
  auto-load; `micropip` works from the console). No lock files yet.
- ty has no type information for installed third-party packages (it only
  knows the standard library); their imports are simply not flagged.
- "Jump to Definition" and "Show Info" in the selection menu have not been
  tried on a device yet.
- Turtle: no on-screen keyboard for `onkey` games on a phone, no scrolling
  of canvases bigger than the window. Not tried on a device yet.
