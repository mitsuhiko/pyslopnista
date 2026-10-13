# AGENTS.md

A Pythonista replacement for iOS: Pyodide in a WKWebView, a TypeScript web
app, a thin Swift host and a pi-durable coding agent. Early research phase.

## Where things live

- `app/`: the real app (see `app/README.md`). Build and test with `app/run.sh`
  (`--selftest`, `--device`). Keep `./run.sh --selftest` passing.

- `GOALS.md`: the feature set, tagged [core]/[later]/[maybe]. Update it when scope changes.
- `DECISIONS.md`: decisions D<n> (append-only), proposals P<n>, open questions Q<n>.
  When a spike answers a question, add a decision or note that cites the spike,
  and remove the question.
- `spikes/<name>/`: throwaway experiments. Each one has a `README.md` with the
  question, how to run it, the results and the date. Spikes are never production code.

## Current work

App (`app/`): IDE with files, editor, run, console, UI apps, ruff + ty,
PEP 723 dependencies. Next: hands-on device feedback, then the gaps in
`app/README.md` (Q16-Q18). `app/scripts/build-ty.sh` needs Rust + wasm-pack.

Spike queue (update the status here). The pi-durable agent always comes last
(D8); never start agent work before the spikes ahead of it are done.

1. [x] `ios-host`: Swift host, WKWebView, `app://` scheme handler; probe inside it (Q1 answered: D9; Q2/Q3 narrowed)
2. [x] `pyodide-worker`: bundled Pyodide in a worker: console, `input()`, interrupt, restart, package cache (D10-D12; open: PyPI offline cache, Q11)
3. [x] `ui-toolkit`: declarative Python UI in the app and exported as a static site (D14, D15)
4. [x] `device-perf`: real-phone startup, memory, speed, bridge latency, backgrounding, wasm-GC trampoline check (D13 confirmed, D16; open: App Intents Q6, Q14, Q15)
5. [ ] `agent` (last): pi-durable in the web view, with a SQLite bridge adapter, `python` tool and proxied providers (D7, Q4)

Done:
- [x] `jspi-repro`: JSPI "hang" root-caused to CPython's iOS JS-trampoline fallback (D13)
- [x] `webkit-probe`: wasm and threading features of iOS 27 Safari (simulator)

## Conventions

- Environment: Xcode 27, iOS 27 simulator, macOS 26.
- Python tooling on the host goes through `uv`.
- Write dates as YYYY-MM-DD.
- Spikes with a web part have `run.sh --selftest [steps]`, which prints JSON from
  the simulator. Prefer the app over Safari for automated runs; driving Safari
  with `simctl openurl` reuses tabs and is unreliable.
- Never claim a result from the simulator or Safari applies to a real device or to WKWebView; say which one was tested.
- Device runs: `spikes/device-perf/run.sh` (paired iPhone 14 Pro, personal team `ZRL6J4P42H`). The phone must be unlocked; ask the user first.
