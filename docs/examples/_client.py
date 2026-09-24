"""Shared in-process WSGI test client for the Restoration Copilot examples.

Each example builds an ``App`` backed by a ``RestorationPipeline`` rooted in a
temporary directory, so the examples run fully offline and leave no state in
the repository. This mirrors the approach of ``tests/restoration/conftest.py``
without importing test machinery.
"""

from __future__ import annotations

import io
import json
import sys
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from orchestrator.api.server import App  # noqa: E402
from orchestrator.core.restoration_pipeline import RestorationPipeline  # noqa: E402


def make_app(runs_root: Path) -> "Client":
    pipeline = RestorationPipeline(
        runs_root=runs_root,
        config={"tasks_inline": True},  # deterministic: tasks run on the caller thread
    )
    return Client(App(pipeline))


class Response:
    def __init__(self, status: int, headers: list, body: bytes):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf-8")) if self.body else None


class Client:
    def __init__(self, app: App):
        self.app = app
        self.token: str = ""

    def login(self, username: str = "operator", password: str = "restoration-dev") -> str:
        res = self.request("POST", "/admin/operator/session",
                           json_body={"username": username, "password": password})
        assert res.status == 200, res.body
        self.token = res.json()["session_token"]
        return self.token

    def request(self, method: str, path: str, json_body=None, multipart=None,
                headers=None, auth: bool = True) -> Response:
        headers = dict(headers or {})
        body = b""
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        if multipart is not None:
            boundary, body = encode_multipart(**multipart)
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        if auth and self.token:
            headers.setdefault("Authorization", f"Bearer {self.token}")
        parsed = urllib.parse.urlsplit(path)
        environ = {
            "REQUEST_METHOD": method.upper(),
            "PATH_INFO": parsed.path,
            "QUERY_STRING": parsed.query,
            "CONTENT_TYPE": headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(len(body)),
            "wsgi.input": io.BytesIO(body),
        }
        for key, value in headers.items():
            environ["HTTP_" + key.upper().replace("-", "_")] = value
        captured: dict = {}

        def start_response(status_line, response_headers, exc_info=None):
            captured["status"] = int(status_line.split(" ", 1)[0])
            captured["headers"] = response_headers

        chunks = self.app(environ, start_response)
        return Response(captured["status"], captured["headers"], b"".join(chunks))

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, **kw):
        return self.request("POST", path, **kw)

    def delete(self, path, **kw):
        return self.request("DELETE", path, **kw)


def encode_multipart(photos=None, parts_list=None, fields=None):
    boundary = "----restoration-example-boundary"
    out = io.BytesIO()
    for name, value in (fields or {}).items():
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        out.write(f"{value}\r\n".encode())
    for filename, data in (photos or []):
        out.write(f"--{boundary}\r\n".encode())
        out.write(
            f'Content-Disposition: form-data; name="photos"; filename="{filename}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n".encode()
        )
        out.write(data + b"\r\n")
    if parts_list is not None:
        filename, data = parts_list
        out.write(f"--{boundary}\r\n".encode())
        out.write(
            f'Content-Disposition: form-data; name="parts_list"; filename="{filename}"\r\n'
            "Content-Type: text/csv\r\n\r\n".encode()
        )
        out.write(data + b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return boundary, out.getvalue()


def jpeg_bytes(seed: int = 0) -> bytes:
    """Minimal bytes that pass FR-002 JPEG magic-byte validation."""
    return (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x00\x00"
        + bytes([seed % 256]) * 64
    )


def show(label: str, res: Response, limit: int = 400) -> None:
    body = res.body.decode("utf-8", errors="replace")
    if len(body) > limit:
        body = body[:limit] + "…"
    print(f"\n### {label}\nHTTP {res.status}\n{body}")
