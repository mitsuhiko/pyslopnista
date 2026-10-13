"""Serve web/ with COOP/COEP headers and a /__bridge endpoint that records
log lines and the final result in out/.

    uv run server.py [port]   then open http://127.0.0.1:<port>/?r=<random>
"""
import json
import pathlib
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE / "web"), **kwargs)

    def translate_path(self, path):
        clean = path.split("?", 1)[0]
        if clean.startswith("/pyodide/"):
            vendor = HERE.parent / "pyodide-worker" / "vendor" / "pyodide-314.0.7"
            return str(vendor / clean.removeprefix("/pyodide/"))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith((".js", ".mjs")):
            return "text/javascript"
        if str(path).endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        OUT.mkdir(exist_ok=True)
        if msg["op"] == "log":
            with open(OUT / "log.txt", "a") as f:
                f.write(msg["value"] + "\n")
        elif msg["op"] == "result":
            (OUT / "result.json").write_text(msg["value"])
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18767
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
