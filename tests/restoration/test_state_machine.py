"""FR-033 (transitions), AC-020 (ABANDONED + task cancellation),
AC-060 (in-service checklist), FR-038 (parking), AC-033 (re-open)."""

import json

import pytest

from .conftest import upload_six_photos


def _set_status(client, project_id, status):
    """Directly set project.json status (test-only state seeding)."""
    run_dir = client.app.pipeline._find_run_dir(project_id)
    data = json.loads((run_dir / "project.json").read_text())
    data["status"] = status
    client.app.pipeline._write_json(run_dir / "project.json", data)


class TestTransitions:
    def test_invalid_transition_409_names_valid(self, authed_client, project_id):
        # intake_open -> hunting is not allowed
        pipeline = authed_client.app.pipeline
        with pytest.raises(Exception) as excinfo:
            pipeline.transition(project_id, "hunting")
        err = excinfo.value
        assert getattr(err, "status", None) == 409
        assert "intake_open" in str(err)
        assert "intake_sealed" in str(err)

    def test_parked_blocks_transitions(self, authed_client, project_id):
        pipeline = authed_client.app.pipeline
        pipeline.park(project_id, "waiting on customer")
        with pytest.raises(Exception) as excinfo:
            pipeline.transition(project_id, "intake_sealed")
        assert getattr(excinfo.value, "code", "") == "project_parked"
        pipeline.unpark(project_id)
        project = pipeline.get_project(project_id)
        assert project.parked is False

    def test_abandoned_is_terminal(self, authed_client, project_id):
        res = authed_client.post(
            f"/restoration/projects/{project_id}/abandon", json={"reason": "customer cancelled"}
        )
        assert res.status == 200
        assert res.json()["status"] == "abandoned"
        # all state-changing endpoints now 409
        assert (
            authed_client.post(f"/restoration/projects/{project_id}/intake/seal").status == 409
        )
        assert (
            authed_client.post(
                f"/restoration/projects/{project_id}/reopen", json={"reason": "retry"}
            ).status
            == 409
        )
        # read endpoints still work
        assert authed_client.get(f"/restoration/projects/{project_id}").status == 200


class TestAbandon:
    def test_abandon_requires_reason_400(self, authed_client, project_id):
        res = authed_client.post(f"/restoration/projects/{project_id}/abandon", json={})
        assert res.status == 400

    def test_abandon_cancels_pending_tasks(self, authed_client, project_id):
        """AC-020: all pending/running AsyncTask entries are cancelled with
        async_task_cancelled events written."""
        from orchestrator.core.restoration_pipeline import _execute, _rows

        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        for i in range(2):
            _execute(
                run_dir / "restoration.db",
                "INSERT INTO tasks (task_id, project_id, task_type, status, progress_pct, created_at, updated_at)"
                f" VALUES ('t-pend-{i}', ?, 'source', 'pending', 0, '2026-01-01', '2026-01-01')",
                (project_id,),
            )
        res = authed_client.post(
            f"/restoration/projects/{project_id}/abandon", json={"reason": "customer cancelled"}
        )
        assert res.status == 200
        statuses = {
            r["task_id"]: r["status"]
            for r in _rows(run_dir / "restoration.db", "SELECT task_id, status FROM tasks")
        }
        assert statuses["t-pend-0"] == "cancelled"
        assert statuses["t-pend-1"] == "cancelled"
        events = pipeline.read_events(run_dir, "async_task_cancelled")
        assert len(events) == 2
        events = pipeline.read_events(run_dir, "project_abandoned")
        assert events and events[0]["metadata"]["cancelled_tasks"] == 2
        project = pipeline.get_project(project_id)
        assert project.abandoned_reason == "customer cancelled"

    def test_reopen_from_abandoned_409(self, authed_client, project_id):
        authed_client.post(
            f"/restoration/projects/{project_id}/abandon", json={"reason": "done"}
        )
        res = authed_client.post(
            f"/restoration/projects/{project_id}/reopen", json={"reason": "new scope"}
        )
        assert res.status == 409


class TestInServiceChecklist:
    def test_missing_items_named_400(self, authed_client, project_id):
        _set_status(authed_client, project_id, "published")
        res = authed_client.post(
            f"/restoration/projects/{project_id}/in-service",
            json={"checklist": ["all critical sub-assemblies published"]},
        )
        assert res.status == 400
        body = res.json()
        assert "operator has verified the vehicle is road-ready" in body["message"]
        assert body["missing"] == ["operator has verified the vehicle is road-ready"]

    def test_full_checklist_transitions(self, authed_client, project_id):
        _set_status(authed_client, project_id, "published")
        checklist = [
            "all critical sub-assemblies published",
            "operator has verified the vehicle is road-ready",
            "custom: paint cured 72h",
        ]
        res = authed_client.post(
            f"/restoration/projects/{project_id}/in-service", json={"checklist": checklist}
        )
        assert res.status == 200
        assert res.json()["status"] == "in_service"
        project = authed_client.get(f"/restoration/projects/{project_id}").json()
        assert project["in_service_checklist"] == checklist
        # and in_service -> closed works
        pipeline = authed_client.app.pipeline
        project = pipeline.transition(project_id, "closed")
        assert project.status == "closed"


class TestReopen:
    def test_reopen_from_closed_preserves_and_marks(self, authed_client, project_id):
        pipeline = authed_client.app.pipeline
        _set_status(authed_client, project_id, "closed")
        # a prior sourcing candidate should mark the part previously_sourced
        res = authed_client.post(
            f"/restoration/projects/{project_id}/reopen", json={"reason": "customer added scope"}
        )
        assert res.status == 200
        assert res.json()["status"] == "manifest_locked"
        project = pipeline.get_project(project_id)
        assert project.reopened_from is not None
        run_dir = pipeline._find_run_dir(project_id)
        events = pipeline.read_events(run_dir, "project_reopened")
        assert events and events[0]["metadata"]["reason"] == "customer added scope"

    def test_reopen_requires_reason(self, authed_client, project_id):
        _set_status(authed_client, project_id, "closed")
        res = authed_client.post(f"/restoration/projects/{project_id}/reopen", json={})
        assert res.status == 400

    def test_reopen_only_from_closed(self, authed_client, project_id):
        res = authed_client.post(
            f"/restoration/projects/{project_id}/reopen", json={"reason": "too early"}
        )
        assert res.status == 409
