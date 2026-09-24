"""Boot-time crash reconciliation (FR-067) + event-log divergence (FR-028).

Runs on server start for each restoration run, and on demand via
``POST /restoration/reconcile/{run_id}``. SQLite is canonical for
transactional state; this job corrects stale JSON toward it, marks interrupted
tasks, and imports/exports event-log divergences in both directions. Every
correction is logged as ``crash_reconciliation_sync`` — self-healing with
visibility, never silent rewriting.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from .restoration_pipeline import (
    PipelineError,
    RestorationPipeline,
    _execute,
    _iso,
    _parse_dt,
    _rows,
    _utcnow,
    ensure_schema,
)

log = logging.getLogger("restoration.reconcile")


def _load_jsonl(path: Path) -> List[dict]:
    events: List[dict] = []
    if not path.exists():
        return events
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return events


def reconcile_run_state(pipeline: RestorationPipeline, run_dir: Path) -> Dict[str, Any]:
    """FR-067 reconciliation for one run directory. Never raises."""
    run_dir = Path(run_dir)
    fixed: List[str] = []
    db_path = pipeline._db_path(run_dir)
    ensure_schema(db_path)

    # (2) tasks with status running are marked interrupted (FR-029/FR-056)
    try:
        n = _rows(db_path, "SELECT COUNT(*) AS n FROM tasks WHERE status='running'")
        if n and n[0]["n"]:
            _execute(
                db_path,
                "UPDATE tasks SET status='interrupted', updated_at=? WHERE status='running'",
                (_iso(_utcnow()),),
            )
            for row in _rows(db_path, "SELECT task_id, project_id FROM tasks WHERE status='interrupted'"):
                pipeline.write_event(
                    run_dir,
                    row["project_id"],
                    "async_task_interrupted",
                    "system",
                    {"task_id": row["task_id"], "reason": "server_restart"},
                )
            fixed.append("running_tasks_marked_interrupted")
    except Exception as exc:  # noqa: BLE001
        log.warning("reconcile: task interruption check failed: %s", exc)

    project_path = run_dir / "project.json"
    project_data = pipeline._read_json(project_path)
    project_id = (project_data or {}).get("project_id")

    # (2b) project status implies a running task but none exists → needs attention
    try:
        if project_data and project_data.get("status") in ("identifying", "hunting", "meshing"):
            active = _rows(
                db_path,
                "SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status IN ('pending','running')",
                (project_id,),
            )
            if active and active[0]["n"] == 0:
                project_data["needs_attention"] = "possible interrupted task"
                pipeline._write_json(project_path, project_data)
                fixed.append("flagged_needs_attention_interrupted_task")
    except Exception as exc:  # noqa: BLE001
        log.warning("reconcile: needs-attention check failed: %s", exc)

    # (3) sourcing.json missing/stale → rebuild from SQLite (SQLite canonical)
    try:
        sourcing_json = run_dir / "sourcing.json"
        candidates = _rows(
            db_path,
            "SELECT * FROM sourcing_candidates WHERE project_id=? ORDER BY rowid ASC",
            (project_id,),
        )
        latest_db_ts = None
        if candidates:
            latest_db_ts = max((_parse_dt(r["fetched_at"]) for r in candidates), default=None)
        stale = False
        existing = pipeline._read_json(sourcing_json)
        if candidates and not existing:
            stale = True
        elif existing and latest_db_ts:
            rebuilt_count = len(existing.get("candidates") or [])
            if rebuilt_count != len(candidates):
                stale = True
        if stale:
            doc = {
                "candidates": [dict(r) for r in candidates],
                "rebuilt_from": "sqlite",
                "rebuilt_at": _iso(_utcnow()),
            }
            pipeline._write_json(sourcing_json, doc)
            fixed.append("sourcing_json_rebuilt_from_sqlite")
    except Exception as exc:  # noqa: BLE001
        log.warning("reconcile: sourcing.json rebuild failed: %s", exc)

    # (4) project.json status conflicts with latest SQLite stage event → SQLite wins
    try:
        # re-read fresh: step (2b) may have rewritten the file
        project_data = pipeline._read_json(project_path)
        if project_data:
            stage_events = _rows(
                db_path,
                "SELECT metadata, timestamp FROM events WHERE project_id=? AND event_type='restoration_stage_changed'"
                " ORDER BY timestamp DESC LIMIT 1",
                (project_id,),
            )
            if stage_events:
                meta = json.loads(stage_events[0]["metadata"] or "{}")
                sqlite_status = meta.get("to")
                if sqlite_status and sqlite_status != project_data.get("status"):
                    old = project_data.get("status")
                    project_data["status"] = sqlite_status
                    pipeline._write_json(project_path, project_data)
                    fixed.append(f"project_status_corrected:{old}->{sqlite_status}")
    except Exception as exc:  # noqa: BLE001
        log.warning("reconcile: status correction failed: %s", exc)

    # (5) event-log divergence: import JSONL→SQLite, re-export SQLite→JSONL (FR-028)
    divergence = reconcile_event_log(pipeline, run_dir, project_id)
    if divergence.get("imported") or divergence.get("exported"):
        fixed.append("event_log_divergence_resolved")

    # (6) budget.json overridden without audit event → reconciliation_warning
    try:
        budget = pipeline._read_json(run_dir / "budget.json")
        if budget and budget.get("overridden"):
            audits = budget.get("override_audit") or []
            if not audits:
                pipeline.write_event(
                    run_dir,
                    project_id,
                    "reconciliation_warning",
                    "system",
                    {"warning": "budget.json overridden but no audit entry present"},
                )
                fixed.append("budget_override_missing_audit_warned")
    except Exception as exc:  # noqa: BLE001
        log.warning("reconcile: budget audit check failed: %s", exc)

    if fixed:
        pipeline.write_event(
            run_dir,
            project_id,
            "crash_reconciliation_sync",
            "system",
            {"corrections": fixed},
        )
    return {"reconciled": True, "discrepancies_fixed": fixed, "divergence": divergence}


def reconcile_event_log(
    pipeline: RestorationPipeline, run_dir: Path, project_id: Optional[str]
) -> Dict[str, int]:
    """FR-028: SQLite is canonical. JSONL entries missing from SQLite are
    imported; SQLite entries missing from JSONL are re-exported. A summary
    ``event_log_divergence`` event records count + direction."""
    run_dir = Path(run_dir)
    db_path = pipeline._db_path(run_dir)
    jsonl_path = run_dir / "events.jsonl"
    imported = 0
    exported = 0
    try:
        sqlite_ids = {
            r["event_id"] for r in _rows(db_path, "SELECT event_id FROM events")
        }
        jsonl_events = _load_jsonl(jsonl_path)
        jsonl_ids = {e.get("event_id") for e in jsonl_events}
        for event in jsonl_events:
            eid = event.get("event_id")
            if eid and eid not in sqlite_ids:
                try:
                    pipeline._insert_event(db_path, event)
                    imported += 1
                except Exception as exc:  # noqa: BLE001
                    log.warning("reconcile: jsonl→sqlite import failed for %s: %s", eid, exc)
        if imported or any(eid not in jsonl_ids for eid in sqlite_ids if eid):
            # re-export SQLite→JSONL in canonical order
            rows = _rows(db_path, "SELECT * FROM events ORDER BY timestamp ASC")
            missing = [r for r in rows if r["event_id"] not in jsonl_ids]
            if missing:
                with open(jsonl_path, "a", encoding="utf-8") as fh:
                    for r in missing:
                        fh.write(
                            json.dumps(
                                {
                                    "event_id": r["event_id"],
                                    "project_id": r["project_id"],
                                    "event_type": r["event_type"],
                                    "timestamp": r["timestamp"],
                                    "actor": r["actor"],
                                    "metadata": json.loads(r["metadata"] or "{}"),
                                },
                                default=str,
                            )
                            + "\n"
                        )
                exported += len(missing)
        if imported or exported:
            pipeline.write_event(
                run_dir,
                project_id,
                "event_log_divergence",
                "system",
                {"imported_jsonl_to_sqlite": imported, "exported_sqlite_to_jsonl": exported},
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("reconcile: event-log divergence resolution failed: %s", exc)
    return {"imported": imported, "exported": exported}


def reconcile_all(pipeline: RestorationPipeline) -> List[Dict[str, Any]]:
    """Boot-time sweep over every restoration run (lifespan hook)."""
    results: List[Dict[str, Any]] = []
    for project_json in sorted(pipeline.runs_root.glob("*/restoration/project.json")):
        run_dir = project_json.parent
        try:
            results.append(reconcile_run_state(pipeline, run_dir))
        except Exception as exc:  # noqa: BLE001 - never halt boot on reconcile
            log.warning("reconcile %s failed: %s", run_dir, exc)
    return results


def reconcile_by_run_id(pipeline: RestorationPipeline, run_id: str) -> Dict[str, Any]:
    run_dir = pipeline.runs_root / run_id / "restoration"
    if not run_dir.exists():
        raise PipelineError(404, "run_not_found", f"No restoration run {run_id!r}.")
    return reconcile_run_state(pipeline, run_dir)
