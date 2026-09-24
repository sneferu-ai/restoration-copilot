"""AC-001 (KB seed population, per-category minimums, duplicate part_id
uniqueness — OBL-28), FR-049 (KB loading and fallback — AC-027)."""

import csv
import subprocess
import sys
from pathlib import Path

import pytest

from orchestrator.core import restoration_yaml
from scripts.seed_restoration_kb import (
    CATEGORY_MINIMUMS,
    CSV_PATH,
    YAML_PATH,
    read_seed,
    validate_rows,
)


class TestSeedCSV:
    def test_counts_minimums_uniqueness(self):
        rows = read_seed(CSV_PATH)
        assert len(rows) >= 205
        ids = [r["part_id"] for r in rows]
        assert len(ids) == len(set(ids)), "duplicate part_id in seed CSV"
        counts = {}
        for row in rows:
            counts[row["category"]] = counts.get(row["category"], 0) + 1
        for cat, minimum in CATEGORY_MINIMUMS.items():
            assert counts.get(cat, 0) >= minimum, f"category {cat} below minimum"
        for row in rows:
            assert row["oem_number"].strip(), f"empty OEM for {row['part_id']}"
            pmin, pmax, pmid = (
                float(row["indicative_price_min_usd"]),
                float(row["indicative_price_max_usd"]),
                float(row["indicative_price_mid_usd"]),
            )
            assert 0 < pmin <= pmid <= pmax

    def test_five_plus_vehicle_combos(self):
        rows = read_seed(CSV_PATH)
        combos = {tuple(r["part_id"].split("_")[:3]) for r in rows}
        assert len(combos) >= 5

    def test_validate_rows_flags_duplicates(self):
        rows = read_seed(CSV_PATH)
        duped = rows + [rows[0]]
        errors = validate_rows(duped)
        assert any("duplicate part_id" in e for e in errors)


class TestScripts:
    def test_validate_script_exit_zero(self):
        proc = subprocess.run(
            [sys.executable, "scripts/validate_kb_seed.py"],
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).resolve().parents[2]),
        )
        assert proc.returncode == 0, proc.stderr
        assert "KB validation passed" in proc.stdout

    def test_seed_then_yaml_loadable(self, pipeline):
        data = restoration_yaml.load_file(str(YAML_PATH))
        assert data and data.get("makes"), "generated KB YAML not loadable"
        entries, err = pipeline.load_kb()
        assert err is None
        assert len(entries) >= 205


class TestKBLoadingFallback:
    def test_missing_kb_is_silent_empty(self, pipeline, monkeypatch, tmp_path):
        monkeypatch.setattr(type(pipeline), "_kb_path", lambda self: tmp_path / "nope.yaml")
        entries, err = pipeline.load_kb()
        assert entries == []
        assert err is None  # missing file → silent empty-KB default (FR-049)

    def test_malformed_kb_reports_error(self, pipeline, tmp_path):
        bad = tmp_path / "bad_kb.yaml"
        bad.write_text("makes:\n  Chevrolet:\n - broken: [unclosed\n")
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(type(pipeline), "_kb_path", lambda self: bad)
        try:
            entries, err = pipeline.load_kb()
            assert entries == []
            assert err and "kb_load_error" in err
        finally:
            monkeypatch.undo()
