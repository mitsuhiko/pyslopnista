# AGENTS.md

A Pythonista replacement for iOS: a native SwiftUI app, with Pyodide and
CodeMirror in web views (D31), native ui apps (D30) and a pi-durable coding
agent. Early research phase.

## Where things live

- `app/`: the real app (see `app/README.md`). Build and test with `app/run.sh`
  (`--selftest`, `--device`). Keep `./run.sh --selftest` passing.
  - `app/ios/Sources/Shell/`: the native IDE (SwiftUI). `app/ios/Sources/UIRenderer/`: ui apps.
  - `app/web/`: two pages, `engine.html` (Python, analysis, the self-test) and `editor.html` (CodeMirror).

- `uikit/`: the `ui` module (D26, Solid-style signals): `python/ui.py`, the
  web renderer for published apps (`web/renderer.js`, `web/ui.css`), examples
  and a playground. Edit it there, then run `uikit/scripts/install.sh` to copy
  `ui.py` into `app/web`. Test with `uikit/run.sh --selftest` (host pytest +
  headless Chrome). A change to the op protocol needs both renderers: the web
  one and `app/ios/Sources/UIRenderer/`.

- `GOALS.md`: the feature set, tagged [core]/[later]/[maybe]. Update it when scope changes.
- `DECISIONS.md`: decisions D<n> (append-only), proposals P<n>, open questions Q<n>.
  When a spike answers a question, add a decision or note that cites the spike,
  and remove the question.
- `spikes/<name>/`: throwaway experiments. Each one has a `README.md` with the
  question, how to run it, the results and the date. Spikes are never production code.

## Current work

App (`app/`): native SwiftUI IDE (D31) with files, editor, run, console, native UI apps (D26, D30, `uikit/`), turtle (D29), ruff + ty,
PEP 723 dependencies, visual debugger (D23), tabs and split view with
traceback links and go to definition (D24), outline / go to line / find in
folder / show info / settings / keyboard shortcuts, HTTP through the host (D25),
and the coding agent (D34: pi-durable in the engine page, sign-in with pi-ai's
flows, D33; conversations per project and IDE tools, D36). Next: the agent on a device (Q22), the rest of D34's list (write
conflicts, per-turn undo, teaching mode, iPad panel), then the gaps in
`app/README.md` (Q16-Q18). `app/scripts/build-ty.sh` needs Rust + wasm-pack.

Spike queue (update the status here). The pi-durable agent always comes last
(D8); never start agent work before the spikes ahead of it are done.

1. [x] `ios-host`: Swift host, WKWebView, `app://` scheme handler; probe inside it (Q1 answered: D9; Q2/Q3 narrowed)
2. [x] `pyodide-worker`: bundled Pyodide in a worker: console, `input()`, interrupt, restart, package cache (D10-D12; open: PyPI offline cache, Q11)
3. [x] `ui-toolkit`: declarative Python UI in the app and exported as a static site (D14, D15)
4. [x] `device-perf`: real-phone startup, memory, speed, bridge latency, backgrounding, wasm-GC trampoline check (D13 confirmed, D16; open: App Intents Q6, Q14, Q15)
5. [x] `debugger`: breakpoints, stepping, pause and post-mortem on bdb's `monitoring` backend (D23, built into the app; open: Q19)
6. [x] `agent`: pi-durable in a web view on native SQLite, a project `ExecutionEnv`, streaming proxy, resume after a reload, pi-ai sign-in flows with a loopback listener and the Keychain (D32, D33). Built into the app (D34).

Done:
- [x] `jspi-repro`: JSPI "hang" root-caused to CPython's iOS JS-trampoline fallback (D13)
- [x] `webkit-probe`: wasm and threading features of iOS 27 Safari (simulator)
- [x] `host-fs`: Pyodide on the host's files (an Emscripten FS over sync XHR), costs, caches, SQLite crash safety (D35, built into the app)

## Conventions

- Environment: Xcode 27, iOS 27 simulator, macOS 26.
- Python tooling on the host goes through `uv`.
- Write dates as YYYY-MM-DD.
- Spikes with a web part have `run.sh --selftest [steps]`, which prints JSON from
  the simulator. Prefer the app over Safari for automated runs; driving Safari
  with `simctl openurl` reuses tabs and is unreliable.
- Never claim a result from the simulator or Safari applies to a real device or to WKWebView; say which one was tested.
- Device runs: `spikes/device-perf/run.sh` (paired iPhone 14 Pro, personal team `ZRL6J4P42H`). The phone must be unlocked; ask the user first.
