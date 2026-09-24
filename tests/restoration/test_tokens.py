"""AC-019 (revoke / supersede / bulk revoke / extend / expired UX),
FR-039/040/041 (mint, rate limit, validation)."""

import pytest

from orchestrator.core.restoration_pipeline import _execute


def _mint(authed_client, project_id, assembly="brake_system"):
    res = authed_client.post(
        f"/restoration/projects/{project_id}/tokens",
        json={"assembly_id": assembly, "bundle_version": 1},
    )
    assert res.status == 201, res.body
    return res.json()


class TestTokenLifecycle:
    def test_mint_and_guide_200(self, authed_client, project_id):
        token = _mint(authed_client, project_id)
        assert len(token["token_id"]) >= 32
        res = authed_client.get(f"/guide/{token['token_id']}", token=None)
        assert res.status == 200
        # The guide is now served from the built React SPA (spec §2). The
        # bootstrap meta is injected server-side; the shell title is
        # "Restoration Guide" (replacing the legacy "Bay Guide" scaffold).
        assert b"Restoration Guide" in res.body
        assert b"__GUIDE_META__" in res.body
        assert b"brake_system" in res.body
        assert res.headers.get("referrer-policy") == "no-referrer"

    def test_revoke_returns_404(self, authed_client, project_id):
        token = _mint(authed_client, project_id)
        res = authed_client.delete(
            f"/restoration/projects/{project_id}/tokens/{token['token_id']}"
        )
        assert res.status == 200
        res = authed_client.get(f"/guide/{token['token_id']}", token=None)
        assert res.status == 404

    def test_superseded_serves_200_with_header(self, authed_client, project_id):
        """FR-040/OBL-30: superseded token → 200 + X-Guide-Superseded: true,
        old guide remains functional."""
        token = _mint(authed_client, project_id)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/tokens/{token['token_id']}/supersede"
        )
        assert res.status == 200
        res = authed_client.get(f"/guide/{token['token_id']}", token=None)
        assert res.status == 200  # NOT 404 — mechanic mid-procedure is not disrupted
        assert res.headers.get("x-guide-superseded") == "true"

    def test_bulk_revoke(self, authed_client, project_id):
        t1 = _mint(authed_client, project_id)
        t2 = _mint(authed_client, project_id)
        res = authed_client.delete(f"/restoration/projects/{project_id}/tokens")
        assert res.status == 200
        assert res.json()["revoked_count"] == 2
        assert authed_client.get(f"/guide/{t1['token_id']}", token=None).status == 404
        assert authed_client.get(f"/guide/{t2['token_id']}", token=None).status == 404

    def test_extend_keeps_token_string_moves_expiry(self, authed_client, project_id):
        token = _mint(authed_client, project_id)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/tokens/{token['token_id']}/extend",
            json={"extends_days": 30},
        )
        assert res.status == 200
        new_expiry = res.json()["token"]["expires_at"]
        assert new_expiry > token["expires_at"]
        # audit event written
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        events = pipeline.read_events(run_dir, "guide_token_extended")
        assert events
        # over-max extension rejected
        res = authed_client.post(
            f"/restoration/projects/{project_id}/tokens/{token['token_id']}/extend",
            json={"extends_days": 400},
        )
        assert res.status == 400

    def test_expired_token_410(self, authed_client, project_id):
        """FR-041/OBL-31: expired → 410 token_expired with contact message."""
        token = _mint(authed_client, project_id)
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        _execute(
            run_dir / "restoration.db",
            "UPDATE guide_tokens SET expires_at='2020-01-01T00:00:00+00:00' WHERE token_id=?",
            (token["token_id"],),
        )
        res = authed_client.get(f"/guide/{token['token_id']}", token=None)
        assert res.status == 410
        body = res.json()
        assert body["error"] == "token_expired"
        assert "Contact the shop operator" in body["message"]

    def test_invalid_token_404(self, authed_client, project_id):
        assert authed_client.get("/guide/not-a-real-token", token=None).status == 404

    def test_rate_limit_429(self, authed_client, project_id):
        """FR-041: 60 requests per token per hour → 429 beyond."""
        authed_client.app.pipeline.config["token_rate_limit_per_hour"] = 3
        token = _mint(authed_client, project_id)
        codes = [
            authed_client.get(f"/guide/{token['token_id']}", token=None).status for _ in range(5)
        ]
        assert 429 in codes
        assert codes[:3] == [200, 200, 200]
