# ui-toolkit

2026-10-13 - WKWebView in the pyodide-worker host app, plus exported apps in
mobile Safari. iOS 27 simulator (iPhone 17). Not a real device.

**Questions:** Is a declarative Python UI (P2) pleasant to write, fast enough
over the worker boundary, and can the same app be published as a static site
(D5)?

## What it is

- `web/ui.py`: the Python API. `ui.state(value)` and `ui.run(view)`. The view is
  a function returning components: `Screen`, `Section`, `VStack`, `HStack`,
  `Spacer`, `Text`, `Button`, `TextField`, `Toggle`, `Slider`, `Row`, `Image`.
  - When state changes, `view()` runs again. The whole tree is serialized to
    JSON and sent to the page.
  - Callbacks become ids based on their position in the tree, so they stay
    stable across renders.
  - Changes made inside an event handler are rendered right after it.
    Changes made elsewhere (timers, asyncio tasks) are batched with `call_soon`.
  - A handler can take the event value or not (`lambda: ...` or `def f(value)`),
    and async handlers work.
- `web/ui-renderer.js`: renders the JSON tree and patches the DOM. Nodes are
  matched by type and key; keyed children are moved, not recreated. Handlers
  read the current callback id when they fire. Text fields are controlled
  without resetting the caret.
- `web/ui.css`: iOS styling (inset grouped sections, large titles, switches,
  button styles, dark mode).
- `web/examples/`: `counter`, `todo` (keyed rows, text field, toggle, delete),
  `timer` (state changed from an asyncio task), `widgets`.
- `web/index.html` + `playground.js`: example picker, editor, console. The app
  appears full screen when it renders; "Done" closes it and kills its worker.
- `export.py`: turns an app into a static site, `serve.py` serves it like a
  plain static host (no COOP/COEP). `web/standalone.js` is the exported app's
  entry point.

```sh
./run.sh                               # playground in the simulator
FRAGMENT=run=todo ./run.sh             # start an example directly
./run.sh --selftest                    # scripted checks, JSON
uv run export.py web/examples/counter.py dist/counter
uv run serve.py dist/counter           # http://127.0.0.1:18768/ (append #selftest)
```

The pyodide-worker runtime gained the options this needed: a configurable
Pyodide URL, Python files written at boot, `ui-render`/`ui-event` messages, and
working without cross-origin isolation.

## Results (simulator)

Measured from the DOM event to the patched DOM: event → postMessage → Python
callback → `view()` → JSON → postMessage → patch.

| Check | Result |
|---|---|
| Counter tap round trip (50 taps) | average 0.24 ms, p95 1 ms |
| Todo keystroke round trip (controlled TextField) | average 0.5 ms, p95 2 ms |
| Keyed rows: insert, toggle, delete | DOM elements reused |
| asyncio timer updating state | 9-10 renders/s, stops when toggled off |
| Exception in a callback | traceback in the console; app keeps working |
| 1,000 keyed rows: first render | 21 ms (Python 4 ms, DOM 4 ms, 72 KB JSON) |
| 1,000 rows reversed / first dropped | 26 ms / 23 ms (Python 3-5 ms, DOM 7 ms) |
| Run again | fresh worker, state reset |
| Exported counter in plain mobile Safari, not isolated, Pyodide from CDN | first render 1.23 s, tap 0.25 ms, JSPI + wasm-GC trampoline |
| Exported site size | 12 files, 37 KiB (+ Pyodide from CDN) |

## Findings

- The worker boundary costs nothing noticeable. Re-rendering and resending the
  whole tree is fine up to about 1,000 rows (a 72 KB message, around 25 ms).
  Diffing on the Python side can come later if needed.
- "View is a function of state" maps well onto Python. Positional callback ids
  make lambdas in list comprehensions work (`lambda t=t: ...`).
- Exported apps need no special hosting: without isolation there is no
  `input()` and no Stop button, which UI apps don't need.

## Not covered yet

- Navigation stacks, sheets and alerts; images from project files; a canvas
  or drawing API; animations.
- Composed text input (CJK, dictation) with controlled text fields.
- Accessibility beyond native `button`/`input` semantics.
- Offline for published apps (needs a service worker and self-hosted Pyodide);
  iOS ignores SVG `apple-touch-icon`, so a PNG icon is needed.
- The status bar area above the app view in the playground isn't styled.
- Real-device latency and first-load time.
