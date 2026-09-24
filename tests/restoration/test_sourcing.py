"""AC-059 (negotiation state machine), AC-023 (coverage formulas FR-013),
AC-055 (global sourcing concurrency FR-069), AC-038 (manual-entry coverage
split), FR-042/FR-043."""

import json
import threading
import time

import pytest

from orchestrator.core import restoration_pipeline
from orchestrator.core.restoration_models import TaskType
from orchestrator.core.restoration_pipeline import RestorationPipeline, _execute, _rows


def _seed_manifest_with_parts(client, project_id, part_ids_criticalities):
    pipeline = client.app.pipeline
    run_dir = pipeline._find_run_dir(project_id)
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
        for pid, crit in part_ids_criticalities
    ]
    pipeline._write_json(
        run_dir / "manifest.json",
        {"version": 1, "locked": True, "automation_coverage_pct": 100.0, "entries": entries},
    )
    data = pipeline._read_json(run_dir / "project.json")
    data["status"] = "hunting"
    pipeline._write_json(run_dir / "project.json", data)


class TestNegotiationStateMachine:
    def _candidate(self, authed_client, project_id):
        res = authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/manual",
            json={"part_id": "p1", "vendor": "NAPA", "price_usd": 50.0, "condition": "new"},
        )
        assert res.status == 200
        return res.json()["candidate"]["candidate_id"]

    def test_valid_chain(self, authed_client, project_id):
        """AC-059: pending → negotiating → ordered → received, with
        ordered_at/final price and received-side effects."""
        cid = self._candidate(authed_client, project_id)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "negotiating"},
        )
        assert res.status == 200
        assert res.json()["record"]["status"] == "negotiating"
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "ordered", "final_price_usd": 45.0},
        )
        assert res.status == 200
        assert res.json()["record"]["final_price_usd"] == 45.0
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "received"},
        )
        assert res.status == 200
        # received → purchase_outcome feedback signal with vendor from candidate
        pipeline = authed_client.app.pipeline
        signals = pipeline.list_feedback(signal_type="purchase_outcome")
        assert signals
        assert signals[0]["vendor"] == "NAPA"
        assert signals[0]["final_price_usd"] == 45.0

    def test_ordered_requires_final_price_400(self, authed_client, project_id):
        cid = self._candidate(authed_client, project_id)
        authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "negotiating"},
        )
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "ordered"},
        )
        assert res.status == 400
        assert "final_price_usd" in res.json()["message"]

    def test_invalid_transitions_409_name_valid(self, authed_client, project_id):
        cid = self._candidate(authed_client, project_id)
        # pending → received is invalid
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "received"},
        )
        assert res.status == 409
        body = res.json()
        assert body["current"] == "pending"
        assert body["valid_next"] == ["negotiating"]
        # drive to received, then received → negotiating is invalid
        authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "negotiating"},
        )
        authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "ordered", "final_price_usd": 45.0},
        )
        authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "received"},
        )
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "negotiating"},
        )
        assert res.status == 409
        assert set(res.json()["valid_next"]) == {"disputed", "returned"}

    def test_passed_terminal_with_notes(self, authed_client, project_id):
        cid = self._candidate(authed_client, project_id)
        authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "negotiating"},
        )
        # notes required for passed
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "passed"},
        )
        assert res.status == 400
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "passed", "notes": "price too high"},
        )
        assert res.status == 200
        # terminal: no further transitions
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "ordered", "final_price_usd": 1.0},
        )
        assert res.status == 409
        assert res.json()["valid_next"] == []

    def test_disputed_roundtrip(self, authed_client, project_id):
        cid = self._candidate(authed_client, project_id)
        for status, extra in (
            ("negotiating", {}),
            ("ordered", {"final_price_usd": 45.0}),
            ("received", {}),
            ("disputed", {}),
        ):
            res = authed_client.post(
                f"/restoration/projects/{project_id}/negotiation",
                json={"part_id": "p1", "candidate_id": cid, "status": status, **extra},
            )
            assert res.status == 200, (status, res.body)
        # disputed → received (resolved positively)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/negotiation",
            json={"part_id": "p1", "candidate_id": cid, "status": "received"},
        )
        assert res.status == 200


class TestCoverageFormulas:
    def test_system_vs_total_vs_critical(self, authed_client, project_id):
        """AC-023/AC-038: system_coverage excludes unstructured_lead and
        manual_entry; total includes manual_entry; fabrication-ref flags count."""
        _seed_manifest_with_parts(
            authed_client,
            project_id,
            [("p-crit", "critical"), ("p-std", "standard"), ("p-opt", "optional"), ("p-fab", "standard")],
        )
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        # system-discovered on the critical part
        _execute(
            run_dir / "restoration.db",
            "INSERT INTO sourcing_candidates (project_id, part_id, candidate_id, vendor, price_usd,"
            " condition, availability, provenance, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (project_id, "p-crit", "c1", "Hemmings", 100.0, "used", "in_stock", "source_registry",
             "2026-08-01T00:00:00+00:00"),
        )
        # unstructured lead on the standard part (does NOT count as system)
        _execute(
            run_dir / "restoration.db",
            "INSERT INTO sourcing_candidates (project_id, part_id, candidate_id, vendor, price_usd,"
            " condition, availability, provenance, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (project_id, "p-std", "c2", "lead", None, "used", "in_stock", "unstructured_lead",
             "2026-08-01T00:00:00+00:00"),
        )
        # manual entry on the optional part (counts toward TOTAL only)
        authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/manual",
            json={"part_id": "p-opt", "vendor": "Swap Meet", "price_usd": 20.0, "condition": "used"},
        )
        # fabrication-ref flag on p-fab (counts in both)
        _execute(
            run_dir / "restoration.db",
            "INSERT INTO unsourceable_flags (project_id, part_id, reason_code, alternative_suggestion,"
            " fabrication_reference_glb) VALUES (?,?,?,?,?)",
            (project_id, "p-fab", "discontinued", "fabricate", "fab/p-fab.glb"),
        )
        res = authed_client.get(f"/restoration/projects/{project_id}/sourcing")
        assert res.status == 200
        body = res.json()
        # system: p-crit + p-fab = 2/4 = 50.0 (lead + manual excluded)
        assert body["system_coverage"] == 50.0
        # total: p-crit + p-fab + p-opt = 3/4 = 75.0 (manual included)
        assert body["total_coverage"] == 75.0
        # critical path: p-crit covered → 100.0
        assert body["critical_coverage"] == 100.0
        assert body["total_parts"] == 4


class TestGlobalSourcingConcurrency:
    def test_three_running_fourth_queued(self, tmp_path):
        """AC-055: max 3 concurrent sourcing tasks globally; the 4th queues
        and starts when a slot frees; per-project limit is 1."""
        pipeline = RestorationPipeline(
            runs_root=tmp_path / "runs", config={"tasks_inline": False}
        )
        started = threading.Event()
        release = threading.Event()

        def slow_runner(ctx):
            started.set()
            release.wait(timeout=10)
            return {"done": ctx.project_id}

        pipeline.register_runner(TaskType.SOURCE, slow_runner)
        pids = []
        for i in range(4):
            res = pipeline.create_project({"make": f"M{i}"})
            pid = res["project_id"]
            run_dir = pipeline._find_run_dir(pid)
            data = pipeline._read_json(run_dir / "project.json")
            data["status"] = "budget_ruled"
            pipeline._write_json(run_dir / "project.json", data)
            pids.append(pid)
        task_ids = []
        for pid in pids:
            out = pipeline.start_task(pid, TaskType.SOURCE)
            task_ids.append(out["task_id"])
        time.sleep(0.3)
        statuses = {tid: pipeline.get_task(tid)["status"] for tid in task_ids}
        assert list(statuses.values()).count("running") == 3, statuses
        assert list(statuses.values()).count("pending") == 1, statuses
        # per-project limit: a second hunt on project 1 → 409
        with pytest.raises(Exception) as excinfo:
            pipeline.start_task(pids[0], TaskType.SOURCE)
        assert getattr(excinfo.value, "code", "") == "sourcing_concurrency_limit"
        # free the slots → the queued task starts and all complete
        release.set()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            statuses = {tid: pipeline.get_task(tid)["status"] for tid in task_ids}
            if all(s == "completed" for s in statuses.values()):
                break
            time.sleep(0.1)
        assert all(s == "completed" for s in statuses.values()), statuses


# ---------------------------------------------------------------------------
# FR-070 hunt timeout + FR-037 insufficient-coverage transition + FR-005 sync
# ---------------------------------------------------------------------------


class _FakeClock:
    """Deterministic monotonic clock for the hunt-timeout seam."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def _fake_primitive(fake_clock, queried, per_query_s=3.0, found=True):
    """Mock research primitive: advances the fake clock per query and returns
    one registry candidate per part (or an unsourceable flag when found=False)."""

    def fake(query, sources, dispatcher, clock=None, per_query_timeout_s=30.0):
        queried.append(query.part_id)
        fake_clock.t += per_query_s
        if not found:
            return {
                "part_id": query.part_id,
                "candidates": [],
                "unsourceable": {
                    "reason_code": "no_vendor_response",
                    "alternative_suggestion": "contact specialty rebuilder",
                    "fabrication_reference_glb": None,
                },
                "errors": [],
            }
        return {
            "part_id": query.part_id,
            "candidates": [
                {
                    "part_id": query.part_id,
                    "candidate_id": f"cand-{query.part_id}",
                    "vendor": "TestVendor",
                    "oem_number": query.oem_number,
                    "price_usd": 10.0,
                    "condition": "used",
                    "availability": "in_stock",
                    "region": "US",
                    "url_or_contact": "https://example.test/part",
                    "tradeable": False,
                    "provenance": "source_registry",
                    "fetched_at": None,
                    "trade_partner_id": None,
                }
            ],
            "unsourceable": None,
            "errors": [],
        }

    return fake


def _project_status(pipeline, project_id):
    run_dir = pipeline._find_run_dir(project_id)
    return json.loads((run_dir / "project.json").read_text())["status"]


def _events(pipeline, project_id, event_type):
    run_dir = pipeline._find_run_dir(project_id)
    return _rows(
        run_dir / "restoration.db",
        "SELECT * FROM events WHERE project_id=? AND event_type=?",
        (project_id, event_type),
    )


def _candidates(pipeline, project_id):
    run_dir = pipeline._find_run_dir(project_id)
    return _rows(
        run_dir / "restoration.db",
        "SELECT * FROM sourcing_candidates WHERE project_id=?",
        (project_id,),
    )


class TestHuntTimeout:
    def test_timeout_partial_results_then_resume(self, authed_client, project_id, monkeypatch):
        """AC-057 (FR-070): hunt exceeding hunt_timeout_seconds halts with
        partial results, writes sourcing_hunt_timeout, transitions to
        SOURCING_INSUFFICIENT; POST /sourcing/resume returns 200 and sources
        the remaining parts without duplicating prior candidates."""
        pipeline = authed_client.app.pipeline
        parts = [(f"pt{i}", "standard") for i in range(5)]
        _seed_manifest_with_parts(authed_client, project_id, parts)
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        pipeline.config["hunt_timeout_seconds"] = 5.0
        queried = []
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, queried, per_query_s=3.0),
        )

        res = authed_client.post(f"/restoration/projects/{project_id}/source")
        assert res.status == 202, res.body
        task_id = res.json()["task_id"]

        # parts 1-2 processed (2×3s=6s ≥ 5s → halt before part 3)
        assert queried == ["pt0", "pt1"]
        cands = _candidates(pipeline, project_id)
        assert len(cands) == 2  # partial results preserved (>0, <5)
        # FR-070: the sourcing task transitions to completed carrying the
        # spec-named timeout_reached flag (not failed — partial results stand).
        task = pipeline.get_task(task_id)
        assert task["status"] == "completed", f"timeout task not completed: {task}"
        assert task["result"]["timeout_reached"] is True
        assert task["result"]["outcome"] == "timeout"
        # sourcing_hunt_timeout event written
        events = _events(pipeline, project_id, "sourcing_hunt_timeout")
        assert events, "sourcing_hunt_timeout event missing"
        meta = json.loads(events[0]["metadata"] or "{}")
        assert meta["parts_total"] == 5
        assert meta["parts_processed"] == 2
        assert meta["timeout_s"] == 5.0
        # project transitioned to SOURCING_INSUFFICIENT
        assert _project_status(pipeline, project_id) == "sourcing_insufficient"

        # operator resumes: 200, remaining parts sourced, no duplicates
        pipeline.config["hunt_timeout_seconds"] = 1000.0
        res = authed_client.post(f"/restoration/projects/{project_id}/sourcing/resume")
        assert res.status == 200, res.body
        assert res.json()["status"] == "resumed"
        assert queried == ["pt0", "pt1", "pt2", "pt3", "pt4"]
        cands = _candidates(pipeline, project_id)
        assert len(cands) == 5, f"resume duplicated or lost candidates: {len(cands)}"
        # full coverage → back to HUNTING awaiting the seal
        assert _project_status(pipeline, project_id) == "hunting"

    def test_resume_from_unrelated_state_409(self, authed_client, project_id):
        """Resume is only valid from HUNTING/SOURCING_INSUFFICIENT."""
        res = authed_client.post(f"/restoration/projects/{project_id}/sourcing/resume")
        assert res.status == 409


class TestSealPartialAcceptance:
    """FR-037: the seal action is re-offered at threshold OR on explicit partial
    acceptance (audit event). Below the coverage floor the operator may seal by
    explicitly accepting the partial coverage with a recorded reason."""

    def test_partial_acceptance_seals_below_floor_with_audit(self, authed_client, project_id, monkeypatch):
        """accept_partial=True + reason seals below the floor and writes the
        hunt_sealed_partial_acceptance audit event (FR-037)."""
        pipeline = authed_client.app.pipeline
        _seed_manifest_with_parts(authed_client, project_id, [("p1", "critical"), ("p2", "standard")])
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        queried = []
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, queried, found=False),
        )
        # hunt finds nothing → SOURCING_INSUFFICIENT
        authed_client.post(f"/restoration/projects/{project_id}/source")
        assert _project_status(pipeline, project_id) == "sourcing_insufficient"
        # plain seal refuses (below floor, no acceptance) → stays insufficient
        res = authed_client.post(f"/restoration/projects/{project_id}/sourcing/seal")
        assert res.status == 200
        assert res.json()["status"] == "sourcing_insufficient"
        # explicit partial acceptance with a reason → sealed + audit event
        res = authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/seal",
            json={"accept_partial": True, "reason": "remaining parts are local-pickup only"},
        )
        assert res.status == 200, res.body
        body = res.json()
        assert body["status"] == "hunt_sealed"
        assert body["partial_acceptance"] is True
        assert body["reason"] == "remaining parts are local-pickup only"
        assert _project_status(pipeline, project_id) == "hunt_sealed"
        audit = _events(pipeline, project_id, "hunt_sealed_partial_acceptance")
        assert audit, "hunt_sealed_partial_acceptance audit event missing"
        meta = json.loads(audit[0]["metadata"] or "{}")
        assert meta["reason"] == "remaining parts are local-pickup only"
        assert meta["floor"] == pipeline.config["restoration_sourcing_floor"]
        assert meta["coverage"]["total_coverage"] == 0.0

    def test_partial_acceptance_without_reason_400(self, authed_client, project_id, monkeypatch):
        """accept_partial=True with no reason → 400 (FR-037 audit requires a reason)."""
        pipeline = authed_client.app.pipeline
        _seed_manifest_with_parts(authed_client, project_id, [("p1", "critical"), ("p2", "standard")])
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, [], found=False),
        )
        authed_client.post(f"/restoration/projects/{project_id}/source")
        assert _project_status(pipeline, project_id) == "sourcing_insufficient"
        # blank reason
        res = authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/seal",
            json={"accept_partial": True, "reason": "   "},
        )
        assert res.status == 400
        assert res.json()["error"] == "partial_acceptance_requires_reason"
        # project unchanged (not sealed)
        assert _project_status(pipeline, project_id) == "sourcing_insufficient"

    def test_partial_acceptance_at_floor_seals_normally(self, authed_client, project_id, monkeypatch):
        """accept_partial=True when coverage is AT/above the floor seals normally
        — no partial-acceptance event (it is not partial)."""
        pipeline = authed_client.app.pipeline
        _seed_manifest_with_parts(authed_client, project_id, [("p1", "critical"), ("p2", "standard")])
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, [], found=True),
        )
        authed_client.post(f"/restoration/projects/{project_id}/source")
        assert _project_status(pipeline, project_id) == "hunting"  # full coverage
        res = authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/seal",
            json={"accept_partial": True, "reason": "unused at floor"},
        )
        assert res.status == 200, res.body
        assert res.json()["status"] == "hunt_sealed"
        # normal hunt_sealed event, NOT the partial-acceptance event
        assert _events(pipeline, project_id, "hunt_sealed")
        assert not _events(pipeline, project_id, "hunt_sealed_partial_acceptance")


class TestHuntCompletionTransition:
    def test_completion_below_floor_transitions_insufficient(self, authed_client, project_id, monkeypatch):
        """FR-037: a hunt that completes with system coverage below the
        sourcing floor transitions HUNTING → SOURCING_INSUFFICIENT, and the
        manifest sourcing_status syncs (FR-005)."""
        pipeline = authed_client.app.pipeline
        _seed_manifest_with_parts(authed_client, project_id, [("p1", "critical"), ("p2", "standard")])
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        queried = []
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, queried, found=False),
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/source")
        assert res.status == 202, res.body
        assert _project_status(pipeline, project_id) == "sourcing_insufficient"
        stage = _events(pipeline, project_id, "restoration_stage_changed")
        assert any('sourcing_insufficient' in (e["metadata"] or "") for e in stage)
        # FR-005: both parts carry an unsourceable flag → manifest reflects it
        manifest = pipeline.get_manifest(project_id)
        statuses = {e["part_id"]: e["sourcing_status"] for e in manifest["entries"]}
        assert statuses == {"p1": "unsourceable", "p2": "unsourceable"}

    def test_completion_at_coverage_stays_hunting(self, authed_client, project_id, monkeypatch):
        """FR-037 complement: coverage at/above the floor stays in HUNTING
        awaiting the operator seal; manifest entries flip to sourced."""
        pipeline = authed_client.app.pipeline
        _seed_manifest_with_parts(authed_client, project_id, [("p1", "critical"), ("p2", "standard")])
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        queried = []
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, queried, found=True),
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/source")
        assert res.status == 202, res.body
        assert _project_status(pipeline, project_id) == "hunting"
        manifest = pipeline.get_manifest(project_id)
        statuses = {e["part_id"]: e["sourcing_status"] for e in manifest["entries"]}
        assert statuses == {"p1": "sourced", "p2": "sourced"}

    def test_hunt_skips_already_covered_parts(self, authed_client, project_id, monkeypatch):
        """FR-056 retention: a re-hunt keeps prior SQLite state — parts with an
        existing candidate (e.g. operator manual entry) or unsourceable flag are
        not re-queried and never duplicated."""
        pipeline = authed_client.app.pipeline
        _seed_manifest_with_parts(authed_client, project_id, [("pt0", "standard"), ("pt1", "standard"), ("pt2", "standard")])
        # operator manual entry covers pt0 before the hunt
        res = authed_client.post(
            f"/restoration/projects/{project_id}/sourcing/manual",
            json={"part_id": "pt0", "vendor": "NAPA", "price_usd": 42.0, "condition": "new"},
        )
        assert res.status == 200, res.body
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        queried = []
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, queried, found=True),
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/source")
        assert res.status == 202, res.body
        assert queried == ["pt1", "pt2"], f"covered part re-queried: {queried}"
        pt0 = [c for c in _candidates(pipeline, project_id) if c["part_id"] == "pt0"]
        assert len(pt0) == 1  # manual entry untouched, no duplicate
        assert pt0[0]["provenance"] == "manual_entry"

    def test_rehunt_retries_flagged_parts_replacing_stale_flags(self, authed_client, project_id, monkeypatch):
        """Re-hunt semantics: candidateless-flagged parts are retried (the
        sourcing_insufficient → hunting path exists to retry them). A retry
        that finds a candidate clears the stale flag; a re-flag replaces the
        prior row instead of duplicating it. Flags are current-state; the
        event log is the history."""
        pipeline = authed_client.app.pipeline
        _seed_manifest_with_parts(authed_client, project_id, [("p1", "standard"), ("p2", "standard")])
        fake_clock = _FakeClock()
        pipeline._monotonic = fake_clock
        queried = []
        # hunt 1: everything unsourceable → sourcing_insufficient
        monkeypatch.setattr(
            restoration_pipeline.research_primitives,
            "research_part_sourcing",
            _fake_primitive(fake_clock, queried, found=False),
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/source")
        assert res.status == 202, res.body
        assert _project_status(pipeline, project_id) == "sourcing_insufficient"
        flags = pipeline.list_unsourceable_flags(project_id)
        assert {f["part_id"] for f in flags} == {"p1", "p2"}

        # hunt 2 (resume): p1 now sourceable, p2 still not
        state = {"calls": 0}

        def improving(query, sources, dispatcher, clock=None, per_query_timeout_s=30.0):
            found = query.part_id == "p1"
            return _fake_primitive(fake_clock, [], found=found)(
                query, sources, dispatcher, clock=clock, per_query_timeout_s=per_query_timeout_s
            )

        monkeypatch.setattr(
            restoration_pipeline.research_primitives, "research_part_sourcing", improving
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/sourcing/resume")
        assert res.status == 200, res.body
        # p1: candidate present, stale flag cleared
        p1_cands = [c for c in _candidates(pipeline, project_id) if c["part_id"] == "p1"]
        assert len(p1_cands) == 1
        flags = pipeline.list_unsourceable_flags(project_id)
        # p2: exactly one flag row (replaced, not duplicated)
        assert [f["part_id"] for f in flags] == ["p2"]
        # boundary pin: p1 system-discovered = 1/2 = exactly the 50% floor;
        # FR-037 fires strictly BELOW the floor → stays HUNTING awaiting seal
        assert _project_status(pipeline, project_id) == "hunting"
        manifest = pipeline.get_manifest(project_id)
        statuses = {e["part_id"]: e["sourcing_status"] for e in manifest["entries"]}
        assert statuses == {"p1": "sourced", "p2": "unsourceable"}
