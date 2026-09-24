# Restoration Copilot — API reference

Complete reference for every route the server registers (`orchestrator/api/server.py::_register_routes`), the library-level sourcing primitive, and the error model. Response bodies in this document are real output captured from a live server on Python 3.12, trimmed only with `…`.

For the state machine these routes drive, see [ARCHITECTURE.md — state machine](ARCHITECTURE.md#state-machine--the-project-spine). For the end-to-end journey, run [examples/02_full_journey.py](examples/02_full_journey.py).

## Base URL and servers

| Context | Base URL | Notes |
|---|---|---|
| Standalone (this build) | `http://localhost:8000` | `python3 -m orchestrator.api.server`; `PORT` env overrides. |
| Vite dev server | `http://localhost:5173` | Proxies `/restoration`, `/admin`, `/bridge`, `/guide` to `localhost:8000` (`vite.config.ts`). |
| Production host (spec §8) | the claudopus host origin | Same route surface, mounted on FastAPI/uvicorn. |

All API bodies are JSON unless marked multipart. Content types: `application/json` for API responses; `text/html` for pages.

## Authentication

Two credential planes:

1. **Operator session** — required for every route marked 🔒 below. Obtain a token with `POST /admin/operator/session`, then send it as `Authorization: Bearer <token>` (the legacy header `X-Operator-Session` is also accepted). Sessions are in-memory in this build: a server restart invalidates all tokens (login again). Credentials come from `OPERATOR_USERNAME` / `OPERATOR_PASSWORD` (dev defaults `operator` / `restoration-dev`).
2. **Guide token** — the mechanic's only credential, embedded in the `/guide/{token}` URL. No session, no account. Rate-limited to **60 requests per token per hour** (in-memory sliding window; resets on restart). Lifecycle: minted (30-day expiry default) → extended (≤365 days) → superseded (old guide still serves, with `X-Guide-Superseded: true`) → revoked (404) → expired (410).

Failed operator auth returns `401 {"error": "unauthorized", "message": "Operator session required."}`.

## Error model

Every error is a JSON envelope with a machine-readable `error` code and a human `message`; some carry extra fields (e.g. `current`, `valid_next`, `receipts`):

```json
{"error": "invalid_transition", "message": "Cannot transition from budget_ruled to budget_ruled. Valid next states: ['hunting'].", "current": "budget_ruled", "valid_next": ["hunting"]}
```

| Status | Meaning | Common codes |
|---|---|---|
| 400 | Bad input or payload | `invalid_json`, `invalid_payload`, `invalid_budget`, `reason_required`, `missing_field`, `invalid_extension`, `partial_acceptance_requires_reason`, `all_files_rejected`, `batch_too_large`, `incomplete_checklist`, `duplicate_part_id`, `duplicate_source_id`, `unknown_state`, `unknown_status`, `unknown_workflow` |
| 401 | No/invalid operator session | `unauthorized`, `invalid_credentials` |
| 404 | Missing entity or token | `not_found`, `project_not_found`, `manifest_not_found`, `part_not_found`, `token_not_found`, `source_not_found`, `kb_entry_not_found`, `proposal_not_found`, `flag_not_found`, `task_not_found`, `run_not_found` |
| 409 | State conflict | `invalid_transition`, `invalid_state`, `project_abandoned`, `project_parked`, `insufficient_photos`, `no_manifest`, `no_ruling`, `override_not_permitted`, `cost_gate_failed`, `sourcing_concurrency_limit`, `not_in_review`, `os_not_supported`, `no_task_runner`, `task_cancelled`, `api_cost_ceiling_reached` |
| 410 | Guide token expired | `token_expired` |
| 429 | Guide token rate limit | `rate_limited` |
| 500 | Unhandled server error | `internal_error` (message names the exception class; details are in the server log) |

---

## Host shims (FR-026 dependency surface)

Minimal standalone shims for the five Sneferu host endpoints the module depends on. In production the real host serves these.

### `POST /admin/operator/session` — log in (public)

Body: `{"username": str, "password": str}`.
Response 200: `{"session_token": "faVEmDxXvCm_lioc8A3aDc_-knFvOcdP", "username": "operator"}`.
Errors: 401 `invalid_credentials`.

```bash
curl -X POST http://localhost:8000/admin/operator/session \
  -H 'Content-Type: application/json' \
  -d '{"username": "operator", "password": "restoration-dev"}'
```

### `GET /admin/operator/session` — session check (public)

Returns `{"valid": true, "session": "<first-8-chars>…"}` when the presented token is valid, else 401 `unauthorized`.

### `GET /live/status` — liveness (public)

Returns `{"status": "ok"}`.

### `GET /bridge/health` — provider posture (public)

Static shim describing the five provider legs:

```json
{"bridges": {"vision": {"configured": true, "healthy": true}, "sourcing": {"configured": true, "healthy": true}, "bfl": {"configured": false, "healthy": false, "unverified": true}, "meshy": {"configured": false, "healthy": false, "unverified": true}, "tts": {"configured": false, "healthy": false, "unverified": true}}}
```

### `POST /runs/start` — workflow registration shim (public)

Body: `{"workflow": "restoration_pipeline"}`. Any other workflow → 400 `unknown_workflow`. Returns `{"run_id": "manual-<hex>", "workflow": "restoration_pipeline"}`.

---

## Pages, health, and static

### `GET /restoration/health` — module health (public)

```json
{"module_loaded": true, "active_projects": 1, "pipeline_route": "configured", "os_supported": true, "version": "272dc4e2289a3bbc570bd00a2b9bf28a452e23e8"}
```

`active_projects` is computed by scanning `runs/*/restoration/project.json`; `version` is `git rev-parse HEAD` (fallback `GIT_SHA` env, then `"unknown"`); `os_supported` reports POSIX `fcntl` availability — 200 with `os_supported: false` on unsupported platforms, never 500 (FR-062).

### `GET /restoration-ui` and `GET /restoration-ui/{path}` — operator console (public)

Serves the compiled React SPA (`orchestrator/ui/web/static/restoration/app/operator/index.html`) when present, else the legacy `restoration_copilot.html`. The `{path}` catch-all lets BrowserRouter deep links refresh without 404. The SPA itself enforces login client-side.

### `GET /guide/{token}` — Bay Guide (token)

Serves the guide shell with `window.__GUIDE_META__ = {"token_id": …, "assembly_id": …}` injected. Always `Referrer-Policy: no-referrer`; the page carries `<meta name="robots" content="noindex">`.

| Token verdict | Response |
|---|---|
| valid | 200 guide shell |
| superseded | 200 guide shell + header `X-Guide-Superseded: true` |
| expired | 410 `{"error": "token_expired", "message": "This guide link has expired. Contact the shop operator for a new guide link."}` |
| revoked / unknown | 404 `{"error": "token_not_found", "message": "Guide link is not valid."}` |
| > 60 requests/hour | 429 `{"error": "rate_limited", …}` |

### `GET /static/restoration/{filename}` — static assets (public)

Traversal-proof file serving from `orchestrator/ui/web/` (resolve + containment check). 404 `not_found` for missing assets.

---

## Projects

### 🔒 `POST /restoration/projects` — create a job (FR-001)

Body: `{"vehicle_meta": {"year"?, "make"?, "model"?, "trim"?, "engine_code"?, "notes"?}}` — all fields optional.
Response **201**:

```json
{"project_id": "rest-85516a12", "run_id": "2026-08-03T23-58-53Z-restoration-17cbcbe5"}
```

Creates `runs/<run_id>/restoration/` with `project.json` + `restoration.db`, status `intake_open`.
Errors: 401; 409 `os_not_supported` when POSIX locking is unavailable.

```bash
curl -X POST http://localhost:8000/restoration/projects \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"vehicle_meta": {"year": "1969", "make": "Chevrolet", "model": "Camaro", "engine_code": "L48"}}'
```

### 🔒 `GET /restoration/projects` — list jobs

Query: `?state=<status>` (exact status match), `?search=<text>` (matches project id and vehicle fields). Response: array of full project records (see `RestorationProject` in [ARCHITECTURE.md — data model](ARCHITECTURE.md#data-and-persistence)):

```json
[{"project_id": "rest-85516a12", "run_id": "…", "vehicle_meta": {"year": "1969", "make": "Chevrolet", …}, "status": "intake_open", "parked": false, …, "api_cost_ceiling_usd": 100.0, "needs_attention": null}]
```

### 🔒 `GET /restoration/projects/{project_id}` — job detail

Full `RestorationProject`. Errors: 404 `project_not_found`.

---

## Intake and identification

### 🔒 `POST /restoration/projects/{project_id}/intake` — upload (FR-002)

`multipart/form-data` with repeated `photos` file parts and an optional `parts_list` file part (CSV/TSV/free-text). Limits: ≤ 25 MB per photo, ≤ 50 files per batch; JPEG/PNG/HEIC/WebP **by magic bytes** (extension is ignored). Photos are stored byte-identical under `intake/photos/<sha12>_<name>`; thumbnails are best-effort (`generated` | `skipped_no_pillow`).

Response 200:

```json
{"receipts": [{"filename": "photo0.jpg", "stored_path": "intake/photos/648dfb6c01ba_photo0.jpg", "content_sha256": "648dfb6c…", "stored_format": "jpeg", "thumbnail_path": null, "thumbnail_status": "skipped_no_pillow", "size_bytes": 84, "accepted": true, "rejection_reason": null}, …],
 "gap_list": ["no parts list uploaded"]}
```

Errors: 400 `invalid_content_type` (not multipart), 400 `empty_intake` (nothing provided), 400 `batch_too_large`, 400 `all_files_rejected` (body includes per-file `receipts` with `rejection_reason`, e.g. `"format mismatch: expected JPEG/PNG/HEIC/WebP magic bytes, got GIF89a"`), 409 `project_abandoned`.

```bash
curl -X POST http://localhost:8000/restoration/projects/$P/intake \
  -H "Authorization: Bearer $TOKEN" \
  -F "photos=@front.jpg" -F "photos=@engine.jpg" -F "parts_list=@parts.csv"
```

### 🔒 `POST /restoration/projects/{project_id}/intake/seal` — seal intake (FR-003)

Guards: ≥ 6 usable photos (config `min_usable_photos`), else 409 `insufficient_photos` naming the count. Response: `{"status": "identifying", "identify_task_id": "…"}` (identification starts automatically on the sealed intake's identify path — see next route for manual control).

### 🔒 `POST /restoration/projects/{project_id}/identify` — start identification (FR-004)

Requires status `intake_sealed` / `identifying` / `review_open`, else 409 `invalid_state`. Moves the project to `identifying` and spawns the identify task. Response **202**: `{"task_id": "…", "status": "running"}`. The current engine is deterministic and KB-backed (parts-list-driven; vision-bridge identification is the spec-future runner seam `register_runner(TaskType.IDENTIFY, …)`).

### 🔒 `GET /restoration/tasks/{task_id}` — task status

Returns the `AsyncTask` row: `{"task_id", "project_id", "task_type": "identify|source|generate_3d|tts|audio_normalize", "status": "pending|running|completed|failed|interrupted|cancelled", "progress_pct", "result", "error", "created_at", "updated_at", "resumed_from"}`. Errors: 404 `task_not_found`.

### 🔒 `POST /restoration/tasks/{task_id}/resume` — resume an interrupted task (FR-056)

Re-runs the task preserving `task_id`; sets `resumed_from`. Response 202 `{"task_id", "status": "running", "resumed_from": …}`. Errors: 404, 409 for tasks that are not `interrupted`.

---

## Manifest and review

### 🔒 `GET /restoration/projects/{project_id}/manifest` — draft/locked manifest

```json
{"version": 1, "locked": false, "automation_coverage_pct": 80.0,
 "entries": [{"part_id": "part-9d7a4bd9", "name": "Brake booster", "oem_number": "5461351", "aftermarket_alternatives": ["PBR-1273", "A1-Cardone-43389"], "quantity": 1, "criticality": "critical", "estimated_cost_usd": 158.0, "sourcing_status": "pending", "confidence": 0.92, "requires_review": false}, …]}
```

KB-matched entries carry the KB's OEM number, alternatives, criticality, and mid price. `requires_review` is true when confidence < threshold (0.70, or 0.85 VLM-only) **or** the category is outside the 10-category taxonomy (hallucination defense). Errors: 404 `manifest_not_found` (identification has not run).

### 🔒 `POST /restoration/projects/{project_id}/manifest/resolve` — settle a review case (FR-007)

Body: `{"part_id", "name"?, "condition"?, "category"?, "notes"?}`. Writes a `review_log` audit row (before/after, actor, timestamp) and an `identification_correction` feedback signal with the denormalized category. Response: `{"entry": {…}, "audit_delta": {…}}`.
Errors: 404 `part_not_found`, 409 `no_manifest`, 409 `not_in_review`.

### 🔒 `GET /restoration/projects/{project_id}/reviews` — review audit log

Returns `[ReviewLogEntry]` from SQLite `review_log`. Errors: 404 `project_not_found`.

### 🔒 `POST /restoration/projects/{project_id}/manifest/lock` — lock manifest (FR-008)

Marks the manifest locked, computes `automation_coverage_pct`, generates KB auto-extraction proposals for confirmed parts with no KB entry, and transitions to `manifest_locked`. Response: `{"manifest_version": 1, "coverage": 80.0}`. Errors: 409 `no_manifest`, 409 `invalid_transition`.

---

## Budget

### 🔒 `POST /restoration/projects/{project_id}/budget` — rule the budget (FR-009/FR-010)

Body: `{"budget_ceiling_usd": number}` (positive; USD only). Computes the ruling, writes `budget.json`, transitions to `budget_ruled`. Response:

```json
{"ruling": "INSUFFICIENT_DATA",
 "detail": {"total_estimated_cost_usd": 158.0, "known_cost_count": 1, "unknown_cost_count": 4,
            "per_part_allocation": {"critical": 100.0, "standard": 12.5}},
 "unknown_cost_count": 4}
```

Bands: total ≤ 80% → `AFFORDABLE`; ≤ 100% → `TIGHT`; above → `SHORTFALL_CRITICAL`; unknown costs > 30% of parts → `INSUFFICIENT_DATA` (checked first). Allocation is per-part within tier with empty-tier redistribution (60/30/10). Errors: 400 `invalid_budget`, 409 `no_manifest`, 409 `invalid_transition` (already ruled — a re-POST from `budget_ruled` returns `invalid_transition` naming `["hunting"]` as the valid next state).

### 🔒 `POST /restoration/projects/{project_id}/budget/override` — audited override (FR-011)

Body: `{"reason": str}` (required). Permitted only from `SHORTFALL_CRITICAL` or `INSUFFICIENT_DATA`. Appends an immutable `{actor, timestamp, reason}` entry to `budget.json → override_audit`. Response: `{"override_record": {…}, "ruling": "INSUFFICIENT_DATA"}`. Errors: 400 `reason_required`, 409 `no_ruling`, 409 `override_not_permitted`.

---

## Sourcing

### 🔒 `POST /restoration/projects/{project_id}/source` — start the hunt (FR-013)

Moves `budget_ruled`/`sourcing_insufficient` → `hunting` and spawns the `source` task. Response 202 `{"task_id", "status": "running"}` (`"pending"` when the FR-069 global semaphore queues it). Concurrency: 1 hunt per project, 3 across all projects — a second hunt on the same project returns 409 `sourcing_concurrency_limit`. The hunt calls the research primitive per manifest part (sequential), persists candidates + unsourceable flags as it goes, enforces `hunt_timeout_seconds` (default 3600; timeout → partial results preserved + `sourcing_hunt_timeout` event + `sourcing_insufficient`), and transitions a completed hunt below the 50% system-coverage floor to `sourcing_insufficient`. Parts that already have any candidate are never re-queried or duplicated.

### 🔒 `GET /restoration/projects/{project_id}/sourcing` — hunt state

```json
{"candidates": […], "flags": [{"rowid": 1, "part_id": "part-9d7a4bd9", "reason_code": "no_vendor_response", "alternative_suggestion": "Try a specialty rebuilder or custom fabricator for this part.", "fabrication_reference_glb": null}],
 "system_coverage": 0.0, "total_coverage": 20.0, "critical_coverage": 0.0, "total_parts": 5}
```

Coverage formulas: [ARCHITECTURE.md — money rules](ARCHITECTURE.md#the-money-rules-pinned-formulas).

### 🔒 `POST /restoration/projects/{project_id}/sourcing/pause` — pause the hunt

Only from `hunting` (else 409 `invalid_state`). Interrupts the running source task (progress preserved in SQLite). Response: `{"status": "paused"}`.

### 🔒 `POST /restoration/projects/{project_id}/sourcing/resume` — resume / re-hunt (FR-038, AC-057)

From `hunting` or `sourcing_insufficient`. Resumes interrupted source tasks; when the previous hunt completed (timeout or low coverage) starts a **fresh hunt** that keeps prior candidates and only sources remaining parts; reports `{"status": "already_running"}` honestly when a hunt is live. Response: `{"status": "resumed", "task_id": …}`.

### 🔒 `POST /restoration/projects/{project_id}/sourcing/seal` — seal the hunt (FR-037)

Body: `{"accept_partial": bool, "reason": str}` (both optional; string `"true"/"1"/"yes"` accepted for `accept_partial`). Order of gates:

1. **Cost gate:** sum of `selected=1` candidate prices must be ≤ ceiling, else 409 `cost_gate_failed` with totals.
2. **Coverage floor:** total coverage below the 50% floor *without* `accept_partial` → no seal; response `{"status": "sourcing_insufficient", …}` (and the state transition fires if not already there).
3. **Partial acceptance:** below floor + `accept_partial: true` requires a non-blank `reason` (400 `partial_acceptance_requires_reason` otherwise) → seals with the `hunt_sealed_partial_acceptance` audit event.

Normal response:

```json
{"status": "hunt_sealed", "total_selected_cost": 0.0, "budget_ceiling": 5000.0, "cost_gate_passed": true,
 "coverage": {"system_coverage": 0.0, "total_coverage": 20.0, "critical_coverage": 0.0, "total_parts": 5},
 "partial_acceptance": true, "reason": "sourced critical parts manually; sandbox bridges offline"}
```

Errors: 409 `invalid_state` (seal only from `hunting`/`sourcing_insufficient`).

### 🔒 `POST /restoration/projects/{project_id}/sourcing/manual` — manual candidate (FR-013)

Body: any `SourcingCandidate` field set — `part_id` (required), `vendor`, `price_usd`, `condition` (`new|used|rebuilt|nos`), `availability` (`in_stock|backorder|special_order`), `region`, `url_or_contact`, `tradeable`, `trade_partner_id`. Provenance is forced to `manual_entry` (counts toward total coverage, never system coverage). Response: `{"candidate": {…, "provenance": "manual_entry", …}}`. Errors: 400 `invalid_payload` (schema violation — e.g. negative price becomes null, not an error).

---

## Negotiation and purchase

### 🔒 `POST /restoration/projects/{project_id}/negotiation` — negotiation state machine (FR-042)

Body: `{"part_id", "candidate_id", "status", "notes"?, "final_price_usd"?}`. Pinned flow `pending → negotiating → ordered → received`, with `passed`, `returned`, `disputed` exception branches (`NEGOTIATION_TRANSITIONS` in `restoration_models.py:133`). `ordered` requires `final_price_usd`; `negotiating → passed` requires `notes`. Response: `{"record": {…, "status": "negotiating", "updated_at": …}}`.
Errors: 400 `missing_field`, 409 `invalid_transition` — the body names current and valid next:

```json
{"error": "invalid_transition", "message": "Cannot transition negotiation from negotiating to received. Valid next: ['ordered', 'passed'].", "current": "negotiating", "valid_next": ["ordered", "passed"]}
```

The system never negotiates autonomously — every transition is an operator POST.

### 🔒 `POST /restoration/projects/{project_id}/purchase` — record a purchase (FR-043)

Body: `{"part_id", "vendor", "price_usd" (positive, required), "condition"?, "ordered_at"?, "received_at"?, "notes"?, "batch_id"?}`. `batch_id` links group buys. A received purchase writes a `purchase_outcome` feedback signal and a KB pricing proposal. Response: `{"record": {…}}`. Errors: 400 `invalid_payload`.

---

## Mechanic flags (FR-054)

### 🔒 `POST /restoration/projects/{project_id}/flags` — submit a flag

Body: `{"assembly_id", "step_index"?, "problem_type": "wrong_part|step_unclear|tool_missing|safety_concern|other", "description"?, "screenshot_path"?, "photo_path"?}`. Unknown `problem_type` values coerce to `other`. Response **201**: `{"flag_id": "d5e6a011facb40bbaca46602a26fa8f0"}`. Guard: flags are accepted only from `hunting` or later — earlier stages and abandoned projects return 409 `invalid_state` naming the current status. This operator-authenticated route is the flag-ingestion path that exists today; the token-scoped `/guide/{token}/flags` route the React guide queues against is spec-future (404 today, so queued flags stay pending).

### 🔒 `GET /restoration/projects/{project_id}/flags` — list flags

Returns all `mechanic_flags` rows for the project (open and resolved), oldest first.

### 🔒 `POST /restoration/projects/{project_id}/flags/{flag_id}/resolve` — resolve

Body: `{"resolution_notes": str}`. Marks the flag resolved and writes `mechanic_flag_resolved`. Response: `{"flag_id", "status": "resolved", "resolution_notes"}`. Errors: 404 `flag_not_found`. The spec's flag→learning-ledger routing (resolved `wrong_part`/`tool_missing` flags emitting feedback signals, FR-054) is not wired in this build.

---

## Lifecycle

### 🔒 `POST /restoration/projects/{project_id}/in-service` — sign off (FR-033)

Body: `{"checklist": [str, …]}` — must include every item from config `restoration_in_service_checklist` (default two: "all critical sub-assemblies published", "operator has verified the vehicle is road-ready"); missing items → 400 `incomplete_checklist` naming them. Valid only from `published` (spec-future state). Response: `{"status": "in_service"}`.

### 🔒 `POST /restoration/projects/{project_id}/abandon` — abandon (FR-034)

Body: `{"reason": str}` (required, 400 `reason_required`). From **any** state; cancels all pending/running tasks (each gets an `async_task_cancelled` event); terminal — abandoned projects are read-only (all mutating routes return 409 `project_abandoned`) and cannot reopen; clone by creating a new project with `cloned_from` metadata. Response: `{"status": "abandoned", "abandoned_reason": "…"}`.

### 🔒 `POST /restoration/projects/{project_id}/reopen` — reopen from CLOSED (FR-035)

Body: `{"reason": str}` (required). Only from `closed` → `manifest_locked`. Prior candidates/purchases/tokens are preserved; sourced parts are marked `previously_sourced`; records `reopened_from` + a `prior_run_summary` and writes `project_reopened`. Errors: 409 `invalid_transition` (not closed).

### 🔒 `POST /restoration/projects/{project_id}/park` / `unpark` — hold a job

`park` body: `{"reason": str}` → `{"status": …, "parked": true}`. A parked project rejects every transition except abandon with 409 `project_parked` naming the reason. `unpark` clears the flag → `{"status": …, "parked": false}`. Park is an orthogonal flag, not a state — the job's spine position is preserved.

---

## Guide tokens (FR-039/FR-040/FR-041)

All token routes are operator-authenticated; the mechanic side is `GET /guide/{token}` above.

### 🔒 `POST /restoration/projects/{project_id}/tokens` — mint

Body: `{"assembly_id": str (required), "bundle_version": int (default 1)}`. Token: 32-byte URL-safe random; expiry = now + `token_expiry_days` (default 30). Response **201**:

```json
{"token_id": "XNp777Pww3Owa3s8kEc5trKj14dOLTSJXeoi0txEjHc", "project_id": "rest-85516a12", "assembly_id": "front-brakes", "bundle_version": 1, "minted_at": "…", "expires_at": "…", "revoked_at": null, "superseded_at": null, "access_count": 0}
```

Errors: 400 `missing_field`.

### 🔒 `DELETE /restoration/projects/{project_id}/tokens/{token_id}` — revoke

Response: `{"revoked": "<token_id>"}`; writes `guide_token_revoked`. Errors: 404 `token_not_found`.

### 🔒 `DELETE /restoration/projects/{project_id}/tokens` — bulk revoke

Revokes every un-revoked token for the project. Response: `{"revoked_count": 3}`.

### 🔒 `POST /restoration/projects/{project_id}/tokens/{token_id}/supersede` — supersede

Marks the token superseded (by operator id); the old guide keeps serving with the `X-Guide-Superseded: true` header. Response: `{"superseded": "<token_id>"}`.

### 🔒 `POST /restoration/projects/{project_id}/tokens/{token_id}/extend` — extend expiry

Body: `{"extends_days": int}` — 1..365 (`token_extend_max_days`), default 30; 400 `invalid_extension` outside. Keeps the same token string (printed QR stays valid); writes `guide_token_extended` with actor + new expiry. Response: `{"token": {…, "expires_at": "…"}}`.

---

## API cost (FR-051/FR-065)

### 🔒 `GET /restoration/projects/{project_id}/api-costs` — spend summary

```json
{"total": 0.0, "per_provider": {}, "ceiling": 100.0, "pct_of_ceiling": 0.0}
```

The ceiling is per-job (default $100, `restoration_api_cost_ceiling_usd`), separate from the parts budget: 80% warning, 100% blocks new API-incurring tasks. Pricing table: config `restoration_api_pricing` (`bfl.image_generation` $0.05, `meshy.mesh_generation` $0.20, `llm.vision` $0.02, `llm.sourcing` $0.01, `tts.tts` $0.015).

### 🔒 `POST /restoration/projects/{project_id}/api-cost/override` — ceiling override

Body: `{"reason": str}` (required). Writes `api_cost_ceiling_overridden` and unblocks. Response: `{"override_record": {…}}`. Errors: 400 `reason_required`.

---

## Reconciliation (FR-067/FR-028)

### 🔒 `POST /restoration/reconcile/{run_id}` — on-demand reconcile

Runs the same repair the boot sweep does for one run: interrupted-task marking, `sourcing.json` rebuild, status correction toward the latest SQLite stage event, event-log divergence import/export, budget-override audit check. Response:

```json
{"reconciled": true, "discrepancies_fixed": ["sourcing_json_rebuilt_from_sqlite"], "divergence": {"imported": 0, "exported": 0}}
```

Never raises; fixes are also logged as `crash_reconciliation_sync` events.

---

## Source registry (FR-012)

The curated vendor directory backing tier-1 sourcing. Persisted in `orchestrator/prompts/packs/restoration_sources.yaml` (seed: Hemmings, Classic Industries, RockAuto, plus a trade-partner contact with `search_template: null`).

### 🔒 `GET /restoration/sources` — list

```json
[{"source_id": "hemmings", "vendor_name": "Hemmings", "url": "https://hemmings.com/search", "search_template": "https://hemmings.com/search?q={part_name}+{vehicle_make}+{vehicle_year}", "specialty": "classic car parts marketplace", "is_trade_partner": false, "contact_info": null, "rate_limit_seconds": 5}, …]
```

### 🔒 `POST /restoration/sources` — add

Body: `SourceRegistryEntry` fields (`source_id`, `vendor_name` required; `url`, `search_template`, `specialty`, `is_trade_partner`, `contact_info`, `rate_limit_seconds` default 2). Response **201**: `{"source_id": "…"}`. `search_template` placeholders: `{part_name}`, `{oem_number}`, `{vehicle_make}`, `{vehicle_model}`, `{vehicle_year}` — interpolated by the research primitive, never by this module. Entries with `search_template: null` are trade-partner contacts the primitive skips. Errors: 400 `duplicate_source_id`.

### 🔒 `PUT /restoration/sources/{source_id}` — update

Same body; replaces fields. Response: the updated entry. Errors: 404 `source_not_found`.

### 🔒 `DELETE /restoration/sources/{source_id}` — remove

Response: `{"deleted": true, "source_id": "…"}`. Errors: 404 `source_not_found`.

---

## Knowledge base (FR-049/FR-056)

The reference KB: 205 seeded parts across 10 categories and 19 vehicle combinations (`orchestrator/prompts/packs/restoration_kb.yaml`, seeded from the committed CSV by `scripts/seed_restoration_kb.py`).

### 🔒 `GET /restoration/kb/entries` — list/query

Query: `?make=&model=&year=` (exact-match filters). Response: flat array of entries:

```json
[{"make": "Chevrolet", "model": "Camaro", "year": "1967", "part_id": "chevy_camaro_1967_brake_front_brake_caliper_a", "name": "Front Brake Caliper", "oem_number": "5460007", "aftermarket_alternatives": ["PBR-7606", "A1-Cardone-31487"], "category": "brake", "criticality": "critical", "reference_dimensions_mm": {"length": 180.0, "width": 95.0, "height": 120.0}, "indicative_price_range_usd": {"min": 51.0, "max": 205.0, "mid": 128.0}, "interchange": ["1966-1968 Camaro", …]}, …]
```

### 🔒 `POST /restoration/kb/entries` — add

Body: a `ReferenceKBEntry` (`part_id`, `name`, `category` required; category must be one of the 10 taxonomy values). Response **201**: `{"part_id": …}`. Operator entries are stored in the KB YAML's `operator_entries` list. Errors: 400 `invalid_payload` (e.g. unknown category — the message lists valid values), 400 `duplicate_part_id`.

### 🔒 `PUT /restoration/kb/entries/{part_id}` — update

Response: the updated entry. Errors: 404 `kb_entry_not_found`.

### 🔒 `DELETE /restoration/kb/entries/{part_id}` — remove

Response: `{"deleted": true, "part_id": "…"}`. Errors: 404 `kb_entry_not_found`.

### 🔒 `POST /restoration/kb/approve` — approve an auto-extraction proposal

Body: `{"proposal_id": str}` (required, 400 `missing_field`). Approves a `kb_proposals` row (created by manifest lock / purchase receipt) into the KB YAML and marks it `approved`. Response: `{"entry": {…}}`. Errors: 404 `proposal_not_found`; re-approving an already-approved proposal fails with 400 `duplicate_part_id` (its entry is already in the KB).

---

## Provider management (FR-050/FR-066)

Explicit operator write actions over provider posture (the U7 Engine Room backs these). Posture is process-local in this build (a `_provider_status` dict that resets on restart); each action writes a structured line to the process log (`provider_paused` / `provider_resumed` / `provider_failover` / `provider_rechecked` — log lines, not SQLite events, in this build). All four require a non-blank `provider` (400 `missing_field`).

### 🔒 `POST /restoration/provider/pause`

Body: `{"provider": str}` → `{"status": "paused", "provider": "bfl", "affected_jobs": 0}`. `affected_jobs` counts tasks pending/running across every project. Blocks new dispatches to the provider; in-flight complete.

### 🔒 `POST /restoration/provider/resume`

Body: `{"provider": str}` → `{"status": "resumed", "provider": "bfl"}`.

### 🔒 `POST /restoration/provider/failover`

Body: `{"provider": str, "fallback": str}` (both required) → `{"status": "failed_over", "provider": "bfl", "fallback": "fireworks"}`. New dispatches route to the named backup.

### 🔒 `POST /restoration/provider/recheck`

Body: `{"provider": str}` → `{"status": "healthy", "provider": "bfl"}` (`"paused"` when the provider is still in the paused set). Clears the provider from the posture map and reports the resulting posture.

---

## The sourcing primitive (library contract)

`orchestrator/core/research_primitives.py::research_part_sourcing` — the FR-012 contract, used by the hunt and hermetically testable:

```python
def research_part_sourcing(
    query: PartSourcingQuery,
    source_registry: list[SourceRegistryEntry],
    bridge_dispatcher: Callable[..., Any],   # injected; (kind, payload, timeout_s) -> dict | list
    clock: Optional[_Clock] = None,          # injected for deterministic tests
    per_query_timeout_s: float = 30,
    min_registry_candidates: int = 3,
) -> dict  # {"part_id", "candidates": [...], "unsourceable": {...} | None, "errors": [...]}
```

- `bridge_dispatcher("registry_query", {"url", "source_id", "query"}, timeout)` for each registry entry with a `search_template` (RFC 3986 interpolation; null `oem_number` removes the token — sole-param dropped, compound collapsed); `clock.sleep(rate_limit_seconds)` between queries to the same source.
- `bridge_dispatcher("llm_search", {part, vehicle, budget…}, timeout)` only when the registry yields < 3 candidates.
- Anything unparseable → a `unstructured_lead` candidate (never priced, never counted as system coverage).
- Dedup `part_id + vendor + oem_number + price ±5%` pairwise. Over-budget candidates are dropped; if they were the only options the part is unsourceable with reason `exceeds_budget` (cheapest named in the suggestion).
- Retries: 3 at 2/4/8 s backoff on `BridgeTimeoutError` / `RateLimitExceeded`; `BridgeUnavailableError` is non-retryable; exhausted retries → `no_vendor_response`.
- Output is schema-validated before return (`manual_entry` provenance is rejected — OBL-22).
- Error taxonomy: `BridgeTimeoutError` (retryable), `BridgeUnavailableError` (non-retryable, surfaces to U7), `ParseError` (→ `unstructured_lead`), `RateLimitExceeded` (wait + retry).

In this standalone build the pipeline's dispatcher raises `BridgeUnavailableError("no bridge configured (sandbox mode)")`, so live hunts complete with flags and zero bridge-discovered candidates — the honest degraded mode. A runnable offline demo: [examples/04_research_primitive.py](examples/04_research_primitive.py).

## Spec routes NOT yet implemented

The frozen spec's REST table ([specification/SPECIFICATION.md](specification/SPECIFICATION.md) §5) includes Phase 4–6 routes this backend does **not** register today. Calling them returns 404 `not_found` (`"No route POST /restoration/projects/…"`). The React UI gates these surfaces on capabilities instead of hiding the gap.

| Spec route | Purpose (spec-future) |
|---|---|
| `POST /restoration/projects/{id}/parts/{part_id}/dimensions` | Operator-supplied reference dimensions (FR-060) |
| `POST /restoration/projects/{id}/generate_3d` | 3D mesh generation task (FR-016) |
| `GET /restoration/projects/{id}/assemblies` | Walkthrough assemblies + bundle versions |
| `GET /restoration/projects/{id}/assemblies/{assembly_id}/assets/{filename}` | Guide bundle asset serving (GLB/MP3/PNG/TXT) |
| `POST /restoration/projects/{id}/assemblies/manual` | Manual assembly creation (UI-side S-7) |
| `POST /restoration/projects/{id}/assembly/graph` | Confirm assembly graph |
| `POST /restoration/projects/{id}/publish` | Publish guide bundle (+ token) |
| `POST /restoration/projects/{id}/export-artifact` | Customer-facing PDF export (FR-055) |
| `GET /restoration/insights` | Shop Insights aggregation (U8) |
| `GET /guide/{token}/bundle`, `POST /guide/{token}/flags` | Token-scoped guide data + flag submission |

## Events

State-changing routes write audit events to the canonical SQLite `events` table (mirrored to `events.jsonl`, rotated at 10 MB × 5). Each row: `{event_id, project_id, event_type, timestamp, actor, metadata}`. Verified emitted by this build (grep the source: `write_event` calls in `orchestrator/core/`):

- **Lifecycle:** `restoration_stage_changed`, `project_abandoned`, `project_reopened`, `intake_upload`
- **Tasks:** `async_task_cancelled`, `async_task_interrupted`, `async_task_resumed`
- **Hunt:** `sourcing_manual_added`, `sourcing_hunt_completed` (carries `outcome: completed|timeout|insufficient`, `status_after`, part counters), `sourcing_hunt_timeout`, `hunt_paused`, `hunt_resumed`, `hunt_sealed`, `hunt_sealed_partial_acceptance`, `hunt_seal_insufficient`, `hunt_seal_cost_gate_failed`
- **Tokens:** `guide_token_revoked`, `guide_token_superseded`, `guide_token_extended`
- **Money:** `negotiation_status_changed`, `api_cost_ceiling_warning`, `api_cost_ceiling_reached`, `api_cost_ceiling_overridden`
- **Flags:** `mechanic_flag_submitted`, `mechanic_flag_resolved`
- **Reconciliation:** `crash_reconciliation_sync`, `event_log_divergence`, `reconciliation_warning`

Signals that exist as **log lines** (not SQLite events) in this build: `provider_paused` / `provider_resumed` / `provider_failover` / `provider_rechecked` (`log.info`), `kb_entry_added` (`log.info`), `stale_lock_cleared` (`log.warning`), `kb_load_error` (returned error detail). Spec event names for Phase 4–6 surfaces (`guide_published`, `mesh_qa_*`, `sourcing_candidate_found`, `sourcing_unsourceable`, `api_cost_logged`, `mechanic_flag_synced`, `pdf_template_error`, `glb_decode_failure`) are not emitted yet — the spec's §8 list describes the finished product.
