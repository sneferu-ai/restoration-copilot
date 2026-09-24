# Restoration Copilot — Operations

Install, configure, run, test, deploy, observe, back up, and troubleshoot. Every command was run against this repository on macOS (Darwin) with Python 3.12.13 and Node 26.5.0.

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| OS | Linux or macOS (POSIX) | `fcntl.flock` file locking; **Windows unsupported** (FR-062 — `/restoration/health` reports `os_supported: false`) |
| Python | ≥ 3.9 (developed and CI-verified on 3.12; **≤ 3.12 required for the standalone server** — see [Python 3.13 note](#python-313-cgi-removed)) | runtime |
| pip | current | installs `pydantic`, `Pillow`, `pillow-heif`, `trimesh`, `qrcode`, `pyloudnorm`, `aiosqlite`, `reportlab` + dev deps |
| Node.js + npm | ≥ 18 (verified on 26.5.0 / 11.17.0) | frontend builds and tests only — **not needed to run the product** (the build is committed) |
| Provider API keys | optional | only for `--e2e` tests against real bridges |

No database server, message broker, or other service is required. SQLite is embedded; state lives in `runs/`.

## Install

```bash
# from the repository root
pip install -e ".[dev]"

# seed + independently validate the reference KB (205 parts)
python3 scripts/seed_restoration_kb.py
python3 scripts/validate_kb_seed.py
# → "KB validation passed: 205 entries across 10 categories"
```

`pip install -e ".[dev]"` pulls from PyPI. On an offline machine with the deps already present, `pip install -e . --no-deps` still gives you the `orchestrator` + `scripts` packages on `sys.path` (tests only need `pydantic` and `pytest`).

Optional packaging check (builds sdist + wheel per the declared `setuptools` build backend):

```bash
python3 -m build          # requires the 'build' package (pip install build)
```

## Configuration

### Environment variables

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PORT` | `8000` | no | Backend listen port (standalone entry). |
| `OPERATOR_USERNAME` | `operator` | no | Dev login username. **Change for any shared deployment.** |
| `OPERATOR_PASSWORD` | `restoration-dev` | no | Dev login password. **Change for any shared deployment.** |
| `RUNS_ROOT` | `./runs/` | no | Root for all run state (per-run dirs, feedback DB, index cache). Tests set this to a tmp dir; `--e2e` sets it to `tests/restoration/tmp_runs/`. |
| `GIT_SHA` | — | no | Fallback for `/restoration/health → version` when `git` is unavailable. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BFL_API_KEY`, `MESHY_API_KEY` | — | only for `--e2e` | Real-bridge end-to-end tests (FR-064). The conftest fails fast naming the missing keys. |
| `FIREWORKS_API_KEY` | — | no | Reserved for the production host's bridge layer (spec §7). |

Keys are read from the process environment (or `.env` in the production host). No secret is written to the repo, logged, or persisted in run artifacts.

### `orchestrator/config/defaults.yaml` — the `restoration:` block

`load_config` overlays this block over code defaults; edit here, never in code. Checked-in values (code fallback in parentheses when different):

| Key | Default | Meaning |
|---|---|---|
| `restoration_confidence_threshold` | 0.70 | Below this, parts route to the review queue. |
| `restoration_vlm_only_threshold` | 0.85 | Raised threshold when no KB match exists for the vehicle. |
| `restoration_budget_affordable_pct` | 0.80 | `AFFORDABLE` band edge (of ceiling). |
| `restoration_budget_tight_pct` | 1.00 | `TIGHT` band edge. |
| `restoration_unknown_cost_pct` | 0.30 (code-only) | Unknown-cost share above which the ruling is `INSUFFICIENT_DATA`. |
| `restoration_api_cost_ceiling_usd` | 100.0 | Per-job API spend ceiling (80% warn / 100% block). |
| `restoration_api_pricing` | bfl 0.05 / meshy 0.20 / llm 0.02+0.01 / tts 0.015 (code-only) | Per-operation cost table for the ceiling. |
| `restoration_3d_degradation_threshold` | 0.30 | QA pass-rate below which 3D is "degraded" (Phase 4 surface). |
| `restoration_sourcing_floor` | 0.50 | System-discovered coverage floor; below it hunts end `sourcing_insufficient`. |
| `hunt_timeout_seconds` | 3600 | Wall-clock hunt budget (`<= 0` disables). |
| `restoration_max_concurrent_sourcing` | 3 | Global hunt semaphore (FR-069). |
| `restoration_max_sourcing_per_project` | 1 | Per-project hunt limit. |
| `restoration_in_service_checklist` | 2 items (see YAML) | Required items for the `in_service` transition. |
| `audio_lufs_target` | -16.0 | Narration loudness target (spec-future audio path). |
| `learning_ledger.K` / `minimum_samples` / `recency_decay_base` / `max_correction_age_months` | 0.2 / 5 / 0.95 / 12 | FR-066 formula constants. |
| `tier_allocation` | 0.60/0.30/0.10 (code-only) | Budget split critical/standard/optional (FR-010). |
| `events_jsonl_max_bytes` / `events_jsonl_max_rotated` | 10 MB / 5 (code-only) | Event-log rotation. |
| `tasks_inline` | false (code-only) | Run tasks on the request thread (tests use true). |
| `min_usable_photos` / `max_photo_bytes` / `max_batch_files` / `thumbnail_max_px` | 6 / 25 MB / 50 / 1024 (code-only) | Intake limits. |
| `token_expiry_days` / `token_extend_max_days` / `token_rate_limit_per_hour` | 30 / 365 / 60 (code-only) | Guide token policy. |

Malformed YAML logs a warning and falls back to code defaults — the server still starts.

## Running

### Backend (development and standalone)

```bash
python3 -m orchestrator.api.server
# INFO:restoration.server:Restoration Copilot (stdlib WSGI) listening on http://0.0.0.0:8000
```

Boot behavior (both visible in logs): stale-lock cleanup (`stale_lock_cleared` warnings) then crash reconciliation over every prior run (`restoration.reconcile`). Boot never fails on reconcile errors.

Stop with `Ctrl+C`. The dev entry has no auto-reload — restart to pick up code changes.

### Frontend (only when changing UI code)

```bash
cd orchestrator/ui/app
npm ci
npm run dev     # http://localhost:5173, proxies API calls to :8000
```

Day-to-day use does not need this: open `http://localhost:8000/restoration-ui` — the backend serves the committed build.

### Smoke-verify a running server

```bash
curl http://localhost:8000/live/status           # {"status": "ok"}
curl http://localhost:8000/bridge/health         # provider posture
curl http://localhost:8000/restoration/health    # {"module_loaded": true, "os_supported": true, "version": "<git sha>", …}
```

## Tests

```bash
# Backend — 152 tests, ~4 s, no API keys, no sockets (in-process WSGI client)
python3 -m pytest tests/restoration/ -v

# End-to-end against REAL provider bridges (FR-064) — requires the four API keys
python3 -m pytest tests/restoration/ -v --e2e

# Playwright browser tests (none currently collected; flag is registered)
python3 -m pytest tests/restoration/ -v --run-browser

# Frontend
cd orchestrator/ui/app
npm test               # 5 vitest brand-asset tests
npm run typecheck      # tsc -b --noEmit
npm run build          # includes the postbuild static-asset gate
npm run audit:tokens   # design-token lint
```

The suite registers two flags in `tests/restoration/conftest.py`: `--e2e` (real bridges; fails fast naming missing keys; isolates `RUNS_ROOT` to `tests/restoration/tmp_runs/`) and `--run-browser` (Playwright). Per-test state isolation comes from a `tmp_path`-rooted pipeline fixture with `tasks_inline: true`.

## Deployment

### What ships

Pure Python + committed static assets; no build step required on the deploy target beyond `pip install`. No Dockerfile, docker-compose, or CI pipeline exists in this repository — deployment is a git checkout plus the commands above.

### Standalone (a shop server or VM)

1. `git clone` / `git pull`, `pip install -e ".[dev]"`, seed the KB (once).
2. Set `OPERATOR_USERNAME` / `OPERATOR_PASSWORD` to real credentials; set `PORT` if 8000 is taken; set `RUNS_ROOT` if state should live outside the checkout.
3. Run under a process supervisor of your choice (systemd, launchd, tmux). The process is single-worker; do not run two instances against the same `RUNS_ROOT` (file locks protect data, but in-memory sessions/rate limits would diverge).
4. Verify: `curl …/restoration/health` — `version` must equal the deployed commit SHA.

### Production mount (spec §8, the intended shape)

In production this module mounts in-process into the claudopus FastAPI host: the host serves sessions, `/live/status`, `/bridge/health`, `/runs/start`, and real bridge dispatchers; `RestorationPipeline` is reused unchanged. The standalone WSGI adapter in `orchestrator/api/server.py` is the same route surface for development and testing. The host's `launch.sh` / `launch-dev.sh` (with `--https`) are **not part of this repository** — they live in the host checkout.

### HTTPS for the phone guide (FR-063)

Service Worker registration and screen wake-lock require HTTPS or localhost. For development:

```bash
python3 scripts/generate_test_cert.py            # writes state/https/dev-cert.pem + dev-key.pem
```

For production phone access, terminate TLS at a reverse proxy (Caddy internal CA, nginx + Let's Encrypt, or a shop CA installed on the mechanic's phone) — mobile browsers reject self-signed certs for Service Worker registration. Production checklist: (1) `GET /guide/{token}` loads without cert warnings, (2) `navigator.serviceWorker.controller` is non-null on the phone, (3) wake-lock API available, (4) without HTTPS the guide is online-only (not degraded — absent offline caching).

### Rollback

```bash
git log --oneline -5
git checkout <previous_commit>
python3 -m orchestrator.api.server &
curl http://localhost:8000/restoration/health   # version == rolled-back SHA
```

State is forward-compatible (additive SQLite schema, additive JSON fields); boot reconciliation repairs drift after any rollback.

## Observability

| Signal | Where |
|---|---|
| HTTP access log | stderr of the server process (`wsgiref` request lines) |
| App logs | loggers `restoration.server` (HTTP layer), `restoration` (pipeline), `restoration.reconcile`, `restoration.research`; `logging.basicConfig(level=INFO)` in the standalone entry |
| Audit events | canonical SQLite `events` table per run + rotated `events.jsonl` secondary (10 MB × 5). Event names: [API.md — events](API.md#events) |
| Health | `GET /live/status`, `GET /bridge/health`, `GET /restoration/health` (module, projects, OS support, git SHA) |
| Crash repair | boot sweep + `POST /restoration/reconcile/{run_id}`; every fix logged as `crash_reconciliation_sync` / `event_log_divergence` |
| Task state | SQLite `tasks` table per run (`GET /restoration/tasks/{task_id}`) |
| Spend | SQLite `api_costs` table (`GET /restoration/projects/{id}/api-costs`) |

No metrics/tracing exporter exists in v1; the events table is the audit substrate.

## Backup and restore

- **Back up:** copy the `runs/` tree (include the `-wal`/`-shm` files) plus `orchestrator/prompts/packs/restoration_kb.yaml` and `restoration_sources.yaml` if the operator curated them.
- **Restore:** copy back, restart. The boot sweep marks interrupted tasks, rebuilds stale snapshots from canonical SQLite, corrects status drift, and logs every repair.
- **Reset to factory (dev only):** stop the server, delete `runs/`, restart. KB/sources live in the repo, not in `runs/`.

## Troubleshooting

**`ModuleNotFoundError: No module named 'orchestrator'`**
The package is not installed or you are outside the repo. Fix: `pip install -e .` from the repository root (or run with `PYTHONPATH=<repo root>`).

**Server exits or is unreachable; another listener owns the port**
`lsof -iTCP:8000 -sTCP:LISTEN` shows the owner. Either stop it or run on another port: `PORT=8010 python3 -m orchestrator.api.server`.

**Every API call returns 401 `unauthorized`**
Sessions are in-memory: a server restart invalidates every token. Log in again via `POST /admin/operator/session`. Also check you are sending `Authorization: Bearer <token>`, not the raw password.

**Receipts show `thumbnail_status: "skipped_no_pillow"`**
Either Pillow is not installed (`pip install Pillow pillow-heif`) or the image bytes are corrupt (the magic-byte check passed but decode failed — the warning is in the server log). Originals are always preserved byte-identical, so intake still succeeds; this is honest degradation, not data loss.

**The sourcing hunt completes with zero candidates and `no_vendor_response` flags, project goes `sourcing_insufficient`**
Expected in the standalone build: the bridge dispatcher reports "no bridge configured (sandbox mode)". This is the designed degraded mode — add candidates with `POST .../sourcing/manual`, then either resume the hunt or seal with `accept_partial: true` + a reason. Real discovery needs the production host's bridge layer. To prove the bridges themselves work against the real providers, run the end-to-end tier — `python3 -m pytest tests/restoration/ -v --e2e` (requires the four provider API keys; the conftest fails fast naming any missing one — see [Tests](#tests)).

**`409 os_not_supported` on project creation**
The platform lacks POSIX `fcntl` (Windows). v1 runs on Linux/macOS only; `/restoration/health` shows `os_supported: false`. Existing projects stay readable.

**`409 insufficient_photos` when sealing intake**
Fewer than `min_usable_photos` (6) accepted photos. Check the intake response `receipts[].rejection_reason` — the usual cause is format rejection (only JPEG/PNG/HEIC/WebP by **content**; a `.jpg` that is really a GIF fails) or > 25 MB files.

**`409 invalid_transition` errors name valid next states**
The error body carries `current` and `valid_next` — follow them (e.g. re-posting `/budget` after `budget_ruled` fails; the valid next state is `hunting` via `POST .../source`). Parked projects reject everything but abandon: unpark first.

### Python 3.13: `cgi` removed

`orchestrator/api/server.py` imports the stdlib `cgi` module for multipart parsing; Python 3.13 removes it (`ModuleNotFoundError: No module named 'cgi'`). Run the standalone server on Python ≤ 3.12, or mount the pipeline on the production FastAPI host (whose multipart parser replaces `cgi`). `IMPLEMENTATION_NOTES.md` tracks this deliberate deviation.

**Service Worker never registers on the phone**
You are on plain HTTP from a non-localhost origin. Use HTTPS (see the FR-063 checklist above). Until then the guide works online-only.

**KB endpoints return an empty list and identification runs in VLM-only mode (0.85 threshold)**
The KB YAML was not seeded or is malformed. Run `python3 scripts/seed_restoration_kb.py` then `python3 scripts/validate_kb_seed.py`; the validator names the failing category/row and exits 1. Note the honest-degradation edge in this build: `load_kb` produces a `kb_load_error` detail on malformed YAML, but the REST layer currently discards it — a silently empty KB list is the symptom, and the seed/validate scripts are the diagnosis path.

**After a SIGKILL, `.lock` files litter `runs/` and writes stall**
Boot cleanup removes lock sidecars whose recorded PID is dead (`stale_lock_cleared` warnings in the boot log). To force it without a restart: `POST /restoration/reconcile/{run_id}` repairs state; remaining stale sidecars are removed at next boot.

**Guide page loads but shows "Loading error (HTTP 404)"**
The guide bundle endpoint is spec-future; the shell itself served fine. This is the expected state of the mechanic surface in this build — see [UI.md — known gaps](UI.md#known-gaps-honest).

**Guide page returns 429 `rate_limited`**
The token exceeded its per-token request budget: **60 requests/hour** by default (FR-041, in-memory sliding window; the error message names the current limit). A mechanic opening the guide a few times a day will never hit this — repeated 429s in normal use mean something is polling the link in a loop. The window clears itself within an hour, and a server restart resets the counter (in-memory). To change the budget, set `token_rate_limit_per_hour` in the `restoration:` block of `orchestrator/config/defaults.yaml` (see [Configuration](#configuration)).

**`npm run dev` proxy errors / blank page**
The backend is not on :8000. Start it (`python3 -m orchestrator.api.server`) or edit the proxy targets in `orchestrator/ui/app/vite.config.ts`. A blank page at :8000/restoration-ui with the backend up means the committed build was deleted — `cd orchestrator/ui/app && npm ci && npm run build` restores it (the postbuild gate verifies the output).
