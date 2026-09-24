"""AC-006 (ruling bands, null-cost handling, INSUFFICIENT_DATA),
AC-007 (override rules), FR-010 (60/30/10 allocation), AC-045 (API cost
ceiling), AC-034 (API cost visibility), AC-026 (cost gate math)."""

import pytest


def _manifest(client, project_id, entries):
    pipeline = client.app.pipeline
    run_dir = pipeline._find_run_dir(project_id)
    doc = {"version": 1, "locked": True, "automation_coverage_pct": 80.0, "entries": entries}
    pipeline._write_json(run_dir / "manifest.json", doc)
    data = pipeline._read_json(run_dir / "project.json")
    data["status"] = "manifest_locked"
    pipeline._write_json(run_dir / "project.json", data)


def _entry(pid, cost, criticality="standard", name=None):
    return {
        "part_id": pid,
        "name": name or pid,
        "oem_number": None,
        "aftermarket_alternatives": [],
        "quantity": 1,
        "criticality": criticality,
        "estimated_cost_usd": cost,
        "sourcing_status": "pending",
        "confidence": 0.9,
        "requires_review": False,
    }


class TestBudgetRuling:
    def test_affordable_tight_shortfall_bands(self, authed_client, project_id):
        _manifest(authed_client, project_id, [_entry("p1", 100.0), _entry("p2", 100.0)])
        # total 200; ceiling 500 → 40% ≤ 80% → AFFORDABLE
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 500.0}
        )
        assert res.status == 200
        assert res.json()["ruling"] == "AFFORDABLE"
        # ceiling 230 → 87% → TIGHT (re-ruled from budget_ruled state via direct recompute)
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        data = pipeline._read_json(run_dir / "project.json")
        data["status"] = "manifest_locked"
        pipeline._write_json(run_dir / "project.json", data)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 230.0}
        )
        assert res.json()["ruling"] == "TIGHT"
        data = pipeline._read_json(run_dir / "project.json")
        data["status"] = "manifest_locked"
        pipeline._write_json(run_dir / "project.json", data)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 150.0}
        )
        assert res.json()["ruling"] == "SHORTFALL_CRITICAL"

    def test_boundary_exact_80pct_affordable(self, authed_client, project_id):
        _manifest(authed_client, project_id, [_entry("p1", 200.0)])
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 250.0}
        )
        assert res.json()["ruling"] == "AFFORDABLE"  # 200 ≤ 0.8×250

    def test_null_costs_excluded_not_zeroed(self, authed_client, project_id):
        entries = [_entry("p1", 100.0), _entry("p2", None), _entry("p3", None)]
        _manifest(authed_client, project_id, entries)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 500.0}
        )
        body = res.json()
        assert body["detail"]["total_estimated_cost_usd"] == 100.0  # nulls excluded
        assert body["unknown_cost_count"] == 2
        # 2/3 unknown > 30% → INSUFFICIENT_DATA
        assert body["ruling"] == "INSUFFICIENT_DATA"

    def test_insufficient_data_precedence(self, authed_client, project_id):
        entries = [_entry("p1", 10000.0), _entry("p2", None), _entry("p3", None), _entry("p4", None)]
        _manifest(authed_client, project_id, entries)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 100.0}
        )
        # would be SHORTFALL by sum, but >30% unknown wins
        assert res.json()["ruling"] == "INSUFFICIENT_DATA"

    def test_invalid_budget_400(self, authed_client, project_id):
        _manifest(authed_client, project_id, [_entry("p1", 1.0)])
        assert (
            authed_client.post(
                f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": -5}
            ).status
            == 400
        )
        assert (
            authed_client.post(
                f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": "lots"}
            ).status
            == 400
        )


class TestPerPartAllocation:
    def test_60_30_10_formula(self, authed_client, project_id):
        """FR-010 worked example: $5000, 10 critical, 20 standard, 5 optional
        → $300 / $75 / $100."""
        entries = (
            [_entry(f"c{i}", 1.0, "critical") for i in range(10)]
            + [_entry(f"s{i}", 1.0, "standard") for i in range(20)]
            + [_entry(f"o{i}", 1.0, "optional") for i in range(5)]
        )
        _manifest(authed_client, project_id, entries)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 5000.0}
        )
        alloc = res.json()["detail"]["per_part_allocation"]
        assert alloc["critical"] == 300.0
        assert alloc["standard"] == 75.0
        assert alloc["optional"] == 100.0

    def test_empty_tier_redistributed(self, authed_client, project_id):
        entries = [_entry("c1", 1.0, "critical"), _entry("s1", 1.0, "standard")]
        _manifest(authed_client, project_id, entries)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 900.0}
        )
        alloc = res.json()["detail"]["per_part_allocation"]
        assert "optional" not in alloc
        # 0.6/0.9 × 900 = 600 critical; 0.3/0.9 × 900 = 300 standard
        assert alloc["critical"] == 600.0
        assert alloc["standard"] == 300.0


class TestBudgetOverride:
    def test_override_only_from_shortfall_or_insufficient(self, authed_client, project_id):
        _manifest(authed_client, project_id, [_entry("p1", 100.0)])
        authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 500.0}
        )
        # AFFORDABLE → override refused (AC-007)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget/override", json={"reason": "nope"}
        )
        assert res.status == 409

    def test_override_from_shortfall_writes_audit(self, authed_client, project_id):
        _manifest(authed_client, project_id, [_entry("p1", 1000.0)])
        authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 100.0}
        )
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget/override",
            json={"reason": "panel price increase"},
        )
        assert res.status == 200
        record = res.json()["override_record"]
        assert record["reason"] == "panel price increase"
        assert record["actor"] == "operator"
        assert record["timestamp"]
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        budget = pipeline._read_json(run_dir / "budget.json")
        assert budget["overridden"] is True
        assert budget["override_audit"][0]["reason"] == "panel price increase"

    def test_override_requires_reason(self, authed_client, project_id):
        _manifest(authed_client, project_id, [_entry("p1", 1000.0)])
        authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 100.0}
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/budget/override", json={})
        assert res.status == 400


class TestAPICostCeiling:
    def test_tracking_and_summary(self, authed_client, project_id):
        """AC-034: api_costs rows sum to project field; endpoint shape."""
        pipeline = authed_client.app.pipeline
        pipeline.log_api_cost(project_id, "llm", "vision", 1.50, "identify")
        pipeline.log_api_cost(project_id, "bfl", "image_generation", 5.00, "render")
        pipeline.log_api_cost(project_id, "bfl", "image_generation", 5.00, "render2")
        res = authed_client.get(f"/restoration/projects/{project_id}/api-costs")
        assert res.status == 200
        body = res.json()
        assert body["total"] == 11.50
        assert body["per_provider"]["bfl"] == 10.0
        assert body["ceiling"] == 100.0
        assert body["pct_of_ceiling"] == 11.5
        project = authed_client.get(f"/restoration/projects/{project_id}").json()
        assert project["api_cost_to_date_usd"] == 11.50

    def test_80pct_warning_event(self, authed_client, project_id):
        pipeline = authed_client.app.pipeline
        pipeline.log_api_cost(project_id, "llm", "vision", 80.0, "big job")
        run_dir = pipeline._find_run_dir(project_id)
        events = pipeline.read_events(run_dir, "api_cost_ceiling_warning")
        assert events, "api_cost_ceiling_warning not written at 80%"

    def test_100pct_blocks_new_tasks_then_override(self, authed_client, project_id):
        """AC-045: at 100% new API-incurring tasks 409; override unblocks."""
        pipeline = authed_client.app.pipeline
        pipeline.log_api_cost(project_id, "llm", "vision", 100.0, "maxed")
        # identify is an API-incurring task
        res = authed_client.post(f"/restoration/projects/{project_id}/identify")
        assert res.status == 409
        assert "API cost ceiling reached" in res.json()["message"]
        run_dir = pipeline._find_run_dir(project_id)
        events = pipeline.read_events(run_dir, "api_cost_ceiling_reached")
        assert events
        # override
        res = authed_client.post(
            f"/restoration/projects/{project_id}/api-cost/override",
            json={"reason": "client approved"},
        )
        assert res.status == 200
        events = pipeline.read_events(run_dir, "api_cost_ceiling_overridden")
        assert events and events[0]["metadata"]["reason"] == "client approved"
        project = pipeline.get_project(project_id)
        assert project.api_cost_override_reason == "client approved"
        # after override the API gate opens again (202 — task is accepted)
        # seed photos so the identify task itself can run
        from .conftest import upload_six_photos

        upload_six_photos(authed_client, project_id)
        authed_client.post(f"/restoration/projects/{project_id}/intake/seal")
        res = authed_client.post(f"/restoration/projects/{project_id}/identify")
        assert res.status == 202
