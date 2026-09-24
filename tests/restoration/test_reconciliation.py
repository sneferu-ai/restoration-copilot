"""AC-047 (boot reconciliation corrects stale JSON from canonical SQLite),
AC-048 (event-log divergence, bidirectional, rotation), FR-028."""

import json
import sqlite3

import pytest

from orchestrator.core.restoration_pipeline import _execute, _rows
from orchestrator.core.restoration_reconcile import reconcile_run_state


class TestCrashReconciliation:
    def test_stale_json_corrected_from_sqlite(self, pipeline):
        """AC-047: sourcing.json (3 candidates) vs SQLite (5) → rebuilt;
        project.json status conflicting with SQLite events → corrected;
        running task → interrupted."""
        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        run_dir = pipeline._find_run_dir(pid)
        # 5 candidates in SQLite
        for i in range(5):
            pipeline.add_manual_candidate(
                pid,
                {"part_id": f"part-{i}", "vendor": f"Vendor{i}", "price_usd": 10.0 + i,
                 "condition": "used"},
            )
        # stale sourcing.json claiming 3
        pipeline._write_json(run_dir / "sourcing.json", {"candidates": [{"part_id": f"part-{i}"} for i in range(3)]})
        # conflicting status (SQLite events say intake_open)
        data = json.loads((run_dir / "project.json").read_text())
        data["status"] = "hunting"
        pipeline._write_json(run_dir / "project.json", data)
        # a crashed running task
        _execute(
            run_dir / "restoration.db",
            "INSERT INTO tasks (task_id, project_id, task_type, status, progress_pct, created_at, updated_at)"
            " VALUES ('t-run', ?, 'source', 'running', 10, '2026-01-01', '2026-01-01')",
            (pid,),
        )
        report = reconcile_run_state(pipeline, run_dir)
        fixed = report["discrepancies_fixed"]
        assert "sourcing_json_rebuilt_from_sqlite" in fixed
        assert any(f.startswith("project_status_corrected:hunting->intake_open") for f in fixed)
        assert "running_tasks_marked_interrupted" in fixed
        rebuilt = json.loads((run_dir / "sourcing.json").read_text())
        assert len(rebuilt["candidates"]) == 5
        corrected = json.loads((run_dir / "project.json").read_text())
        assert corrected["status"] == "intake_open"
        # corrections logged as crash_reconciliation_sync
        events = pipeline.read_events(run_dir, "crash_reconciliation_sync")
        assert events, "crash_reconciliation_sync event missing"

    def test_reconcile_endpoint(self, authed_client, project_id):
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        run_id = run_dir.parent.name
        res = authed_client.post(f"/restoration/reconcile/{run_id}")
        assert res.status == 200
        assert res.json()["reconciled"] is True
        assert authed_client.post("/restoration/reconcile/no-such-run").status == 404


class TestEventLogDivergence:
    def test_jsonl_to_sqlite_import(self, pipeline):
        """AC-048: an event present in events.jsonl but missing from SQLite is
        imported, with an event_log_divergence summary."""
        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        run_dir = pipeline._find_run_dir(pid)
        db_path = run_dir / "restoration.db"
        # drop the stage-changed event from SQLite only
        _execute(db_path, "DELETE FROM events WHERE event_type='restoration_stage_changed'")
        assert pipeline.read_events(run_dir, "restoration_stage_changed") == []
        report = reconcile_run_state(pipeline, run_dir)
        assert report["divergence"]["imported"] >= 1
        # back in SQLite now
        assert pipeline.read_events(run_dir, "restoration_stage_changed")
        divergence = pipeline.read_events(run_dir, "event_log_divergence")
        assert divergence
        meta = divergence[-1]["metadata"]
        assert meta["imported_jsonl_to_sqlite"] >= 1

    def test_sqlite_to_jsonl_reexport(self, pipeline):
        """AC-048: SQLite rows missing from events.jsonl are re-exported."""
        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        run_dir = pipeline._find_run_dir(pid)
        (run_dir / "events.jsonl").unlink()  # lose the JSONL copy entirely
        report = reconcile_run_state(pipeline, run_dir)
        assert report["divergence"]["exported"] >= 1
        lines = (run_dir / "events.jsonl").read_text().strip().splitlines()
        assert lines, "events.jsonl not re-exported"

    def test_rotation_max_five_kept(self, pipeline):
        """FR-028: rotation at the byte cap, max 5 rotated files retained."""
        pipeline.config["events_jsonl_max_bytes"] = 120
        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        run_dir = pipeline._find_run_dir(pid)
        for i in range(30):
            pipeline.write_event(run_dir, pid, "intake_upload", "operator", {"i": i, "pad": "x" * 40})
        rotated = sorted(run_dir.glob("events.*.jsonl"))
        assert rotated, "no rotated files produced"
        assert len(rotated) <= 5, f"expected ≤5 rotated files, found {len(rotated)}"
        assert (run_dir / "events.jsonl").exists()


class TestStaleLockCleanup:
    def test_dead_pid_lock_removed(self, pipeline, tmp_path):
        """FR-068/AC-054: a lock file whose recorded PID is dead is removed."""
        from orchestrator.core.restoration_pipeline import cleanup_stale_locks
        import os

        lock = pipeline.runs_root / ".restoration_index.lock"
        lock.write_text("99999999")  # implausible live PID
        cleared = cleanup_stale_locks(pipeline.runs_root)
        assert str(lock) in cleared
        assert not lock.exists()
        # live PID lock is kept
        lock.write_text(str(os.getpid()))
        cleared = cleanup_stale_locks(pipeline.runs_root)
        assert cleared == []
        assert lock.exists()
