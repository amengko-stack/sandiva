#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path not in {"/v1/responses", "/v1/messages"}:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "-1"))
        body = json.loads(self.rfile.read(length)) if 0 <= length <= 1024 * 1024 else {}
        expected = os.environ["EXPECTED_PROVIDER_CREDENTIAL"]
        observed = self.headers.get("Authorization", "").removeprefix("Bearer ")
        if self.path == "/v1/messages":
            observed = self.headers.get("x-api-key", "")
        if observed != expected:
            self.send_error(403)
            return
        mode = body.get("testMode")
        status, raw = 200, json.dumps({"credentialAccepted": True}).encode()
        if mode == "echo-success": raw = json.dumps({"echo": expected}).encode()
        elif mode == "echo-error": status, raw = 401, json.dumps({"error": expected}).encode()
        elif mode == "oversized-success": raw = b"x" * (128 * 1024)
        elif mode == "oversized-error": status, raw = 500, b"x" * (128 * 1024)
        elif mode == "malformed": raw = b"not-json"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
