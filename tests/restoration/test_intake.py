"""AC-003 (intake + HEIC policy + byte-identical persistence), AC-014
(content-based validation), FR-003 (seal rules), FR-002 (limits)."""

import hashlib
import json

import pytest

from .conftest import gif_bytes, heic_bytes, jpeg_bytes, png_bytes, upload_six_photos, webp_bytes


class TestIntakeUpload:
    def test_byte_identical_persistence_and_receipts(self, authed_client, project_id):
        payloads = {
            "engine.jpg": jpeg_bytes(1),
            "bay.png": png_bytes(2),
            "misc.webp": webp_bytes(3),
        }
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": list(payloads.items())},
        )
        assert res.status == 200
        receipts = {r["filename"]: r for r in res.json()["receipts"]}
        assert len(receipts) == 3
        for name, data in payloads.items():
            receipt = receipts[name]
            assert receipt["accepted"] is True
            assert receipt["content_sha256"] == hashlib.sha256(data).hexdigest()
            assert receipt["stored_format"] == {"engine.jpg": "jpeg", "bay.png": "png", "misc.webp": "webp"}[name]
        # stored photos are byte-identical to uploads (SHA-256 verifiable)
        run_dir = authed_client.app.pipeline._find_run_dir(project_id)
        for name, data in payloads.items():
            digest = hashlib.sha256(data).hexdigest()[:12]
            stored = (run_dir / "intake" / "photos" / f"{digest}_{name}").read_bytes()
            assert stored == data, f"{name} not preserved byte-identically"

    def test_heic_original_preserved_and_thumbnail_policy(self, authed_client, project_id):
        data = heic_bytes(9)
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": [("bay.heic", data)]},
        )
        assert res.status == 200
        receipt = res.json()["receipts"][0]
        assert receipt["accepted"] is True
        assert receipt["stored_format"] == "heic"
        # original HEIC preserved byte-identical
        run_dir = authed_client.app.pipeline._find_run_dir(project_id)
        digest = hashlib.sha256(data).hexdigest()[:12]
        assert (run_dir / "intake" / "photos" / f"{digest}_bay.heic").read_bytes() == data
        # thumbnail: generated (pillow-heif present) or honestly skipped
        assert receipt["thumbnail_status"] in ("generated", "skipped_no_pillow")
        if receipt["thumbnail_status"] == "generated":
            assert receipt["thumbnail_path"].endswith(".jpg")

    def test_gap_list(self, authed_client, project_id):
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": [("a.jpg", jpeg_bytes(1))]},
        )
        gaps = res.json()["gap_list"]
        assert any("usable frames" in g for g in gaps)
        assert any("parts list" in g for g in gaps)

    def test_content_based_rejection_gif_in_jpg(self, authed_client, project_id):
        """AC-014: fake.jpg with GIF89a magic bytes is rejected by content,
        never by extension; the valid file is accepted and stored."""
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": [("fake.jpg", gif_bytes(1)), ("real.jpg", jpeg_bytes(2))]},
        )
        assert res.status == 200
        receipts = {r["filename"]: r for r in res.json()["receipts"]}
        assert receipts["fake.jpg"]["accepted"] is False
        assert "GIF89a" in receipts["fake.jpg"]["rejection_reason"]
        assert "format mismatch" in receipts["fake.jpg"]["rejection_reason"]
        assert receipts["real.jpg"]["accepted"] is True
        run_dir = authed_client.app.pipeline._find_run_dir(project_id)
        names = [p.name for p in (run_dir / "intake" / "photos").iterdir()]
        assert not any("fake" in n for n in names)

    def test_all_files_rejected_is_400(self, authed_client, project_id):
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": [("fake.jpg", gif_bytes(1))]},
        )
        assert res.status == 400
        body = res.json()
        assert "fake.jpg" in body["message"]
        assert body["receipts"][0]["rejection_reason"]

    def test_oversize_file_rejected(self, authed_client, project_id, monkeypatch):
        from orchestrator.core import restoration_pipeline as rp

        monkeypatch.setitem(
            authed_client.app.pipeline.config, "max_photo_bytes", 16
        )
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": [("big.jpg", jpeg_bytes(1))]},
        )
        assert res.status == 400
        assert "too large" in res.json()["receipts"][0]["rejection_reason"]

    def test_batch_limit(self, authed_client, project_id):
        photos = [(f"p{i:02d}.jpg", jpeg_bytes(i)) for i in range(51)]
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": photos},
        )
        assert res.status == 400
        assert res.json()["error"] == "batch_too_large"

    def test_parts_list_csv_parsed(self, authed_client, project_id):
        csv_data = b"part_name,quantity,oem_number\nFront Brake Caliper,2,5463628\nRadiator,1,\n"
        res = authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": [], "parts_list": ("parts.csv", csv_data)},
        )
        assert res.status == 200
        run_dir = authed_client.app.pipeline._find_run_dir(project_id)
        rows = json.loads((run_dir / "intake" / "parts_list.parsed.json").read_text())
        assert rows[0]["name"] == "Front Brake Caliper"
        assert rows[0]["quantity"] == 2
        assert rows[0]["oem_number"] == "5463628"
        assert rows[1]["quantity"] == 1


class TestIntakeSeal:
    def test_seal_requires_six_photos(self, authed_client, project_id):
        authed_client.post(
            f"/restoration/projects/{project_id}/intake",
            multipart={"photos": [("a.jpg", jpeg_bytes(1))]},
        )
        res = authed_client.post(f"/restoration/projects/{project_id}/intake/seal")
        assert res.status == 409
        assert "usable photos" in res.json()["message"]

    def test_seal_transitions_and_starts_identify(self, authed_client, project_id):
        upload_six_photos(authed_client, project_id)
        res = authed_client.post(f"/restoration/projects/{project_id}/intake/seal")
        assert res.status == 200
        body = res.json()
        assert body["status"] in ("intake_sealed", "review_open")
        # inline task mode: identification already ran, project reached review_open
        project = authed_client.get(f"/restoration/projects/{project_id}").json()
        assert project["status"] == "review_open"
