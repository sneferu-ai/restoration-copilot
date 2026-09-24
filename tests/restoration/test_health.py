"""AC-002 (functional health), AC-049 (os_supported=false behavior, FR-062)."""

import subprocess

import pytest

from orchestrator.core import restoration_pipeline as rp


class TestHealthEndpoint:
    def test_health_dynamic_fields(self, authed_client, project_id):
        res = authed_client.get("/restoration/health")
        assert res.status == 200
        body = res.json()
        assert body["module_loaded"] is True
        assert body["pipeline_route"] == "configured"
        assert body["os_supported"] is True
        assert body["active_projects"] == 1
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=str(rp.REPO_ROOT)
        ).stdout.strip()
        assert body["version"] == sha

    def test_health_active_projects_increments(self, authed_client, project_id):
        authed_client.post("/restoration/projects", json={"vehicle_meta": {"make": "Ford"}})
        res = authed_client.get("/restoration/health")
        assert res.json()["active_projects"] == 2

    def test_auth_required_on_operator_endpoints(self, client):
        # AC-013: unauthenticated access blocked
        assert client.get("/restoration/projects").status == 401
        assert client.post("/restoration/projects", json={"vehicle_meta": {}}).status == 401
        # ...while the operator console page itself is served
        assert client.get("/restoration-ui").status == 200


class TestOsUnsupported:
    def test_health_200_with_os_supported_false(self, authed_client, monkeypatch):
        monkeypatch.setattr(rp, "_FCNTL_OK", False)
        res = authed_client.get("/restoration/health")
        assert res.status == 200  # NOT 500 — FR-062
        body = res.json()
        assert body["os_supported"] is False
        assert body["module_loaded"] is True

    def test_project_creation_blocked_409(self, authed_client, monkeypatch):
        monkeypatch.setattr(rp, "_FCNTL_OK", False)
        res = authed_client.post("/restoration/projects", json={"vehicle_meta": {"make": "Ford"}})
        assert res.status == 409
        body = res.json()
        assert body["error"] == "os_not_supported"
        assert "Linux or macOS" in body["message"]
