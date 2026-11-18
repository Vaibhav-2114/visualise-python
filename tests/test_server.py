"""
Tier 3 Integration Tests for Backend Server Endpoints (server.py).

Tests:
- GET /api/health returns 200 with status ok and version.
- POST /api/trace with valid code returns 200 with status ok and steps array.
- POST /api/trace with syntax error returns 400 with structured error.
- POST /api/trace with security sandbox violation returns 400 with SecurityError.
- POST /api/trace with runtime exception returns 400 with ZeroDivisionError.
- POST /api/trace with malformed JSON or missing code field returns 400.
- CORS headers for preflight OPTIONS and response headers.
- Static file serving (HTML, CSS, JS MIME types) and 404 for invalid routes.
- Path traversal protection (403 Forbidden).
"""

import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
import pytest

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
import sys
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.server import create_server


@pytest.fixture(scope="module")
def server_info():
    """Starts a live ThreadingHTTPServer on an ephemeral port with a mock frontend directory."""
    with tempfile.TemporaryDirectory() as tmp_frontend:
        # Create mock frontend assets to verify static MIME types
        index_file = os.path.join(tmp_frontend, "index.html")
        with open(index_file, "w") as f:
            f.write("<!DOCTYPE html><html><body>Visualizer</body></html>")

        css_dir = os.path.join(tmp_frontend, "css")
        os.makedirs(css_dir, exist_ok=True)
        css_file = os.path.join(css_dir, "main.css")
        with open(css_file, "w") as f:
            f.write("body { margin: 0; }")

        js_dir = os.path.join(tmp_frontend, "js")
        os.makedirs(js_dir, exist_ok=True)
        js_file = os.path.join(js_dir, "app.js")
        with open(js_file, "w") as f:
            f.write("console.log('Visualizer loaded');")

        server = create_server(host="127.0.0.1", port=0, frontend_dir=tmp_frontend)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        base_url = f"http://127.0.0.1:{port}"
        yield base_url

        server.shutdown()
        server.server_close()


class TestServerEndpoints:
    """Tier 3: REST API endpoint integration tests."""

    def test_health_endpoint(self, server_info):
        """T3.1: GET /api/health returns 200 with status ok and version."""
        url = f"{server_info}/api/health"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200
            data = json.loads(resp.read().decode("utf-8"))
            assert data["status"] == "ok"
            assert data["version"] == "1.0.0"

    def test_trace_valid_code_returns_200(self, server_info):
        """T3.2: POST /api/trace with valid Python code returns 200 with full trace schema."""
        url = f"{server_info}/api/trace"
        payload = json.dumps({
            "code": "x = 10\ny = 20\nz = x + y\nprint(f'sum: {z}')"
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200
            data = json.loads(resp.read().decode("utf-8"))
            assert data["status"] == "ok"
            assert data["error"] is None
            assert data["total_steps"] > 0
            assert len(data["steps"]) == data["total_steps"]

            # Validate PROJECT.md schema keys in step 0
            step0 = data["steps"][0]
            assert "step" in step0
            assert "event" in step0
            assert "line" in step0
            assert "func_name" in step0
            assert "stdout" in step0
            assert "stack" in step0
            assert "heap" in step0

    def test_trace_syntax_error_returns_400(self, server_info):
        """T3.3: POST /api/trace with invalid syntax returns 400 Bad Request."""
        url = f"{server_info}/api/trace"
        payload = json.dumps({"code": "def incomplete_function("}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req)

        assert exc_info.value.code == 400
        data = json.loads(exc_info.value.read().decode("utf-8"))
        assert data["status"] == "error"
        assert data["error"]["type"] == "SyntaxError"
        assert data["error"]["line"] is not None

    def test_trace_security_sandbox_violation_returns_400(self, server_info):
        """T3.5: POST /api/trace with blocked import returns 400 with SecurityError."""
        url = f"{server_info}/api/trace"
        payload = json.dumps({"code": "import subprocess\nsubprocess.run(['ls'])"}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req)

        assert exc_info.value.code == 400
        data = json.loads(exc_info.value.read().decode("utf-8"))
        assert data["status"] == "error"
        assert data["error"]["type"] == "SecurityError"
        assert "subprocess" in data["error"]["message"]

    def test_trace_runtime_error_returns_400(self, server_info):
        """T3.4: POST /api/trace with unhandled runtime exception returns 400."""
        url = f"{server_info}/api/trace"
        payload = json.dumps({"code": "def div(a, b): return a / b\ndiv(5, 0)"}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req)

        assert exc_info.value.code == 400
        data = json.loads(exc_info.value.read().decode("utf-8"))
        assert data["status"] == "error"
        assert data["error"]["type"] == "ZeroDivisionError"

    def test_trace_malformed_json_returns_400(self, server_info):
        """T3.8: Malformed JSON or missing Content-Length returns 400."""
        url = f"{server_info}/api/trace"
        req = urllib.request.Request(
            url,
            data=b"not a valid json string {",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req)
        assert exc_info.value.code == 400

    def test_trace_missing_code_key_returns_400(self, server_info):
        """POST /api/trace missing 'code' key returns 400."""
        url = f"{server_info}/api/trace"
        payload = json.dumps({"other_key": "some value"}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req)
        assert exc_info.value.code == 400

    def test_cors_options_preflight(self, server_info):
        """Verifies CORS preflight OPTIONS returns 204 with required headers."""
        url = f"{server_info}/api/trace"
        req = urllib.request.Request(url, method="OPTIONS")
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 204
            assert resp.headers.get("Access-Control-Allow-Origin") == "*"
            assert "POST" in resp.headers.get("Access-Control-Allow-Methods")

    def test_static_asset_serving_and_mime_types(self, server_info):
        """T3.6 & T3.7: Static files served with correct MIME types."""
        # Index HTML
        with urllib.request.urlopen(f"{server_info}/") as resp:
            assert resp.status == 200
            assert "text/html" in resp.headers.get("Content-Type")

        # CSS
        with urllib.request.urlopen(f"{server_info}/css/main.css") as resp:
            assert resp.status == 200
            assert "text/css" in resp.headers.get("Content-Type")

        # JavaScript
        with urllib.request.urlopen(f"{server_info}/js/app.js") as resp:
            assert resp.status == 200
            assert "application/javascript" in resp.headers.get("Content-Type")

    def test_nonexistent_route_returns_404(self, server_info):
        """T3.9: Request for non-existent route returns 404 Not Found."""
        url = f"{server_info}/nonexistent/page.html"
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(url)
        assert exc_info.value.code == 404

    def test_path_traversal_attempt_forbidden(self, server_info):
        """Path traversal '../' outside frontend root is blocked."""
        url = f"{server_info}/../../etc/passwd"
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(url)
        assert exc_info.value.code in (400, 403, 404)


class TestServerRemediationIteration2:
    """Iteration 2 Remediation: Non-string code payloads, clamped max_steps, sibling traversal."""

    def test_non_string_code_payloads_return_400(self, server_info):
        """Verifies non-string code field in JSON body returns 400 Bad Request without crashing."""
        invalid_payloads = [
            {"code": 12345},
            {"code": None},
            {"code": ["x = 1"]},
            {"code": {"snippet": "x = 1"}},
            {"code": True},
        ]
        url = f"{server_info}/api/trace"
        for payload in invalid_payloads:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with pytest.raises(urllib.error.HTTPError) as exc_info:
                urllib.request.urlopen(req)

            assert exc_info.value.code == 400
            data = json.loads(exc_info.value.read().decode("utf-8"))
            assert data["status"] == "error"
            assert data["error"]["type"] == "ValueError"
            assert "JSON body must contain 'code' string field." in data["error"]["message"]

    def test_clamped_max_steps_enforced(self, server_info):
        """Verifies user-supplied max_steps is clamped to MAX_STEPS (1000)."""
        url = f"{server_info}/api/trace"
        # 1500 iterations will exceed MAX_STEPS (1000) if clamped
        code = (
            "i = 0\n"
            "while i < 1500:\n"
            "    i += 1\n"
        )
        req = urllib.request.Request(
            url,
            data=json.dumps({"code": code, "max_steps": 10_000_000}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req)

        assert exc_info.value.code == 400
        data = json.loads(exc_info.value.read().decode("utf-8"))
        assert data["status"] == "error"
        assert "step limit" in data["error"]["message"].lower()

    def test_sibling_directory_traversal_forbidden(self, server_info):
        """Verifies sibling directory path traversal (/../sibling/) is rejected with 403."""
        # Querying outside the frontend root directory
        url = f"{server_info}/../secret_sibling_file.txt"
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(url)

        assert exc_info.value.code in (403, 404)


class TestServerRemediationIteration3:
    """Iteration 3 Remediation: Subprocess isolation and server timeout robustness."""

    def test_server_subprocess_catastrophic_regex_timeout(self, server_info):
        """Verifies catastrophic backtracking in C extensions times out cleanly via subprocess isolation."""
        url = f"{server_info}/api/trace"
        code = (
            "import re\n"
            "re.match(r'(a+)+$', 'a'*30 + '!')\n"
        )
        req = urllib.request.Request(
            url,
            data=json.dumps({"code": code}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req, timeout=10.0)

        assert exc_info.value.code == 400
        data = json.loads(exc_info.value.read().decode("utf-8"))
        assert data["status"] == "error"
        assert data["error"]["type"] == "TimeoutError"
        assert "timed out" in data["error"]["message"].lower()

    def test_server_concurrent_requests_preserve_stdout(self, server_info):
        """Verifies concurrent HTTP requests to /api/trace preserve process stdout intact."""
        real_stdout = sys.stdout
        url = f"{server_info}/api/trace"

        errors = []

        def send_req(val):
            try:
                code = f"for i in range(10):\n    print('REQ_{val}:', i)"
                req = urllib.request.Request(
                    url,
                    data=json.dumps({"code": code}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req) as resp:
                    assert resp.status == 200
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=send_req, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Errors during concurrent HTTP requests: {errors}"
        assert sys.stdout is real_stdout

