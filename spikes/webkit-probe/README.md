# webkit-probe

2026-10-13 · iOS 27 Safari on the iPhone 17 simulator (not WKWebView, not a device)

**Question:** Does WebKit on iOS have the features Pyodide needs for blocking-style
Python and isolated workers?

**Run:**
```sh
python3 server.py   # serves on 127.0.0.1:18765 with COOP/COEP headers
xcrun simctl openurl booted http://127.0.0.1:18765/index.html
cat result.json
```

**Results** (`result.json`):

| Feature | Result |
|---|---|
| JSPI (`WebAssembly.Suspending`/`promising`), on the page and in workers | Yes |
| `crossOriginIsolated`, SharedArrayBuffer, shared wasm memory | Yes |
| `Atomics.wait` in a worker | Yes |
| Synchronous XHR in a worker | Yes (about 10 ms overhead per call against Python's `http.server`; not representative) |
| Wasm exceptions (exnref, `JSTag`), memory64 | Yes |
| Largest wasm memory allocation | 2 GB works, 3 GB fails with out-of-memory (a real device will be lower) |

**Not answered yet:** behaviour in WKWebView with a custom `app://` scheme (Q1),
and real-device limits (Q5).
