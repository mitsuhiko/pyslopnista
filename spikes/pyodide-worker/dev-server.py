"""Serve the spike to a plain browser with the same endpoints as the iOS host.

    uv run dev-server.py [port]    then open http://127.0.0.1:<port>/#selftest
"""
import json
import pathlib
import sys
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).parent
VERSION = "314.0.7"
CDN = f"https://cdn.jsdelivr.net/pyodide/v{VERSION}/full/"
VENDOR = HERE / "vendor" / f"pyodide-{VERSION}"
PKG_CACHE = HERE / "vendor" / "pkgs"
OUT = HERE / "build" / "browser"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path.startswith("/pyodide/"):
            return str(VENDOR / path.removeprefix("/pyodide/"))
        if path.startswith("/pkgs/"):
            name = path.removeprefix("/pkgs/")
            cached = PKG_CACHE / name
            if not cached.exists() and "/" not in name:
                PKG_CACHE.mkdir(parents=True, exist_ok=True)
                with urllib.request.urlopen(CDN + name) as res:
                    cached.write_bytes(res.read())
            return str(cached)
        return str(HERE / "web" / path.lstrip("/"))

    def guess_type(self, path):
        if str(path).endswith((".mjs", ".js")):
            return "text/javascript"
        if str(path).endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        op, value = msg.get("op"), msg.get("value")
        OUT.mkdir(parents=True, exist_ok=True)
        reply = {"value": True}
        if op == "echo":
            reply = {"value": value}
        elif op == "log":
            with open(OUT / "probe-log.txt", "a") as f:
                f.write(f"{value}\n")
        elif op == "result":
            (OUT / "probe-result.json").write_text(value)
        elif op != "haptic":
            reply = {"error": f"unknown op {op}"}
        body = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18766
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
