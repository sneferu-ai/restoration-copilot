"""Restoration Copilot — HTTP layer (spec B13 §5 REST API surface).

In production this module's routes mount into the claudopus FastAPI host. The
sandbox build environment has no FastAPI/uvicorn and no network access, so the
identical surface is served here through a small stdlib WSGI implementation.
Every route, method, status code, and error body maps 1:1 onto the spec's REST
table; the core logic lives in ``orchestrator/core/restoration_pipeline.py``
and is framework-agnostic, so re-mounting onto FastAPI is mechanical.

Also provided (FR-026 — the module's Sneferu dependency surface, minimal
standalone shims so the product is runnable and testable in isolation):
  POST/GET /admin/operator/session, GET /live/status, GET /bridge/health,
  POST /runs/start
"""

from __future__ import annotations

import cgi
import io
import json
import logging
import mimetypes
import os
import re
import secrets
import threading
import time
import urllib.parse
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..core import restoration_reconcile
from ..core.restoration_models import TaskType
from ..core.restoration_pipeline import (
    REPO_ROOT,
    PipelineError,
    RestorationPipeline,
    _status_str,
    cleanup_stale_locks,
)

log = logging.getLogger("restoration.server")

WEB_ROOT = REPO_ROOT / "orchestrator" / "ui" / "web"

#: Operator credentials come from the environment (never hardcoded secrets).
OPERATOR_USERNAME = os.environ.get("OPERATOR_USERNAME", "operator")
OPERATOR_PASSWORD = os.environ.get("OPERATOR_PASSWORD", "restoration-dev")


# ---------------------------------------------------------------------------
# Request / Response
# ---------------------------------------------------------------------------


class Request:
    def __init__(self, environ: dict):
        self.environ = environ
        self.method = environ.get("REQUEST_METHOD", "GET").upper()
        self.path = environ.get("PATH_INFO", "/") or "/"
        self.query = {
            k: v[0] for k, v in urllib.parse.parse_qs(environ.get("QUERY_STRING", "")).items()
        }
        self.headers = self._headers(environ)
        self._body: Optional[bytes] = None
        self._json: Any = ...
        self.session: Optional[str] = None

    @staticmethod
    def _headers(environ: dict) -> Dict[str, str]:
        out = {}
        for key, value in environ.items():
            if key.startswith("HTTP_"):
                name = key[5:].replace("_", "-").title()
                out[name] = value
        if "CONTENT_TYPE" in environ:
            out["Content-Type"] = environ["CONTENT_TYPE"]
        if "CONTENT_LENGTH" in environ:
            out["Content-Length"] = environ["CONTENT_LENGTH"]
        return out

    @property
    def body(self) -> bytes:
        if self._body is None:
            try:
                length = int(self.environ.get("CONTENT_LENGTH") or 0)
            except ValueError:
                length = 0
            self._body = self.environ["wsgi.input"].read(length) if length > 0 else b""
        return self._body

    def json(self) -> Any:
        if self._json is ...:
            if not self.body:
                self._json = {}
            else:
                try:
                    self._json = json.loads(self.body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise PipelineError(400, "invalid_json", "Request body is not valid JSON.")
        return self._json

    def multipart(self) -> Tuple[List[Tuple[str, bytes]], Optional[Tuple[str, bytes]]]:
        """Parse multipart/form-data → (photos, parts_list)."""
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            raise PipelineError(400, "invalid_content_type", "Expected multipart/form-data.")
        environ = {
            "REQUEST_METHOD": "POST",
            "CONTENT_TYPE": content_type,
            "CONTENT_LENGTH": str(len(self.body)),
        }
        form = cgi.FieldStorage(fp=io.BytesIO(self.body), environ=environ, keep_blank_values=True)
        photos: List[Tuple[str, bytes]] = []
        parts_list: Optional[Tuple[str, bytes]] = None
        fields = form.list or []
        for field in fields:
            if not field.filename:
                continue
            data = field.file.read()
            if field.name == "photos":
                photos.append((field.filename, data))
            elif field.name == "parts_list":
                parts_list = (field.filename, data)
        return photos, parts_list


class Response:
    def __init__(self, status: int = 200, body: Any = None, headers: Optional[List[Tuple[str, str]]] = None,
                 content_type: str = "application/json"):
        self.status = status
        self.headers = headers or []
        self.content_type = content_type
        if body is None:
            self.raw = b""
        elif isinstance(body, (bytes, bytearray)):
            self.raw = bytes(body)
        elif isinstance(body, str):
            self.raw = body.encode("utf-8")
            if content_type == "application/json":
                self.content_type = "text/plain; charset=utf-8"
        else:
            self.raw = json.dumps(body, default=str).encode("utf-8")


# ---------------------------------------------------------------------------
# Sessions (FR-026 operator auth shim)
# ---------------------------------------------------------------------------


class SessionStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._sessions: Dict[str, dict] = {}

    def create(self, username: str) -> str:
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._sessions[token] = {"username": username, "created_at": time.time()}
        return token

    def valid(self, token: Optional[str]) -> bool:
        if not token:
            return False
        with self._lock:
            return token in self._sessions

    def revoke(self, token: str) -> None:
        with self._lock:
            self._sessions.pop(token, None)


SESSIONS = SessionStore()


class TokenRateLimiter:
    """FR-041: 60 requests per token per hour (in-memory sliding window)."""

    def __init__(self, limit: int = 60, window_s: float = 3600.0):
        self.limit = limit
        self.window_s = window_s
        self._hits: Dict[str, List[float]] = {}
        self._lock = threading.Lock()

    def allow(self, token: str) -> bool:
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(token, []) if now - t < self.window_s]
            if len(hits) >= self.limit:
                self._hits[token] = hits
                return False
            hits.append(now)
            self._hits[token] = hits
            return True


TOKEN_LIMITER = TokenRateLimiter()


def _bearer(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return request.headers.get("X-Operator-Session")


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

Handler = Callable[..., Any]
Route = Tuple[str, re.Pattern, Handler, bool]  # method, pattern, handler, operator_required


def _compile(pattern: str) -> re.Pattern:
    # {name} matches one segment; {name:path} matches across slashes (assets)
    regex = re.sub(r"\{(\w+):path\}", r"(?P<\1>.+)", pattern)
    regex = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", regex)
    return re.compile(f"^{regex}$")


class App:
    def __init__(self, pipeline: Optional[RestorationPipeline] = None):
        self.pipeline = pipeline or RestorationPipeline()
        self.routes: List[Route] = []
        self._register_routes()
        # Boot behavior: stale-lock cleanup (FR-068) + crash reconciliation (FR-067)
        try:
            cleanup_stale_locks(self.pipeline.runs_root)
            restoration_reconcile.reconcile_all(self.pipeline)
        except Exception as exc:  # noqa: BLE001 - boot must never fail on reconcile
            log.warning("boot reconcile failed: %s", exc)

    # -- routing -------------------------------------------------------------

    def add(self, method: str, pattern: str, handler: Handler, operator: bool = True) -> None:
        self.routes.append((method, _compile(pattern), handler, operator))

    def __call__(self, environ: dict, start_response: Callable) -> List[bytes]:
        request = Request(environ)
        try:
            response = self._dispatch(request)
        except PipelineError as exc:
            response = Response(exc.status, exc.body())
        except Exception as exc:  # noqa: BLE001
            from pydantic import ValidationError

            if isinstance(exc, ValidationError):
                response = Response(400, {"error": "invalid_payload", "message": str(exc)})
            else:
                log.exception("unhandled error on %s %s", request.method, request.path)
                response = Response(500, {"error": "internal_error", "message": f"{type(exc).__name__}: {exc}"})
        status_line = f"{response.status} {HTTPStatus(response.status).phrase}"
        headers = [("Content-Type", response.content_type)] + response.headers
        headers.append(("Content-Length", str(len(response.raw))))
        start_response(status_line, headers)
        return [response.raw]

    def _dispatch(self, request: Request) -> Response:
        for method, pattern, handler, operator_required in self.routes:
            if method != request.method:
                continue
            match = pattern.match(request.path)
            if not match:
                continue
            if operator_required and not SESSIONS.valid(_bearer(request)):
                raise PipelineError(401, "unauthorized", "Operator session required.")
            result = handler(request, **match.groupdict())
            if isinstance(result, Response):
                return result
            return Response(200, result)
        raise PipelineError(404, "not_found", f"No route {request.method} {request.path}.")

    # -- route table -----------------------------------------------------------

    def _register_routes(self) -> None:
        p = self.pipeline

        # --- host shims (FR-026 dependency surface) ---
        self.add("POST", "/admin/operator/session", self._login, operator=False)
        self.add("GET", "/admin/operator/session", self._session_info, operator=False)
        self.add("GET", "/live/status", lambda r: {"status": "ok"}, operator=False)
        self.add("GET", "/bridge/health", self._bridge_health, operator=False)
        self.add("POST", "/runs/start", self._runs_start, operator=False)

        # --- static + pages (FR-061) ---
        self.add("GET", "/restoration-ui", self._operator_console, operator=False)
        # S-8: catch-all so BrowserRouter deep links (e.g. /restoration-ui/jobs/abc)
        # refresh to the SPA shell instead of 404. This is a routing-table addition,
        # not a new product endpoint (spec §3, decision S-8).
        self.add("GET", "/restoration-ui/{path:path}", self._operator_console, operator=False)
        self.add("GET", "/restoration/health", lambda r: p.health(), operator=False)
        self.add("GET", "/guide/{token}", self._guide, operator=False)
        self.add("GET", "/static/restoration/{filename:path}", self._static, operator=False)

        # --- projects (FR-001, FR-033…) ---
        self.add("POST", "/restoration/projects", self._create_project)
        self.add("GET", "/restoration/projects", self._list_projects)
        self.add("GET", "/restoration/projects/{project_id}", self._get_project)
        self.add("POST", "/restoration/projects/{project_id}/intake", self._intake)
        self.add("POST", "/restoration/projects/{project_id}/intake/seal", self._seal)
        self.add("POST", "/restoration/projects/{project_id}/identify", self._identify)
        self.add("GET", "/restoration/tasks/{task_id}", self._get_task)
        self.add("POST", "/restoration/tasks/{task_id}/resume", self._resume_task)
        self.add("GET", "/restoration/projects/{project_id}/manifest", self._get_manifest)
        self.add("POST", "/restoration/projects/{project_id}/manifest/resolve", self._resolve_review)
        self.add("GET", "/restoration/projects/{project_id}/reviews", self._list_reviews)
        self.add("POST", "/restoration/projects/{project_id}/manifest/lock", self._lock_manifest)
        self.add("POST", "/restoration/projects/{project_id}/budget", self._budget)
        self.add("POST", "/restoration/projects/{project_id}/budget/override", self._budget_override)
        self.add("POST", "/restoration/projects/{project_id}/sourcing/manual", self._manual_candidate)
        self.add("GET", "/restoration/projects/{project_id}/sourcing", self._sourcing_summary)
        self.add("POST", "/restoration/projects/{project_id}/source", self._start_sourcing)
        self.add("POST", "/restoration/projects/{project_id}/sourcing/pause", self._pause_sourcing)
        self.add("POST", "/restoration/projects/{project_id}/sourcing/resume", self._resume_sourcing)
        self.add("POST", "/restoration/projects/{project_id}/sourcing/seal", self._seal_sourcing)
        self.add("POST", "/restoration/projects/{project_id}/negotiation", self._negotiation)
        self.add("POST", "/restoration/projects/{project_id}/purchase", self._purchase)
        self.add("POST", "/restoration/projects/{project_id}/flags", self._submit_flag)
        self.add("GET", "/restoration/projects/{project_id}/flags", self._list_flags)
        self.add("POST", "/restoration/projects/{project_id}/flags/{flag_id}/resolve", self._resolve_flag)
        self.add("POST", "/restoration/projects/{project_id}/in-service", self._in_service)
        self.add("POST", "/restoration/projects/{project_id}/abandon", self._abandon)
        self.add("POST", "/restoration/projects/{project_id}/reopen", self._reopen)
        self.add("POST", "/restoration/projects/{project_id}/park", self._park)
        self.add("POST", "/restoration/projects/{project_id}/unpark", self._unpark)

        # --- tokens (FR-039/040) ---
        self.add("POST", "/restoration/projects/{project_id}/tokens", self._mint_token)
        self.add("DELETE", "/restoration/projects/{project_id}/tokens/{token_id}", self._revoke_token)
        self.add("DELETE", "/restoration/projects/{project_id}/tokens", self._revoke_all)
        self.add("POST", "/restoration/projects/{project_id}/tokens/{token_id}/supersede", self._supersede_token)
        self.add("POST", "/restoration/projects/{project_id}/tokens/{token_id}/extend", self._extend_token)

        # --- api cost (FR-051/065) ---
        self.add("GET", "/restoration/projects/{project_id}/api-costs", self._api_costs)
        self.add("POST", "/restoration/projects/{project_id}/api-cost/override", self._api_cost_override)

        # --- reconcile (FR-067) + sources (FR-012) ---
        self.add("POST", "/restoration/reconcile/{run_id}", self._reconcile)
        self.add("GET", "/restoration/sources", self._sources)
        self.add("POST", "/restoration/sources", self._add_source)
        self.add("PUT", "/restoration/sources/{source_id}", self._update_source)
        self.add("DELETE", "/restoration/sources/{source_id}", self._delete_source)

        # --- KB management (FR-056) ---
        self.add("GET", "/restoration/kb/entries", self._list_kb_entries)
        self.add("POST", "/restoration/kb/entries", self._add_kb_entry)
        self.add("PUT", "/restoration/kb/entries/{part_id}", self._update_kb_entry)
        self.add("DELETE", "/restoration/kb/entries/{part_id}", self._delete_kb_entry)
        self.add("POST", "/restoration/kb/approve", self._approve_kb_proposal)

        # --- provider management (FR-066) ---
        self.add("POST", "/restoration/provider/pause", self._pause_provider)
        self.add("POST", "/restoration/provider/resume", self._resume_provider)
        self.add("POST", "/restoration/provider/failover", self._failover_provider)
        self.add("POST", "/restoration/provider/recheck", self._recheck_provider)

    # -- host shim handlers ----------------------------------------------------

    def _login(self, request: Request) -> Response:
        body = request.json()
        if body.get("username") != OPERATOR_USERNAME or body.get("password") != OPERATOR_PASSWORD:
            raise PipelineError(401, "invalid_credentials", "Invalid credentials.")
        token = SESSIONS.create(body["username"])
        return Response(200, {"session_token": token, "username": body["username"]})

    def _session_info(self, request: Request) -> Response:
        token = _bearer(request)
        if not SESSIONS.valid(token):
            raise PipelineError(401, "unauthorized", "No valid operator session.")
        return Response(200, {"valid": True, "session": token[:8] + "…"})

    def _bridge_health(self, request: Request) -> Response:
        return Response(
            200,
            {
                # Standalone there is no Sneferu bridge behind vision or sourcing
                # (RestorationPipeline._bridge_dispatcher raises
                # BridgeUnavailableError), so neither may report healthy. In a
                # Sneferu host this route is the host's own /bridge/health.
                "bridges": {
                    "vision": {"configured": False, "healthy": False, "unverified": True},
                    "sourcing": {"configured": False, "healthy": False, "unverified": True},
                    "bfl": {"configured": False, "healthy": False, "unverified": True},
                    "meshy": {"configured": False, "healthy": False, "unverified": True},
                    "tts": {"configured": False, "healthy": False, "unverified": True},
                }
            },
        )

    def _runs_start(self, request: Request) -> Response:
        body = request.json()
        workflow = body.get("workflow")
        if workflow != "restoration_pipeline":
            raise PipelineError(400, "unknown_workflow", f"Unknown workflow {workflow!r}.")
        return Response(200, {"run_id": f"manual-{secrets.token_hex(4)}", "workflow": workflow})

    # -- pages / static -----------------------------------------------------------

    def _serve_file(self, path: Path, content_type: str, extra_headers: Optional[List[Tuple[str, str]]] = None) -> Response:
        try:
            raw = path.read_bytes()
        except OSError:
            raise PipelineError(404, "not_found", f"Missing asset {path.name}.")
        return Response(200, raw, headers=extra_headers or [], content_type=content_type)

    def _operator_console(self, request: Request, **kw: Any) -> Response:
        # Serve the compiled React SPA (vite build output). Falls back to the
        # legacy restoration_copilot.html only if the built bundle is absent
        # (e.g. dev server mode where vite serves index.html itself).
        built = WEB_ROOT / "static" / "restoration" / "app" / "operator" / "index.html"
        if built.exists():
            return self._serve_file(built, "text/html; charset=utf-8")
        return self._serve_file(WEB_ROOT / "restoration_copilot.html", "text/html; charset=utf-8")

    def _static(self, request: Request, filename: str) -> Response:
        # traversal-proof: resolve and require containment under WEB_ROOT
        candidates = [
            WEB_ROOT / "static" / "restoration" / filename,
            WEB_ROOT / filename,
        ]
        for path in candidates:
            try:
                resolved = path.resolve()
                resolved.relative_to(WEB_ROOT.resolve())
            except (OSError, ValueError):
                continue
            if resolved.is_file():
                ctype = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
                return self._serve_file(resolved, ctype)
        raise PipelineError(404, "not_found", f"No static asset {filename}.")

    def _guide(self, request: Request, token: str) -> Response:
        verdict, run_dir, row = self.pipeline.validate_token(token)
        if verdict == "revoked":
            raise PipelineError(404, "token_not_found", "Guide link is not valid.")
        if verdict == "expired":
            raise PipelineError(
                410,
                "token_expired",
                "This guide link has expired. Contact the shop operator for a new guide link.",
            )
        limit = int(self.pipeline.config["token_rate_limit_per_hour"])
        TOKEN_LIMITER.limit = limit
        if not TOKEN_LIMITER.allow(token):
            raise PipelineError(
                429, "rate_limited", f"Guide token rate limit exceeded ({limit} requests/hour)."
            )
        self.pipeline.touch_token(run_dir, token)
        headers = [("Referrer-Policy", "no-referrer")]
        if verdict == "superseded":
            headers.append(("X-Guide-Superseded", "true"))
        built = WEB_ROOT / "static" / "restoration" / "app" / "guide" / "index.html"
        if built.exists():
            page = built.read_text(encoding="utf-8")
            meta = json.dumps({"token_id": token, "assembly_id": row["assembly_id"]})
            inject = f"<script>window.__GUIDE_META__={meta};</script>"
            page = page.replace("</head>", f"{inject}</head>", 1)
        else:
            page = (WEB_ROOT / "bay_guide.html").read_text(encoding="utf-8")
            page = page.replace("{{TOKEN}}", token).replace("{{ASSEMBLY_ID}}", row["assembly_id"])
        return Response(200, page, headers=headers, content_type="text/html; charset=utf-8")

    # -- project handlers ----------------------------------------------------------

    def _actor(self, request: Request) -> str:
        return "operator"

    def _create_project(self, request: Request) -> Response:
        body = request.json()
        result = self.pipeline.create_project(body.get("vehicle_meta") or {}, actor=self._actor(request))
        return Response(201, result)

    def _list_projects(self, request: Request) -> Response:
        return Response(
            200,
            self.pipeline.list_projects(
                state=request.query.get("state"), search=request.query.get("search")
            ),
        )

    def _get_project(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.get_project(project_id).model_dump(mode="json"))

    def _intake(self, request: Request, project_id: str) -> Response:
        photos, parts_list = request.multipart()
        if not photos and parts_list is None:
            raise PipelineError(400, "empty_intake", "Provide at least one photo or a parts list.")
        result = self.pipeline.intake_upload(project_id, photos, parts_list, actor=self._actor(request))
        return Response(200, result)

    def _seal(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.seal_intake(project_id, actor=self._actor(request)))

    def _identify(self, request: Request, project_id: str) -> Response:
        result = self.pipeline.start_task(project_id, TaskType.IDENTIFY, actor=self._actor(request))
        return Response(202, result)

    def _get_task(self, request: Request, task_id: str) -> Response:
        return Response(200, self.pipeline.get_task(task_id))

    def _resume_task(self, request: Request, task_id: str) -> Response:
        result = self.pipeline.resume_task(task_id, actor=self._actor(request))
        return Response(202, result)

    def _get_manifest(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.get_manifest(project_id))

    def _resolve_review(self, request: Request, project_id: str) -> Response:
        return Response(
            200, self.pipeline.resolve_review(project_id, request.json(), actor=self._actor(request))
        )

    def _list_reviews(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.list_reviews(project_id))

    def _lock_manifest(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.lock_manifest(project_id, actor=self._actor(request)))

    def _budget(self, request: Request, project_id: str) -> Response:
        body = request.json()
        ceiling = body.get("budget_ceiling_usd")
        if not isinstance(ceiling, (int, float)):
            raise PipelineError(400, "invalid_budget", "budget_ceiling_usd must be a positive number (USD).")
        return Response(
            200, self.pipeline.compute_budget_ruling(project_id, float(ceiling), actor=self._actor(request))
        )

    def _budget_override(self, request: Request, project_id: str) -> Response:
        body = request.json()
        return Response(
            200,
            self.pipeline.override_budget(project_id, body.get("reason") or "", actor=self._actor(request)),
        )

    def _manual_candidate(self, request: Request, project_id: str) -> Response:
        return Response(
            200, self.pipeline.add_manual_candidate(project_id, request.json(), actor=self._actor(request))
        )

    def _sourcing_summary(self, request: Request, project_id: str) -> Response:
        coverage = self.pipeline.compute_coverage(project_id)
        candidates = self.pipeline.list_candidates(project_id)
        flags = self.pipeline.list_unsourceable_flags(project_id)
        return Response(200, {"candidates": candidates, "flags": flags, **coverage})

    def _negotiation(self, request: Request, project_id: str) -> Response:
        return Response(
            200, self.pipeline.record_negotiation(project_id, request.json(), actor=self._actor(request))
        )

    def _purchase(self, request: Request, project_id: str) -> Response:
        return Response(
            200, self.pipeline.record_purchase(project_id, request.json(), actor=self._actor(request))
        )

    def _in_service(self, request: Request, project_id: str) -> Response:
        body = request.json()
        project = self.pipeline.transition(
            project_id, "in_service", actor=self._actor(request), checklist=body.get("checklist")
        )
        return Response(200, {"status": _status_str(project.status)})

    def _abandon(self, request: Request, project_id: str) -> Response:
        body = request.json()
        project = self.pipeline.transition(
            project_id, "abandoned", actor=self._actor(request), reason=body.get("reason")
        )
        return Response(200, {"status": _status_str(project.status), "abandoned_reason": project.abandoned_reason})

    def _reopen(self, request: Request, project_id: str) -> Response:
        body = request.json()
        project = self.pipeline.transition(
            project_id, "manifest_locked", actor=self._actor(request), reason=body.get("reason")
        )
        return Response(200, {"status": _status_str(project.status)})

    def _park(self, request: Request, project_id: str) -> Response:
        body = request.json()
        project = self.pipeline.park(project_id, body.get("reason") or "parked by operator")
        return Response(200, {"status": _status_str(project.status), "parked": True})

    def _unpark(self, request: Request, project_id: str) -> Response:
        project = self.pipeline.unpark(project_id)
        return Response(200, {"status": _status_str(project.status), "parked": False})

    def _mint_token(self, request: Request, project_id: str) -> Response:
        body = request.json()
        assembly_id = body.get("assembly_id")
        if not assembly_id:
            raise PipelineError(400, "missing_field", "assembly_id is required.")
        token = self.pipeline.mint_token(
            project_id,
            assembly_id,
            int(body.get("bundle_version") or 1),
            actor=self._actor(request),
        )
        return Response(201, token.model_dump(mode="json"))

    def _revoke_token(self, request: Request, project_id: str, token_id: str) -> Response:
        return Response(200, self.pipeline.revoke_token(project_id, token_id, actor=self._actor(request)))

    def _revoke_all(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.revoke_all_tokens(project_id, actor=self._actor(request)))

    def _supersede_token(self, request: Request, project_id: str, token_id: str) -> Response:
        return Response(200, self.pipeline.supersede_token(project_id, token_id, actor=self._actor(request)))

    def _extend_token(self, request: Request, project_id: str, token_id: str) -> Response:
        body = request.json()
        return Response(
            200,
            self.pipeline.extend_token(
                project_id, token_id, int(body.get("extends_days") or 30), actor=self._actor(request)
            ),
        )

    def _api_costs(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.api_cost_summary(project_id))

    def _api_cost_override(self, request: Request, project_id: str) -> Response:
        body = request.json()
        return Response(
            200,
            self.pipeline.override_api_cost_ceiling(project_id, body.get("reason") or "", actor=self._actor(request)),
        )

    def _reconcile(self, request: Request, run_id: str) -> Response:
        return Response(200, restoration_reconcile.reconcile_by_run_id(self.pipeline, run_id))

    def _sources(self, request: Request) -> Response:
        return Response(200, [s.model_dump(mode="json") for s in self.pipeline.list_sources()])

    # -- sourcing hunt (FR-012/FR-013/FR-038/FR-070) ----------------------------

    def _start_sourcing(self, request: Request, project_id: str) -> Response:
        task = self.pipeline.start_task(
            project_id, TaskType.SOURCE, actor=self._actor(request)
        )
        return Response(202, {"task_id": task["task_id"], "status": task["status"]})

    def _pause_sourcing(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.pause_hunt(project_id, actor=self._actor(request)))

    def _resume_sourcing(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.resume_hunt(project_id, actor=self._actor(request)))

    def _seal_sourcing(self, request: Request, project_id: str) -> Response:
        body = request.json() or {}
        accept_partial = body.get("accept_partial", False)
        if isinstance(accept_partial, str):
            accept_partial = accept_partial.strip().lower() in ("true", "1", "yes")
        reason = body.get("reason") or ""
        return Response(
            200,
            self.pipeline.seal_hunt(
                project_id,
                actor=self._actor(request),
                accept_partial=bool(accept_partial),
                reason=str(reason),
            ),
        )

    # -- source registry CRUD (FR-012) -------------------------------------------

    def _add_source(self, request: Request) -> Response:
        return Response(201, self.pipeline.add_source(request.json(), actor=self._actor(request)))

    def _update_source(self, request: Request, source_id: str) -> Response:
        return Response(200, self.pipeline.update_source(source_id, request.json(), actor=self._actor(request)))

    def _delete_source(self, request: Request, source_id: str) -> Response:
        return Response(200, self.pipeline.delete_source(source_id, actor=self._actor(request)))

    # -- KB management (FR-056) ---------------------------------------------------

    def _list_kb_entries(self, request: Request) -> Response:
        make = request.query.get("make")
        model = request.query.get("model")
        year = request.query.get("year")
        return Response(200, self.pipeline.list_kb_entries(make=make, model=model, year=year))

    def _add_kb_entry(self, request: Request) -> Response:
        return Response(201, self.pipeline.add_kb_entry(request.json(), actor=self._actor(request)))

    def _update_kb_entry(self, request: Request, part_id: str) -> Response:
        return Response(200, self.pipeline.update_kb_entry(part_id, request.json(), actor=self._actor(request)))

    def _delete_kb_entry(self, request: Request, part_id: str) -> Response:
        return Response(200, self.pipeline.delete_kb_entry(part_id, actor=self._actor(request)))

    def _approve_kb_proposal(self, request: Request) -> Response:
        body = request.json()
        proposal_id = body.get("proposal_id")
        if not proposal_id:
            raise PipelineError(400, "missing_field", "proposal_id is required.")
        return Response(200, self.pipeline.approve_kb_proposal(proposal_id, actor=self._actor(request)))

    # -- provider management (FR-066) ---------------------------------------------

    def _pause_provider(self, request: Request) -> Response:
        body = request.json()
        return Response(200, self.pipeline.pause_provider(body.get("provider") or "", actor=self._actor(request)))

    def _resume_provider(self, request: Request) -> Response:
        body = request.json()
        return Response(200, self.pipeline.resume_provider(body.get("provider") or "", actor=self._actor(request)))

    def _failover_provider(self, request: Request) -> Response:
        body = request.json()
        return Response(
            200,
            self.pipeline.failover_provider(
                body.get("provider") or "", body.get("fallback") or "", actor=self._actor(request)
            ),
        )

    def _recheck_provider(self, request: Request) -> Response:
        body = request.json()
        return Response(200, self.pipeline.recheck_provider(body.get("provider") or "", actor=self._actor(request)))

    # -- mechanic flags (FR-054) --------------------------------------------------

    def _submit_flag(self, request: Request, project_id: str) -> Response:
        return Response(201, self.pipeline.submit_flag(project_id, request.json(), actor=self._actor(request)))

    def _list_flags(self, request: Request, project_id: str) -> Response:
        return Response(200, self.pipeline.list_flags(project_id))

    def _resolve_flag(self, request: Request, project_id: str, flag_id: str) -> Response:
        body = request.json()
        return Response(
            200,
            self.pipeline.resolve_flag(
                project_id, flag_id, body.get("resolution_notes") or "", actor=self._actor(request)
            ),
        )


def create_app(pipeline: Optional[RestorationPipeline] = None) -> App:
    return App(pipeline)


def main() -> None:  # pragma: no cover - manual entry point
    from wsgiref.simple_server import make_server

    port = int(os.environ.get("PORT", "8000"))
    app = create_app()
    log.info("Restoration Copilot (stdlib WSGI) listening on http://0.0.0.0:%s", port)
    with make_server("0.0.0.0", port, app) as server:
        server.serve_forever()


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO)
    main()
