"""AC-012 (custom injected status displays exactly; JSON+SQLite intact) and
static asset serving (nested module paths, traversal-proof)."""

import json

import pytest


class TestCustomStatusPersistence:
    def test_injected_status_displays_verbatim(self, authed_client, project_id):
        """AC-012 core: project.json injected with a status the enum does not
        know must still load and display — never a 500."""
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        data = json.loads((run_dir / "project.json").read_text())
        data["status"] = "PARKED_CUSTOM_TEST_123"
        data["parked"] = True
        pipeline._write_json(run_dir / "project.json", data)
        res = authed_client.get(f"/restoration/projects/{project_id}")
        assert res.status == 200
        assert res.json()["status"] == "PARKED_CUSTOM_TEST_123"
        assert res.json()["parked"] is True
        listing = authed_client.get("/restoration/projects").json()
        match = [p for p in listing if p["project_id"] == project_id]
        assert match and match[0]["status"] == "PARKED_CUSTOM_TEST_123"
        # transitions from an unknown state are refused with current named
        from orchestrator.core.restoration_pipeline import PipelineError

        data = json.loads((run_dir / "project.json").read_text())
        data["parked"] = False
        pipeline._write_json(run_dir / "project.json", data)
        with pytest.raises(PipelineError) as excinfo:
            pipeline.transition(project_id, "intake_sealed")
        assert excinfo.value.status == 409
        assert "PARKED_CUSTOM_TEST_123" in str(excinfo.value)


class TestStaticServing:
    def test_nested_module_paths(self, client):
        res = client.get("/static/restoration/restoration_copilot/shared.js")
        assert res.status == 200
        assert b"sessionToken" in res.body
        res = client.get("/static/restoration/bay_guide/guide_view.js")
        assert res.status == 200
        res = client.get("/static/restoration/restoration_styles.css")
        assert res.status == 200

    def test_traversal_refused(self, client):
        assert client.get("/static/restoration/../../../../etc/passwd").status == 404
        assert client.get("/static/restoration/..%2F..%2Fspec.md").status == 404
