#!/usr/bin/env python3
"""03 — Knowledge base + source registry management.

Self-contained: boots the WSGI app in-process with a temp RUNS_ROOT, then
exercises the KB and source-registry routes documented in docs/API.md.

    python3 docs/examples/03_kb_and_sources.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path
from wsgiref.simple_server import make_server

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

RUNS = Path(tempfile.mkdtemp(prefix="rc_example03_"))

from orchestrator.api.server import create_app  # noqa: E402
from orchestrator.core.restoration_pipeline import RestorationPipeline  # noqa: E402

PORT = 8932
BASE = f"http://127.0.0.1:{PORT}"
TOKEN = None


def call(method, path, body=None, expect=(200,)):
    global TOKEN
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req) as res:
            payload, status = res.read(), res.status
    except urllib.error.HTTPError as exc:
        payload, status = exc.read(), exc.code
    if status not in expect:
        raise SystemExit(f"FAIL {method} {path} -> {status}: {payload[:300]!r}")
    return status, json.loads(payload) if payload else {}


def main() -> int:
    global TOKEN
    # Temp config_dir keeps this example from writing operator entries into the
    # repository's pack files (the conftest does the same for the test suite).
    config_dir = RUNS / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    import shutil
    packs = REPO / "orchestrator" / "prompts" / "packs"
    for name in ("restoration_kb.yaml", "restoration_sources.yaml"):
        shutil.copy2(packs / name, config_dir / name)
    app = create_app(RestorationPipeline(
        runs_root=RUNS, config={"tasks_inline": True}, config_dir=config_dir))
    server = make_server("127.0.0.1", PORT, app)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    _, login = call("POST", "/admin/operator/session",
                    {"username": "operator", "password": "restoration-dev"})
    TOKEN = login["session_token"]

    # KB — list (seeded), filter, add, update, delete
    _, entries = call("GET", "/restoration/kb/entries")
    print(f"1. KB list: {len(entries)} seeded entries")
    _, camaro = call("GET", "/restoration/kb/entries?make=Chevrolet&model=Camaro")
    print(f"2. filter make=Chevrolet&model=Camaro -> {len(camaro)} entries")
    _, added = call("POST", "/restoration/kb/entries", {
        "part_id": "chevy_camaro_1969_engine_valve_cover_custom",
        "name": "Valve Cover (custom fab)",
        "category": "engine",
        "criticality": "optional",
        "oem_number": "VC-1969-CST",
        "indicative_price_range_usd": {"min": 40.0, "max": 120.0, "mid": 75.0},
    }, expect=(201,))
    print(f"3. added KB entry {added['part_id']}")
    _, updated = call("PUT", f"/restoration/kb/entries/{added['part_id']}", {
        "name": "Valve Cover (custom fab, polished)",
        "category": "engine",
        "criticality": "optional",
    })
    print(f"4. updated -> {updated['entry']['name']}")
    call("DELETE", f"/restoration/kb/entries/{added['part_id']}")
    print("5. deleted")

    # KB taxonomy guard — unknown category is a 400 with the valid list
    try:
        call("POST", "/restoration/kb/entries",
             {"part_id": "bad_entry", "name": "Flux capacitor", "category": "time_travel"},
             expect=(201,))
        raise SystemExit("FAIL: unknown category accepted")
    except SystemExit as exc:
        if "invalid_payload" in str(exc) or "400" in str(exc):
            print("6. taxonomy guard OK (unknown category rejected)")
        else:
            raise

    # Sources — list (seeded), add trade partner, update, delete
    _, sources = call("GET", "/restoration/sources")
    ids = [s["source_id"] for s in sources]
    print(f"7. sources: {ids}")
    _, src = call("POST", "/restoration/sources", {
        "source_id": "swap_meet_al",
        "vendor_name": "Al's Swap Meet Table",
        "url": "tel:555-867-5309",
        "search_template": None,
        "is_trade_partner": True,
        "contact_info": "Al, weekends at the fairgrounds",
    }, expect=(201,))
    print(f"8. added trade partner {src['source_id']} (search_template=null -> primitive skips it)")
    call("PUT", "/restoration/sources/swap_meet_al",
         {"vendor_name": "Al's Swap Meet Table", "specialty": "Mopar trim"})
    call("DELETE", "/restoration/sources/swap_meet_al")
    print("9. updated + deleted")

    server.shutdown()
    print("\nKB/SOURCES PASS.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
