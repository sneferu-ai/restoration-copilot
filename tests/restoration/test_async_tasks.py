"""FR-056 (async tasks, resume), AC-056 (resume preserves task_id),
AC-031 (non-blocking note — threaded mode), AC-012 (restart interrupt)."""

import json
import time

import pytest

from orchestrator.core.restoration_models import TaskType
from orchestrator.core.restoration_pipeline import RestorationPipeline

from .conftest import upload_six_photos


@pytest.fixture
def pipeline_threaded(tmp_path):
    # threaded (non-inline) task execution
    return RestorationPipeline(runs_root=tmp_path / "runs", config={"tasks_inline": False})


class TestTaskLifecycle:
    def test_inline_task_completes(self, pipeline):
        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        calls = []

        def runner(ctx):
            calls.append(ctx.task_id)
            ctx.progress(50.0)
            return {"did": "work"}

        pipeline.register_runner(TaskType.IDENTIFY, runner)
        # bypass seal guard by seeding 6 photos via intake upload
        for i in range(6):
            pipeline.intake_upload(pid, [(f"p{i}.jpg", b"\xff\xd8\xff\xe0" + bytes([i]) * 8)])
        pipeline.transition(pid, "intake_sealed")
        out = pipeline.start_task(pid, TaskType.IDENTIFY)
        task = pipeline.get_task(out["task_id"])
        assert task["status"] == "completed"
        assert task["progress_pct"] == 100.0
        assert calls == [out["task_id"]]

    def test_resume_preserves_task_id_and_records_resumed_from(self, pipeline):
        """AC-056."""
        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        attempts = []

        def flaky(ctx):
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("boom")
            return {"ok": True}

        pipeline.register_runner(TaskType.IDENTIFY, flaky)
        for i in range(6):
            pipeline.intake_upload(pid, [(f"p{i}.jpg", b"\xff\xd8\xff\xe0" + bytes([i]) * 8)])
        pipeline.transition(pid, "intake_sealed")
        out = pipeline.start_task(pid, TaskType.IDENTIFY)
        task = pipeline.get_task(out["task_id"])
        assert task["status"] == "failed"
        assert "boom" in task["error"]
        # resume: same task_id, resumed_from recorded, completes
        resumed = pipeline.resume_task(out["task_id"])
        assert resumed["task_id"] == out["task_id"]
        task = pipeline.get_task(out["task_id"])
        assert task["status"] == "completed"
        assert task["resumed_from"] is not None
        assert len(attempts) == 2

    def test_resume_running_task_409(self, authed_client, project_id):
        pipeline = authed_client.app.pipeline
        upload_six_photos(authed_client, project_id)
        authed_client.post(f"/restoration/projects/{project_id}/intake/seal")
        # the inline identify task completed; resume is invalid for completed
        run_dir = pipeline._find_run_dir(project_id)
        from orchestrator.core.restoration_pipeline import _rows

        rows = _rows(run_dir / "restoration.db", "SELECT task_id FROM tasks")
        assert rows
        res = authed_client.post(f"/restoration/tasks/{rows[0]['task_id']}/resume")
        assert res.status == 409

    def test_threaded_task_non_blocking_and_poll(self, pipeline_threaded):
        """AC-031: with threaded execution, start returns immediately and the
        task is pollable while running."""
        pipeline = pipeline_threaded
        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        started = time.monotonic()

        def slow(ctx):
            time.sleep(0.4)
            ctx.progress(50.0)
            time.sleep(0.4)
            return {"slow": True}

        pipeline.register_runner(TaskType.IDENTIFY, slow)
        for i in range(6):
            pipeline.intake_upload(pid, [(f"p{i}.jpg", b"\xff\xd8\xff\xe0" + bytes([i]) * 8)])
        pipeline.transition(pid, "intake_sealed")
        t0 = time.monotonic()
        out = pipeline.start_task(pid, TaskType.IDENTIFY)
        launch_s = time.monotonic() - t0
        assert launch_s < 0.3, f"start_task blocked {launch_s:.2f}s"
        seen_running = False
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            task = pipeline.get_task(out["task_id"])
            if task["status"] == "running":
                seen_running = True
            if task["status"] == "completed":
                break
            time.sleep(0.05)
        assert seen_running
        assert pipeline.get_task(out["task_id"])["status"] == "completed"

    def test_restart_marks_running_interrupted(self, pipeline):
        """AC-012/FR-029: a task left 'running' (crash) reconciles to interrupted."""
        from orchestrator.core.restoration_reconcile import reconcile_run_state
        from orchestrator.core.restoration_pipeline import _execute

        res = pipeline.create_project({"make": "Chevrolet"})
        pid = res["project_id"]
        run_dir = pipeline._find_run_dir(pid)
        _execute(
            run_dir / "restoration.db",
            "INSERT INTO tasks (task_id, project_id, task_type, status, progress_pct, created_at, updated_at)"
            " VALUES ('t-crash', ?, 'identify', 'running', 42, '2026-01-01', '2026-01-01')",
            (pid,),
        )
        report = reconcile_run_state(pipeline, run_dir)
        assert "running_tasks_marked_interrupted" in report["discrepancies_fixed"]
        task = pipeline.get_task("t-crash")
        assert task["status"] == "interrupted"
        # resume works after interrupt
        pipeline.register_runner(TaskType.IDENTIFY, lambda ctx: {"recovered": True})
        out = pipeline.resume_task("t-crash")
        assert out["task_id"] == "t-crash"
        assert pipeline.get_task("t-crash")["status"] == "completed"
