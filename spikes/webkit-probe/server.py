import http.server, json, sys, time
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def do_GET(self):
        if self.path.startswith("/sync"):
            time.sleep(0.01)
            body = b'{"ok":true}'
            self.send_response(200); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()
    def do_POST(self):
        data = self.rfile.read(int(self.headers["Content-Length"]))
        open("result.json","wb").write(data)
        self.send_response(204); self.end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", 18765), H).serve_forever()
