# ios-host

2026-10-13 - WKWebView in our own app, iOS 27 simulator (iPhone 17). Not a real device.

**Questions:** Q1 (cross-origin isolation, SharedArrayBuffer, JSPI in our
WKWebView on `app://`), Q2 (is storage persistent), Q3 (bridge latency).

**What it is:** A minimal SwiftUI app with a full-screen WKWebView. A
`WKURLSchemeHandler` serves `web/` under `app://app/` with COOP/COEP/CORP
headers and answers `/__bridge/echo` (for synchronous XHR). A
`WKScriptMessageHandlerWithReply` named `bridge` handles `echo`, `log` and
`result`. No Xcode project: `run.sh` builds with `swiftc`, assembles and
ad-hoc-signs the `.app`, installs and launches it, and prints
`Documents/probe-result.json`.

```sh
./run.sh            # booted simulator
```

## Results

| Feature | Result |
|---|---|
| `isSecureContext`, `crossOriginIsolated` (page and worker) | `true` |
| JSPI, wasm exceptions, shared wasm memory | Yes |
| Global `SharedArrayBuffer` | **Missing** (Safari on http://localhost has it) |
| SharedArrayBuffer obtained from `new WebAssembly.Memory({shared: true}).buffer` | Works: the constructor can be called, it can be sent to workers, `Atomics.wait`/`notify` work |
| Largest wasm memory allocation | 2 GB OK (simulator) |
| localStorage, IndexedDB, OPFS persist across relaunch and reinstall | Yes |
| OPFS `createSyncAccessHandle` in a worker | Yes |
| `navigator.storage.persist()` / `persisted()` | `false` (eviction policy still unknown) |
| Quota (`storage.estimate`) | about 9.8 GB (simulator) |

Average round trip to Swift and back, 500 calls each:

| Path | ms |
|---|---|
| Page → message handler with reply | 0.068 |
| Page → `fetch('/__bridge/echo')` | 0.094 |
| Worker → page → message handler (async relay, what JSPI would wrap) | 0.080 |
| Worker → page → message handler, blocking with `Atomics.wait` | 0.076 |
| Worker → synchronous XHR GET to the scheme handler | 0.100 |
| Worker → synchronous XHR POST with a body | 0.188 |

## Takeaways

- Cross-origin isolation works on `app://`; only the global constructor is
  missing. A polyfill fixes it; it must run before Pyodide or Emscripten code,
  in the page and in every worker:
  ```js
  globalThis.SharedArrayBuffer ??=
    new WebAssembly.Memory({ initial: 0, maximum: 0, shared: true }).buffer.constructor;
  ```
- Blocking calls from a worker to Swift are cheap in all three forms (about
  0.1 ms on the simulator). Every path works, so the choice is a design
  question, not a feasibility one.
- Storage survives relaunch and reinstall, but `persist()` is denied. Keep data
  that must last (projects, agent state) in native storage through the bridge
  until eviction behaviour is known.
