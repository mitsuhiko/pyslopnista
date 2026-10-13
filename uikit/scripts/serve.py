"""Serve the playground: / is uikit/, /pyodide/ is the app's vendored Pyodide.

    python3 scripts/serve.py [port]
"""

import functools
import http.server
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYODIDE = ROOT.parent / "app" / "vendor" / "pyodide-314.0.7"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript",
                      ".js": "text/javascript", ".wasm": "application/wasm", ".py": "text/plain; charset=utf-8"}

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/pyodide/"):
            return str(PYODIDE / clean[len("/pyodide/"):])
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        if os.environ.get("VERBOSE"):
            super().log_message(*args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18770
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"http://127.0.0.1:{port}/playground/", flush=True)
        httpd.serve_forever()
