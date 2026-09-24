"""Restoration Copilot — workflow definitions, state machine, and primitive
orchestration (spec B13 §3–§5).

This module is the framework-agnostic core. The HTTP layer
(``orchestrator/api/server.py``) is a thin adapter over this class; all state
rules live here so the module can be mounted into the production FastAPI host
unchanged.

Persistence (FR-027/FR-028):
  * JSON artifacts under runs/<run_id>/restoration/ with fcntl.flock sidecars
  * per-run SQLite restoration.db (WAL, 5s busy timeout) — CANONICAL events
  * shared runs/restoration_feedback.db learning ledger (WAL)
  * runs/restoration_index.json is a CACHE, rebuilt from SQLite+project.json
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from . import restoration_yaml
from .restoration_models import (
    AsyncTask,
    BudgetRuling,
    ComponentRecord,
    Criticality,
    FeedbackSignal,
    FlagStatus,
    GuideToken,
    IntakeReceipt,
    ManifestEntry,
    MechanicFlag,
    NegotiationRecord,
    NEGOTIATION_TRANSITIONS,
    NegotiationStatus,
    PART_CATEGORIES,
    PartSourcingQuery,
    ProblemType,
    ProjectStatus,
    Provenance,
    PurchaseRecord,
    ReferenceKBEntry,
    RestorationProject,
    SourcingCandidate,
    SourceRegistryEntry,
    SourcingStatus,
    SYSTEM_DISCOVERED_PROVENANCES,
    TOTAL_COVERAGE_PROVENANCES,
    TaskStatus,
    TaskType,
    UnsourceableFlag,
    VehicleMeta,
)
from . import research_primitives
from .research_primitives import (
    BridgeTimeoutError,
    BridgeUnavailableError,
    ParseError,
    RateLimitExceeded,
)

log = logging.getLogger("restoration")

try:  # FR-062: fcntl.flock is POSIX-only
    import fcntl

    _FCNTL_OK = True
except ImportError:  # pragma: no cover - exercised via monkeypatch on POSIX
    fcntl = None  # type: ignore[assignment]
    _FCNTL_OK = False

try:  # Optional imaging stack (declared in pyproject for production)
    from PIL import Image  # type: ignore

    _PIL_OK = True
except ImportError:  # pragma: no cover - sandbox has no Pillow
    Image = None  # type: ignore[assignment]
    _PIL_OK = False

try:
    import pillow_heif  # type: ignore

    _HEIF_OK = True
except ImportError:  # pragma: no cover - sandbox has no pillow-heif
    pillow_heif = None  # type: ignore[assignment]
    _HEIF_OK = False


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class PipelineError(Exception):
    """Carries an HTTP-shaped error up to the API adapter."""

    def __init__(self, status: int, code: str, message: str, extra: Optional[dict] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}

    def body(self) -> dict:
        out = {"error": self.code, "message": self.message}
        out.update(self.extra)
        return out


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_CONFIG: Dict[str, Any] = {
    "restoration_confidence_threshold": 0.70,
    "restoration_vlm_only_threshold": 0.85,
    "restoration_budget_affordable_pct": 0.80,
    "restoration_budget_tight_pct": 1.00,
    "restoration_unknown_cost_pct": 0.30,
    "restoration_api_cost_ceiling_usd": 100.0,
    "restoration_api_pricing": {
        "bfl": {"image_generation": 0.05},
        "meshy": {"mesh_generation": 0.20},
        "llm": {"vision": 0.02, "sourcing": 0.01},
        "tts": {"tts": 0.015},
    },
    "restoration_3d_degradation_threshold": 0.30,
    "restoration_sourcing_floor": 0.50,
    "hunt_timeout_seconds": 3600,
    "restoration_max_concurrent_sourcing": 3,
    "restoration_max_sourcing_per_project": 1,
    "restoration_in_service_checklist": [
        "all critical sub-assemblies published",
        "operator has verified the vehicle is road-ready",
    ],
    "audio_lufs_target": -16.0,
    "learning_ledger": {
        "K": 0.2,
        "minimum_samples": 5,
        "recency_decay_base": 0.95,
        "max_correction_age_months": 12,
    },
    "tier_allocation": {"critical": 0.60, "standard": 0.30, "optional": 0.10},
    "events_jsonl_max_bytes": 10 * 1024 * 1024,
    "events_jsonl_max_rotated": 5,
    "tasks_inline": False,
    "min_usable_photos": 6,
    "max_photo_bytes": 25 * 1024 * 1024,
    "max_batch_files": 50,
    "thumbnail_max_px": 1024,
    "token_expiry_days": 30,
    "token_extend_max_days": 365,
    "token_rate_limit_per_hour": 60,
}


def load_config(runs_root: Path) -> Dict[str, Any]:
    """defaults.yaml overlay on DEFAULT_CONFIG (values live in YAML, §9)."""
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    path = REPO_ROOT / "orchestrator" / "config" / "defaults.yaml"
    try:
        raw = restoration_yaml.load_file(str(path)) or {}
    except FileNotFoundError:
        return cfg
    except Exception as exc:  # malformed YAML — loud, fall back to code defaults
        log.warning("defaults.yaml parse failed (%s); using code defaults", exc)
        return cfg
    block = raw.get("restoration") if isinstance(raw, dict) else None
    if isinstance(block, dict):
        for key, value in block.items():
            if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                cfg[key].update(value)
            else:
                cfg[key] = value
    return cfg


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _parse_dt(value: Any) -> Optional[datetime]:
    if value is None or isinstance(value, datetime):
        return value
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _months_old(then: datetime, now: datetime) -> float:
    return max(0.0, (now - then).days / 30.4375)


def _safe_filename(name: str) -> str:
    base = os.path.basename(name or "upload")
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "upload"
    return base[:120]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _status_str(status: Any) -> str:
    """project.status is a plain str per §5 (custom injected statuses must
    display); enum members assigned in code read back through .value."""
    return status.value if hasattr(status, "value") else str(status)


def detect_photo_format(data: bytes) -> Optional[str]:
    """FR-002 magic-byte validation (content-based, never extension)."""
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if len(data) >= 4 and data[:4] == b"\x89PNG":
        return "png"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix"):
        return "heic"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def describe_format_mismatch(data: bytes) -> str:
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF89a" if data[:6] == b"GIF89a" else "GIF87a"
    if data[:2] == b"BM":
        return "BMP"
    if data[:4] == b"%PDF":
        return "PDF"
    return "unknown"


# ---------------------------------------------------------------------------
# fcntl lock sidecars (FR-047/FR-048) + stale-lock cleanup (FR-068)
# ---------------------------------------------------------------------------


class _FileLock:
    """fcntl.flock on a per-file .lock sidecar; PID recorded inside (FR-068)."""

    def __init__(self, target: Path):
        self.lock_path = target.with_name(target.name + ".lock")

    def __enter__(self) -> "_FileLock":
        if not _FCNTL_OK:
            raise PipelineError(
                409,
                "os_not_supported",
                "Restoration Copilot requires Linux or macOS for file locking. See FR-062.",
            )
        self._fh = open(self.lock_path, "a+", encoding="utf-8")
        fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(str(os.getpid()))
        self._fh.flush()
        return self

    def __exit__(self, *exc: Any) -> None:
        # NOTE: the sidecar is deliberately NOT unlinked. Unlinking creates an
        # inode race (a second opener flocks the old inode while a third opens
        # a fresh file — no mutual exclusion). Leaving the file lets flock
        # exclude correctly; FR-068 stale cleanup removes locks whose recorded
        # PID is dead.
        fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        self._fh.close()


def cleanup_stale_locks(runs_root: Path, logger: Optional[logging.Logger] = None) -> List[str]:
    """FR-068: remove lock files whose recorded PID is dead (SIGKILL edge).

    fcntl.flock locks auto-release on process exit; this handles the case of a
    process killed before unlinking the sidecar file itself."""
    logger = logger or log
    cleared: List[str] = []
    candidates: List[Path] = []
    index_lock = runs_root / ".restoration_index.lock"
    if index_lock.exists():
        candidates.append(index_lock)
    for lock in runs_root.glob("*/restoration/**/*.lock"):
        candidates.append(lock)
    for lock_path in candidates:
        try:
            pid_text = lock_path.read_text(encoding="utf-8").strip()
            pid = int(pid_text) if pid_text else -1
        except (OSError, ValueError):
            pid = -1
        alive = False
        if pid > 0:
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            except PermissionError:
                alive = True  # fail closed: another user's live process
            except OSError:
                alive = True
        if not alive:
            try:
                lock_path.unlink()
                cleared.append(str(lock_path))
                logger.warning(
                    "stale_lock_cleared path=%s dead_pid=%s", lock_path, pid
                )
            except OSError:
                pass
    return cleared


# ---------------------------------------------------------------------------
# SQLite layer (FR-027)
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    project_id TEXT,
    event_type TEXT,
    timestamp TEXT,
    actor TEXT,
    metadata TEXT
);
CREATE TABLE IF NOT EXISTS sourcing_candidates (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, part_id TEXT, candidate_id TEXT, vendor TEXT,
    oem_number TEXT, price_usd REAL, condition TEXT, availability TEXT,
    region TEXT, url_or_contact TEXT, tradeable INTEGER, provenance TEXT,
    fetched_at TEXT, trade_partner_id TEXT, selected INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS unsourceable_flags (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, part_id TEXT, reason_code TEXT,
    alternative_suggestion TEXT, fabrication_reference_glb TEXT
);
CREATE TABLE IF NOT EXISTS negotiation_records (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, part_id TEXT, candidate_id TEXT, status TEXT,
    notes TEXT, final_price_usd REAL, updated_at TEXT,
    UNIQUE(project_id, part_id, candidate_id)
);
CREATE TABLE IF NOT EXISTS purchase_records (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, part_id TEXT, vendor TEXT, price_usd REAL,
    condition TEXT, ordered_at TEXT, received_at TEXT, notes TEXT, batch_id TEXT
);
CREATE TABLE IF NOT EXISTS guide_tokens (
    token_id TEXT PRIMARY KEY, project_id TEXT, assembly_id TEXT,
    bundle_version INTEGER, minted_at TEXT, expires_at TEXT,
    revoked_at TEXT, revoked_by TEXT, superseded_at TEXT, superseded_by TEXT,
    last_accessed_at TEXT, access_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS review_log (
    review_id TEXT PRIMARY KEY, project_id TEXT, part_id TEXT,
    field_name TEXT, old_value TEXT, new_value TEXT, actor TEXT,
    timestamp TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY, project_id TEXT, task_type TEXT, status TEXT,
    progress_pct REAL, result TEXT, error TEXT,
    created_at TEXT, updated_at TEXT, resumed_from TEXT
);
CREATE TABLE IF NOT EXISTS api_costs (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, provider TEXT, operation TEXT, cost_usd REAL,
    timestamp TEXT, description TEXT
);
CREATE TABLE IF NOT EXISTS kb_proposals (
    proposal_id TEXT PRIMARY KEY, project_id TEXT, payload TEXT,
    status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS mechanic_flags (
    flag_id TEXT PRIMARY KEY, project_id TEXT, assembly_id TEXT,
    step_index INTEGER, problem_type TEXT, description TEXT,
    screenshot_path TEXT, photo_path TEXT, status TEXT,
    created_at TEXT, resolved_at TEXT, resolution_notes TEXT
);
"""

FEEDBACK_SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback_signals (
    signal_id TEXT PRIMARY KEY, project_id TEXT, signal_type TEXT,
    part_id TEXT, category TEXT, vehicle_make TEXT, vehicle_model TEXT,
    vehicle_year TEXT, field_name TEXT, old_value TEXT, new_value TEXT,
    vendor TEXT, final_price_usd REAL, created_at TEXT
);
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=5.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def ensure_schema(db_path: Path, schema: str = SCHEMA) -> None:
    with _connect(db_path) as conn:
        conn.executescript(schema)
        conn.commit()


def _rows(db_path: Path, sql: str, args: Iterable[Any] = ()) -> List[sqlite3.Row]:
    with _connect(db_path) as conn:
        return list(conn.execute(sql, tuple(args)).fetchall())


def _execute(db_path: Path, sql: str, args: Iterable[Any] = ()) -> int:
    with _connect(db_path) as conn:
        cur = conn.execute(sql, tuple(args))
        conn.commit()
        return cur.rowcount


# ---------------------------------------------------------------------------
# Task runner (FR-056)
# ---------------------------------------------------------------------------


class TaskContext:
    def __init__(self, pipeline: "RestorationPipeline", task_id: str, project_id: str, run_dir: Path):
        self.pipeline = pipeline
        self.task_id = task_id
        self.project_id = project_id
        self.run_dir = run_dir

    def progress(self, pct: float) -> None:
        self.pipeline.update_task(self.task_id, progress_pct=float(pct))
        if self.pipeline.is_cancel_requested(self.task_id):
            raise PipelineError(409, "task_cancelled", "Task was cancelled by operator action.")


TaskRunner = Callable[[TaskContext], Dict[str, Any]]


# ---------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------


class RestorationPipeline:
    def __init__(self, runs_root: Optional[Path] = None, config: Optional[dict] = None,
                 config_dir: Optional[Path] = None):
        self.runs_root = Path(
            runs_root or os.environ.get("RUNS_ROOT") or (REPO_ROOT / "runs")
        ).resolve()
        self.runs_root.mkdir(parents=True, exist_ok=True)
        self._config_dir = Path(config_dir) if config_dir else None
        self.config = load_config(self.runs_root)
        if config:
            for key, value in config.items():
                if isinstance(value, dict) and isinstance(self.config.get(key), dict):
                    self.config[key].update(value)
                else:
                    self.config[key] = value
        self._index_lock = threading.Lock()
        self._threads: Dict[str, threading.Thread] = {}
        self._cancel_flags: Dict[str, threading.Event] = {}
        self._runners: Dict[TaskType, TaskRunner] = {}
        self._pending_sqlite_events: List[Tuple[Path, dict]] = []
        self._pending_lock = threading.Lock()
        self._sourcing_sem = threading.Semaphore(
            int(self.config["restoration_max_concurrent_sourcing"])
        )
        self._sourcing_sem_lock = threading.Lock()
        self.feedback_db = self.runs_root / "restoration_feedback.db"
        ensure_schema(self.feedback_db, FEEDBACK_SCHEMA)
        self.register_runner(TaskType.IDENTIFY, self._run_identify)
        self.register_runner(TaskType.SOURCE, self._run_source)
        self._provider_status: Dict[str, str] = {}  # FR-066 provider pause/resume/failover
        self._paused_tasks: set = set()  # task IDs paused by pause_hunt (preserve interrupted status)
        self._monotonic = time.monotonic  # FR-070 hunt wall-clock (test seam)

    # -- OS support (FR-062) -------------------------------------------------

    def os_supported(self) -> bool:
        return _FCNTL_OK

    def require_supported(self) -> None:
        if not self.os_supported():
            raise PipelineError(
                409,
                "os_not_supported",
                "Restoration Copilot requires Linux or macOS for file locking. See FR-062.",
            )

    # -- paths ---------------------------------------------------------------

    def _find_run_dir(self, project_id: str) -> Path:
        for project_json in self.runs_root.glob("*/restoration/project.json"):
            try:
                with open(project_json, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if data.get("project_id") == project_id:
                    return project_json.parent
            except (OSError, json.JSONDecodeError):
                continue
        raise PipelineError(404, "project_not_found", f"No project {project_id!r}.")

    def _db_path(self, run_dir: Path) -> Path:
        return run_dir / "restoration.db"

    # -- JSON persistence (flock sidecar + atomic rename) ---------------------

    def _write_json(self, path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(data, indent=2, default=str)
        with _FileLock(path):
            tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(payload)
            os.replace(tmp, path)

    def _read_json(self, path: Path, default: Any = None) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, json.JSONDecodeError):
            return default

    # -- events (FR-028: SQLite canonical, JSONL secondary, rotated) ----------

    def write_event(
        self,
        run_dir: Path,
        project_id: Optional[str],
        event_type: str,
        actor: str = "system",
        metadata: Optional[dict] = None,
    ) -> dict:
        event = {
            "event_id": uuid.uuid4().hex,
            "project_id": project_id,
            "event_type": event_type,
            "timestamp": _iso(_utcnow()),
            "actor": actor,
            "metadata": metadata or {},
        }
        db_path = self._db_path(run_dir)
        ensure_schema(db_path)
        # flush pending retries first (FR-028 retry on next write cycle)
        with self._pending_lock:
            pending = [p for p in self._pending_sqlite_events if p[0] == db_path]
            self._pending_sqlite_events = [
                p for p in self._pending_sqlite_events if p[0] != db_path
            ]
        for _, ev in pending:
            try:
                self._insert_event(db_path, ev)
            except sqlite3.Error:
                with self._pending_lock:
                    self._pending_sqlite_events.append((db_path, ev))
        try:
            self._insert_event(db_path, event)
        except sqlite3.Error as exc:
            event["metadata"] = dict(event["metadata"])
            event["metadata"]["sqlite_event_write_failed"] = str(exc)
            with self._pending_lock:
                self._pending_sqlite_events.append((db_path, event))
        self._append_jsonl(run_dir, event)
        return event

    def _insert_event(self, db_path: Path, event: dict) -> None:
        _execute(
            db_path,
            "INSERT OR REPLACE INTO events (event_id, project_id, event_type, timestamp, actor, metadata)"
            " VALUES (?,?,?,?,?,?)",
            (
                event["event_id"],
                event.get("project_id"),
                event["event_type"],
                event.get("timestamp"),
                event.get("actor"),
                json.dumps(event.get("metadata") or {}),
            ),
        )

    def _append_jsonl(self, run_dir: Path, event: dict) -> None:
        path = run_dir / "events.jsonl"
        max_bytes = int(self.config["events_jsonl_max_bytes"])
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size > max_bytes:
                self._rotate_jsonl(path)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, default=str) + "\n")
        except OSError as exc:
            log.error("jsonl_event_write_failed path=%s error=%s", path, exc)

    def _rotate_jsonl(self, path: Path) -> None:
        max_keep = int(self.config["events_jsonl_max_rotated"])
        state_path = path.with_name("events.rotation.json")
        state = self._read_json(state_path, {"next_n": 1}) or {"next_n": 1}
        n = int(state.get("next_n", 1))
        rotated = path.with_name(f"events.{n}.jsonl")
        try:
            os.replace(path, rotated)
        except OSError:
            return
        n += 1
        # retain only the newest `max_keep` rotated files
        for old in sorted(path.parent.glob("events.*.jsonl"), key=lambda p: p.stat().st_mtime):
            if old.name.startswith("events.") and old.name.endswith(".jsonl"):
                try:
                    num = int(old.name.split(".")[1])
                except (ValueError, IndexError):
                    continue
                if num <= n - 1 - max_keep:
                    try:
                        old.unlink()
                    except OSError:
                        pass
        self._write_json(state_path, {"next_n": n})

    def read_events(self, run_dir: Path, event_type: Optional[str] = None) -> List[dict]:
        db_path = self._db_path(run_dir)
        if not db_path.exists():
            return []
        sql = "SELECT * FROM events"
        args: Tuple[Any, ...] = ()
        if event_type:
            sql += " WHERE event_type = ?"
            args = (event_type,)
        sql += " ORDER BY timestamp ASC"
        out = []
        for row in _rows(db_path, sql, args):
            out.append(
                {
                    "event_id": row["event_id"],
                    "project_id": row["project_id"],
                    "event_type": row["event_type"],
                    "timestamp": row["timestamp"],
                    "actor": row["actor"],
                    "metadata": json.loads(row["metadata"] or "{}"),
                }
            )
        return out

    # -- project lifecycle ----------------------------------------------------

    def create_project(self, vehicle_meta: dict, actor: str = "operator") -> dict:
        self.require_supported()
        meta = VehicleMeta(**(vehicle_meta or {}))
        project_id = f"rest-{uuid.uuid4().hex[:8]}"
        run_id = "{}-restoration-{}".format(
            _utcnow().strftime("%Y-%m-%dT%H-%M-%SZ"), uuid.uuid4().hex[:8]
        )
        run_dir = self.runs_root / run_id / "restoration"
        for sub in ("intake/photos", "intake/thumbnails", "guides", "artifacts", "flags", "qa_receipts"):
            (run_dir / sub).mkdir(parents=True, exist_ok=True)
        ensure_schema(self._db_path(run_dir))
        project = RestorationProject(
            project_id=project_id,
            run_id=run_id,
            vehicle_meta=meta,
            status=ProjectStatus.INTAKE_OPEN,
            api_cost_ceiling_usd=float(self.config["restoration_api_cost_ceiling_usd"]),
        )
        self._write_json(run_dir / "project.json", project.model_dump(mode="json"))
        self.write_event(run_dir, project_id, "restoration_stage_changed", actor, {"to": "intake_open"})
        self._index_update(project)
        return {"project_id": project_id, "run_id": run_id}

    def get_project(self, project_id: str) -> RestorationProject:
        run_dir = self._find_run_dir(project_id)
        data = self._read_json(run_dir / "project.json")
        if not data:
            raise PipelineError(404, "project_not_found", f"No project {project_id!r}.")
        return RestorationProject(**data)

    def _save_project(self, run_dir: Path, project: RestorationProject) -> None:
        project.updated_at = _utcnow()
        self._write_json(run_dir / "project.json", project.model_dump(mode="json"))
        self._index_update(project)

    def list_projects(self, state: Optional[str] = None, search: Optional[str] = None) -> List[dict]:
        out: List[dict] = []
        for project_json in sorted(self.runs_root.glob("*/restoration/project.json")):
            data = self._read_json(project_json)
            if not data:
                continue
            if state and data.get("status") != state:
                continue
            if search:
                hay = json.dumps(data.get("vehicle_meta") or {}).lower()
                if search.lower() not in hay and search.lower() not in str(data.get("project_id")):
                    continue
            data["needs_attention"] = self._needs_attention(project_json.parent, data)
            out.append(data)
        return out

    def _needs_attention(self, run_dir: Path, data: dict) -> Optional[str]:
        if data.get("needs_attention"):
            return data["needs_attention"]
        db_path = self._db_path(run_dir)
        if db_path.exists():
            flags = _rows(
                db_path,
                "SELECT COUNT(*) AS n FROM mechanic_flags WHERE project_id=? AND status='open'",
                (data.get("project_id"),),
            )
            if flags and flags[0]["n"]:
                return "open mechanic flags"
            tasks = _rows(
                db_path,
                "SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status='interrupted'",
                (data.get("project_id"),),
            )
            if tasks and tasks[0]["n"]:
                return "interrupted tasks"
        return None

    # -- state machine (§3, FR-033/034/035/038) --------------------------------

    _TRANSITIONS: Dict[str, List[str]] = {
        "draft": ["intake_open"],
        "intake_open": ["intake_sealed"],
        "intake_sealed": ["identifying"],
        "identifying": ["review_open"],
        "review_open": ["manifest_locked"],
        "manifest_locked": ["budget_ruled"],
        "budget_ruled": ["hunting"],
        "hunting": ["hunt_sealed", "sourcing_insufficient"],
        "sourcing_insufficient": ["hunting", "budget_ruled", "hunt_sealed"],
        "hunt_sealed": ["meshing"],
        "meshing": ["graph_review"],
        "graph_review": ["published"],
        "published": ["meshing", "published", "in_service"],
        "in_service": ["closed"],
        "closed": ["manifest_locked"],
        "abandoned": [],
    }

    def transition(
        self,
        project_id: str,
        target: str,
        actor: str = "operator",
        reason: Optional[str] = None,
        checklist: Optional[List[str]] = None,
    ) -> RestorationProject:
        run_dir = self._find_run_dir(project_id)
        data = self._read_json(run_dir / "project.json")
        if not data:
            raise PipelineError(404, "project_not_found", f"No project {project_id!r}.")
        project = RestorationProject(**data)
        try:
            target_status = ProjectStatus(target)
        except ValueError:
            raise PipelineError(400, "unknown_state", f"Unknown target state {target!r}.")

        current = _status_str(project.status)
        if current == "abandoned":
            raise PipelineError(409, "project_abandoned", "Project is abandoned.")
        if project.parked and target != "abandoned":
            raise PipelineError(
                409, "project_parked", f"Project is parked: {project.parked_reason}. Unpark to resume."
            )
        if target == "abandoned":
            return self._abandon(run_dir, project, actor, reason)

        valid = self._TRANSITIONS.get(current, [])
        if target not in valid:
            raise PipelineError(
                409,
                "invalid_transition",
                f"Cannot transition from {current} to {target}. Valid next states: {valid or ['(none)']}.",
                {"current": current, "valid_next": valid},
            )

        # Guards
        if current == "intake_open" and target == "intake_sealed":
            usable = self._usable_photos(run_dir)
            if usable < int(self.config["min_usable_photos"]):
                raise PipelineError(
                    409,
                    "insufficient_photos",
                    f"Cannot seal intake: {usable} usable photos, minimum {self.config['min_usable_photos']} required.",
                )
        if target == "in_service":
            required = list(self.config["restoration_in_service_checklist"])
            submitted = checklist or []
            missing = [item for item in required if item not in submitted]
            if missing:
                raise PipelineError(
                    400,
                    "incomplete_checklist",
                    f"In-service checklist is missing required items: {missing}",
                    {"missing": missing},
                )
            project.in_service_checklist = submitted
        if current == "closed" and target == "manifest_locked":
            if not reason:
                raise PipelineError(400, "reason_required", "Re-open requires a reason.")
            self._reopen(run_dir, project, actor, reason)

        project.status = target_status.value
        self._save_project(run_dir, project)
        self.write_event(
            run_dir,
            project_id,
            "restoration_stage_changed",
            actor,
            {"from": current, "to": target, **({"reason": reason} if reason else {})},
        )
        return project

    def _abandon(
        self, run_dir: Path, project: RestorationProject, actor: str, reason: Optional[str]
    ) -> RestorationProject:
        if not reason:
            raise PipelineError(400, "reason_required", "Abandon requires a reason.")
        project.status = ProjectStatus.ABANDONED.value
        project.abandoned_reason = reason
        cancelled = 0
        db_path = self._db_path(run_dir)
        ensure_schema(db_path)
        for row in _rows(
            db_path,
            "SELECT task_id FROM tasks WHERE project_id=? AND status IN ('pending','running')",
            (project.project_id,),
        ):
            self.request_cancel(row["task_id"])
            _execute(
                db_path,
                "UPDATE tasks SET status='cancelled', updated_at=? WHERE task_id=?",
                (_iso(_utcnow()), row["task_id"]),
            )
            self.write_event(
                run_dir, project.project_id, "async_task_cancelled", actor, {"task_id": row["task_id"]}
            )
            cancelled += 1
        self._save_project(run_dir, project)
        self.write_event(
            run_dir,
            project.project_id,
            "project_abandoned",
            actor,
            {"reason": reason, "cancelled_tasks": cancelled},
        )
        return project

    def _reopen(self, run_dir: Path, project: RestorationProject, actor: str, reason: str) -> None:
        project.reopened_from = _utcnow()
        db_path = self._db_path(run_dir)
        prior = {
            "candidates": 0,
            "purchases": 0,
            "tokens": 0,
        }
        if db_path.exists():
            for key, sql in (
                ("candidates", "SELECT COUNT(*) AS n FROM sourcing_candidates WHERE project_id=?"),
                ("purchases", "SELECT COUNT(*) AS n FROM purchase_records WHERE project_id=?"),
                ("tokens", "SELECT COUNT(*) AS n FROM guide_tokens WHERE project_id=?"),
            ):
                rows = _rows(db_path, sql, (project.project_id,))
                prior[key] = rows[0]["n"] if rows else 0
        # FR-035: previously sourced parts are marked previously_sourced
        manifest = self._read_json(run_dir / "manifest.json")
        if manifest and isinstance(manifest.get("entries"), list):
            db_path = self._db_path(run_dir)
            sourced_parts = {
                r["part_id"]
                for r in _rows(
                    db_path,
                    "SELECT DISTINCT part_id FROM sourcing_candidates WHERE project_id=?",
                    (project.project_id,),
                )
            }
            changed = False
            for entry in manifest["entries"]:
                if entry.get("part_id") in sourced_parts and entry.get("sourcing_status") != "previously_sourced":
                    entry["sourcing_status"] = "previously_sourced"
                    changed = True
            if changed:
                self._write_json(run_dir / "manifest.json", manifest)
        self.write_event(
            run_dir,
            project.project_id,
            "project_reopened",
            actor,
            {"reason": reason, "prior_run_summary": prior},
        )

    def park(self, project_id: str, reason: str, actor: str = "operator") -> RestorationProject:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        project.parked = True
        project.parked_reason = reason
        self._save_project(run_dir, project)
        return project

    def unpark(self, project_id: str, actor: str = "operator") -> RestorationProject:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        project.parked = False
        project.parked_reason = None
        self._save_project(run_dir, project)
        return project

    # -- intake (FR-002/FR-003) -------------------------------------------------

    def _usable_photos(self, run_dir: Path) -> int:
        photos = run_dir / "intake" / "photos"
        if not photos.exists():
            return 0
        return sum(1 for p in photos.iterdir() if p.is_file())

    def intake_upload(
        self,
        project_id: str,
        files: List[Tuple[str, bytes]],
        parts_list: Optional[Tuple[str, bytes]] = None,
        actor: str = "operator",
    ) -> dict:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        if project.status == ProjectStatus.ABANDONED:
            raise PipelineError(409, "project_abandoned", "Project is abandoned.")
        if len(files) > int(self.config["max_batch_files"]):
            raise PipelineError(
                400, "batch_too_large", f"At most {self.config['max_batch_files']} photos per batch."
            )
        receipts: List[IntakeReceipt] = []
        max_bytes = int(self.config["max_photo_bytes"])
        for filename, data in files:
            safe = _safe_filename(filename)
            receipt = IntakeReceipt(filename=safe, size_bytes=len(data))
            if len(data) > max_bytes:
                receipt.rejection_reason = (
                    f"file too large: {len(data)} bytes exceeds {max_bytes} (25 MB)"
                )
                receipts.append(receipt)
                continue
            fmt = detect_photo_format(data)
            if fmt is None:
                got = describe_format_mismatch(data)
                receipt.rejection_reason = (
                    f"format mismatch: expected JPEG/PNG/HEIC/WebP magic bytes, got {got}"
                )
                receipts.append(receipt)
                continue
            digest = _sha256(data)
            stored_name = f"{digest[:12]}_{safe}"
            stored_path = run_dir / "intake" / "photos" / stored_name
            with open(stored_path, "wb") as fh:  # byte-identical preservation
                fh.write(data)
            receipt.content_sha256 = digest
            receipt.stored_format = fmt
            receipt.stored_path = f"intake/photos/{stored_name}"
            thumb_name = f"{digest[:12]}.jpg"
            thumb_path = run_dir / "intake" / "thumbnails" / thumb_name
            receipt.thumbnail_path, receipt.thumbnail_status = self._make_thumbnail(
                data, fmt, thumb_path
            )
            receipt.accepted = True
            receipts.append(receipt)
        gap_list: List[str] = []
        if parts_list is not None:
            rows = self._parse_parts_list(parts_list[0], parts_list[1])
            raw_name = _safe_filename(parts_list[0])
            with open(run_dir / "intake" / "parts_list.csv", "wb") as fh:
                fh.write(parts_list[1])
            self._write_json(run_dir / "intake" / "parts_list.parsed.json", rows)
            if not rows:
                gap_list.append("parts list uploaded but no rows could be parsed")
        elif not (run_dir / "intake" / "parts_list.parsed.json").exists():
            gap_list.append("no parts list uploaded")
        total_usable = self._usable_photos(run_dir)
        if total_usable < int(self.config["min_usable_photos"]):
            gap_list.append(
                f"fewer than {self.config['min_usable_photos']} usable frames ({total_usable} present)"
            )
        accepted = [r for r in receipts if r.accepted]
        rejected = [r for r in receipts if not r.accepted]
        self.write_event(
            run_dir,
            project_id,
            "intake_upload",
            actor,
            {"accepted": len(accepted), "rejected": len(rejected)},
        )
        body = {
            "receipts": [r.model_dump(mode="json") for r in receipts],
            "gap_list": gap_list,
        }
        if files and not accepted:
            first = rejected[0] if rejected else None
            raise PipelineError(
                400,
                "all_files_rejected",
                f"All {len(rejected)} file(s) rejected. First: {first.filename}: {first.rejection_reason}"
                if first
                else "All files rejected.",
                {"receipts": body["receipts"]},
            )
        return body

    def _make_thumbnail(self, data: bytes, fmt: str, thumb_path: Path) -> Tuple[Optional[str], str]:
        """FR-002: HEIC transcoded via pillow-heif (q85); other formats via PIL.
        Honest degradation when the imaging stack is unavailable."""
        if fmt == "heic" and not _HEIF_OK:
            return None, "skipped_no_pillow"
        if not _PIL_OK:
            return None, "skipped_no_pillow"
        try:
            if fmt == "heic":
                pillow_heif.register_heif_opener()
            img = Image.open(io.BytesIO(data))
            img.load()
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.thumbnail((int(self.config["thumbnail_max_px"]),) * 2)
            thumb_path.parent.mkdir(parents=True, exist_ok=True)
            img.save(thumb_path, "JPEG", quality=85)
            return f"intake/thumbnails/{thumb_path.name}", "generated"
        except Exception as exc:  # corrupt payload that passed magic bytes
            log.warning("thumbnail generation failed: %s", exc)
            return None, "skipped_no_pillow"

    def _parse_parts_list(self, filename: str, data: bytes) -> List[dict]:
        text = data.decode("utf-8", errors="replace")
        rows: List[dict] = []
        try:
            sample = text[:2048]
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
            reader = csv.DictReader(io.StringIO(text), dialect=dialect)
            for raw in reader:
                name = (
                    raw.get("part_name") or raw.get("name") or raw.get("part") or ""
                ).strip()
                if not name:
                    continue
                qty_raw = (raw.get("quantity") or raw.get("qty") or "1").strip()
                try:
                    qty = max(1, int(qty_raw))
                except ValueError:
                    qty = 1
                rows.append(
                    {
                        "name": name,
                        "quantity": qty,
                        "oem_number": (raw.get("oem_number") or raw.get("oem") or "").strip() or None,
                        "condition": (raw.get("condition") or "present").strip() or "present",
                        "confidence": 0.9,
                    }
                )
            if rows:
                return rows
        except csv.Error:
            pass
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            rows.append({"name": line, "quantity": 1, "oem_number": None, "condition": "present", "confidence": 0.4})
        return rows

    def seal_intake(self, project_id: str, actor: str = "operator") -> dict:
        project = self.transition(project_id, "intake_sealed", actor)
        # FR-003: trigger identification as an async task
        task = None
        try:
            task = self.start_task(project_id, TaskType.IDENTIFY, actor=actor)
        except PipelineError as exc:
            if exc.code != "api_cost_ceiling_reached":
                raise
        # re-read: in inline mode the identify task may have advanced the state
        project = self.get_project(project_id)
        return {"status": _status_str(project.status), "identify_task_id": task["task_id"] if task else None}

    # -- async tasks (FR-056) ---------------------------------------------------

    def register_runner(self, task_type: TaskType, runner: TaskRunner) -> None:
        self._runners[task_type] = runner

    def start_task(
        self,
        project_id: str,
        task_type: TaskType,
        actor: str = "operator",
        extra: Optional[dict] = None,
    ) -> dict:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        if project.status == ProjectStatus.ABANDONED:
            raise PipelineError(409, "project_abandoned", "Project is abandoned.")
        self._check_api_cost_ceiling(project, run_dir, task_type)
        if task_type == TaskType.IDENTIFY and project.status not in (
            ProjectStatus.INTAKE_SEALED,
            ProjectStatus.IDENTIFYING,
            ProjectStatus.REVIEW_OPEN,
        ):
            raise PipelineError(
                409,
                "invalid_state",
                f"Identification requires intake to be sealed first (current: {_status_str(project.status)}).",
            )
        # State-spine pre-transitions (§3): a task launch moves the project
        # into the corresponding stage when the spine requires it.
        if task_type == TaskType.IDENTIFY and project.status == ProjectStatus.INTAKE_SEALED:
            self.transition(project_id, "identifying", actor)
        elif task_type == TaskType.SOURCE and project.status in (
            ProjectStatus.BUDGET_RULED,
            ProjectStatus.SOURCING_INSUFFICIENT,
        ):
            self.transition(project_id, "hunting", actor)
        db_path = self._db_path(run_dir)
        ensure_schema(db_path)
        if task_type == TaskType.SOURCE:
            running = _rows(
                db_path,
                "SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND task_type='source'"
                " AND status IN ('pending','running')",
                (project_id,),
            )
            limit = int(self.config["restoration_max_sourcing_per_project"])
            if running and running[0]["n"] >= limit:
                raise PipelineError(
                    409,
                    "sourcing_concurrency_limit",
                    f"Per-project sourcing limit ({limit}) reached; existing hunt is still active.",
                )
        task = AsyncTask(task_id=uuid.uuid4().hex, project_id=project_id, task_type=task_type)
        _execute(
            db_path,
            "INSERT INTO tasks (task_id, project_id, task_type, status, progress_pct, result, error,"
            " created_at, updated_at, resumed_from) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                task.task_id,
                project_id,
                task_type.value,
                task.status.value,
                0.0,
                None,
                None,
                _iso(task.created_at),
                _iso(task.updated_at),
                None,
            ),
        )
        if task_type == TaskType.SOURCE and not self._sourcing_sem.acquire(blocking=False):
            # FR-069: queued until a global slot frees
            return {"task_id": task.task_id, "status": "pending"}
        if self.config["tasks_inline"]:
            self._execute_task(task.task_id, project_id, task_type, run_dir, source_slot_held=task_type == TaskType.SOURCE)
        else:
            self._spawn(task.task_id, project_id, task_type, run_dir, source_slot_held=task_type == TaskType.SOURCE)
        return {"task_id": task.task_id, "status": "running"}

    def _spawn(self, task_id: str, project_id: str, task_type: TaskType, run_dir: Path, source_slot_held: bool = False) -> None:
        flag = threading.Event()
        self._cancel_flags[task_id] = flag
        thread = threading.Thread(
            target=self._execute_task,
            args=(task_id, project_id, task_type, run_dir, source_slot_held),
            daemon=True,
            name=f"restoration-task-{task_id[:8]}",
        )
        self._threads[task_id] = thread
        thread.start()

    def _execute_task(self, task_id: str, project_id: str, task_type: TaskType, run_dir: Path, source_slot_held: bool = False) -> None:
        db_path = self._db_path(run_dir)
        self.update_task(task_id, status=TaskStatus.RUNNING, progress_pct=0.0)
        runner = self._runners.get(task_type)
        try:
            if runner is None:
                raise PipelineError(409, "no_task_runner", f"No runner registered for {task_type.value}.")
            ctx = TaskContext(self, task_id, project_id, run_dir)
            result = runner(ctx)
            self.update_task(task_id, status=TaskStatus.COMPLETED, progress_pct=100.0, result=result)
        except PipelineError as exc:
            if exc.code == "task_cancelled" and task_id in self._paused_tasks:
                self._paused_tasks.discard(task_id)
                status = TaskStatus.INTERRUPTED
            else:
                status = TaskStatus.CANCELLED if exc.code == "task_cancelled" else TaskStatus.FAILED
            self.update_task(task_id, status=status, error=exc.message)
        except Exception as exc:  # noqa: BLE001 - recorded on the task row
            log.exception("task %s failed", task_id)
            self.update_task(task_id, status=TaskStatus.FAILED, error=f"{type(exc).__name__}: {exc}")
        finally:
            self._cancel_flags.pop(task_id, None)
            if source_slot_held:
                self._release_source_slot()
            self._maybe_start_queued_source(db_path, run_dir)

    def _release_source_slot(self) -> None:
        try:
            self._sourcing_sem.release()
        except ValueError:  # pragma: no cover - defensive
            pass

    def _maybe_start_queued_source(self, db_path: Path, run_dir: Path) -> None:
        """FR-069: when a global sourcing slot frees, start the OLDEST queued
        source task across ALL projects (each project has its own database)."""
        candidates: List[Tuple[str, str, Path]] = []  # (created_at, task_id, run_dir)
        for db in self.runs_root.glob("*/restoration/restoration.db"):
            for row in _rows(
                db,
                "SELECT task_id, project_id, created_at FROM tasks WHERE task_type='source'"
                " AND status='pending'",
            ):
                candidates.append((row["created_at"] or "", row["task_id"], db.parent))
        if not candidates:
            return
        if not self._sourcing_sem.acquire(blocking=False):
            return
        candidates.sort(key=lambda c: c[0])
        _, task_id, task_run_dir = candidates[0]
        rows = _rows(self._db_path(task_run_dir), "SELECT project_id FROM tasks WHERE task_id=?", (task_id,))
        if not rows:
            self._release_source_slot()
            return
        project_id = rows[0]["project_id"]
        if self.config["tasks_inline"]:
            self._execute_task(task_id, project_id, TaskType.SOURCE, task_run_dir, source_slot_held=True)
        else:
            self._spawn(task_id, project_id, TaskType.SOURCE, task_run_dir, source_slot_held=True)

    def update_task(self, task_id: str, **fields: Any) -> None:
        run_dir = self._find_run_dir_for_task(task_id)
        db_path = self._db_path(run_dir)
        sets, args = [], []
        for key, value in fields.items():
            if key == "status" and isinstance(value, TaskStatus):
                value = value.value
            if key == "result" and not isinstance(value, (str, type(None))):
                value = json.dumps(value, default=str)
            sets.append(f"{key}=?")
            args.append(value)
        sets.append("updated_at=?")
        args.append(_iso(_utcnow()))
        args.append(task_id)
        _execute(db_path, f"UPDATE tasks SET {', '.join(sets)} WHERE task_id=?", args)

    def _find_run_dir_for_task(self, task_id: str) -> Path:
        for db in self.runs_root.glob("*/restoration/restoration.db"):
            rows = _rows(db, "SELECT project_id FROM tasks WHERE task_id=?", (task_id,))
            if rows:
                return db.parent
        raise PipelineError(404, "task_not_found", f"No task {task_id!r}.")

    def get_task(self, task_id: str) -> dict:
        run_dir = self._find_run_dir_for_task(task_id)
        rows = _rows(self._db_path(run_dir), "SELECT * FROM tasks WHERE task_id=?", (task_id,))
        if not rows:
            raise PipelineError(404, "task_not_found", f"No task {task_id!r}.")
        row = dict(rows[0])
        if row.get("result"):
            try:
                row["result"] = json.loads(row["result"])
            except (json.JSONDecodeError, TypeError):
                pass
        return row

    def resume_task(self, task_id: str, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir_for_task(task_id)
        rows = _rows(self._db_path(run_dir), "SELECT * FROM tasks WHERE task_id=?", (task_id,))
        if not rows:
            raise PipelineError(404, "task_not_found", f"No task {task_id!r}.")
        row = rows[0]
        if row["status"] not in ("interrupted", "failed"):
            raise PipelineError(
                409,
                "task_not_resumable",
                f"Task status is {row['status']}; only interrupted or failed tasks can be resumed.",
            )
        task_type = TaskType(row["task_type"])
        _execute(
            self._db_path(run_dir),
            "UPDATE tasks SET status='pending', progress_pct=0, resumed_from=?, updated_at=? WHERE task_id=?",
            (_iso(_utcnow()), _iso(_utcnow()), task_id),
        )
        self.write_event(run_dir, row["project_id"], "async_task_resumed", actor, {"task_id": task_id})
        source_slot = False
        if task_type == TaskType.SOURCE:
            source_slot = self._sourcing_sem.acquire(blocking=False)
            if not source_slot:
                return {"task_id": task_id, "status": "pending"}
        if self.config["tasks_inline"]:
            self._execute_task(task_id, row["project_id"], task_type, run_dir, source_slot_held=source_slot)
        else:
            self._spawn(task_id, row["project_id"], task_type, run_dir, source_slot_held=source_slot)
        return {"task_id": task_id, "status": "running"}

    def request_cancel(self, task_id: str) -> None:
        flag = self._cancel_flags.get(task_id)
        if flag is not None:
            flag.set()

    def is_cancel_requested(self, task_id: str) -> bool:
        flag = self._cancel_flags.get(task_id)
        return bool(flag and flag.is_set())

    # -- identify (FR-004/FR-005 — parts-list-driven v1 engine) ------------------

    _CATEGORY_HINTS: Dict[str, str] = {
        "brake": "brake", "caliper": "brake", "rotor": "brake", "drum": "brake",
        "shock": "suspension", "strut": "suspension", "spring": "suspension", "control arm": "suspension",
        "piston": "engine", "gasket": "engine", "carburetor": "engine", "valve": "engine",
        "fender": "body", "bumper": "body", "hood": "body", "door": "body", "panel": "body",
        "seat": "interior", "carpet": "interior", "dash": "interior",
        "alternator": "electrical", "wiring": "electrical", "battery": "electrical", "starter": "electrical",
        "muffler": "exhaust", "manifold": "exhaust", "exhaust": "exhaust",
        "fuel": "fuel", "tank": "fuel", "fuel pump": "fuel",
        "radiator": "cooling", "water pump": "cooling", "thermostat": "cooling", "hose": "cooling",
        "transmission": "transmission", "clutch": "transmission", "gearbox": "transmission",
    }

    def _run_identify(self, ctx: TaskContext) -> Dict[str, Any]:
        """Builds ComponentRecords from the parsed parts list + KB matches.

        Vision-bridge identification plugs in at this runner in the next phase;
        the parts-list path is real, deterministic automation, not a stub."""
        run_dir = ctx.run_dir
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        rows = self._read_json(run_dir / "intake" / "parts_list.parsed.json", []) or []
        kb_entries = self._kb_entries_for(project.vehicle_meta)
        threshold = float(self.config["restoration_confidence_threshold"])
        vlm_only = not kb_entries
        if vlm_only:
            threshold = float(self.config["restoration_vlm_only_threshold"])
        components: List[ComponentRecord] = []
        total = max(1, len(rows))
        for idx, row in enumerate(rows):
            name = str(row.get("name") or "").strip()
            category = self._categorize(name)
            kb_match = self._match_kb(name, kb_entries)
            base_conf = float(row.get("confidence", 0.5))
            if kb_match:
                base_conf = max(base_conf, 0.92)
                category = kb_match.get("category") or category
            confidence = base_conf
            record = ComponentRecord(
                part_id=f"part-{uuid.uuid4().hex[:8]}",
                name=name,
                category=category,
                condition=row.get("condition") or "present",
                confidence=round(confidence, 3),
                photo_refs=[],
                source="auto",
                kb_match=kb_match.get("part_id") if kb_match else None,
            )
            components.append(record)
            ctx.progress(100.0 * (idx + 1) / total)
        self._write_json(run_dir / "inventory.json", [c.model_dump(mode="json") for c in components])
        self._build_manifest(run_dir, project, components)
        # idempotent re-runs: only advance the spine when actually identifying
        if _status_str(self.get_project(project.project_id).status) == "identifying":
            self.transition(project.project_id, "review_open", actor="system")
        return {"components": len(components), "vlm_only": vlm_only}

    # -- source (FR-012/FR-013 — sourcing hunt runner) ----------------------------

    def _bridge_dispatcher(self, kind: str, payload: dict, timeout_s: float) -> Any:
        """Bridge dispatcher for the research primitive. In the sandbox there is
        no bridge configured, so this returns empty results honestly — the hunt
        completes with zero bridge-discovered candidates and the operator can add
        manual entries or seal. A real bridge plugs in here in production."""
        raise BridgeUnavailableError("no bridge configured (sandbox mode)")

    class _NoSleepClock:
        """Clock that skips rate-limit sleeps (the bridge handles rate limiting
        in production; in sandbox the dispatcher fails immediately so sleeps are
        wasted wall-clock)."""

        def monotonic(self) -> float:
            import time as _t
            return _t.monotonic()

        def sleep(self, seconds: float) -> None:
            pass

        def now_iso(self) -> str:
            return _utcnow().isoformat()

    def _run_source(self, ctx: TaskContext) -> Dict[str, Any]:
        """Sourcing hunt: calls the research primitive for each manifest part,
        persists candidates + unsourceable flags, updates coverage.

        FR-070: the hunt has a wall-clock budget (``hunt_timeout_seconds``);
        exceeding it halts with partial results, writes ``sourcing_hunt_timeout``,
        and transitions the project to SOURCING_INSUFFICIENT with partials
        preserved. FR-037: a hunt that completes below the system-discovered
        coverage floor also transitions to SOURCING_INSUFFICIENT. FR-056:
        parts with an existing candidate (any provenance — manual entries
        included) are never re-queried or duplicated, so a resumed/re-run hunt
        retains prior state. Flagged-but-candidateless parts ARE retried on a
        fresh hunt (the sourcing_insufficient → hunting re-hunt path exists to
        retry them); unsourceable flags are current-state, so a re-query
        replaces the part's prior flag rows — the event log carries the
        history."""
        run_dir = ctx.run_dir
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        manifest = self._read_json(run_dir / "manifest.json") or {}
        entries = manifest.get("entries") or []
        if not entries:
            raise PipelineError(409, "no_manifest", "Manifest must exist before sourcing.")
        budget = self._read_json(run_dir / "budget.json") or {}
        ceiling = float(budget.get("budget_ceiling_usd") or 0.0)
        allocation = budget.get("detail", {}).get("per_part_allocation") or {}
        sources = self.list_sources()
        clock = self._NoSleepClock()
        db_path = self._db_path(run_dir)
        ensure_schema(db_path)
        covered_before = {
            r["part_id"]
            for r in _rows(
                db_path,
                "SELECT DISTINCT part_id FROM sourcing_candidates WHERE project_id=?",
                (project.project_id,),
            )
        }
        hunt_timeout_s = float(self.config.get("hunt_timeout_seconds") or 0.0)
        started = self._monotonic()
        total_parts = max(1, len(entries))
        candidates_found = 0
        unsourceable_count = 0
        parts_processed = 0
        parts_skipped_covered = 0
        timed_out = False
        errors: List[dict] = []
        for idx, entry in enumerate(entries):
            part_id = entry.get("part_id")
            if part_id in covered_before:
                parts_skipped_covered += 1
                ctx.progress(100.0 * (idx + 1) / total_parts)
                continue
            if hunt_timeout_s > 0 and (self._monotonic() - started) >= hunt_timeout_s:
                timed_out = True
                break
            ctx.progress(100.0 * idx / total_parts)
            criticality = str(entry.get("criticality") or "standard")
            per_part_ceiling = float(allocation.get(part_id) or (ceiling / max(1, len(entries))))
            query = PartSourcingQuery(
                part_id=part_id,
                part_name=entry.get("name") or "",
                oem_number=entry.get("oem_number"),
                vehicle_make=project.vehicle_meta.make or "",
                vehicle_model=project.vehicle_meta.model or "",
                vehicle_year=project.vehicle_meta.year or "",
                per_part_budget_ceiling_usd=per_part_ceiling,
                criticality=Criticality(criticality) if criticality in [c.value for c in Criticality] else Criticality.STANDARD,
            )
            try:
                result = research_primitives.research_part_sourcing(
                    query, sources, self._bridge_dispatcher,
                    clock=clock,
                    per_query_timeout_s=30.0,
                )
            except Exception as exc:  # noqa: BLE001 — never halt the whole hunt on one part
                errors.append({"part_id": part_id, "error": str(exc)})
                result = {"part_id": part_id, "candidates": [], "unsourceable": None, "errors": []}
            if (result.get("candidates") or []) or result.get("unsourceable"):
                # flags are current-state: a fresh outcome replaces prior flags
                _execute(
                    db_path,
                    "DELETE FROM unsourceable_flags WHERE project_id=? AND part_id=?",
                    (project.project_id, part_id),
                )
            for cand in result.get("candidates") or []:
                cand_obj = SourcingCandidate(
                    part_id=cand["part_id"],
                    candidate_id=cand.get("candidate_id") or uuid.uuid4().hex,
                    vendor=cand.get("vendor") or "unknown",
                    oem_number=cand.get("oem_number"),
                    price_usd=cand.get("price_usd"),
                    condition=cand.get("condition") or "used",
                    availability=cand.get("availability") or "in_stock",
                    region=cand.get("region") or "",
                    url_or_contact=cand.get("url_or_contact") or "",
                    tradeable=bool(cand.get("tradeable", False)),
                    provenance=cand.get("provenance") or Provenance.RESEARCH_PRIMITIVE.value,
                    fetched_at=_parse_dt(cand.get("fetched_at")) or _utcnow(),
                    trade_partner_id=cand.get("trade_partner_id"),
                )
                self._insert_candidate(run_dir, project.project_id, cand_obj)
                candidates_found += 1
            unsourced = result.get("unsourceable")
            if unsourced:
                _execute(
                    db_path,
                    "INSERT INTO unsourceable_flags (project_id, part_id, reason_code,"
                    " alternative_suggestion, fabrication_reference_glb)"
                    " VALUES (?,?,?,?,?)",
                    (
                        project.project_id,
                        part_id,
                        unsourced.get("reason_code") or "no_vendor_response",
                        unsourced.get("alternative_suggestion"),
                        unsourced.get("fabrication_reference_glb"),
                    ),
                )
                unsourceable_count += 1
            parts_processed += 1
            ctx.progress(100.0 * (idx + 1) / total_parts)
        self._sync_manifest_sourcing_status(run_dir, project.project_id)
        self._update_coverage(project.project_id, run_dir)
        coverage = self.compute_coverage(project.project_id)
        floor_pct = float(self.config["restoration_sourcing_floor"]) * 100.0
        outcome = "completed"
        if timed_out:
            outcome = "timeout"
            elapsed_s = self._monotonic() - started
            self.write_event(
                run_dir,
                project.project_id,
                "sourcing_hunt_timeout",
                "system",
                {
                    "elapsed_s": round(elapsed_s, 3),
                    "timeout_s": hunt_timeout_s,
                    "parts_processed": parts_processed,
                    "parts_skipped_covered": parts_skipped_covered,
                    "parts_total": len(entries),
                    "candidates": candidates_found,
                    "unsourceable": unsourceable_count,
                    "coverage": coverage,
                },
            )
            self._transition_after_hunt(project.project_id, "sourcing_insufficient")
        elif coverage["system_coverage"] < floor_pct:
            # FR-037: below the system-discovered floor → SOURCING_INSUFFICIENT
            outcome = "insufficient"
            self._transition_after_hunt(project.project_id, "sourcing_insufficient")
        status_after = _status_str(self.get_project(project.project_id).status)
        self.write_event(
            run_dir,
            project.project_id,
            "sourcing_hunt_completed",
            "system",
            {
                "candidates": candidates_found,
                "unsourceable": unsourceable_count,
                "errors": errors,
                "coverage": coverage,
                "outcome": outcome,
                "status_after": status_after,
                "parts_processed": parts_processed,
                "parts_skipped_covered": parts_skipped_covered,
                "parts_total": len(entries),
            },
        )
        return {
            "candidates": candidates_found,
            "unsourceable": unsourceable_count,
            "errors": errors,
            "coverage": coverage,
            "timed_out": timed_out,
            # FR-070: spec-named flag carried on the completed task row
            "timeout_reached": timed_out,
            "outcome": outcome,
            "status_after": status_after,
            "parts_processed": parts_processed,
            "parts_skipped_covered": parts_skipped_covered,
            "parts_total": len(entries),
        }

    def _transition_after_hunt(self, project_id: str, target: str) -> None:
        """Post-hunt spine transition (FR-037/FR-070). Fires only from HUNTING
        and never fails the hunt — the persisted candidates/flags are the
        payload; a transition error is logged, not raised."""
        try:
            current = _status_str(self.get_project(project_id).status)
            if current != "hunting":
                return
            self.transition(project_id, target, actor="system")
        except PipelineError as exc:
            log.warning("post-hunt transition to %s failed for %s: %s", target, project_id, exc.message)

    def _sync_manifest_sourcing_status(self, run_dir: Path, project_id: str) -> None:
        """FR-005: derive each manifest entry's ``sourcing_status`` from the
        canonical SQLite state. ``previously_sourced`` (FR-035) is never
        clobbered."""
        manifest = self._read_json(run_dir / "manifest.json") or {}
        entries = manifest.get("entries") or []
        if not entries:
            return
        db_path = self._db_path(run_dir)
        if not db_path.exists():
            return
        covered = {
            r["part_id"]
            for r in _rows(
                db_path,
                "SELECT DISTINCT part_id FROM sourcing_candidates WHERE project_id=?",
                (project_id,),
            )
        }
        flags: Dict[str, bool] = {}
        for r in _rows(
            db_path,
            "SELECT part_id, fabrication_reference_glb FROM unsourceable_flags WHERE project_id=?",
            (project_id,),
        ):
            flags[r["part_id"]] = bool(r["fabrication_reference_glb"])
        changed = False
        for entry in entries:
            pid = entry.get("part_id")
            current = entry.get("sourcing_status")
            if current == SourcingStatus.PREVIOUSLY_SOURCED.value:
                continue
            if pid in covered:
                new = SourcingStatus.SOURCED.value
            elif pid in flags:
                new = SourcingStatus.FABRICATION_REF.value if flags[pid] else SourcingStatus.UNSOURCEABLE.value
            else:
                new = SourcingStatus.PENDING.value
            if current != new:
                entry["sourcing_status"] = new
                changed = True
        if changed:
            self._write_json(run_dir / "manifest.json", manifest)

    # -- sourcing seal / pause / resume (FR-038/FR-070, AC-026) ------------------

    def seal_hunt(self, project_id: str, actor: str = "operator", accept_partial: bool = False, reason: str = "") -> dict:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        if _status_str(project.status) not in ("hunting", "sourcing_insufficient"):
            raise PipelineError(
                409, "invalid_state",
                f"Hunt can only be sealed from HUNTING or SOURCING_INSUFFICIENT (current: {_status_str(project.status)}).",
            )
        budget = self._read_json(run_dir / "budget.json") or {}
        ceiling = float(budget.get("budget_ceiling_usd") or 0.0)
        db_path = self._db_path(run_dir)
        ensure_schema(db_path)
        selected_cost = 0.0
        for row in _rows(
            db_path,
            "SELECT price_usd FROM sourcing_candidates WHERE project_id=? AND selected=1",
            (project_id,),
        ):
            price = row["price_usd"]
            if isinstance(price, (int, float)) and price > 0:
                selected_cost += float(price)
        cost_gate_passed = ceiling <= 0 or selected_cost <= ceiling
        coverage = self.compute_coverage(project_id)
        sourcing_floor = float(self.config["restoration_sourcing_floor"])
        below_floor = coverage["total_coverage"] < sourcing_floor * 100 and coverage["total_coverage"] < 100.0
        if not cost_gate_passed:
            self.write_event(
                run_dir, project_id, "hunt_seal_cost_gate_failed", actor,
                {"total_selected_cost": round(selected_cost, 2), "budget_ceiling": ceiling},
            )
            raise PipelineError(
                409, "cost_gate_failed",
                f"Total selected cost (${selected_cost:.2f}) exceeds budget ceiling (${ceiling:.2f})."
                f" Override the budget or deselect candidates.",
                {"total_selected_cost": round(selected_cost, 2), "budget_ceiling": ceiling},
            )
        if below_floor and not accept_partial:
            # FR-037: below the coverage floor and the operator has NOT
            # explicitly accepted partial coverage → SOURCING_INSUFFICIENT.
            # The seal action is re-offered (here or from that state) with
            # accept_partial=True to record an audited partial acceptance.
            # Idempotent: if already SOURCING_INSUFFICIENT (e.g. the hunt or a
            # prior seal attempt put us here), do not re-transition — the same-
            # state transition is not in the table and would 409.
            if _status_str(project.status) != "sourcing_insufficient":
                self.transition(project_id, "sourcing_insufficient", actor)
            self.write_event(
                run_dir, project_id, "hunt_seal_insufficient", actor,
                {"coverage": coverage, "floor": sourcing_floor},
            )
            return {
                "status": "sourcing_insufficient",
                "total_selected_cost": round(selected_cost, 2),
                "budget_ceiling": ceiling,
                "cost_gate_passed": True,
                "coverage": coverage,
            }
        if below_floor and accept_partial:
            if not reason.strip():
                raise PipelineError(
                    400, "partial_acceptance_requires_reason",
                    "Explicit partial coverage acceptance requires a reason (FR-037 audit).",
                )
            # FR-037: explicit partial acceptance below the floor — sealed with
            # an audit event recording the coverage gap and the operator reason.
            self.transition(project_id, "hunt_sealed", actor)
            self.write_event(
                run_dir, project_id, "hunt_sealed_partial_acceptance", actor,
                {
                    "total_selected_cost": round(selected_cost, 2),
                    "budget_ceiling": ceiling,
                    "coverage": coverage,
                    "floor": sourcing_floor,
                    "reason": reason.strip(),
                },
            )
            return {
                "status": "hunt_sealed",
                "total_selected_cost": round(selected_cost, 2),
                "budget_ceiling": ceiling,
                "cost_gate_passed": True,
                "coverage": coverage,
                "partial_acceptance": True,
                "reason": reason.strip(),
            }
        self.transition(project_id, "hunt_sealed", actor)
        self.write_event(
            run_dir, project_id, "hunt_sealed", actor,
            {"total_selected_cost": round(selected_cost, 2), "budget_ceiling": ceiling, "coverage": coverage},
        )
        return {
            "status": "hunt_sealed",
            "total_selected_cost": round(selected_cost, 2),
            "budget_ceiling": ceiling,
            "cost_gate_passed": True,
            "coverage": coverage,
        }

    def pause_hunt(self, project_id: str, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        if _status_str(project.status) != "hunting":
            raise PipelineError(
                409, "invalid_state",
                f"Hunt can only be paused from HUNTING (current: {_status_str(project.status)}).",
            )
        db_path = self._db_path(run_dir)
        for row in _rows(
            db_path,
            "SELECT task_id FROM tasks WHERE project_id=? AND task_type='source' AND status IN ('pending','running')",
            (project_id,),
        ):
            tid = row["task_id"]
            self._paused_tasks.add(tid)
            self.request_cancel(tid)
            _execute(
                db_path,
                "UPDATE tasks SET status='interrupted', updated_at=? WHERE task_id=?",
                (_iso(_utcnow()), tid),
            )
        self.write_event(run_dir, project_id, "hunt_paused", actor, {})
        return {"status": "paused"}

    def resume_hunt(self, project_id: str, actor: str = "operator") -> dict:
        """FR-038/FR-070: resume the hunt. From HUNTING this resumes a paused
        (interrupted) sourcing task; from SOURCING_INSUFFICIENT — where a
        timeout (FR-070) or low-coverage halt (FR-037) leaves the project —
        resume starts a fresh hunt that keeps prior candidates and sources the
        remaining parts (AC-057)."""
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        status = _status_str(project.status)
        if status not in ("hunting", "sourcing_insufficient"):
            raise PipelineError(
                409, "invalid_state",
                f"Hunt can only be resumed from HUNTING or SOURCING_INSUFFICIENT (current: {status}).",
            )
        db_path = self._db_path(run_dir)
        interrupted = _rows(
            db_path,
            "SELECT task_id FROM tasks WHERE project_id=? AND task_type='source' AND status='interrupted'",
            (project_id,),
        )
        if interrupted:
            if status == "sourcing_insufficient":
                self.transition(project_id, "hunting", actor)
            for row in interrupted:
                self.resume_task(row["task_id"], actor=actor)
            self.write_event(run_dir, project_id, "hunt_resumed", actor, {"resumed_tasks": len(interrupted)})
            return {"status": "resumed"}
        live = _rows(
            db_path,
            "SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND task_type='source'"
            " AND status IN ('pending','running')",
            (project_id,),
        )
        if live and live[0]["n"]:
            return {"status": "already_running"}
        # No interrupted hunt to resume: the prior hunt completed (timeout or
        # low coverage) with partials preserved — resume means a fresh hunt.
        task = self.start_task(project_id, TaskType.SOURCE, actor=actor)
        self.write_event(
            run_dir, project_id, "hunt_resumed", actor,
            {"task_id": task["task_id"], "fresh_hunt": True},
        )
        return {"status": "resumed", "task_id": task["task_id"]}

    def list_unsourceable_flags(self, project_id: str) -> List[dict]:
        run_dir = self._find_run_dir(project_id)
        db_path = self._db_path(run_dir)
        if not db_path.exists():
            return []
        return [
            dict(r) for r in _rows(
                db_path,
                "SELECT * FROM unsourceable_flags WHERE project_id=? ORDER BY rowid ASC",
                (project_id,),
            )
        ]

    # -- KB management (FR-056) ---------------------------------------------------

    def list_kb_entries(self, make: Optional[str] = None, model: Optional[str] = None, year: Optional[str] = None) -> List[dict]:
        entries, _ = self.load_kb()
        out = []
        for e in entries:
            if make and make.lower() not in str(e.get("make", "")).lower():
                continue
            if model and model.lower() not in str(e.get("model", "")).lower():
                continue
            if year and str(e.get("year")) != str(year):
                continue
            out.append(e)
        return out

    def _save_kb(self, data: dict) -> None:
        path = self._kb_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        restoration_yaml.dump_file(data, str(path))

    def add_kb_entry(self, payload: dict, actor: str = "operator") -> dict:
        entry = ReferenceKBEntry(**payload)
        entries, _ = self.load_kb()
        existing_ids = {e.get("part_id") for e in entries}
        if entry.part_id in existing_ids:
            raise PipelineError(400, "duplicate_part_id", f"KB entry with part_id {entry.part_id!r} already exists.")
        data = restoration_yaml.load_file(str(self._kb_path())) or {"makes": {}}
        operator_entries = data.setdefault("operator_entries", [])
        operator_entries.append(entry.model_dump(mode="json"))
        self._save_kb(data)
        log.info("kb_entry_added part_id=%s actor=%s", entry.part_id, actor)
        return {"part_id": entry.part_id}

    def update_kb_entry(self, part_id: str, payload: dict, actor: str = "operator") -> dict:
        entries, _ = self.load_kb()
        existing = None
        for e in entries:
            if e.get("part_id") == part_id:
                existing = e
                break
        if not existing:
            raise PipelineError(404, "kb_entry_not_found", f"No KB entry with part_id {part_id!r}.")
        payload["part_id"] = part_id
        entry = ReferenceKBEntry(**payload)
        self._delete_kb_entry_from_data(part_id)
        data = restoration_yaml.load_file(str(self._kb_path())) or {"makes": {}}
        operator_entries = data.setdefault("operator_entries", [])
        operator_entries.append(entry.model_dump(mode="json"))
        self._save_kb(data)
        return {"entry": entry.model_dump(mode="json")}

    def _delete_kb_entry_from_data(self, part_id: str) -> bool:
        path = self._kb_path()
        if not path.exists():
            return False
        data = restoration_yaml.load_file(str(path)) or {"makes": {}}
        removed = False
        # Check operator_entries
        op_entries = data.get("operator_entries") or []
        new_op = []
        for e in op_entries:
            if e.get("part_id") == part_id:
                removed = True
                continue
            new_op.append(e)
        if removed:
            data["operator_entries"] = new_op
        # Check nested makes/models/years structure
        if not removed:
            for make_name, make_block in list((data.get("makes") or {}).items()):
                for model_name, model_block in list((make_block.get("models") or {}).items()):
                    for year_name, year_block in list((model_block.get("years") or {}).items()):
                        parts = year_block.get("parts") or []
                        new_parts = [p for p in parts if p.get("part_id") != part_id]
                        if len(new_parts) != len(parts):
                            year_block["parts"] = new_parts
                            removed = True
        if removed:
            self._save_kb(data)
        return removed

    def delete_kb_entry(self, part_id: str, actor: str = "operator") -> dict:
        removed = self._delete_kb_entry_from_data(part_id)
        if not removed:
            raise PipelineError(404, "kb_entry_not_found", f"No KB entry with part_id {part_id!r}.")
        return {"deleted": True, "part_id": part_id}

    def approve_kb_proposal(self, proposal_id: str, actor: str = "operator") -> dict:
        for project_json in self.runs_root.glob("*/restoration/project.json"):
            run_dir = project_json.parent
            db_path = self._db_path(run_dir)
            if not db_path.exists():
                continue
            rows = _rows(db_path, "SELECT * FROM kb_proposals WHERE proposal_id=?", (proposal_id,))
            if rows:
                row = rows[0]
                payload = json.loads(row["payload"] or "{}")
                entry = ReferenceKBEntry(**payload)
                self.add_kb_entry(payload, actor=actor)
                _execute(
                    db_path,
                    "UPDATE kb_proposals SET status='approved' WHERE proposal_id=?",
                    (proposal_id,),
                )
                return {"entry": entry.model_dump(mode="json")}
        raise PipelineError(404, "proposal_not_found", f"No KB proposal {proposal_id!r}.")

    # -- source registry management (FR-012) --------------------------------------

    def add_source(self, payload: dict, actor: str = "operator") -> dict:
        entry = SourceRegistryEntry(**payload)
        sources = self.list_sources()
        if any(s.source_id == entry.source_id for s in sources):
            raise PipelineError(400, "duplicate_source_id", f"Source {entry.source_id!r} already exists.")
        path = self._sources_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        data = restoration_yaml.load_file(str(path)) or {"sources": []}
        data.setdefault("sources", []).append(entry.model_dump(mode="json"))
        restoration_yaml.dump_file(data, str(path))
        return {"source_id": entry.source_id}

    def update_source(self, source_id: str, payload: dict, actor: str = "operator") -> dict:
        sources = self.list_sources()
        existing = None
        for s in sources:
            if s.source_id == source_id:
                existing = s
                break
        if not existing:
            raise PipelineError(404, "source_not_found", f"No source {source_id!r}.")
        payload["source_id"] = source_id
        entry = SourceRegistryEntry(**payload)
        path = self._sources_path()
        data = restoration_yaml.load_file(str(path)) or {"sources": []}
        src_list = data.get("sources") or []
        for i, s in enumerate(src_list):
            if s.get("source_id") == source_id:
                src_list[i] = entry.model_dump(mode="json")
                break
        data["sources"] = src_list
        restoration_yaml.dump_file(data, str(path))
        return {"entry": entry.model_dump(mode="json")}

    def delete_source(self, source_id: str, actor: str = "operator") -> dict:
        path = self._sources_path()
        if not path.exists():
            raise PipelineError(404, "source_not_found", f"No source {source_id!r}.")
        data = restoration_yaml.load_file(str(path)) or {"sources": []}
        src_list = data.get("sources") or []
        new_list = [s for s in src_list if s.get("source_id") != source_id]
        if len(new_list) == len(src_list):
            raise PipelineError(404, "source_not_found", f"No source {source_id!r}.")
        data["sources"] = new_list
        restoration_yaml.dump_file(data, str(path))
        return {"deleted": True, "source_id": source_id}

    # -- provider management (FR-066) ---------------------------------------------

    def pause_provider(self, provider: str, actor: str = "operator") -> dict:
        if not provider:
            raise PipelineError(400, "missing_field", "provider is required.")
        self._provider_status[provider] = "paused"
        affected = 0
        for project_json in self.runs_root.glob("*/restoration/project.json"):
            run_dir = project_json.parent
            db_path = self._db_path(run_dir)
            if db_path.exists():
                active = _rows(
                    db_path,
                    "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending','running')",
                )
                if active and active[0]["n"]:
                    affected += active[0]["n"]
        log.info("provider_paused provider=%s affected_jobs=%d actor=%s", provider, affected, actor)
        return {"status": "paused", "provider": provider, "affected_jobs": affected}

    def resume_provider(self, provider: str, actor: str = "operator") -> dict:
        if not provider:
            raise PipelineError(400, "missing_field", "provider is required.")
        self._provider_status.pop(provider, None)
        log.info("provider_resumed provider=%s actor=%s", provider, actor)
        return {"status": "resumed", "provider": provider}

    def failover_provider(self, provider: str, fallback: str, actor: str = "operator") -> dict:
        if not provider or not fallback:
            raise PipelineError(400, "missing_field", "provider and fallback are required.")
        self._provider_status[provider] = f"failed_over:{fallback}"
        log.info("provider_failover provider=%s fallback=%s actor=%s", provider, fallback, actor)
        return {"status": "failed_over", "provider": provider, "fallback": fallback}

    def recheck_provider(self, provider: str, actor: str = "operator") -> dict:
        if not provider:
            raise PipelineError(400, "missing_field", "provider is required.")
        status = self._provider_status.pop(provider, None)
        healthy = status != "paused"
        log.info("provider_rechecked provider=%s healthy=%s actor=%s", provider, healthy, actor)
        return {"status": "healthy" if healthy else "paused", "provider": provider}

    # -- mechanic flags (FR-054) --------------------------------------------------

    def submit_flag(self, project_id: str, payload: dict, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        st = _status_str(project.status)
        if st in ("intake_open", "intake_sealed", "identifying", "parked", "abandoned"):
            raise PipelineError(
                409, "invalid_state",
                f"Flags can only be submitted from HUNTING or later (current: {st}).",
            )
        ensure_schema(self._db_path(run_dir))
        flag = MechanicFlag(
            project_id=project_id,
            assembly_id=payload.get("assembly_id") or "",
            step_index=int(payload.get("step_index") or 0),
            problem_type=ProblemType(payload.get("problem_type") or "other")
            if payload.get("problem_type") in [p.value for p in ProblemType] else ProblemType.OTHER,
            description=payload.get("description") or "",
            screenshot_path=payload.get("screenshot_path"),
            photo_path=payload.get("photo_path"),
        )
        _execute(
            self._db_path(run_dir),
            "INSERT INTO mechanic_flags (flag_id, project_id, assembly_id, step_index, problem_type,"
            " description, screenshot_path, photo_path, status, created_at, resolved_at, resolution_notes)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
            (
                flag.flag_id,
                flag.project_id,
                flag.assembly_id,
                flag.step_index,
                flag.problem_type.value,
                flag.description,
                flag.screenshot_path,
                flag.photo_path,
                FlagStatus.OPEN.value,
                _iso(flag.created_at),
            ),
        )
        self.write_event(
            run_dir, project_id, "mechanic_flag_submitted", actor,
            {"flag_id": flag.flag_id, "problem_type": flag.problem_type.value},
        )
        return {"flag_id": flag.flag_id}

    def resolve_flag(self, project_id: str, flag_id: str, resolution_notes: str, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        db_path = self._db_path(run_dir)
        rows = _rows(db_path, "SELECT * FROM mechanic_flags WHERE flag_id=?", (flag_id,))
        if not rows:
            raise PipelineError(404, "flag_not_found", f"No flag {flag_id!r}.")
        _execute(
            db_path,
            "UPDATE mechanic_flags SET status=?, resolved_at=?, resolution_notes=? WHERE flag_id=?",
            (FlagStatus.RESOLVED.value, _iso(_utcnow()), resolution_notes, flag_id),
        )
        self.write_event(
            run_dir, project_id, "mechanic_flag_resolved", actor,
            {"flag_id": flag_id, "resolution_notes": resolution_notes},
        )
        return {
            "flag_id": flag_id,
            "status": FlagStatus.RESOLVED.value,
            "resolution_notes": resolution_notes,
        }

    def list_flags(self, project_id: str) -> List[dict]:
        run_dir = self._find_run_dir(project_id)
        db_path = self._db_path(run_dir)
        if not db_path.exists():
            return []
        return [
            dict(r) for r in _rows(
                db_path,
                "SELECT * FROM mechanic_flags WHERE project_id=? ORDER BY created_at ASC",
                (project_id,),
            )
        ]

    def _categorize(self, name: str) -> str:
        lowered = name.lower()
        for hint, category in self._CATEGORY_HINTS.items():
            if hint in lowered:
                return category
        return "engine" if not lowered else "unknown"

    def _build_manifest(
        self, run_dir: Path, project: RestorationProject, components: List[ComponentRecord]
    ) -> None:
        threshold = float(self.config["restoration_confidence_threshold"])
        vlm_only = not any(c.kb_match for c in components)
        if vlm_only:
            threshold = float(self.config["restoration_vlm_only_threshold"])
        entries: List[ManifestEntry] = []
        kb_lookup = self._kb_flat_lookup()
        for comp in components:
            est = None
            oem = None
            alternatives: List[str] = []
            if comp.kb_match and comp.kb_match in kb_lookup:
                kb = kb_lookup[comp.kb_match]
                rng = kb.get("indicative_price_range_usd") or {}
                est = rng.get("mid")
                oem = kb.get("oem_number")
                alternatives = list(kb.get("aftermarket_alternatives") or [])
            requires_review = comp.confidence < threshold or comp.category not in PART_CATEGORIES
            entries.append(
                ManifestEntry(
                    part_id=comp.part_id,
                    name=comp.name,
                    oem_number=oem,
                    aftermarket_alternatives=alternatives,
                    quantity=1,
                    criticality=(kb_lookup.get(comp.kb_match, {}).get("criticality") or "standard")
                    if comp.kb_match
                    else "standard",
                    estimated_cost_usd=est,
                    confidence=comp.confidence,
                    requires_review=requires_review,
                )
            )
        coverage = 0.0
        if entries:
            coverage = round(100.0 * sum(1 for e in entries if not e.requires_review) / len(entries), 1)
        project.automation_coverage_pct = coverage
        manifest = {
            "version": 1,
            "locked": False,
            "automation_coverage_pct": coverage,
            "entries": [e.model_dump(mode="json") for e in entries],
        }
        self._write_json(run_dir / "manifest.json", manifest)
        self._save_project(run_dir, project)

    def get_manifest(self, project_id: str) -> dict:
        run_dir = self._find_run_dir(project_id)
        manifest = self._read_json(run_dir / "manifest.json")
        if not manifest:
            raise PipelineError(404, "manifest_not_found", "Identification has not produced a manifest yet.")
        return manifest

    def lock_manifest(self, project_id: str, actor: str = "operator") -> dict:
        """FR-008: lock the manifest, write the locked version + coverage, and
        generate KB auto-extraction proposals for confirmed parts with no KB
        entry (proposal content derives from the part's actual fields)."""
        run_dir = self._find_run_dir(project_id)
        manifest = self._read_json(run_dir / "manifest.json")
        if not manifest:
            raise PipelineError(409, "no_manifest", "Identification has not produced a manifest yet.")
        manifest["locked"] = True
        manifest["locked_at"] = _iso(_utcnow())
        self._write_json(run_dir / "manifest.json", manifest)
        for entry in manifest.get("entries") or []:
            if entry.get("requires_review"):
                continue
            has_kb = entry.get("oem_number") or entry.get("estimated_cost_usd") is not None
            if not has_kb:
                self._add_kb_proposal(
                    run_dir,
                    project_id,
                    {
                        "kind": "new_entry",
                        "part_id": entry.get("part_id"),
                        "name": entry.get("name"),
                        "category": self._categorize(entry.get("name") or ""),
                        "vehicle": self._vehicle_label(run_dir),
                    },
                )
        self.transition(project_id, "manifest_locked", actor)
        return {"manifest_version": manifest.get("version", 1), "coverage": manifest.get("automation_coverage_pct")}

    def _vehicle_label(self, run_dir: Path) -> str:
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        meta = project.vehicle_meta
        return " ".join(p for p in (meta.year, meta.make, meta.model) if p)

    def resolve_review(self, project_id: str, payload: dict, actor: str = "operator") -> dict:
        """FR-007: resolve a review case; audit delta in review_log; feedback
        signal with denormalized category (OBL-29)."""
        run_dir = self._find_run_dir(project_id)
        manifest = self._read_json(run_dir / "manifest.json")
        if not manifest:
            raise PipelineError(409, "no_manifest", "No manifest to resolve against.")
        part_id = payload.get("part_id")
        entries = manifest.get("entries") or []
        target = None
        for entry in entries:
            if entry.get("part_id") == part_id:
                target = entry
                break
        if target is None:
            raise PipelineError(404, "part_not_found", f"No part {part_id!r} in the manifest.")
        if not target.get("requires_review"):
            raise PipelineError(
                409, "not_in_review", f"Part {part_id!r} is not in the review queue."
            )
        new_name = (payload.get("name") or target.get("name") or "").strip()
        new_condition = (payload.get("condition") or target.get("condition") or "present").strip()
        notes = payload.get("notes")
        deltas = []
        if new_name != target.get("name"):
            deltas.append(("name", target.get("name"), new_name))
        if new_condition != target.get("condition"):
            deltas.append(("condition", target.get("condition"), new_condition))
        old_name = target.get("name")
        target["name"] = new_name
        target["condition"] = new_condition
        target["requires_review"] = False
        new_category = self._categorize(new_name)
        target["category"] = new_category
        self._write_json(run_dir / "manifest.json", manifest)
        ensure_schema(self._db_path(run_dir))
        for field_name, old_value, new_value in deltas:
            _execute(
                self._db_path(run_dir),
                "INSERT INTO review_log (review_id, project_id, part_id, field_name, old_value,"
                " new_value, actor, timestamp, notes) VALUES (?,?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, project_id, part_id, field_name, old_value, new_value, actor,
                 _iso(_utcnow()), notes),
            )
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        signal = FeedbackSignal(
            project_id=project_id,
            signal_type="identification_correction",
            part_id=part_id,
            category=new_category,
            vehicle_make=project.vehicle_meta.make,
            vehicle_model=project.vehicle_meta.model,
            vehicle_year=project.vehicle_meta.year,
            field_name="name",
            old_value=old_name,
            new_value=new_name,
        )
        self.record_feedback(signal)
        return {
            "entry": target,
            "audit_delta": [{"field": f, "old": o, "new": n} for f, o, n in deltas],
        }

    def list_reviews(self, project_id: str) -> List[dict]:
        run_dir = self._find_run_dir(project_id)
        db_path = self._db_path(run_dir)
        if not db_path.exists():
            return []
        return [
            dict(r)
            for r in _rows(
                db_path,
                "SELECT * FROM review_log WHERE project_id=? ORDER BY timestamp ASC",
                (project_id,),
            )
        ]

    # -- KB loading (FR-049) ------------------------------------------------------

    def _kb_path(self) -> Path:
        if self._config_dir:
            return self._config_dir / "restoration_kb.yaml"
        return REPO_ROOT / "orchestrator" / "prompts" / "packs" / "restoration_kb.yaml"

    def load_kb(self) -> Tuple[List[dict], Optional[str]]:
        """Returns (entries, error). Missing file → silent empty default;
        malformed → kb_load_error detail (FR-049)."""
        path = self._kb_path()
        if not path.exists():
            return [], None
        try:
            data = restoration_yaml.load_file(str(path)) or {}
        except Exception as exc:
            return [], f"kb_load_error: {exc}"
        entries: List[dict] = []
        makes = data.get("makes") or {}
        for make, make_block in makes.items():
            for model, model_block in (make_block.get("models") or {}).items():
                for year, year_block in (model_block.get("years") or {}).items():
                    for part in year_block.get("parts") or []:
                        entries.append(
                            {
                                "make": make,
                                "model": model,
                                "year": str(year),
                                **part,
                            }
                        )
        # operator-added entries (FR-056 KB management) — flat list
        for op_entry in data.get("operator_entries") or []:
            entries.append({"make": "", "model": "", "year": "", **op_entry})
        return entries, None

    def _kb_flat_lookup(self) -> Dict[str, dict]:
        entries, _ = self.load_kb()
        return {e["part_id"]: e for e in entries if "part_id" in e}

    def _kb_entries_for(self, meta: VehicleMeta) -> List[dict]:
        entries, _ = self.load_kb()
        if not (meta.make and meta.model):
            return []
        make = (meta.make or "").lower()
        model = (meta.model or "").lower()
        year = (meta.year or "").strip()
        out = []
        for entry in entries:
            if make and make not in str(entry.get("make", "")).lower():
                continue
            if model and model not in str(entry.get("model", "")).lower():
                continue
            if year and str(entry.get("year")) != year:
                continue
            out.append(entry)
        return out

    def _match_kb(self, name: str, kb_entries: List[dict]) -> Optional[dict]:
        """Token-overlap match with a coverage floor: the overlap must cover
        ≥60% of the shorter name's tokens, so a shared category word alone
        ("brake") never produces a false KB match."""
        norm = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
        best: Optional[dict] = None
        best_ratio = 0.0
        for entry in kb_entries:
            candidate = re.sub(r"[^a-z0-9]+", " ", str(entry.get("name", "")).lower()).strip()
            if not candidate:
                continue
            a, b = set(norm.split()), set(candidate.split())
            score = len(a & b)
            if not score:
                continue
            ratio = score / max(1, min(len(a), len(b)))
            if ratio >= 0.6 and ratio > best_ratio:
                best = entry
                best_ratio = ratio
        return best

    # -- budget (FR-009/FR-010/FR-011) ---------------------------------------------

    def compute_budget_ruling(self, project_id: str, ceiling: float, actor: str = "operator") -> dict:
        if ceiling is None or ceiling <= 0:
            raise PipelineError(400, "invalid_budget", "budget_ceiling_usd must be a positive number (USD).")
        run_dir = self._find_run_dir(project_id)
        manifest = self._read_json(run_dir / "manifest.json")
        if not manifest:
            raise PipelineError(409, "no_manifest", "Manifest must exist before a budget ruling.")
        entries = manifest.get("entries") or []
        costs = [e.get("estimated_cost_usd") for e in entries]
        known = [c for c in costs if c is not None]
        unknown = len(costs) - len(known)
        total = sum(known)
        affordable_pct = float(self.config["restoration_budget_affordable_pct"])
        tight_pct = float(self.config["restoration_budget_tight_pct"])
        unknown_pct_limit = float(self.config["restoration_unknown_cost_pct"])
        if entries and unknown > unknown_pct_limit * len(entries):
            ruling = BudgetRuling.INSUFFICIENT_DATA
        elif total <= affordable_pct * ceiling:
            ruling = BudgetRuling.AFFORDABLE
        elif total <= tight_pct * ceiling:
            ruling = BudgetRuling.TIGHT
        else:
            ruling = BudgetRuling.SHORTFALL_CRITICAL
        allocation = self._per_part_allocation(entries, ceiling)
        detail = {
            "total_estimated_cost_usd": round(total, 2),
            "known_cost_count": len(known),
            "unknown_cost_count": unknown,
            "per_part_allocation": allocation,
        }
        budget_doc = {
            "budget_ceiling_usd": ceiling,
            "ruling": ruling.value,
            "detail": detail,
            "computed_at": _iso(_utcnow()),
            "overridden": False,
            "override_audit": [],
        }
        existing = self._read_json(run_dir / "budget.json")
        if existing and existing.get("override_audit"):
            budget_doc["override_audit"] = existing["override_audit"]
            budget_doc["overridden"] = existing.get("overridden", False)
        self._write_json(run_dir / "budget.json", budget_doc)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        project.budget_ceiling_usd = ceiling
        self._save_project(run_dir, project)
        self.transition(project_id, "budget_ruled", actor)
        return {"ruling": ruling.value, "detail": detail, "unknown_cost_count": unknown}

    def _per_part_allocation(self, entries: List[dict], ceiling: float) -> Dict[str, float]:
        tiers: Dict[str, List[dict]] = {"critical": [], "standard": [], "optional": []}
        for e in entries:
            tiers.get(str(e.get("criticality") or "standard"), tiers["standard"]).append(e)
        alloc_cfg = dict(self.config["tier_allocation"])
        present = {t: p for t, p in alloc_cfg.items() if tiers.get(t)}
        total_pct = sum(present.values()) or 1.0
        out: Dict[str, float] = {}
        for tier, pct in present.items():
            redistributed = pct / total_pct
            per_part = (redistributed * ceiling) / max(1, len(tiers[tier]))
            out[tier] = round(per_part, 2)
        return out

    def override_budget(self, project_id: str, reason: str, actor: str = "operator") -> dict:
        if not reason:
            raise PipelineError(400, "reason_required", "Budget override requires a reason.")
        run_dir = self._find_run_dir(project_id)
        budget = self._read_json(run_dir / "budget.json")
        if not budget:
            raise PipelineError(409, "no_ruling", "No budget ruling exists to override.")
        if budget.get("ruling") not in (BudgetRuling.SHORTFALL_CRITICAL.value, BudgetRuling.INSUFFICIENT_DATA.value):
            raise PipelineError(
                409,
                "override_not_permitted",
                f"Override is permitted only from SHORTFALL_CRITICAL or INSUFFICIENT_DATA (current: {budget.get('ruling')}).",
            )
        entry = {"actor": actor, "timestamp": _iso(_utcnow()), "reason": reason}
        budget.setdefault("override_audit", []).append(entry)
        budget["overridden"] = True
        self._write_json(run_dir / "budget.json", budget)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        project.budget_override_reason = reason
        self._save_project(run_dir, project)
        return {"override_record": entry, "ruling": budget.get("ruling")}

    # -- sourcing data plane (FR-013 manual entries + coverage; hunt in Phase 3) ---

    def add_manual_candidate(self, project_id: str, payload: dict, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        ensure_schema(self._db_path(run_dir))
        payload = dict(payload)
        payload["provenance"] = Provenance.MANUAL_ENTRY.value
        payload.setdefault("candidate_id", uuid.uuid4().hex)
        candidate = SourcingCandidate(**payload)
        self._insert_candidate(run_dir, project_id, candidate)
        self.write_event(
            run_dir,
            project_id,
            "sourcing_manual_added",
            actor,
            {"part_id": candidate.part_id, "vendor": candidate.vendor},
        )
        self._update_coverage(project_id, run_dir)
        return {"candidate": candidate.model_dump(mode="json")}

    def _insert_candidate(self, run_dir: Path, project_id: str, c: SourcingCandidate) -> None:
        _execute(
            self._db_path(run_dir),
            "INSERT INTO sourcing_candidates (project_id, part_id, candidate_id, vendor, oem_number,"
            " price_usd, condition, availability, region, url_or_contact, tradeable, provenance,"
            " fetched_at, trade_partner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                project_id,
                c.part_id,
                c.candidate_id,
                c.vendor,
                c.oem_number,
                c.price_usd,
                c.condition.value if hasattr(c.condition, "value") else c.condition,
                c.availability.value if hasattr(c.availability, "value") else c.availability,
                c.region,
                c.url_or_contact,
                1 if c.tradeable else 0,
                c.provenance.value if hasattr(c.provenance, "value") else c.provenance,
                _iso(c.fetched_at),
                c.trade_partner_id,
            ),
        )

    def _update_coverage(self, project_id: str, run_dir: Path) -> Dict[str, float]:
        coverage = self.compute_coverage(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        project.system_sourcing_coverage_pct = coverage["system_coverage"]
        project.total_sourcing_coverage_pct = coverage["total_coverage"]
        project.critical_path_coverage_pct = coverage["critical_coverage"]
        self._save_project(run_dir, project)
        return coverage

    def compute_coverage(self, project_id: str) -> Dict[str, float]:
        run_dir = self._find_run_dir(project_id)
        manifest = self._read_json(run_dir / "manifest.json") or {}
        entries = manifest.get("entries") or []
        total_parts = len(entries)
        db_path = self._db_path(run_dir)
        covered_system, covered_total = set(), set()
        if db_path.exists():
            for row in _rows(
                db_path, "SELECT DISTINCT part_id, provenance FROM sourcing_candidates WHERE project_id=?", (project_id,)
            ):
                if row["provenance"] in SYSTEM_DISCOVERED_PROVENANCES:
                    covered_system.add(row["part_id"])
                if row["provenance"] in TOTAL_COVERAGE_PROVENANCES:
                    covered_total.add(row["part_id"])
            # FR-013: unsourceable + fabrication ref counts as covered in both
            for row in _rows(
                db_path,
                "SELECT part_id FROM unsourceable_flags WHERE project_id=? AND fabrication_reference_glb IS NOT NULL",
                (project_id,),
            ):
                covered_system.add(row["part_id"])
                covered_total.add(row["part_id"])
        def pct(covered: set, parts: List[dict]) -> float:
            if not parts:
                return 0.0
            ids = {e.get("part_id") for e in parts}
            return round(100.0 * len(covered & ids) / len(ids), 1)
        critical = [e for e in entries if e.get("criticality") == "critical"]
        return {
            "system_coverage": pct(covered_system, entries),
            "total_coverage": pct(covered_total, entries),
            "critical_coverage": pct(covered_system, critical),
            "total_parts": total_parts,
        }

    def list_candidates(self, project_id: str) -> List[dict]:
        run_dir = self._find_run_dir(project_id)
        db_path = self._db_path(run_dir)
        if not db_path.exists():
            return []
        out = []
        for row in _rows(
            db_path,
            "SELECT * FROM sourcing_candidates WHERE project_id=? ORDER BY rowid ASC",
            (project_id,),
        ):
            out.append(dict(row))
        return out

    # -- negotiation (FR-042) + purchases (FR-043) -----------------------------------

    def record_negotiation(self, project_id: str, payload: dict, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        db_path = self._db_path(run_dir)
        ensure_schema(db_path)
        part_id = payload.get("part_id")
        candidate_id = payload.get("candidate_id")
        if not part_id or not candidate_id:
            raise PipelineError(400, "missing_field", "part_id and candidate_id are required.")
        target = payload.get("status")
        if target not in [s.value for s in NegotiationStatus]:
            raise PipelineError(400, "unknown_status", f"Unknown negotiation status {target!r}.")
        rows = _rows(
            db_path,
            "SELECT * FROM negotiation_records WHERE project_id=? AND part_id=? AND candidate_id=?",
            (project_id, part_id, candidate_id),
        )
        current = rows[0]["status"] if rows else "pending"
        if target == current:
            raise PipelineError(409, "invalid_transition", f"Already in status {current}.")
        valid_next = NEGOTIATION_TRANSITIONS.get(current, {})
        if target not in valid_next:
            raise PipelineError(
                409,
                "invalid_transition",
                f"Cannot transition negotiation from {current} to {target}. Valid next: {sorted(valid_next) or ['(terminal)']}.",
                {"current": current, "valid_next": sorted(valid_next)},
            )
        required = valid_next[target]
        missing = [f for f in required if payload.get(f) in (None, "")]
        if missing:
            raise PipelineError(
                400,
                "missing_field",
                f"Status {target} requires fields: {missing}",
                {"missing": missing},
            )
        notes = payload.get("notes") or (rows[0]["notes"] if rows else "")
        final_price = payload.get("final_price_usd")
        if final_price is None and rows:
            final_price = rows[0]["final_price_usd"]
        _execute(
            db_path,
            "INSERT INTO negotiation_records (project_id, part_id, candidate_id, status, notes,"
            " final_price_usd, updated_at) VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(project_id, part_id, candidate_id) DO UPDATE SET"
            " status=excluded.status, notes=excluded.notes,"
            " final_price_usd=excluded.final_price_usd, updated_at=excluded.updated_at",
            (project_id, part_id, candidate_id, target, notes, final_price, _iso(_utcnow())),
        )
        self.write_event(
            run_dir,
            project_id,
            "negotiation_status_changed",
            actor,
            {"part_id": part_id, "candidate_id": candidate_id, "from": current, "to": target},
        )
        if target == "received":
            # FR-042: received triggers purchase_outcome signal + KB proposal
            # (FR-043); the vendor comes from the candidate record
            vendor = None
            cand_rows = _rows(
                db_path,
                "SELECT vendor FROM sourcing_candidates WHERE project_id=? AND candidate_id=? LIMIT 1",
                (project_id, candidate_id),
            )
            if cand_rows:
                vendor = cand_rows[0]["vendor"]
            self._record_purchase_outcome_signal(
                run_dir, project_id, part_id, final_price, actor, vendor=vendor
            )
        record = NegotiationRecord(
            part_id=part_id,
            candidate_id=candidate_id,
            status=target,
            notes=notes or "",
            final_price_usd=final_price,
        )
        return {"record": record.model_dump(mode="json")}

    def record_purchase(self, project_id: str, payload: dict, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        db_path = self._db_path(run_dir)
        ensure_schema(db_path)
        record = PurchaseRecord(**payload)
        _execute(
            db_path,
            "INSERT INTO purchase_records (project_id, part_id, vendor, price_usd, condition,"
            " ordered_at, received_at, notes, batch_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                project_id,
                record.part_id,
                record.vendor,
                record.price_usd,
                record.condition.value if hasattr(record.condition, "value") else record.condition,
                _iso(record.ordered_at),
                _iso(record.received_at),
                record.notes,
                record.batch_id,
            ),
        )
        self._record_purchase_outcome_signal(
            run_dir, project_id, record.part_id, record.price_usd, actor, vendor=record.vendor
        )
        return {"record": record.model_dump(mode="json")}

    def _record_purchase_outcome_signal(
        self,
        run_dir: Path,
        project_id: str,
        part_id: str,
        final_price: Optional[float],
        actor: str,
        vendor: Optional[str] = None,
    ) -> None:
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        manifest = self._read_json(run_dir / "manifest.json") or {}
        category = None
        part_name = None
        for entry in manifest.get("entries") or []:
            if entry.get("part_id") == part_id:
                category = self._categorize(entry.get("name") or "")
                part_name = entry.get("name")
                break
        signal = FeedbackSignal(
            project_id=project_id,
            signal_type="purchase_outcome",
            part_id=part_id,
            category=category,
            vehicle_make=project.vehicle_meta.make,
            vehicle_model=project.vehicle_meta.model,
            vehicle_year=project.vehicle_meta.year,
            vendor=vendor,
            final_price_usd=final_price,
        )
        self.record_feedback(signal)
        # FR-043: KB pricing proposal — actual fields, never placeholders
        if part_name and final_price:
            self._add_kb_proposal(
                run_dir,
                project_id,
                {
                    "kind": "pricing",
                    "part_id": part_id,
                    "name": part_name,
                    "vendor": vendor,
                    "observed_price_usd": final_price,
                    "vehicle": f"{project.vehicle_meta.year} {project.vehicle_meta.make} {project.vehicle_meta.model}".strip(),
                },
            )

    def _add_kb_proposal(self, run_dir: Path, project_id: str, payload: dict) -> None:
        ensure_schema(self._db_path(run_dir))
        _execute(
            self._db_path(run_dir),
            "INSERT INTO kb_proposals (proposal_id, project_id, payload, status, created_at)"
            " VALUES (?,?,?,?,?)",
            (uuid.uuid4().hex, project_id, json.dumps(payload, default=str), "pending", _iso(_utcnow())),
        )

    # -- API cost tracking (FR-051) + ceiling (FR-065) ------------------------------

    def log_api_cost(self, project_id: str, provider: str, operation: str, cost: float, description: str = "") -> None:
        run_dir = self._find_run_dir(project_id)
        ensure_schema(self._db_path(run_dir))
        _execute(
            self._db_path(run_dir),
            "INSERT INTO api_costs (project_id, provider, operation, cost_usd, timestamp, description)"
            " VALUES (?,?,?,?,?,?)",
            (project_id, provider, operation, float(cost), _iso(_utcnow()), description),
        )
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        project.api_cost_to_date_usd = round(self._api_cost_total(run_dir, project_id), 2)
        self._save_project(run_dir, project)
        ceiling = float(project.api_cost_ceiling_usd or self.config["restoration_api_cost_ceiling_usd"])
        if ceiling > 0 and project.api_cost_to_date_usd >= 0.8 * ceiling and not project.api_cost_override_reason:
            existing = self.read_events(run_dir, "api_cost_ceiling_warning")
            if not existing:
                self.write_event(
                    run_dir,
                    project_id,
                    "api_cost_ceiling_warning",
                    "system",
                    {"total": project.api_cost_to_date_usd, "ceiling": ceiling},
                )

    def _api_cost_total(self, run_dir: Path, project_id: str) -> float:
        rows = _rows(
            self._db_path(run_dir),
            "SELECT COALESCE(SUM(cost_usd),0) AS total FROM api_costs WHERE project_id=?",
            (project_id,),
        )
        return float(rows[0]["total"]) if rows else 0.0

    def api_cost_summary(self, project_id: str) -> dict:
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        ceiling = float(project.api_cost_ceiling_usd or self.config["restoration_api_cost_ceiling_usd"])
        per_provider: Dict[str, float] = {}
        if self._db_path(run_dir).exists():
            for row in _rows(
                self._db_path(run_dir),
                "SELECT provider, COALESCE(SUM(cost_usd),0) AS total FROM api_costs WHERE project_id=? GROUP BY provider",
                (project_id,),
            ):
                per_provider[row["provider"]] = float(row["total"])
        total = self._api_cost_total(run_dir, project_id)
        return {
            "total": round(total, 2),
            "per_provider": per_provider,
            "ceiling": ceiling,
            "pct_of_ceiling": round(100.0 * total / ceiling, 1) if ceiling else 0.0,
        }

    def _check_api_cost_ceiling(self, project: RestorationProject, run_dir: Path, task_type: TaskType) -> None:
        ceiling = float(project.api_cost_ceiling_usd or self.config["restoration_api_cost_ceiling_usd"])
        if ceiling <= 0 or project.api_cost_override_reason:
            return
        total = self._api_cost_total(run_dir, project.project_id)
        if total >= ceiling:
            self.write_event(
                run_dir,
                project.project_id,
                "api_cost_ceiling_reached",
                "system",
                {"total": total, "ceiling": ceiling, "task_type": task_type.value},
            )
            raise PipelineError(
                409,
                "api_cost_ceiling_reached",
                f"API cost ceiling reached (${total:.2f} / ${ceiling:.2f}). Override via POST /restoration/projects/{project.project_id}/api-cost/override.",
            )

    def override_api_cost_ceiling(self, project_id: str, reason: str, actor: str = "operator") -> dict:
        if not reason:
            raise PipelineError(400, "reason_required", "API cost ceiling override requires a reason.")
        run_dir = self._find_run_dir(project_id)
        project = RestorationProject(**self._read_json(run_dir / "project.json"))
        project.api_cost_override_reason = reason
        self._save_project(run_dir, project)
        event = self.write_event(
            run_dir,
            project_id,
            "api_cost_ceiling_overridden",
            actor,
            {"reason": reason, "actor": actor, "timestamp": _iso(_utcnow())},
        )
        return {"override_record": event}

    # -- guide tokens (FR-039/040/041) -----------------------------------------------

    def mint_token(self, project_id: str, assembly_id: str, bundle_version: int = 1, actor: str = "operator") -> GuideToken:
        run_dir = self._find_run_dir(project_id)
        ensure_schema(self._db_path(run_dir))
        token = GuideToken(
            token_id=secrets.token_urlsafe(32),
            project_id=project_id,
            assembly_id=assembly_id,
            bundle_version=bundle_version,
            expires_at=_utcnow() + timedelta(days=int(self.config["token_expiry_days"])),
        )
        _execute(
            self._db_path(run_dir),
            "INSERT INTO guide_tokens (token_id, project_id, assembly_id, bundle_version, minted_at,"
            " expires_at, revoked_at, revoked_by, superseded_at, superseded_by, last_accessed_at, access_count)"
            " VALUES (?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,0)",
            (
                token.token_id,
                project_id,
                assembly_id,
                bundle_version,
                _iso(token.minted_at),
                _iso(token.expires_at),
            ),
        )
        return token

    def _token_row(self, run_dir: Path, token_id: str) -> Optional[sqlite3.Row]:
        rows = _rows(
            self._db_path(run_dir), "SELECT * FROM guide_tokens WHERE token_id=?", (token_id,)
        )
        return rows[0] if rows else None

    def validate_token(self, token_id: str) -> Tuple[str, Path, sqlite3.Row]:
        """Returns (verdict, run_dir, row): verdict in ok|superseded|expired|revoked|invalid."""
        for db in self.runs_root.glob("*/restoration/restoration.db"):
            rows = _rows(db, "SELECT * FROM guide_tokens WHERE token_id=?", (token_id,))
            if rows:
                row = rows[0]
                run_dir = db.parent
                if row["revoked_at"]:
                    return "revoked", run_dir, row
                expires = _parse_dt(row["expires_at"])
                if expires and expires < _utcnow():
                    return "expired", run_dir, row
                if row["superseded_at"]:
                    return "superseded", run_dir, row
                return "ok", run_dir, row
        raise PipelineError(404, "token_not_found", "Guide link is not valid.")

    def touch_token(self, run_dir: Path, token_id: str) -> None:
        _execute(
            self._db_path(run_dir),
            "UPDATE guide_tokens SET last_accessed_at=?, access_count=access_count+1 WHERE token_id=?",
            (_iso(_utcnow()), token_id),
        )

    def revoke_token(self, project_id: str, token_id: str, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        row = self._token_row(run_dir, token_id)
        if not row:
            raise PipelineError(404, "token_not_found", f"No token {token_id!r}.")
        _execute(
            self._db_path(run_dir),
            "UPDATE guide_tokens SET revoked_at=?, revoked_by=? WHERE token_id=?",
            (_iso(_utcnow()), actor, token_id),
        )
        self.write_event(run_dir, project_id, "guide_token_revoked", actor, {"token_id": token_id})
        return {"revoked": token_id}

    def revoke_all_tokens(self, project_id: str, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        n = _execute(
            self._db_path(run_dir),
            "UPDATE guide_tokens SET revoked_at=?, revoked_by=? WHERE project_id=? AND revoked_at IS NULL",
            (_iso(_utcnow()), actor, project_id),
        )
        self.write_event(run_dir, project_id, "guide_token_revoked", actor, {"bulk": True, "count": n})
        return {"revoked_count": n}

    def supersede_token(self, project_id: str, token_id: str, actor: str = "operator") -> dict:
        run_dir = self._find_run_dir(project_id)
        row = self._token_row(run_dir, token_id)
        if not row:
            raise PipelineError(404, "token_not_found", f"No token {token_id!r}.")
        _execute(
            self._db_path(run_dir),
            "UPDATE guide_tokens SET superseded_at=?, superseded_by=? WHERE token_id=?",
            (_iso(_utcnow()), actor, token_id),
        )
        self.write_event(run_dir, project_id, "guide_token_superseded", actor, {"token_id": token_id})
        return {"superseded": token_id}

    def extend_token(self, project_id: str, token_id: str, extends_days: int = 30, actor: str = "operator") -> dict:
        if extends_days < 1 or extends_days > int(self.config["token_extend_max_days"]):
            raise PipelineError(
                400,
                "invalid_extension",
                f"extends_days must be 1..{self.config['token_extend_max_days']}.",
            )
        run_dir = self._find_run_dir(project_id)
        row = self._token_row(run_dir, token_id)
        if not row:
            raise PipelineError(404, "token_not_found", f"No token {token_id!r}.")
        base = _parse_dt(row["expires_at"]) or _utcnow()
        new_expiry = base + timedelta(days=extends_days)
        _execute(
            self._db_path(run_dir),
            "UPDATE guide_tokens SET expires_at=? WHERE token_id=?",
            (_iso(new_expiry), token_id),
        )
        self.write_event(
            run_dir,
            project_id,
            "guide_token_extended",
            actor,
            {"token_id": token_id, "expires_at": _iso(new_expiry), "actor": actor, "timestamp": _iso(_utcnow())},
        )
        return {"token": {**dict(row), "expires_at": _iso(new_expiry)}}

    # -- learning ledger (FR-066) -----------------------------------------------------

    def record_feedback(self, signal: FeedbackSignal) -> None:
        _execute(
            self.feedback_db,
            "INSERT OR REPLACE INTO feedback_signals (signal_id, project_id, signal_type, part_id,"
            " category, vehicle_make, vehicle_model, vehicle_year, field_name, old_value, new_value,"
            " vendor, final_price_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                signal.signal_id,
                signal.project_id,
                signal.signal_type.value if hasattr(signal.signal_type, "value") else signal.signal_type,
                signal.part_id,
                signal.category,
                signal.vehicle_make,
                signal.vehicle_model,
                signal.vehicle_year,
                signal.field_name,
                signal.old_value,
                signal.new_value,
                signal.vendor,
                signal.final_price_usd,
                _iso(signal.created_at),
            ),
        )

    def list_feedback(self, signal_type: Optional[str] = None, category: Optional[str] = None,
                      make: Optional[str] = None, model: Optional[str] = None,
                      year: Optional[str] = None) -> List[dict]:
        sql = "SELECT * FROM feedback_signals WHERE 1=1"
        args: List[Any] = []
        if signal_type:
            sql += " AND signal_type=?"
            args.append(signal_type)
        if category:
            sql += " AND category=?"
            args.append(category)
        if make:
            sql += " AND vehicle_make=?"
            args.append(make)
        if model:
            sql += " AND vehicle_model=?"
            args.append(model)
        if year:
            sql += " AND vehicle_year=?"
            args.append(year)
        return [dict(r) for r in _rows(self.feedback_db, sql, args)]

    def confidence_adjustment(
        self,
        base_confidence: float,
        category: Optional[str],
        make: Optional[str],
        model: Optional[str],
        year: Optional[str],
        now: Optional[datetime] = None,
    ) -> Tuple[float, Optional[dict]]:
        """FR-066 pinned formula:
        IF total_corrections < minimum_samples: adjusted = base (guard, no computation)
        ELSE adjusted = base + K * (agreement_rate - 0.5), clamped [0,1].
        Recency weight 0.95^months_old; corrections older than 12 months excluded."""
        cfg = self.config["learning_ledger"]
        now = now or _utcnow()
        signals = self.list_feedback(
            signal_type="identification_correction", category=category, make=make, model=model, year=year
        )
        max_age = float(cfg["max_correction_age_months"])
        decay_base = float(cfg["recency_decay_base"])
        weighted_matching = 0.0
        weighted_partial = 0.0
        weighted_total = 0.0
        for sig in signals:
            created = _parse_dt(sig.get("created_at"))
            if not created:
                continue
            age = _months_old(created, now)
            if age > max_age:
                continue
            weight = decay_base ** age
            weighted_total += weight
            old_v = (sig.get("old_value") or "").strip().lower()
            new_v = (sig.get("new_value") or "").strip().lower()
            field = (sig.get("field_name") or "").strip().lower()
            if old_v and new_v and old_v == new_v:
                weighted_matching += weight
            elif old_v and new_v and field in ("condition", "category"):
                # partial: the identified part was adjusted on condition or
                # category only — the part itself was right (weight 0.5)
                weighted_partial += 0.5 * weight
            # else (name changed): the system's part identification was wrong
            # — a miss, contributing 0 to the agreement numerator
        min_samples = int(cfg["minimum_samples"])
        if weighted_total < min_samples or weighted_total <= 0:
            return base_confidence, None  # zero-sample guard: no division by zero
        agreement_rate = (weighted_matching + weighted_partial) / weighted_total
        k = float(cfg["K"])
        adjusted = base_confidence + k * (agreement_rate - 0.5)
        adjusted = max(0.0, min(1.0, adjusted))
        context = {
            "sample_count": round(weighted_total, 3),
            "agreement_rate": round(agreement_rate, 4),
            "K": k,
            "decay_factor": decay_base,
            "adjusted_value": round(adjusted, 4),
        }
        return adjusted, context

    def vendor_rank_score(self, vendor: str, now: Optional[datetime] = None) -> float:
        """FR-066 vendor ranking: Σ(recency weights) + 0.1 if selected in last 30d."""
        cfg = self.config["learning_ledger"]
        now = now or _utcnow()
        decay = float(cfg["recency_decay_base"])
        score = 0.0
        recent = False
        for sig in self.list_feedback(signal_type="sourcing_selection"):
            if (sig.get("vendor") or "") != vendor:
                continue
            created = _parse_dt(sig.get("created_at"))
            if not created:
                continue
            age = _months_old(created, now)
            score += decay ** age
            if (now - created).days <= 30:
                recent = True
        return round(score + (0.1 if recent else 0.0), 4)

    def weighted_median_estimate(
        self,
        part_id: Optional[str],
        make: Optional[str],
        model: Optional[str],
        year: Optional[str],
        kb_mid: Optional[float] = None,
        now: Optional[datetime] = None,
    ) -> Tuple[Optional[float], int]:
        """FR-066 cost estimation: weighted median of historical purchase prices
        (min 3 records, else KB midpoint)."""
        cfg = self.config["learning_ledger"]
        now = now or _utcnow()
        decay = float(cfg["recency_decay_base"])
        max_age = float(cfg["max_correction_age_months"])
        samples: List[Tuple[float, float]] = []  # (price, weight)
        for sig in self.list_feedback(signal_type="purchase_outcome", make=make, model=model, year=year):
            if part_id and sig.get("part_id") != part_id:
                continue
            price = sig.get("final_price_usd")
            created = _parse_dt(sig.get("created_at"))
            if price is None or not created:
                continue
            age = _months_old(created, now)
            if age > max_age:
                continue
            samples.append((float(price), decay ** age))
        if len(samples) < 3:
            return kb_mid, len(samples)
        samples.sort(key=lambda s: s[0])
        total_weight = sum(w for _, w in samples)
        acc = 0.0
        for price, weight in samples:
            acc += weight
            if acc >= total_weight / 2.0:
                return round(price, 2), len(samples)
        return round(samples[-1][0], 2), len(samples)

    # -- index (FR-048: single-writer lock discipline; a CACHE not a source of truth) --

    def _index_path(self) -> Path:
        return self.runs_root / "restoration_index.json"

    def _index_update(self, project: RestorationProject) -> None:
        record = {
            "project_id": project.project_id,
            "run_id": project.run_id,
            "status": _status_str(project.status),
            "vehicle_meta": project.vehicle_meta.model_dump(mode="json"),
            "updated_at": _iso(project.updated_at),
        }
        with self._index_lock:
            with _FileLock(self._index_path()):
                index = self._read_json(self._index_path(), {}) or {}
                index[project.project_id] = record
                tmp = self._index_path().with_name(
                    f".restoration_index.tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}"
                )
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(index, fh, indent=2)
                os.replace(tmp, self._index_path())

    def load_index(self) -> Dict[str, Any]:
        index = self._read_json(self._index_path())
        if not isinstance(index, dict):
            return self.rebuild_index()
        return index

    def rebuild_index(self) -> Dict[str, Any]:
        index: Dict[str, Any] = {}
        for project_json in self.runs_root.glob("*/restoration/project.json"):
            data = self._read_json(project_json)
            if not data:
                continue
            try:
                project = RestorationProject(**data)
            except Exception:
                continue
            index[project.project_id] = {
                "project_id": project.project_id,
                "run_id": project.run_id,
                "status": _status_str(project.status),
                "vehicle_meta": project.vehicle_meta.model_dump(mode="json"),
                "updated_at": _iso(project.updated_at),
            }
        self._write_json(self._index_path(), index)
        return index

    # -- source registry (FR-012/U4) ---------------------------------------------------

    def _sources_path(self) -> Path:
        if self._config_dir:
            return self._config_dir / "restoration_sources.yaml"
        return REPO_ROOT / "orchestrator" / "prompts" / "packs" / "restoration_sources.yaml"

    def list_sources(self) -> List[SourceRegistryEntry]:
        path = self._sources_path()
        if not path.exists():
            return []
        data = restoration_yaml.load_file(str(path)) or {}
        out = []
        for raw in data.get("sources") or []:
            out.append(SourceRegistryEntry(**raw))
        return out

    # -- health (FR-062, AC-002) --------------------------------------------------------

    def health(self) -> dict:
        active = len(list(self.runs_root.glob("*/restoration/project.json")))
        return {
            "module_loaded": True,
            "active_projects": active,
            "pipeline_route": "configured",
            "os_supported": self.os_supported(),
            "version": self._git_sha(),
        }

    def _git_sha(self) -> str:
        try:
            proc = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=5,
            )
            if proc.returncode == 0:
                return proc.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
        return os.environ.get("GIT_SHA", "unknown")
