# /// script
# requires-python = ">=3.12"
# ///
"""A scripted stand-in for the Anthropic Messages API, for the agent spike.

POST /v1/messages answers with server-sent events. What it says depends on the
last message:
  - a tool result         -> text "saw <tool>: error=<bool> <first 120 chars>"
  - user text with [write] -> tool_use write {path: from-model.txt, ...}
  - user text with [sleep] -> tool_use sleep {ms: 8000}
  - user text with [slow]  -> 30 text chunks, 100 ms apart
  - anything else          -> text "hello from mock"
Requests without x-api-key == MOCK_KEY get a 401 (proves the host injected it).

GET /stream?n=10&ms=200 sends n SSE events ms apart (proxy streaming check).
GET /stats returns request counts; POST /reset clears them.
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

KEY = os.environ.get("MOCK_KEY", "mock-key")
STATS: dict[str, int] = {}


def bump(name: str) -> None:
    STATS[name] = STATS.get(name, 0) + 1


def event(kind: str, data: dict) -> bytes:
    return f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        sys.stderr.write("[mock] " + (format % args) + "\n")

    def send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def start_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def emit(self, data: bytes) -> None:
        self.wfile.write(data)
        self.wfile.flush()

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/stats":
            return self.send_json(200, STATS)
        if url.path == "/stream":
            q = parse_qs(url.query)
            n, ms = int(q.get("n", ["10"])[0]), int(q.get("ms", ["200"])[0])
            bump("stream")
            self.start_stream()
            for i in range(n):
                self.emit(f"data: {json.dumps({'i': i, 't': time.time()})}\n\n".encode())
                time.sleep(ms / 1000)
            return None
        return self.send_json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        url = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if url.path == "/reset":
            STATS.clear()
            return self.send_json(200, {})
        if url.path != "/v1/messages":
            return self.send_json(404, {"error": "not found"})
        if self.headers.get("x-api-key") != KEY:
            bump("unauthorized")
            return self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "bad key"}})
        request = json.loads(body)
        last = request["messages"][-1]
        content = last["content"] if isinstance(last["content"], list) else [{"type": "text", "text": last["content"]}]
        results = [c for c in content if c.get("type") == "tool_result"]
        text = " ".join(c.get("text", "") for c in content if c.get("type") == "text")

        if results:
            r = results[-1]
            inner = r.get("content")
            inner_text = inner if isinstance(inner, str) else " ".join(c.get("text", "") for c in inner or [])
            bump("tool_result")
            return self.answer_text([f"saw tool result: error={str(bool(r.get('is_error'))).lower()} {inner_text[:120]}"])
        if "[write]" in text:
            bump("write")
            return self.answer_tool("write", {"path": "from-model.txt", "content": "written by the mock model\n"})
        if "[sleep]" in text:
            bump("sleep")
            return self.answer_tool("sleep", {"ms": 8000})
        if "[slow]" in text:
            bump("slow")
            return self.answer_text([f"chunk{i} " for i in range(30)], delay=0.1)
        bump("hello")
        return self.answer_text(["hello ", "from ", "mock"])

    def message_start(self) -> None:
        self.emit(event("message_start", {"type": "message_start", "message": {
            "id": f"msg_{time.time_ns()}", "type": "message", "role": "assistant", "model": "mock-1",
            "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 1}}}))

    def message_end(self, reason: str) -> None:
        self.emit(event("message_delta", {"type": "message_delta",
                                          "delta": {"stop_reason": reason, "stop_sequence": None},
                                          "usage": {"output_tokens": 5}}))
        self.emit(event("message_stop", {"type": "message_stop"}))

    def answer_text(self, chunks: list[str], delay: float = 0.0) -> None:
        self.start_stream()
        try:
            self.message_start()
            self.emit(event("content_block_start", {"type": "content_block_start", "index": 0,
                                                    "content_block": {"type": "text", "text": ""}}))
            for chunk in chunks:
                if delay:
                    time.sleep(delay)
                self.emit(event("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                        "delta": {"type": "text_delta", "text": chunk}}))
            self.emit(event("content_block_stop", {"type": "content_block_stop", "index": 0}))
            self.message_end("end_turn")
        except (BrokenPipeError, ConnectionResetError):
            bump("disconnected")

    def answer_tool(self, name: str, args: dict) -> None:
        self.start_stream()
        self.message_start()
        self.emit(event("content_block_start", {"type": "content_block_start", "index": 0,
                                                "content_block": {"type": "tool_use", "id": f"toolu_{time.time_ns()}",
                                                                  "name": name, "input": {}}}))
        self.emit(event("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)}}))
        self.emit(event("content_block_stop", {"type": "content_block_stop", "index": 0}))
        self.message_end("tool_use")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"[mock] listening on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
