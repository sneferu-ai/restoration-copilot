"""pytest configuration for the Restoration Copilot suite.

Registers ``--e2e`` (FR-064) and ``--browser`` options, provides an
in-process WSGI test client (no sockets, no httpx dependency), per-test
RUNS_ROOT isolation, and magic-byte image fixtures.
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.parse
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from orchestrator.api.server import App  # noqa: E402
from orchestrator.core.restoration_pipeline import RestorationPipeline  # noqa: E402


# ---------------------------------------------------------------------------
# --e2e (FR-064) and --browser flags
# ---------------------------------------------------------------------------


def pytest_addoption(parser):
    parser.addoption(
        "--e2e",
        action="store_true",
        default=False,
        help="run tests marked e2e against real provider bridges (requires API keys)",
    )
    parser.addoption(
        "--run-browser",
        action="store_true",
        default=False,
        help="run tests marked browser (Playwright; renamed from --browser to "
             "avoid collision with pytest-playwright's own --browser option)",
    )


def pytest_configure(config):
    config.addinivalue_line("markers", "e2e: real-bridge end-to-end (requires --e2e + API keys)")
    config.addinivalue_line("markers", "browser: Playwright browser tests (requires --run-browser)")
    if config.getoption("--e2e"):
        missing = [
            key
            for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BFL_API_KEY", "MESHY_API_KEY")
            if not os.environ.get(key)
        ]
        if missing:
            raise pytest.UsageError(
                f"--e2e requires API keys; missing: {', '.join(missing)} (FR-064)"
            )
        os.environ["RUNS_ROOT"] = str(REPO_ROOT / "tests" / "restoration" / "tmp_runs")


def pytest_collection_modifyitems(config, items):
    skip_e2e = pytest.mark.skip(reason="requires --e2e (FR-064)")
    skip_browser = pytest.mark.skip(reason="requires --run-browser")
    for item in items:
        if "e2e" in item.keywords and not config.getoption("--e2e"):
            item.add_marker(skip_e2e)
        if "browser" in item.keywords and not config.getoption("--run-browser"):
            item.add_marker(skip_browser)


# ---------------------------------------------------------------------------
# Image byte fixtures (magic bytes per FR-002)
# ---------------------------------------------------------------------------


def jpeg_bytes(seed: int = 0) -> bytes:
    return (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x00\x00"
        + bytes([seed % 256]) * 64
    )


def png_bytes(seed: int = 0) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\x0dIHDR"
        + bytes([seed % 256]) * 32
    )


def heic_bytes(seed: int = 0) -> bytes:
    return b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1" + bytes([seed % 256]) * 32


def webp_bytes(seed: int = 0) -> bytes:
    payload = b"VP8 " + bytes([seed % 256]) * 24
    return b"RIFF" + len(payload).to_bytes(4, "little") + b"WEBP" + payload


def gif_bytes(seed: int = 0) -> bytes:
    return b"GIF89a" + b"\x01\x00\x01\x00" + bytes([seed % 256]) * 16


@pytest.fixture
def image_factory():
    return {"jpeg": jpeg_bytes, "png": png_bytes, "heic": heic_bytes, "webp": webp_bytes, "gif": gif_bytes}


# ---------------------------------------------------------------------------
# Pipeline + in-process WSGI client fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def pipeline(tmp_path):
    config_dir = tmp_path / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    # Copy seed KB + sources YAML so tests that depend on seed entries work
    import shutil
    seed_kb = REPO_ROOT / "orchestrator" / "prompts" / "packs" / "restoration_kb.yaml"
    seed_sources = REPO_ROOT / "orchestrator" / "prompts" / "packs" / "restoration_sources.yaml"
    if seed_kb.exists():
        shutil.copy2(seed_kb, config_dir / "restoration_kb.yaml")
    if seed_sources.exists():
        shutil.copy2(seed_sources, config_dir / "restoration_sources.yaml")
    return RestorationPipeline(
        runs_root=tmp_path / "runs", config={"tasks_inline": True}, config_dir=config_dir
    )


class ClientResponse:
    def __init__(self, status: int, headers: list, body: bytes):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf-8")) if self.body else None


class WSGIClient:
    """In-process client: builds a WSGI environ and calls the app directly."""

    def __init__(self, app: App):
        self.app = app
        self.session_token: str | None = None

    def login(self, username: str = "operator", password: str = "restoration-dev") -> str:
        res = self.post("/admin/operator/session", json={"username": username, "password": password})
        assert res.status == 200, res.body
        self.session_token = res.json()["session_token"]
        return self.session_token

    def request(
        self,
        method: str,
        path: str,
        json_body=None,
        multipart=None,
        headers=None,
        token: str | None = None,
        **kw,
    ) -> ClientResponse:
        if "json" in kw:  # ergonomic alias
            json_body = kw.pop("json")
        if kw:
            raise TypeError(f"unexpected kwargs: {sorted(kw)}")
        headers = dict(headers or {})
        body = b""
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        if multipart is not None:
            boundary, body = encode_multipart(**multipart)
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        effective_token = token if token is not None else self.session_token
        if effective_token:
            headers["Authorization"] = f"Bearer {effective_token}"
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
        return ClientResponse(captured["status"], captured["headers"], b"".join(chunks))

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, **kw):
        return self.request("POST", path, **kw)

    def put(self, path, **kw):
        return self.request("PUT", path, **kw)

    def delete(self, path, **kw):
        return self.request("DELETE", path, **kw)


def encode_multipart(photos=None, parts_list=None, fields=None):
    """Build a multipart/form-data body. photos/parts_list: (filename, bytes)."""
    boundary = "----restoration-test-boundary-7f3a"
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


@pytest.fixture
def client(pipeline):
    app = App(pipeline)
    return WSGIClient(app)


@pytest.fixture
def authed_client(client):
    client.login()
    return client


@pytest.fixture
def project_id(authed_client):
    res = authed_client.post(
        "/restoration/projects",
        json={"vehicle_meta": {"year": "1969", "make": "Chevrolet", "model": "Camaro"}},
    )
    assert res.status == 201, res.body
    return res.json()["project_id"]


def upload_six_photos(client, project_id, factory=None):
    photos = [("bay_%02d.jpg" % i, jpeg_bytes(i)) for i in range(6)]
    res = client.post(
        f"/restoration/projects/{project_id}/intake",
        multipart={"photos": photos},
    )
    assert res.status == 200, res.body
    return res
