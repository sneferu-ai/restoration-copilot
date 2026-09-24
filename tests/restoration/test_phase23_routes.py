"""Tests for Phase 2-3 routes: sourcing hunt, KB management, source registry
CRUD, provider management (FR-066), and mechanic flags (FR-054).

These tests exercise the HTTP layer end-to-end through the in-process WSGI
client, covering the routes added after the partner's Round 1 delivery.
"""

import json
import time
import uuid

import pytest

from orchestrator.core.restoration_models import TaskType
from orchestrator.core.restoration_pipeline import (
    RestorationPipeline,
    _execute,
    _rows,
    _status_str,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _seed_project_to_hunting(client, project_id, parts=None):
    """Write a manifest + budget + set project status to HUNTING."""
    pipeline = client.app.pipeline
    run_dir = pipeline._find_run_dir(project_id)
    parts = parts or [
        ("p1", "critical"),
        ("p2", "standard"),
    ]
    entries = [
        {
            "part_id": pid,
            "name": pid,
            "oem_number": None,
            "aftermarket_alternatives": [],
            "quantity": 1,
            "criticality": crit,
            "estimated_cost_usd": 10.0,
            "sourcing_status": "pending",
            "confidence": 0.9,
            "requires_review": False,
        }
        for pid, crit in parts
    ]
    pipeline._write_json(
        run_dir / "manifest.json",
        {"version": 1, "locked": True, "automation_coverage_pct": 100.0, "entries": entries},
    )
    pipeline._write_json(
        run_dir / "budget.json",
        {
            "budget_ceiling_usd": 5000.0,
            "per_part_allocation": {pid: 500.0 for pid, _ in parts},
            "detail": {
                "per_part_allocation": {pid: 500.0 for pid, _ in parts},
                "total_estimated": sum(500.0 for _ in parts),
                "ceiling": 5000.0,
            },
        },
    )
    data = pipeline._read_json(run_dir / "project.json")
    data["status"] = "hunting"
    pipeline._write_json(run_dir / "project.json", data)
    return run_dir


def _pipeline_get_project(client, project_id):
    """Helper to get the raw project dict."""
    pipeline = client.app.pipeline
    run_dir = pipeline._find_run_dir(project_id)
    return pipeline._read_json(run_dir / "project.json")


# ---------------------------------------------------------------------------
# sourcing hunt (FR-012/FR-013/FR-038/FR-070)
# ---------------------------------------------------------------------------


class TestSourcingHunt:
    def test_start_sourcing_completes_in_sandbox(self, authed_client, project_id):
        """POST /source starts a sourcing hunt. In sandbox (no bridge) all parts
        get no_vendor_response unsourceable flags, coverage is 0%."""
        _seed_project_to_hunting(authed_client, project_id)
        res = authed_client.post(f"/restoration/projects/{project_id}/source")
        assert res.status == 202, res.body
        task_id = res.json()["task_id"]

        # tasks_inline=True → the task runs synchronously and is already done
        pipeline = authed_client.app.pipeline
        for _ in range(50):
            t = pipeline.get_task(task_id)
            if t["status"] in ("completed", "failed"):
                break
            time.sleep(0.1)

        t = pipeline.get_task(task_id)
        assert t["status"] == "completed", f"task not completed: {t}"

        # Verify coverage shows 0% system (no bridge in sandbox)
        coverage = pipeline.compute_coverage(project_id)
        assert coverage["system_coverage"] == 0.0

    def test_start_sourcing_no_manifest(self, authed_client, project_id):
        """POST /source without a manifest → task fails with no_manifest error."""
        # project is in INTAKE phase, no manifest → runner raises 409
        res = authed_client.post(f"/restoration/projects/{project_id}/source")
        assert res.status == 202  # task created
        task_id = res.json()["task_id"]
        pipeline = authed_client.app.pipeline
        for _ in range(50):
            t = pipeline.get_task(task_id)
            if t["status"] in ("completed", "failed"):
                break
            time.sleep(0.1)
        t = pipeline.get_task(task_id)
        assert t["status"] == "failed"
        assert "no_manifest" in (t.get("error") or "") or "Manifest" in (t.get("error") or "")

    def test_seal_hunt(self, authed_client, project_id):
        """POST /sourcing/seal transitions to HUNT_SEALED."""
        _seed_project_to_hunting(authed_client, project_id)
        # Add a manual candidate so there's at least one sourced part
        authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/manual",
            json={"part_id": "p1", "vendor": "NAPA", "price_usd": 50.0, "condition": "new"},
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/sourcing/seal")
        assert res.status == 200, res.body
        assert res.json()["status"] == "hunt_sealed"
        project = _pipeline_get_project(authed_client, project_id)
        assert _status_str(project["status"]) == "hunt_sealed"

    def test_seal_hunt_insufficient_coverage(self, authed_client, project_id):
        """POST /sourcing/seal with zero coverage → SOURCING_INSUFFICIENT."""
        _seed_project_to_hunting(authed_client, project_id)
        res = authed_client.post(f"/restoration/projects/{project_id}/sourcing/seal")
        assert res.status == 200, res.body
        assert res.json()["status"] == "sourcing_insufficient"
        project = _pipeline_get_project(authed_client, project_id)
        assert _status_str(project["status"]) == "sourcing_insufficient"

    def test_pause_hunt(self, authed_client, project_id):
        """POST /sourcing/pause pauses the hunt."""
        _seed_project_to_hunting(authed_client, project_id, parts=[("p1", "critical")])
        res = authed_client.post(f"/restoration/projects/{project_id}/sourcing/pause")
        assert res.status == 200, res.body
        assert res.json()["status"] == "paused"

    def test_sourcing_summary_returns_flags(self, authed_client, project_id):
        """GET /sourcing returns actual unsourceable flags, not hardcoded []."""
        _seed_project_to_hunting(authed_client, project_id)
        # Run the sourcing hunt (sandbox → all parts get no_vendor_response)
        authed_client.post(f"/restoration/projects/{project_id}/source")
        # Add a manual candidate for p1 so it has coverage
        authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/manual",
            json={"part_id": "p1", "vendor": "NAPA", "price_usd": 50.0, "condition": "new"},
        )
        res = authed_client.get(f"/restoration/projects/{project_id}/sourcing")
        assert res.status == 200, res.body
        body = res.json()
        assert "flags" in body
        # p2 has no candidate and no unsourceable flag with fabrication ref →
        # should appear in flags
        flag_part_ids = [f.get("part_id") for f in body["flags"]]
        assert "p2" in flag_part_ids


# ---------------------------------------------------------------------------
# KB management (FR-056)
# ---------------------------------------------------------------------------


_KB_ENTRY_PAYLOAD = {
    "part_id": "test-kb-001",
    "name": "Brake Caliper",
    "oem_number": "TEST-OEM-001",
    "aftermarket_alternatives": ["ALT-A", "ALT-B"],
    "category": "brake",
    "criticality": "standard",
    "interchange": ["NAPA"],
    "indicative_price_range_usd": {"low": 50.0, "high": 100.0},
    "reference_dimensions_mm": {"diameter": 120.0},
}


class TestKBManagement:
    def test_add_and_list_kb_entry(self, authed_client):
        """POST /kb/entries adds an entry; GET /kb/entries lists it."""
        res = authed_client.post("/restoration/kb/entries", json=_KB_ENTRY_PAYLOAD)
        assert res.status == 201, res.body
        assert res.json()["part_id"] == "test-kb-001"

        res = authed_client.get("/restoration/kb/entries")
        assert res.status == 200
        entries = res.json()
        ids = [e.get("part_id") for e in entries]
        assert "test-kb-001" in ids

    def test_add_duplicate_kb_entry(self, authed_client):
        """POST /kb/entries with an existing part_id → 400."""
        authed_client.post("/restoration/kb/entries", json=_KB_ENTRY_PAYLOAD)
        res = authed_client.post("/restoration/kb/entries", json=_KB_ENTRY_PAYLOAD)
        assert res.status == 400
        assert res.json()["error"] == "duplicate_part_id"

    def test_update_kb_entry(self, authed_client):
        """PUT /kb/entries/{part_id} updates an entry."""
        authed_client.post("/restoration/kb/entries", json=_KB_ENTRY_PAYLOAD)
        updated = {**_KB_ENTRY_PAYLOAD, "oem_number": "NEW-OEM", "name": "Updated Caliper"}
        res = authed_client.put("/restoration/kb/entries/test-kb-001", json=updated)
        assert res.status == 200, res.body
        entries = authed_client.get("/restoration/kb/entries").json()
        entry = next(e for e in entries if e["part_id"] == "test-kb-001")
        assert entry["oem_number"] == "NEW-OEM"
        assert entry["name"] == "Updated Caliper"

    def test_delete_kb_entry(self, authed_client):
        """DELETE /kb/entries/{part_id} removes an entry."""
        payload = {**_KB_ENTRY_PAYLOAD, "part_id": "test-kb-del"}
        authed_client.post("/restoration/kb/entries", json=payload)
        res = authed_client.delete("/restoration/kb/entries/test-kb-del")
        assert res.status == 200, res.body
        entries = authed_client.get("/restoration/kb/entries").json()
        assert "test-kb-del" not in {e.get("part_id") for e in entries}

    def test_delete_nonexistent_kb_entry(self, authed_client):
        """DELETE /kb/entries/{unknown} → 404."""
        res = authed_client.delete("/restoration/kb/entries/nonexistent-xyz")
        assert res.status == 404

    def test_approve_kb_proposal(self, authed_client, project_id):
        """POST /kb/approve promotes a proposed entry to confirmed."""
        # Create a KB proposal in the DB (as the research primitive would)
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        proposal_payload = {
            "part_id": "test-prop-001",
            "name": "Proposed Part",
            "oem_number": "PROP-OEM",
            "aftermarket_alternatives": [],
            "category": "engine",
            "criticality": "standard",
            "interchange": [],
        }
        proposal_id = uuid.uuid4().hex
        _execute(
            pipeline._db_path(run_dir),
            "INSERT INTO kb_proposals (proposal_id, project_id, payload, status, created_at)"
            " VALUES (?,?,?,?,?)",
            (proposal_id, project_id, json.dumps(proposal_payload), "pending",
             pipeline._read_json(run_dir / "project.json").get("created_at", "")),
        )
        res = authed_client.post(
            "/restoration/kb/approve",
            json={"proposal_id": proposal_id},
        )
        assert res.status == 200, res.body
        assert res.json()["entry"]["part_id"] == "test-prop-001"

    def test_approve_nonexistent_proposal(self, authed_client):
        """POST /kb/approve with unknown proposal_id → 404."""
        res = authed_client.post(
            "/restoration/kb/approve",
            json={"proposal_id": "nonexistent-xyz"},
        )
        assert res.status == 404


# ---------------------------------------------------------------------------
# Source registry CRUD (FR-012)
# ---------------------------------------------------------------------------


_SOURCE_PAYLOAD = {
    "source_id": "test-src-001",
    "vendor_name": "Test Vendor",
    "url": "https://example.com",
    "search_template": "https://example.com/search?q={part_name}",
    "specialty": "test parts",
    "is_trade_partner": False,
    "rate_limit_seconds": 2,
}


class TestSourceRegistryCRUD:
    def test_add_and_list_source(self, authed_client):
        """POST /restoration/sources adds a source; GET /restoration/sources lists it."""
        res = authed_client.post("/restoration/sources", json=_SOURCE_PAYLOAD)
        assert res.status == 201, res.body
        assert res.json()["source_id"] == "test-src-001"

        res = authed_client.get("/restoration/sources")
        assert res.status == 200
        ids = [s["source_id"] for s in res.json()]
        assert "test-src-001" in ids

    def test_add_duplicate_source(self, authed_client):
        """POST /restoration/sources with existing source_id → 400."""
        authed_client.post("/restoration/sources", json=_SOURCE_PAYLOAD)
        res = authed_client.post("/restoration/sources", json=_SOURCE_PAYLOAD)
        assert res.status == 400
        assert res.json()["error"] == "duplicate_source_id"

    def test_update_source(self, authed_client):
        """PUT /restoration/sources/{id} updates a source."""
        authed_client.post("/restoration/sources", json=_SOURCE_PAYLOAD)
        res = authed_client.put(
            "/restoration/sources/test-src-001",
            json={
                "vendor_name": "New Name",
                "url": "https://new.com",
                "search_template": "https://new.com/search?q={part_name}",
                "specialty": "new spec",
                "is_trade_partner": True,
                "rate_limit_seconds": 5,
            },
        )
        assert res.status == 200, res.body
        sources = authed_client.get("/restoration/sources").json()
        src = next(s for s in sources if s["source_id"] == "test-src-001")
        assert src["vendor_name"] == "New Name"
        assert src["is_trade_partner"] is True

    def test_delete_source(self, authed_client):
        """DELETE /restoration/sources/{id} removes a source."""
        payload = {**_SOURCE_PAYLOAD, "source_id": "test-src-del"}
        authed_client.post("/restoration/sources", json=payload)
        res = authed_client.delete("/restoration/sources/test-src-del")
        assert res.status == 200, res.body
        sources = authed_client.get("/restoration/sources").json()
        assert "test-src-del" not in {s["source_id"] for s in sources}

    def test_delete_nonexistent_source(self, authed_client):
        """DELETE /restoration/sources/{unknown} → 404."""
        res = authed_client.delete("/restoration/sources/nonexistent-xyz")
        assert res.status == 404


# ---------------------------------------------------------------------------
# Provider management (FR-066)
# ---------------------------------------------------------------------------


class TestProviderManagement:
    def test_pause_provider(self, authed_client):
        """POST /provider/pause pauses a provider."""
        res = authed_client.post(
            "/restoration/provider/pause",
            json={"provider": "fireworks"},
        )
        assert res.status == 200, res.body
        assert res.json()["status"] == "paused"
        assert res.json()["provider"] == "fireworks"

    def test_resume_provider(self, authed_client):
        """POST /provider/resume resumes a paused provider."""
        authed_client.post("/restoration/provider/pause", json={"provider": "fireworks"})
        res = authed_client.post(
            "/restoration/provider/resume",
            json={"provider": "fireworks"},
        )
        assert res.status == 200, res.body
        assert res.json()["status"] == "resumed"

    def test_failover_provider(self, authed_client):
        """POST /provider/failover sets failover mode."""
        res = authed_client.post(
            "/restoration/provider/failover",
            json={"provider": "fireworks", "fallback": "baseten"},
        )
        assert res.status == 200, res.body
        assert res.json()["status"] == "failed_over"
        assert res.json()["fallback"] == "baseten"

    def test_recheck_provider(self, authed_client):
        """POST /provider/recheck checks provider health."""
        res = authed_client.post(
            "/restoration/provider/recheck",
            json={"provider": "fireworks"},
        )
        assert res.status == 200, res.body
        assert res.json()["status"] in ("healthy", "paused")

    def test_pause_missing_provider(self, authed_client):
        """POST /provider/pause without provider → 400."""
        res = authed_client.post("/restoration/provider/pause", json={})
        assert res.status == 400
        assert res.json()["error"] == "missing_field"


# ---------------------------------------------------------------------------
# Mechanic flags (FR-054)
# ---------------------------------------------------------------------------


_FLAG_PAYLOAD = {
    "assembly_id": "assembly-001",
    "step_index": 3,
    "problem_type": "wrong_part",
    "description": "This is the wrong brake caliper for this vehicle",
    "screenshot_path": None,
    "photo_path": None,
}


class TestMechanicFlags:
    def test_submit_and_list_flag(self, authed_client, project_id):
        """POST /flags submits a mechanic flag; GET /flags lists it."""
        _seed_project_to_hunting(authed_client, project_id)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/flags",
            json=_FLAG_PAYLOAD,
        )
        assert res.status == 201, res.body
        flag_id = res.json()["flag_id"]
        assert flag_id

        res = authed_client.get(f"/restoration/projects/{project_id}/flags")
        assert res.status == 200, res.body
        flags = res.json()
        assert len(flags) >= 1
        assert any(f["flag_id"] == flag_id for f in flags)

    def test_resolve_flag(self, authed_client, project_id):
        """POST /flags/{id}/resolve resolves a flag."""
        _seed_project_to_hunting(authed_client, project_id)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/flags",
            json=_FLAG_PAYLOAD,
        )
        flag_id = res.json()["flag_id"]

        res = authed_client.post(
            f"/restoration/projects/{project_id}/flags/{flag_id}/resolve",
            json={"resolution_notes": "Replaced with correct part from different vendor"},
        )
        assert res.status == 200, res.body
        assert res.json()["status"] == "resolved"
        assert "Replaced" in res.json()["resolution_notes"]

    def test_resolve_nonexistent_flag(self, authed_client, project_id):
        """POST /flags/{unknown}/resolve → 404."""
        _seed_project_to_hunting(authed_client, project_id)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/flags/nonexistent/resolve",
            json={"resolution_notes": "n/a"},
        )
        assert res.status == 404

    def test_submit_flag_invalid_state(self, authed_client, project_id):
        """POST /flags when project is in INTAKE → 409."""
        # project is in INTAKE phase (default)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/flags",
            json=_FLAG_PAYLOAD,
        )
        assert res.status == 409


class TestStandaloneBridgeHealth:
    def test_bridge_health_never_claims_an_absent_bridge(self, authed_client):
        """Standalone, vision and sourcing have no Sneferu bridge (the pipeline's
        dispatcher raises BridgeUnavailableError), so /bridge/health must not
        report them configured or healthy."""
        res = authed_client.get("/bridge/health")
        assert res.status == 200, res.body
        bridges = res.json()["bridges"]
        for name in ("vision", "sourcing"):
            assert bridges[name]["configured"] is False
            assert bridges[name]["healthy"] is False
        from orchestrator.core.research_primitives import BridgeUnavailableError

        with pytest.raises(BridgeUnavailableError):
            authed_client.app.pipeline._bridge_dispatcher("llm_search", {}, 1.0)
