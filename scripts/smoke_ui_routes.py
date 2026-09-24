#!/usr/bin/env python3
"""Round-1 live smoke: boots the WSGI server on a scratch port and walks every
new/changed route end-to-end (console shell, bundles, guide shell + bootstrap,
asset proxy auth, guide-token flag post, global reconcile)."""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / ".tmp" / "smoke_runs"
shutil.rmtree(RUNS, ignore_errors=True)
RUNS.mkdir(parents=True)

port = 8137
env = dict(os.environ)
env["RUNS_ROOT"] = str(RUNS)
env["PORT"] = str(port)
proc = subprocess.Popen(
    [sys.executable, "-m", "orchestrator.api.server"],
    cwd=ROOT, env=env,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
BASE = f"http://127.0.0.1:{port}"
failures = []


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL", name, detail))
    if not cond:
        failures.append(name)


def req(path, method="GET", token=None, body=None, raw=False):
    r = urllib.request.Request(BASE + path, method=method)
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, data=data, timeout=10) as resp:
            payload = resp.read()
            return resp.status, dict(resp.headers), payload
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


try:
    for _ in range(50):
        try:
            s, _, _ = req("/live/status")
            if s == 200:
                break
        except Exception:
            time.sleep(0.2)

    # 1. console shell is the BUILT shell (not the scaffold)
    s, _, body = req("/restoration-ui")
    check("console-shell-200", s == 200)
    check("console-shell-is-react", b"/static/restoration/app/assets/" in body)

    # 2. brand mark reachable + exact bytes
    s, _, body = req("/static/restoration/app/brand-mark.svg")
    expected = (ROOT / "BRAND_ASSETS" / "brand-mark.svg").read_bytes()
    check("brand-mark-200-exact", s == 200 and body == expected)

    # 3. console bundle JS reachable
    idx = (ROOT / "orchestrator/ui/web/static/restoration/app/index.html").read_text()
    import re
    js = re.search(r'src="(/static/restoration/app/assets/[^"]+\.js)"', idx).group(1)
    s, h, _ = req(js)
    check("console-js-200", s == 200 and "javascript" in h.get("Content-Type", ""))

    # 4. login + create project + mint token
    s, _, body = req("/admin/operator/session", "POST", body={"username": "operator", "password": "restoration-dev"})
    session = json.loads(body)["session_token"]
    check("login", s == 200)
    s, _, body = req("/restoration/projects", "POST", token=session, body={"vehicle_meta": {"year": "1969", "make": "Chevrolet", "model": "Camaro"}})
    pid = json.loads(body)["project_id"]
    check("create-project", s == 201)
    s, _, body = req(f"/restoration/projects/{pid}/tokens", "POST", token=session, body={"assembly_id": "asm_brake"})
    token = json.loads(body)["token_id"]
    check("mint-token", s == 201)

    # 5. guide shell with bootstrap injected
    s, h, body = req(f"/guide/{token}")
    check("guide-shell-200", s == 200)
    check("guide-bootstrap", b'window.__RC_GUIDE__ = {"token":' in body and b'"assemblyId": "asm_brake"' in body)
    # 6. step URL serves same shell (BrowserRouter catch-all)
    s, _, body2 = req(f"/guide/{token}/step/3")
    check("guide-step-200-bootstrap", s == 200 and b'"assemblyId": "asm_brake"' in body2)
    # 7. guide bundles no auth
    gidx = (ROOT / "orchestrator/ui/app/dist/guide/index.html").read_text()
    gjs = re.search(r'src="(/guide/bundles/assets/[^"]+\.js)"', gidx).group(1)
    s, h, _ = req(gjs)
    check("guide-js-200-noauth", s == 200 and "immutable" in h.get("Cache-Control", ""))
    # 8. asset proxy auth: no token → 401; wrong assembly → 403; right → 404 (no bundle yet)
    s, _, _ = req("/guide/assets/asm_brake/bundle_meta.json")
    check("asset-no-token-401", s == 401)
    s, _, _ = req("/guide/assets/asm_other/bundle_meta.json", token=token)
    check("asset-wrong-assembly-403", s == 403)
    s, _, _ = req("/guide/assets/asm_brake/bundle_meta.json", token=token)
    check("asset-missing-404", s == 404)
    # 9. plant a bundle_meta.json → proxy serves it (gzip on request)
    bdir = None
    for pj in RUNS.glob("*/restoration/project.json"):
        if json.loads(pj.read_text())["project_id"] == pid:
            bdir = pj.parent / "bundles" / "asm_brake"
    bdir.mkdir(parents=True)
    (bdir / "bundle_meta.json").write_text(json.dumps({
        "bundle_version": 1, "assembly_id": "asm_brake", "assembly_name": "Brake Assembly",
        "visual_tier": "T4", "total_steps": 1, "asset_base_url": "/guide/assets/asm_brake/",
        "steps": [{"step_index": 0, "description": "Remove the caliper.", "audio_available": False,
                    "has_2d_diagram": False, "tool_callout": "10mm socket"}],
    }))
    r = urllib.request.Request(BASE + "/guide/assets/asm_brake/bundle_meta.json")
    r.add_header("Authorization", f"Bearer {token}")
    r.add_header("Accept-Encoding", "gzip")
    with urllib.request.urlopen(r, timeout=10) as resp:
        import gzip as gz
        payload = gz.decompress(resp.read()) if resp.headers.get("Content-Encoding") == "gzip" else resp.read()
        check("asset-meta-gzip-200", resp.status == 200 and b"Brake Assembly" in payload)

    # 10. guide-token flag post (project must be past intake → force status)
    for pj in RUNS.glob("*/restoration/project.json"):
        data = json.loads(pj.read_text())
        if data["project_id"] == pid:
            data["status"] = "hunting"
            pj.write_text(json.dumps(data))
    s, _, body = req(f"/restoration/projects/{pid}/flags", "POST", token=token,
                     body={"assembly_id": "asm_brake", "description": "Step 3 bolt is 12mm not 10mm"})
    check("guide-flag-201", s == 201, body[:80])
    s, _, body = req(f"/restoration/projects/{pid}/flags", token=session)
    check("operator-sees-flag", s == 200 and b"12mm" in body)

    # 11. global reconcile
    s, _, _ = req("/restoration/reconcile", "POST", token=session, body={})
    check("reconcile-global-200", s == 200)

    # 12. health
    s, _, body = req("/restoration/health")
    check("health-os-supported", s == 200 and json.loads(body)["os_supported"] is True)

    # 12b. source registry CRUD (FR-012, §6.4) — the wiring the BudgetTab
    # source-registry panel depends on (pair-coder round 3).
    s, _, _ = req("/restoration/sources", token=session)
    check("sources-list-200", s == 200)
    sid = f"smoke-src-{int(time.time())}"
    s, _, body = req("/restoration/sources", "POST", token=session,
                     body={"source_id": sid, "vendor_name": "Smoke Vendor",
                           "url": "https://example.com", "rate_limit_seconds": 2})
    check("source-add-201", s == 201, body[:80])
    s, _, body = req(f"/restoration/sources/{sid}", "PUT", token=session,
                     body={"source_id": sid, "vendor_name": "Smoke Vendor 2",
                           "url": "https://example.com", "rate_limit_seconds": 3})
    check("source-update-200", s == 200, body[:80])
    s, _, body = req("/restoration/sources", token=session)
    check("source-update-reflected", s == 200 and b"Smoke Vendor 2" in body)
    s, _, body = req(f"/restoration/sources/{sid}", "DELETE", token=session)
    check("source-delete-200", s == 200)

    # 13. console-sw route exists (404 until SW lands — route, not crash)
    s, _, _ = req("/restoration-ui/console-sw.js")
    check("console-sw-route", s == 404)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

print("\n%d failures" % len(failures))
sys.exit(1 if failures else 0)
