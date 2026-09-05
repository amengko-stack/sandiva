from __future__ import annotations

import json
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def create_health_server(coordinator: Any, host: str = "127.0.0.1", port: int = 8787) -> ThreadingHTTPServer:
    if host != "localhost":
        try:
            if not ipaddress.ip_address(host).is_loopback:
                raise ValueError("health endpoint must bind to loopback")
        except ValueError as error:
            raise ValueError("health endpoint must bind to loopback") from error

    class Handler(BaseHTTPRequestHandler):
        server_version = "HermesBuildStewardHealth/0.1"

        def do_GET(self) -> None:
            if self.path != "/healthz":
                self.send_error(404)
                return
            payload = json.dumps(coordinator.health(), sort_keys=True, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            return

    return ThreadingHTTPServer((host, port), Handler)
