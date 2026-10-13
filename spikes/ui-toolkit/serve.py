"""Serve an exported app like a plain static host (no COOP/COEP headers), plus
a /__bridge endpoint that records the self-test result in <dir>/../out/.

    uv run serve.py dist/counter [port] [--isolated]
"""

import json
import pathlib
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"


class Handler(SimpleHTTPRequestHandler):
    isolated = False

    def end_headers(self):
        if self.isolated:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith((".js", ".mjs")):
            return "text/javascript"
        if str(path).endswith(".webmanifest"):
            return "application/manifest+json"
        return super().guess_type(path)

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        OUT.mkdir(exist_ok=True)
        if msg["op"] == "result":
            (OUT / "standalone-result.json").write_text(msg["value"])
        body = b'{"value": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    Handler.isolated = "--isolated" in sys.argv
    directory = args[0]
    port = int(args[1]) if len(args) > 1 else 18768
    ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=directory)).serve_forever()
