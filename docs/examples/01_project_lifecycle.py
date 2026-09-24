#!/usr/bin/env python3
"""End-to-end operator workflow: create → intake → seal → identify → manifest
→ lock → budget → sourcing hunt → seal (partial acceptance) → mint guide token.

Runs fully offline against an in-process app with a temporary RUNS_ROOT.
No server, no API keys, no network.

    python3 docs/examples/01_project_lifecycle.py

Note: in the standalone build the sourcing hunt has no bridge dispatcher, so
every part is honestly flagged ``no_vendor_response`` and the project lands in
``sourcing_insufficient`` — this example demonstrates the audited partial-
acceptance seal path (FR-037), which is exactly what an operator does in that
situation.
"""

import tempfile
from pathlib import Path

from _client import jpeg_bytes, make_app, show

PARTS_CSV = (
    "part_name,quantity,oem_number\n"
    "front brake caliper,1,\n"
    "radiator,1,\n"
    "alternator,1,\n"
).encode("utf-8")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        client = make_app(Path(tmp) / "runs")
        client.login()
        print("Logged in; session token acquired.")

        # 1. Health + create the project (FR-001)
        show("GET /restoration/health", client.get("/restoration/health"), limit=200)
        res = client.post("/restoration/projects", json_body={
            "vehicle_meta": {"year": "1969", "make": "Chevrolet", "model": "Camaro"},
        })
        show("POST /restoration/projects", res)
        project_id = res.json()["project_id"]

        # 2. Intake: 6 photos (the seal minimum) + a parts list (FR-002)
        photos = [(f"bay_{i:02d}.jpg", jpeg_bytes(i)) for i in range(6)]
        res = client.post(f"/restoration/projects/{project_id}/intake",
                          multipart={"photos": photos, "parts_list": ("parts.csv", PARTS_CSV)})
        receipts = res.json()["receipts"]
        print(f"\n### POST …/intake\nHTTP {res.status} — accepted={sum(1 for r in receipts if r['accepted'])}, "
              f"gap_list={res.json()['gap_list']}")

        # 3. Seal intake — starts the IDENTIFY task (FR-003/004)
        show("POST …/intake/seal", client.post(f"/restoration/projects/{project_id}/intake/seal"))

        # tasks_inline=True, so identification already ran:
        res = client.get(f"/restoration/projects/{project_id}")
        print(f"\nProject status after identify: {res.json()['status']}")
        res = client.get(f"/restoration/projects/{project_id}/manifest")
        manifest = res.json()
        print(f"Manifest: {len(manifest['entries'])} entries, "
              f"automation_coverage={manifest['automation_coverage_pct']}%, "
              f"locked={manifest['locked']}")

        # 4. Lock the manifest (FR-008) and rule a budget (FR-009/010)
        show("POST …/manifest/lock", client.post(f"/restoration/projects/{project_id}/manifest/lock"))
        show("POST …/budget", client.post(
            f"/restoration/projects/{project_id}/budget",
            json_body={"budget_ceiling_usd": 5000}))

        # 5. Sourcing hunt (FR-012). Standalone: no bridge → honest degradation.
        res = client.post(f"/restoration/projects/{project_id}/source")
        show("POST …/source", res)
        task = client.get(f"/restoration/tasks/{res.json()['task_id']}").json()
        print(f"Hunt task: status={task['status']}, result={task['result']}")
        res = client.get(f"/restoration/projects/{project_id}/sourcing")
        sourcing = res.json()
        print(f"\n### GET …/sourcing\nHTTP {res.status} — candidates={len(sourcing['candidates'])}, "
              f"flags={[(f['part_id'], f['reason_code']) for f in sourcing['flags']]}, "
              f"system_coverage={sourcing['system_coverage']}%")

        # 6. Add a manual candidate for one part (FR-013) …
        part_id = manifest["entries"][0]["part_id"]
        res = client.post(f"/restoration/projects/{project_id}/sourcing/manual", json_body={
            "part_id": part_id, "vendor": "Joe's Brake Rebuilding",
            "price_usd": 189.0, "condition": "rebuilt",
            "url_or_contact": "tel:555-123-4567",
        })
        print(f"\n### POST …/sourcing/manual\nHTTP {res.status} — provenance={res.json()['candidate']['provenance']}")

        # 7. … then seal with explicit partial acceptance (FR-037 audit path)
        show("POST …/sourcing/seal (accept_partial)", client.post(
            f"/restoration/projects/{project_id}/sourcing/seal",
            json_body={"accept_partial": True,
                       "reason": "Only one part sourceable in standalone mode; rest ordered by phone."}))

        # 8. Mint a guide token for the mechanic (FR-039)
        res = client.post(f"/restoration/projects/{project_id}/tokens",
                          json_body={"assembly_id": "front-brakes", "bundle_version": 1})
        show("POST …/tokens", res, limit=300)
        token = res.json()["token_id"]
        page = client.get(f"/guide/{token}", auth=False)
        print(f"\n### GET /guide/<token>\nHTTP {page.status} "
              f"(the mechanic's bay guide page; content-type: {page.headers.get('content-type')})")

        # 9. Where the evidence lives
        print(f"\nRun directory: {tmp}/runs/<run_id>/restoration/ "
              f"(project.json, manifest.json, budget.json, restoration.db, events.jsonl)")


if __name__ == "__main__":
    main()
