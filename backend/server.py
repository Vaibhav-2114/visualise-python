"""HTTP REST API and static file server using Python standard library.

Zero external dependencies:
- Uses http.server.ThreadingHTTPServer.
- Endpoints:
  - POST /api/trace: Traces code and returns structured JSON (200 OK or 400 Bad Request on error).
  - GET /api/health: Service status endpoint.
  - GET /...: Serves frontend static assets with appropriate MIME types.
- Full CORS support.
"""

import http.server
import json
import mimetypes
import os
import traceback
import urllib.parse
from pathlib import Path
from typing import Optional

from .limits import MAX_STEPS, TIMEOUT_SECONDS
from .tracer import execute_trace_sandboxed, trace_code

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
}


class VisualizerRequestHandler(http.server.BaseHTTPRequestHandler):
    """Custom HTTP request handler for the Python Visualizer."""

    server_version = "VisualizerServer/1.0"

    def __init__(self, *args, frontend_dir: Optional[str] = None, **kwargs):
        if frontend_dir is None:
            # Default to ../frontend relative to backend/
            base_dir = Path(__file__).resolve().parent.parent
            self.frontend_dir = str(base_dir / "frontend")
        else:
            self.frontend_dir = frontend_dir
        super().__init__(*args, **kwargs)

    def _set_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:
        """Handles CORS preflight requests."""
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        """Handles GET requests: /api/health or static assets."""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._handle_health()
        elif path.startswith("/api/"):
            self._send_json(404, {"status": "error", "message": "Endpoint not found"})
        else:
            self._handle_static(path)

    def do_POST(self) -> None:
        """Handles POST requests: /api/trace."""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/trace":
            self._handle_trace()
        else:
            self._send_json(404, {"status": "error", "message": "Endpoint not found"})

    def _send_json(self, status_code: int, data: dict) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_health(self) -> None:
        self._send_json(200, {"status": "ok", "version": "1.0.0"})

    def _handle_trace(self) -> None:
        content_length = self.headers.get("Content-Length")
        if not content_length:
            self._send_json(400, {
                "status": "error",
                "error": {
                    "type": "ValueError",
                    "message": "Missing Content-Length header",
                    "line": None,
                    "traceback": None,
                },
            })
            return

        try:
            length = int(content_length)
            raw_body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw_body)
        except Exception as e:
            self._send_json(400, {
                "status": "error",
                "error": {
                    "type": "ValueError",
                    "message": f"Malformed JSON request body: {str(e)}",
                    "line": None,
                    "traceback": None,
                },
            })
            return

        if not isinstance(payload, dict) or "code" not in payload or not isinstance(payload.get("code"), str):
            self._send_json(400, {
                "status": "error",
                "error": {
                    "type": "ValueError",
                    "message": "JSON body must contain 'code' string field.",
                    "line": None,
                    "traceback": None,
                },
            })
            return

        code = payload["code"]
        max_steps = payload.get("max_steps", MAX_STEPS)
        if not isinstance(max_steps, int) or max_steps <= 0:
            max_steps = MAX_STEPS
        else:
            max_steps = min(max_steps, MAX_STEPS)

        try:
            result = execute_trace_sandboxed(code, max_steps=max_steps, timeout=TIMEOUT_SECONDS)
        except Exception as exc:
            self._send_json(400, {
                "status": "error",
                "error": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "line": None,
                    "traceback": traceback.format_exc(),
                },
            })
            return

        if result.get("status") == "ok":
            self._send_json(200, result)
        else:
            self._send_json(400, result)

    def _handle_static(self, path: str) -> None:
        # Default root path to index.html
        if path in ("/", ""):
            path = "/index.html"

        # Sanitize and resolve local path
        clean_path = os.path.normpath(path.lstrip("/"))
        file_path = os.path.join(self.frontend_dir, clean_path)

        # Path traversal guard using Path.is_relative_to
        real_frontend = Path(self.frontend_dir).resolve()
        real_file = Path(file_path).resolve()
        if not real_file.is_relative_to(real_frontend):
            self.send_error(403, "Access Denied")
            return

        if not os.path.isfile(str(real_file)):
            if path == "/index.html":
                # Return placeholder if frontend directory is not yet populated
                body = (
                    b"<!DOCTYPE html><html><head><title>Python Visualizer</title></head>"
                    b"<body><h1>Python Visualizer API Server</h1><p>Frontend assets not yet loaded.</p></body></html>"
                )
                self.send_response(200)
                self._set_cors_headers()
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            self.send_error(404, "File Not Found")
            return

        _, ext = os.path.splitext(str(real_file))
        content_type = MIME_TYPES.get(ext.lower(), mimetypes.guess_type(str(real_file))[0] or "application/octet-stream")

        try:
            with open(real_file, "rb") as f:
                content = f.read()

            self.send_response(200)
            self._set_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except OSError:
            self.send_error(500, "Error reading file")

    def log_message(self, format: str, *args) -> None:
        """Suppresses default stdout logging during tests unless desired."""
        pass


def create_server(
    host: str = "0.0.0.0",
    port: int = 8000,
    frontend_dir: Optional[str] = None,
) -> http.server.ThreadingHTTPServer:
    """Creates a ThreadingHTTPServer instance configured with VisualizerRequestHandler."""
    handler_factory = lambda *args, **kwargs: VisualizerRequestHandler(
        *args, frontend_dir=frontend_dir, **kwargs
    )
    server = http.server.ThreadingHTTPServer((host, port), handler_factory)
    return server
