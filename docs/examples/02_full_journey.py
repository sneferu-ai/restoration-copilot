#!/usr/bin/env python3
"""02 — Full job journey, end to end, against the real API.

Self-contained: boots the WSGI app in-process on a throwaway port with
RUNS_ROOT pointed at a temp directory, walks the documented journey, and
shuts down. No API keys, no leftover state.

    python3 docs/examples/02_full_journey.py

Exit 0 when every step matches the documented contract; exit 1 otherwise.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import urllib.request
import uuid
from pathlib import Path
from wsgiref.simple_server import make_server

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

RUNS = Path(tempfile.mkdtemp(prefix="rc_example02_"))

from orchestrator.api.server import create_app  # noqa: E402
from orchestrator.core.restoration_pipeline import RestorationPipeline  # noqa: E402

PORT = 8931
BASE = f"http://127.0.0.1:{PORT}"
TOKEN = None


def call(method: str, path: str, body=None, raw=False, expect=(200,)):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req) as res:
            payload = res.read()
            status = res.status
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        status = exc.code
    if status not in expect:
        raise SystemExit(f"FAIL {method} {path} -> {status}: {payload[:300]!r}")
    if raw:
        return status, payload
    return status, json.loads(payload) if payload else {}


def multipart(path: str, photos: list, parts_csv: bytes = None):
    boundary = uuid.uuid4().hex
    chunks = []
    for name, data in photos:
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="photos"; '
            f'filename="{name}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode() + data + b"\r\n"
        )
    if parts_csv is not None:
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="parts_list"; '
            f'filename="parts.csv"\r\nContent-Type: text/csv\r\n\r\n'.encode() + parts_csv + b"\r\n"
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    req = urllib.request.Request(BASE + path, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Authorization", f"Bearer {TOKEN}")
    with urllib.request.urlopen(req) as res:
        return res.status, json.loads(res.read())


def main() -> int:
    global TOKEN
    pipeline = RestorationPipeline(runs_root=RUNS, config={"tasks_inline": True})
    app = create_app(pipeline)
    server = make_server("127.0.0.1", PORT, app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"server up on {BASE} (RUNS_ROOT={RUNS})")

    # 1. health + login
    _, health = call("GET", "/restoration/health")
    assert health["module_loaded"] and health["os_supported"], health
    print("1. health OK:", health["version"][:8])
    _, login = call("POST", "/admin/operator/session",
                    {"username": "operator", "password": "restoration-dev"})
    TOKEN = login["session_token"]
    print("2. login OK")

    # 2. create + intake
    _, proj = call("POST", "/restoration/projects",
                   {"vehicle_meta": {"year": "1969", "make": "Chevrolet",
                                     "model": "Camaro", "engine_code": "L48"}},
                   expect=(201,))
    pid = proj["project_id"]
    print(f"3. project {pid} (status intake_open)")
    jpeg = lambda i: b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x00\x00" + bytes([i]) * 64
    photos = [(f"photo{i}.jpg", jpeg(i)) for i in range(6)]
    csv_bytes = (b"part_name,oem_number,quantity\n"
                 b"Brake booster,BC-1001,1\nMaster cylinder,MC-2002,1\n"
                 b"Front coil spring,CS-3003,2\nAlternator,AL-4004,1\nRadiator,RD-5005,1\n")
    _, intake = multipart(f"/restoration/projects/{pid}/intake", photos, csv_bytes)
    accepted = sum(1 for r in intake["receipts"] if r["accepted"])
    assert accepted == 6, intake
    print(f"4. intake OK: {accepted}/6 photos accepted, gaps={intake['gap_list']}")

    # 3. seal + identify (inline tasks -> synchronous)
    _, seal = call("POST", f"/restoration/projects/{pid}/intake/seal")
    print(f"5. sealed -> {seal['status']}")
    _, task = call("POST", f"/restoration/projects/{pid}/identify", expect=(202,))
    _, done = call("GET", f"/restoration/tasks/{task['task_id']}")
    assert done["status"] == "completed", done
    _, manifest = call("GET", f"/restoration/projects/{pid}/manifest")
    names = [e["name"] for e in manifest["entries"]]
    review = [e["name"] for e in manifest["entries"] if e["requires_review"]]
    print(f"6. identify OK: {names} | coverage {manifest['automation_coverage_pct']}% | review queue {review}")

    # 4. settle review + lock + budget
    for entry in manifest["entries"]:
        if entry["requires_review"]:
            call("POST", f"/restoration/projects/{pid}/manifest/resolve",
                 {"part_id": entry["part_id"], "name": entry["name"],
                  "condition": "present", "notes": "operator confirmed"})
    _, locked = call("POST", f"/restoration/projects/{pid}/manifest/lock")
    print(f"7. manifest locked (v{locked['manifest_version']}, coverage {locked['coverage']}%)")
    _, ruling = call("POST", f"/restoration/projects/{pid}/budget",
                     {"budget_ceiling_usd": 150})
    print(f"8. ruling at $150: {ruling['ruling']} (unknown costs: {ruling['unknown_cost_count']})")
    _, override = call("POST", f"/restoration/projects/{pid}/budget/override",
                       {"reason": "customer approved contingency"})
    print(f"9. override recorded: {override['override_record']['reason']}")

    # 5. hunt (sandbox bridges -> honest flags), manual candidate, partial seal
    _, hunt = call("POST", f"/restoration/projects/{pid}/source", expect=(202,))
    _, htask = call("GET", f"/restoration/tasks/{hunt['task_id']}")
    _, sourcing = call("GET", f"/restoration/projects/{pid}/sourcing")
    print(f"10. hunt {htask['status']}: {len(sourcing['flags'])} unsourceable flags, "
          f"system coverage {sourcing['system_coverage']}% (no bridge configured — expected)")
    first_part = sourcing["flags"][0]["part_id"]
    call("POST", f"/restoration/projects/{pid}/sourcing/manual",
         {"part_id": first_part, "vendor": "Classic Industries",
          "price_usd": 145.0, "condition": "new", "availability": "in_stock"})
    _, seal2 = call("POST", f"/restoration/projects/{pid}/sourcing/seal",
                    {"accept_partial": True,
                     "reason": "critical part sourced manually; bridges offline"})
    assert seal2["status"] == "hunt_sealed", seal2
    print(f"11. hunt sealed with audited partial acceptance: total coverage "
          f"{seal2['coverage']['total_coverage']}%")

    # 6. negotiation + purchase + token + guide page
    _, cands = call("GET", f"/restoration/projects/{pid}/sourcing")
    cand = cands["candidates"][0]
    call("POST", f"/restoration/projects/{pid}/negotiation",
         {"part_id": cand["part_id"], "candidate_id": cand["candidate_id"],
          "status": "negotiating", "notes": "called vendor"})
    call("POST", f"/restoration/projects/{pid}/negotiation",
         {"part_id": cand["part_id"], "candidate_id": cand["candidate_id"],
          "status": "ordered", "final_price_usd": 145.0})
    call("POST", f"/restoration/projects/{pid}/purchase",
         {"part_id": cand["part_id"], "vendor": "Classic Industries",
          "price_usd": 145.0, "condition": "new"})
    print("12. negotiation + purchase recorded (signals -> learning ledger)")
    _, token = call("POST", f"/restoration/projects/{pid}/tokens",
                    {"assembly_id": "front-brakes", "bundle_version": 1}, expect=(201,))
    status, page = call("GET", f"/guide/{token['token_id']}", raw=True)
    assert b"__GUIDE_META__" in page, "guide meta missing"
    print(f"13. token minted (expires {token['expires_at'][:10]}); guide page serves with meta injection")

    _, costs = call("GET", f"/restoration/projects/{pid}/api-costs")
    _, rec = call("POST", f"/restoration/reconcile/{proj['run_id']}")
    print(f"14. api costs ${costs['total']:.2f}/${costs['ceiling']:.2f} | "
          f"reconcile fixes: {rec['discrepancies_fixed'] or 'none'}")

    server.shutdown()
    print("\nJOURNEY PASS — every step matched the documented contract.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
