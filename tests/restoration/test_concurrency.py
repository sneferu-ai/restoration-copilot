"""AC-024 (concurrent project creation), AC-041 (concurrent SQLite writes)."""

import json
import sqlite3
import threading

import pytest


class TestConcurrentProjectCreation:
    def test_three_simultaneous_creates(self, authed_client):
        """AC-024: 3 simultaneous POST /projects → distinct ids, intact
        project.json files, valid index containing all 3, no lock errors."""
        results = []
        errors = []

        def create(i):
            try:
                res = authed_client.post(
                    "/restoration/projects",
                    json={"vehicle_meta": {"make": f"Make{i}", "model": f"Model{i}"}},
                )
                results.append((res.status, res.json()))
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=create, args=(i,)) for i in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors
        assert all(status == 201 for status, _ in results)
        ids = {body["project_id"] for _, body in results}
        assert len(ids) == 3
        pipeline = authed_client.app.pipeline
        for pid in ids:
            project = pipeline.get_project(pid)
            assert project.project_id == pid
        index = pipeline.load_index()
        assert set(index.keys()) >= ids
        json.dumps(index)  # valid JSON


class TestConcurrentSqliteWrites:
    def test_two_simultaneous_manual_candidates(self, authed_client, project_id):
        """AC-041: two concurrent writes to the same restoration.db both
        succeed; no 'database is locked'; integrity_check passes."""
        outcomes = []

        def add(i):
            res = authed_client.post(
                f"/restoration/projects/{project_id}/sourcing/manual",
                json={
                    "part_id": f"part-{i}",
                    "vendor": f"Vendor{i}",
                    "price_usd": 25.0 + i,
                    "condition": "used",
                    "availability": "in_stock",
                    "region": "US",
                    "url_or_contact": "https://example.com/part",
                },
            )
            outcomes.append(res.status)

        threads = [threading.Thread(target=add, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert outcomes == [200, 200], outcomes
        pipeline = authed_client.app.pipeline
        run_dir = pipeline._find_run_dir(project_id)
        conn = sqlite3.connect(str(run_dir / "restoration.db"))
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        count = conn.execute("SELECT COUNT(*) FROM sourcing_candidates").fetchone()[0]
        conn.close()
        assert integrity == "ok"
        assert count == 2
