# uikit: the `ui` module, Solid-style

2026-10-13. The standard library for building UI apps in Python: fine-grained
reactivity in the style of SolidJS, replacing D14's re-render model (D26).
This folder is the source of truth; `scripts/install.sh` copies it into the
app.

```python
import ui

def Counter():
    count = ui.signal(0)
    return ui.Screen(
        "Counter",
        ui.Text(lambda: f"{count()} taps", font="largeTitle"),
        ui.Button("Tap me", on_click=lambda: count.update(lambda n: n + 1)),
    )

ui.run(Counter)
```

## The model (one paragraph to learn)

Components are plain functions that run **once** and return elements. State
lives in **signals** (`count = ui.signal(0)`, read with `count()`, write with
`count.set(1)`). Any **function** you pass as a prop or child (a `lambda`, or a
signal itself) becomes a live binding. It re-runs when the signals it read
change, and it updates exactly that one spot on screen. Nothing is
re-rendered or diffed, so text fields keep their focus, scroll positions stay
put, and toggling one row of 1,000 sends one tiny update.

If you read a signal while building the UI without a lambda, `ui` prints a hint
with your file and line. That spot would never update. `.peek()` reads on
purpose without the hint.

## API

| Area | Names |
|---|---|
| State | `signal`, `computed`, `effect`, `batch`, `untrack`, `store` (deep reactive dicts and lists, `todo.done = True`), `bind(store, key)` (two-way), `unwrap` |
| Lifecycle | `on_cleanup`, `on_mount`, `interval`, `timeout` (cancelled with their component), `resource(fetcher, source)` (async data with `.loading()` and `.error()`) |
| Control flow | `Show(when, *children, fallback=)`, `For(each, render, key=, fallback=)` (keyed, minimal moves, `render(item, index)`), any `lambda` child |
| App | `run(app, theme=, tint=)`, `css(text)`, `navigation()`, `await alert/confirm/prompt/choose(...)`, `toast(...)` |
| Layout | `VStack`, `HStack`, `ZStack`, `Grid`, `ScrollView`, `Spacer`, `Divider`, `Card` |
| Navigation | `NavigationStack(root)` with `.push(Screen, *args)` / `.pop()` (and edge swipe), `Screen(title, ..., leading=, trailing=)`, `TabView`/`Tab`, `Sheet(open=signal)` |
| Lists | `Section(header=, footer=)`, `Row(title, subtitle=, detail=, icon=, accessory=, checked=, on_click=, on_delete=)` (swipe to delete) |
| Content | `Text(font=)`, `Label`, `Icon` (built-in set or emoji), `Image` (URL, project file, bytes, PIL image, matplotlib figure), `ProgressView`, `Link`, `Html` |
| Inputs | `Button(kind=)`, `TextField`, `TextArea`, `Toggle`, `Slider`, `Stepper`, `Picker` (segmented or menu), `DatePicker` (`datetime.date`), `ColorPicker`. Pass a signal as `value` and it is kept in sync both ways |
| Drawing | `Canvas(draw, width=, height=, on_frame=, on_pointer_down/move/up=)`: the browser's canvas 2D API in snake_case, redrawn when signals change. `on_frame(dt)` is a game loop |
| Escape hatches | `h(tag, *children, **attrs)` for any HTML/SVG element and any DOM event (`on_keydown=lambda e: e.key`), `Html`, `css`, `Element.focus()` |

Every element accepts `on_<event>` for any DOM event it doesn't handle itself
(e.g. `on_click` on a `Card`). Every element also takes layout and style keywords, static or live: `padding`,
`margin`, `width`, `height`, `min_*`/`max_*`, `flex`, `background`, `color`,
`font_size`, `font_weight`, `text_align`, `corner_radius`, `border`,
`opacity`, `shadow`, `hidden`, `disabled`, `style={...}`, `class_`,
`aria_label`.

Event handlers can take the event value or nothing (`lambda: ...` or
`def f(value)`), and can be `async` (dialogs are awaited). Handlers run batched,
inside the component that created them, so `ui.navigation()` works there.

See `examples/`: Counter, Todos (store, For, filters, swipe to delete,
confirm), Todo App (the complete Reminders-style app shipped in the app:
smart lists, search, sorting, due dates, priorities, notes, autosave to
`todos.json`), Navigation (push, sheet, prompt, toast, `bind`), Settings (every
input), Tabs (tabs, a stack per tab, badge, a stopwatch whose interval belongs
to an effect), Paint (pointer events), Bounce (game loop), Escape Hatches
(`h`, `css`, `resource`, SVG), Plot (live matplotlib).

## How it works

- `python/ui.py` (one file, so it drops in as the app's `ui.py` and ty can
  still read it as a stub):
  - **Reactive core.** A push-pull graph: a write marks observers dirty, then
    effects pull, so updates are glitch-free and a computed that doesn't
    change stops propagation. Computations own what they create (bindings,
    nested effects, timers, cleanups) and dispose it before re-running.
  - **Element tree.** Elements get ids and are created detached. Once their
    parent is on screen, every change becomes an op. Regions (`Show`, `For`,
    lambda children) own a run of siblings. `For` reconciles by key and moves
    only rows that are off the longest increasing run (LIS).
  - **Flushing.** Ops are batched per event handler, or per event-loop tick
    for timers and async tasks, and go to the page as one message.
- `web/renderer.js`: `new UIRenderer(root, sendEvent)`, `.render(json)`,
  `.clear()`, which is the same interface as `app/web/src/uiRenderer.js`.
  - It keeps an id → DOM node map and one builder per element type.
  - Animations live here: push/pop, sheets, swipe gestures, segmented control.
  - Inputs echo nothing: Python records the value the page reported, so
    two-way bindings never fight the caret.
  - A new renderer sends `0:resync`, and Python answers with `reset` plus a
    full snapshot. A view can therefore attach late or be re-created, e.g.
    when D23 hides the app view at a breakpoint.
- `web/ui.css`: iOS styling, light and dark mode, safe areas. Same class names
  as before for the app selftest (`.ui-button`, `.ui-text-largeTitle`).

Protocol: Python calls `_uihost.render('{"seq": n, "ops": [...]}')`. The page
calls the dispatcher with `("<id>:<event>", json_args)`. Ops are `mount`,
`move`, `unmount`, `set`, `call`, `config`, `css`, `dialog`, `toast`, `frame`
and `reset` (documented at the top of `renderer.js`). Only the worker's
existing two `_uihost` functions are used.

## Running

```sh
./run.sh               # playground: http://127.0.0.1:18770/playground/ (examples, editor, phone frame)
./run.sh --test        # 88 Python tests on the host (fake DOM applies the op stream like renderer.js)
./run.sh --selftest    # tests + 12 browser checks in headless Chrome, JSON (ONLY=<step>, OFFLINE=1)
uv run scripts/selftest_webkit.py "http://127.0.0.1:18770/playground/#selftest"   # same checks in Playwright WebKit
```

The playground uses Pyodide 314.0.7 from `app/vendor/` with a minimal worker
(`playground/worker.js`) that exposes the same `_uihost` module as the app's
`py-worker.js`. Packages such as matplotlib come from the jsDelivr CDN.

## Results (2026-10-13)

Tested in headless Chrome 155 and Playwright WebKit (Safari 26.6 engine), both
on macOS. In the app, the `ui_app` and `ui_todo` selftests pass in WKWebView
(iPhone 17 simulator, iOS 27). The timings below are not from iOS, and
nothing was run on a device.

| Check | Chrome | WebKit (macOS) |
|---|---|---|
| Tap round trip (Counter, 30 taps) | 0.1 ms avg, p95 0.4 ms | 0.23 ms avg, p95 1 ms |
| Python: build and serialize 1,000 rows | not measured | 10-11 ms |
| 1,000 rows: first DOM build (60 KB message) | 4 ms | 7 ms |
| Toggle one row of 1,000 | 1 op, 0.2 ms | 1 op, 1 ms (median of 7) |
| Reverse 1,000 rows (999 moves, nodes reused) | 3 ms | 31-34 ms |
| Canvas game loop (`on_frame`, 8+ balls) | 60 fps | 60 fps |
| Todo App walkthrough (lists, add, check off, detail edit, move, search, delete list, saved JSON) | pass | pass |
| Todos, navigation/sheet/dialogs/edge swipe, every input, tabs/badge/stopwatch, paint, `h()`/SVG/resource, resync of a second renderer, handler errors + hint, live matplotlib | pass | pass |

Earlier D14 numbers for comparison: 0.24 ms per tap and 23-26 ms for
re-rendering 1,000 rows, since the whole tree was resent and diffed on every
change.

## In the app

`scripts/install.sh` copies `python/ui.py`, `web/renderer.js`, `web/ui.css`
and `examples/Todo App.py` into `app/web`. The app's copies are generated:
edit them here. The app side:
- `UIAppView` gives the renderer a full-size root. It sets
  `--ui-host-inset-right` so nav bar buttons stay clear of the Done button.
- The session no longer replays messages, because each renderer resyncs.
- Files written after the script returned are synced back on Done and when
  the app goes to the background (`sync` message, D26).
- `examples.ts` updates seeded examples the user hasn't edited (by hash).
- App selftests: `ui_app` (Counter App) and `ui_todo` (Todo App: open the
  Inbox, type a to-do, go back, Done, check `todos.json` in Documents). Both
  pass in WKWebView in the iPhone 17 simulator.

## Not covered yet

- On a device: touch gestures (edge swipe, swipe to delete), the software
  keyboard with text fields, IME composition (handled on `compositionend`,
  not tried), safe areas.
- Long lists are not virtualized (1,000 rows are fine; 10,000 not measured).
- Canvas resends the whole command list on each redraw. Transferring an
  OffscreenCanvas to the worker is the upgrade path for heavy drawing.
- Images from files are sent inline as data URLs; big photos inflate messages.
- Missing components: search bar, pull to refresh, context menus, swipe
  actions other than delete, maps, video. A transition/animation API beyond
  CSS. Accessibility beyond native controls.
- Published apps (D15): the export needs these three files instead of the
  spike's.
