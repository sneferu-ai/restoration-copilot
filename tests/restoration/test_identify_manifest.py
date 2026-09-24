"""AC-004 (content-dependent output + threshold routing), FR-005, AC-005
(review resolution + audit + denormalized category), FR-008 (lock + coverage
+ KB proposals), AC-029 (KB proposal from purchase)."""

import pytest

from .conftest import upload_six_photos

PARTS_CSV = (
    "part_name,quantity,oem_number\n"
    "Front Brake Caliper,1,5463628\n"
    "Radiator,1,\n"
    "brake floogle,1,\n"
    "zzxqw flobber,1,\n"
).encode()


def _seed_and_seal(client, project_id, parts_csv=PARTS_CSV):
    upload_six_photos(client, project_id)
    client.post(
        f"/restoration/projects/{project_id}/intake",
        multipart={"photos": [], "parts_list": ("parts.csv", parts_csv)},
    )
    res = client.post(f"/restoration/projects/{project_id}/intake/seal")
    assert res.status == 200


class TestIdentification:
    def test_manifest_content_dependent(self, authed_client):
        """AC-004 (lite): distinct parts lists → distinct manifests."""
        res1 = authed_client.post(
            "/restoration/projects",
            json={"vehicle_meta": {"year": "1969", "make": "Chevrolet", "model": "Camaro"}},
        )
        pid1 = res1.json()["project_id"]
        _seed_and_seal(authed_client, pid1)
        res2 = authed_client.post(
            "/restoration/projects",
            json={"vehicle_meta": {"year": "1965", "make": "Ford", "model": "Mustang"}},
        )
        pid2 = res2.json()["project_id"]
        other = b"part_name,quantity\nAlternator,1\nMuffler,1\n"
        _seed_and_seal(authed_client, pid2, other)
        m1 = authed_client.get(f"/restoration/projects/{pid1}/manifest").json()
        m2 = authed_client.get(f"/restoration/projects/{pid2}/manifest").json()
        names1 = {e["name"] for e in m1["entries"]}
        names2 = {e["name"] for e in m2["entries"]}
        assert names1 != names2
        assert "Alternator" in names2 and "Alternator" not in names1

    def test_threshold_routing_and_hallucination_flag(self, authed_client, project_id):
        """Parts below threshold or with out-of-taxonomy names route to
        review; confident in-taxonomy parts auto-accept (FR-004/U3)."""
        _seed_and_seal(authed_client, project_id)
        manifest = authed_client.get(f"/restoration/projects/{project_id}/manifest").json()
        by_name = {e["name"]: e for e in manifest["entries"]}
        # zzxqw flobber: unknown category → review regardless of confidence
        assert by_name["zzxqw flobber"]["requires_review"] is True
        # Front Brake Caliper: known taxonomy + high confidence → auto-accepted
        assert by_name["Front Brake Caliper"]["requires_review"] is False
        # brake floogle: taxonomy-matching but no KB entry → still auto-accepted
        assert by_name["brake floogle"]["requires_review"] is False
        # single enum sourcing_status, no separate booleans (FR-005)
        for entry in manifest["entries"]:
            assert entry["sourcing_status"] == "pending"

    def test_coverage_metric(self, authed_client, project_id):
        _seed_and_seal(authed_client, project_id)
        manifest = authed_client.get(f"/restoration/projects/{project_id}/manifest").json()
        # 3 of 4 auto-accepted → 75.0%
        assert manifest["automation_coverage_pct"] == pytest.approx(75.0, abs=0.2)


class TestReviewResolution:
    def test_resolve_writes_audit_and_feedback(self, authed_client, project_id):
        """AC-005: resolve succeeds only for review-queue parts; audit delta;
        feedback signal carries denormalized category."""
        _seed_and_seal(authed_client, project_id)
        manifest = authed_client.get(f"/restoration/projects/{project_id}/manifest").json()
        review_part = next(e for e in manifest["entries"] if e["requires_review"])
        res = authed_client.post(
            f"/restoration/projects/{project_id}/manifest/resolve",
            json={
                "part_id": review_part["part_id"],
                "name": "Front Brake Caliper",
                "condition": "deteriorated",
                "notes": "confirmed visually",
            },
        )
        assert res.status == 200
        body = res.json()
        assert body["entry"]["requires_review"] is False
        assert body["entry"]["condition"] == "deteriorated"
        assert body["audit_delta"], "no audit delta recorded"
        # review_log row
        reviews = authed_client.get(f"/restoration/projects/{project_id}/reviews").json()
        assert reviews
        assert reviews[0]["field_name"] in ("name", "condition")
        # feedback signal with denormalized category
        pipeline = authed_client.app.pipeline
        signals = pipeline.list_feedback(signal_type="identification_correction")
        assert signals
        sig = signals[0]
        assert sig["category"] == "brake"  # denormalized from manifest at creation
        assert sig["vehicle_make"] == "Chevrolet"
        assert sig["old_value"] == "zzxqw flobber"
        assert sig["new_value"] == "Front Brake Caliper"

    def test_resolve_unknown_part_404(self, authed_client, project_id):
        _seed_and_seal(authed_client, project_id)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/manifest/resolve",
            json={"part_id": "P999", "name": "x"},
        )
        assert res.status == 404

    def test_resolve_non_review_part_409(self, authed_client, project_id):
        _seed_and_seal(authed_client, project_id)
        manifest = authed_client.get(f"/restoration/projects/{project_id}/manifest").json()
        accepted = next(e for e in manifest["entries"] if not e["requires_review"])
        res = authed_client.post(
            f"/restoration/projects/{project_id}/manifest/resolve",
            json={"part_id": accepted["part_id"], "name": "x"},
        )
        assert res.status == 409


class TestManifestLock:
    def test_lock_transitions_and_proposes(self, authed_client, project_id):
        """FR-008: lock → MANIFEST_LOCKED, coverage written, KB proposals for
        confirmed parts with no KB entry (actual fields, no placeholders)."""
        _seed_and_seal(authed_client, project_id)
        res = authed_client.post(f"/restoration/projects/{project_id}/manifest/lock")
        assert res.status == 200
        body = res.json()
        assert body["manifest_version"] == 1
        project = authed_client.get(f"/restoration/projects/{project_id}").json()
        assert project["status"] == "manifest_locked"
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        manifest = pipeline._read_json(run_dir / "manifest.json")
        assert manifest["locked"] is True
        # KB proposals for entries with no KB pricing (Radiator has no OEM here)
        from orchestrator.core.restoration_pipeline import _rows

        proposals = _rows(run_dir / "restoration.db", "SELECT * FROM kb_proposals")
        assert proposals, "no KB proposals generated"
        import json as _json

        payload = _json.loads(proposals[0]["payload"])
        assert payload["name"]  # actual part name, never a placeholder

    def test_lock_then_budget_flow(self, authed_client, project_id):
        _seed_and_seal(authed_client, project_id)
        authed_client.post(f"/restoration/projects/{project_id}/manifest/lock")
        res = authed_client.post(
            f"/restoration/projects/{project_id}/budget", json={"budget_ceiling_usd": 5000.0}
        )
        assert res.status == 200
        assert res.json()["ruling"] in ("AFFORDABLE", "TIGHT", "SHORTFALL_CRITICAL", "INSUFFICIENT_DATA")
        project = authed_client.get(f"/restoration/projects/{project_id}").json()
        assert project["status"] == "budget_ruled"


class TestPurchaseProposal:
    def test_purchase_writes_signal_and_proposal(self, authed_client, project_id):
        """AC-029: purchase → purchase_outcome signal (vendor, price,
        denormalized category) + KB pricing proposal with actual fields."""
        _seed_and_seal(authed_client, project_id)
        manifest = authed_client.get(f"/restoration/projects/{project_id}/manifest").json()
        caliper = next(e for e in manifest["entries"] if e["name"] == "Front Brake Caliper")
        res = authed_client.post(
            f"/restoration/projects/{project_id}/purchase",
            json={"part_id": caliper["part_id"], "vendor": "NAPA", "price_usd": 89.99,
                  "condition": "new"},
        )
        assert res.status == 200
        pipeline = authed_client.app.pipeline
        signals = pipeline.list_feedback(signal_type="purchase_outcome")
        assert signals
        sig = signals[0]
        assert sig["vendor"] == "NAPA"
        assert sig["final_price_usd"] == 89.99
        assert sig["category"] == "brake"
        from orchestrator.core.restoration_pipeline import _rows

        run_dir = pipeline._find_run_dir(project_id)
        proposals = _rows(run_dir / "restoration.db", "SELECT * FROM kb_proposals")
        import json as _json

        pricing = [_json.loads(p["payload"]) for p in proposals if _json.loads(p["payload"])["kind"] == "pricing"]
        assert pricing
        assert pricing[0]["vendor"] == "NAPA"
        assert pricing[0]["observed_price_usd"] == 89.99
        assert pricing[0]["name"] == "Front Brake Caliper"
