#!/usr/bin/env python3
"""Guide token lifecycle (FR-039/040/041): mint → serve → extend → supersede
→ revoke — and what the mechanic's URL returns at each step.

    python3 docs/examples/04_guide_token_lifecycle.py

Offline; uses a temporary RUNS_ROOT and an in-process app.
"""

import tempfile
from pathlib import Path

from _client import make_app


def guide_status(client, token):
    res = client.get(f"/guide/{token}", auth=False)
    superseded = res.headers.get("x-guide-superseded")
    extra = f", X-Guide-Superseded: {superseded}" if superseded else ""
    if res.status == 200:
        return f"HTTP {res.status} (guide page served{extra})"
    body = res.json() or {}
    return f"HTTP {res.status} {body.get('error')}: {body.get('message')}"


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        client = make_app(Path(tmp) / "runs")
        client.login()
        project_id = client.post("/restoration/projects", json_body={
            "vehicle_meta": {"year": "1967", "make": "Ford", "model": "Mustang"},
        }).json()["project_id"]

        # Mint (201). Default expiry: token_expiry_days = 30.
        res = client.post(f"/restoration/projects/{project_id}/tokens",
                          json_body={"assembly_id": "front-suspension", "bundle_version": 1})
        token = res.json()["token_id"]
        print(f"minted token: {token[:12]}…  expires_at={res.json()['expires_at']}")
        print("mechanic opens it →", guide_status(client, token))

        # Access counters move on every serve (touch_token).
        client.get(f"/guide/{token}", auth=False)

        # Supersede: the old link keeps working but the guide shows a
        # "newer version available" banner (X-Guide-Superseded header).
        client.post(f"/restoration/projects/{project_id}/tokens/{token}/supersede")
        print("after supersede →", guide_status(client, token))

        # Extend: 1..365 days added to the current expiry.
        res = client.post(f"/restoration/projects/{project_id}/tokens/{token}/extend",
                          json_body={"extends_days": 60})
        print(f"after extend  → new expires_at={res.json()['token']['expires_at']}")

        # Revoke: the link dies (404), even though it merely 'expired' reads 410.
        client.delete(f"/restoration/projects/{project_id}/tokens/{token}")
        print("after revoke  →", guide_status(client, token))

        # Unknown token: also 404.
        print("unknown token →", guide_status(client, "no-such-token"))

        # Bulk revoke for a lost phone:
        for i in range(2):
            client.post(f"/restoration/projects/{project_id}/tokens",
                        json_body={"assembly_id": "front-suspension", "bundle_version": 2})
        res = client.delete(f"/restoration/projects/{project_id}/tokens")
        print(f"bulk revoke   → {res.json()}")


if __name__ == "__main__":
    main()
