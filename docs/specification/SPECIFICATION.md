# BUSINESS B13 — Build-ready product contract: Restoration Copilot

**Product:** Restoration Copilot (internal module name: `restoration`), a single-shop vehicle-restoration assistant that runs as an in-process extension of the shop's existing Sneferu orchestrator — this repository, `claudopus`. The terms "Sneferu" and "claudopus" refer to the same back-end throughout this document.

**Naming justification:** The system is a "copilot" because it structures the restoration workflow, automates identification, surfaces sourcing options, generates visual instructions, and delivers step-by-step guidance — while the operator retains all decision authority (budget, supplier selection, purchase, manifest approval, KB curation). "Copilot" = guided assistance with human command, not autonomous execution. This matches the B0 "balanced" risk posture.

**Competitive landscape and dated novelty boundary (as of July 2026 survey):** As of July 2026, no competing product was found that combines photo-based intake, automated identification, budget-constrained worldwide sourcing, vehicle-specific visual assembly guidance, smartphone-delivered narration, and learning loops into a single shop-specific tool. The following existing tools were surveyed: (1) ALLDATA DIY / Mitchell 1 — subscription repair databases for modern vehicles, not vintage-specific, no 3D guidance; (2) Haynes / Chilton manuals — printed step-by-step guides, no digital interactivity, no parts sourcing; (3) RockAuto / Classic Industries — parts catalogs with cross-reference, no restoration workflow or guidance; (4) eBay Motors — marketplace, no workflow integration; (5) generic 3D/CAD services (e.g., 3D printing bureaus) — no restoration workflow, not phone-delivered; (6) niche vintage-car forums and spreadsheet trackers — community knowledge and ad-hoc tracking, no integrated workflow or visual guidance. Comprehensive re-verification of this gap is tracked as A-012 with a re-survey cadence of every 6 months or before each major version release. The product does not claim to be a novel AI model or a novel algorithmic contribution. Its defensible advantage is the shop-specific learning ledger that grows with use — a data flywheel, not a technical moat. A competitor with the same API access and a similar workflow could replicate the integration; they would lack the accumulated shop-specific knowledge (pricing history, sourcing patterns, identification corrections). The PWA/Service Worker offline pattern is standard technology and is not claimed as novel. The reference KB is a structured dataset, not a novel data structure. The novelty claim is scoped to "vertical workflow integration for a domain with no purpose-built tooling as of the survey date" — a commercial positioning, not a technical innovation claim.

**System honesty — what the product is and is not:** The product is a coordination and learning copilot, not a fully automated pipeline. Many sourcing candidates will be operator-manual entries, especially in the first months. The product's value in that period is structured workflow, budget enforcement, audit trail, visual guidance, and the learning ledger that makes each subsequent job faster. The product becomes more automated as the KB grows and the learning ledger accumulates shop-specific patterns. If the unverified components (3D pipeline, TTS bridge, research primitive) are not production-ready, the product functions as a manual restoration tracker with structured data capture and 2D/audio guidance — still useful, but not the full vision. The contract does not guarantee production readiness of those components; it provides bounded defaults and tiered degraded-mode fallbacks for each. Each unverified component carries a pinned concrete default (not an "e.g." placeholder), a bounded assumption, and a defined fallback.

## 1. Product boundary and inherited decisions

**Who it serves and the job:**
- *Primary user:* the mechanic on the shop floor. Smartphone-fluent, no AI background, no interest in configuring anything. Job: put a specific photographed vintage car back together correctly, with parts already lined up and an expert voice walking each step. The mechanic is an empowered explorer, not a button-presser — the guide supports free exploration, glossary lookup, skip-ahead, problem flagging, and step-position persistence across tab close/reopen (see §2 U6).
- *Secondary user:* the solo owner-operator (B0 team capability: `solo`). Job: run intake, settle the identifications automation cannot, set the money ceiling, pick suppliers, conduct all negotiations and purchases personally, curate the reference KB, publish the guide, and review shop-level analytics that inform future bids.
- *Business frame (B0):* the software must help win restoration work and lighten daily workload. Risk posture `balanced` → money handling fails safe with an explicit, audited way through; everything else prefers momentum. API costs carry their own ceiling (FR-065) separate from the parts budget.

**B0 "win restoration work" trace (instrumented):** The product generates customer-facing artifacts from completed restorations: annotated before/after photo comparisons, 3D assembly screenshots, and a one-page restoration summary PDF (A4, 300 DPI, generated from the defined template `orchestrator/prompts/packs/restoration_pdf_template.json` via `reportlab`) exportable from U5 and U1 (FR-055). These give the operator proposal-ready evidence of the shop's process — a product mechanism, not a marketing aspiration. No separate sales, quoting, or CRM surface is built in v1.

**Operator workload model (addresses the solo-team vs. sourcing-automation tension):** The procurement workflow is split into stages, with explicit system/operator boundaries:

| Stage | Performed by | Rationale |
|---|---|---|
| Discovery (find candidates) | System + Operator | System runs tiered search in pinned order: (1) source registry templates queried through the bridge layer, (2) LLM-mediated web search through the configured reasoning bridge as fallback for parts with <3 registry candidates, (3) unstructured results flagged for manual entry. Operator can also add candidates from their own research (forums, swap meets, specialty rebuilders) |
| Source registry curation | Operator | Operator maintains trusted vendor URLs, search templates, and trade partners via U4; system reads the registry at sourcing time. The research primitive (not the restoration module) interpolates `PartSourcingQuery` fields into `search_template` placeholders (FR-012) |
| Outreach (contact vendor) | Operator | Operator clicks link/contact from candidate card; no automated emails in v1 |
| Negotiation (price, terms, trade) | Operator | Operator haggles directly; system tracks status per the pinned negotiation state machine (§3, FR-042) and notes only |
| Batch purchase (group buys) | Operator | Operator links multiple purchases via `batch_id`; system tracks the relationship |
| Commitment (place order, pay) | Operator | No autonomous buying per seed constraint |
| Receipt (receive, inspect) | Operator | Physical handling; `returned` / `disputed` statuses handle wrong or warranty parts |
| Record-keeping | System | System tracks all status changes, writes the audit trail, detects batch opportunities, and auto-extracts KB proposals from confirmed purchases |

**Procurement tier order (pinned):** The research primitive queries sources sequentially, not in parallel: (1) for each part, query every entry in the source registry (`restoration_sources.yaml`) that has a `search_template` using each entry's `search_template` with substituted fields from `PartSourcingQuery`; registry entries without a `search_template` (e.g., trade-partner phone contacts) are skipped by the research primitive and surfaced in U4 as manual-contact sources; (2) deduplicate candidates by `part_id + vendor + oem_number + similar price (±5%)`; (3) if the registry yields <3 candidates for that part, issue an LLM-mediated web search through the configured reasoning bridge for additional candidates; (4) flag unparseable results as `unstructured_lead` for manual entry. Rate limit: 1 request per source per `rate_limit_seconds` (default 2 s, from `SourceRegistryEntry`), applied as a per-source sleep inside the research primitive, enforced sequentially per project (no concurrent sourcing across parts within one project). **Global concurrency limit:** maximum 1 concurrent sourcing task per project, 3 concurrent sourcing tasks across all projects (FR-069). **Hunt-level timeout:** `hunt_timeout_seconds` (default 3600 s, configurable in `defaults.yaml`) — if the hunt exceeds this wall-clock duration, it halts with partial results, writes `sourcing_hunt_timeout` event, and the project transitions to `SOURCING_INSUFFICIENT` with preserved partial candidates (FR-070). This sequential order is testable: AC-008 verifies with a mock primitive that candidates from the registry tier appear before LLM-search candidates.

**Positioning acknowledgment:** When 50%+ of sourcing candidates are operator-manual entries (likely in the first months), the product functions primarily as a coordination and audit tool for operator-performed sourcing. This is the honest operating mode, stated explicitly. The value in this mode is structured manifest management, budget enforcement, candidate tracking, negotiation record-keeping, guide generation, and the learning ledger. Automated coverage increases as the source registry and KB grow. The system-discovered coverage metric (AC-008) and the total-viability metric including manual entries (AC-038) are reported separately so the operator always knows how much automation is actually working.

**Trade partner model:** The source registry includes `is_trade_partner` entries where the operator records trusted vendors, swap-meet contacts, and specialty rebuilders (with `contact_info`). Entries without a `search_template` are trade-partner contacts surfaced for manual outreach — the research primitive skips them (no URL to query), and U4 displays them in a "Trade Partners" sub-panel with click-to-call/click-to-email links. Candidates sourced from trade partners (via manual entry) carry a `trade_partner_id` reference. This is a lightweight directory that grows with use, not a CRM.

**Learning ledger (intelligence accretion):** Every operator correction and job outcome feeds back through a `feedback_signals` store. Three signal types are captured:
1. **Identification corrections:** when the operator resolves a review case, the before/after values, vehicle make/model/year, part category (denormalized at signal-creation time), and KB match (if any) are recorded. Future identifications for similar parts bias confidence upward when historical agreement is high and bias toward operator review when historical disagreement is high.
2. **Sourcing selections:** when the operator selects a candidate, the vendor, price, and condition are recorded; vendors with high selection rates rank first in future candidate lists.
3. **Purchase outcomes:** final prices (including negotiated discounts) are recorded; future cost estimates use the median of historical purchase prices for the same part/vehicle combination, weighted by recency.

**Learning-ledger biasing formulas (pinned, implementable, auditable):** The biasing mechanism is a frequency-weighted adjustment implemented in pure Python with SQL queries — not a machine learning model. FR-066 makes this a functional requirement; AC-044 verifies it with worked inputs.

```
Identification confidence adjustment:

  IF total_corrections < minimum_samples:
    adjusted_confidence = base_confidence   (no adjustment, no computation)
  ELSE:
    adjusted_confidence = base_confidence + K * (agreement_rate - 0.5)

Where:
  K = 0.2 (sensitivity constant, configurable in defaults.yaml)
  agreement_rate = (matching_corrections + 0.5 * partial_corrections) / total_corrections
    — matching = system's original identification matched the operator's final value
    — partial  = same category, different specific part/condition
    — sample   = all corrections for the same part category and vehicle make/model/year
  minimum_samples = 5 — below this, no adjustment (base_confidence used as-is).
                    When total_corrections == 0, the guard fires and
                    adjusted_confidence = base_confidence (no division by zero).
  recency weight    = 0.95 ^ months_old per correction; corrections older than
                      12 months are excluded from the sample
  clamping          = adjusted_confidence is clamped to [0.0, 1.0]
  auditability      = every adjusted confidence carries a biasing_context object
                      {sample_count, agreement_rate, K, decay_factor, adjusted_value}
                      in the identification output so the operator can see why a
                      confidence was raised or lowered

Sourcing vendor ranking:

  vendor_rank_score = selection_count_weighted + recency_bonus

Where:
  selection_count_weighted = Σ(recency weight_i) over historical selections of vendor
  recency_bonus = 0.1 if vendor selected in last 30 days, else 0

Cost estimation:

  estimated_cost = weighted_median(historical_purchase_prices, recency_weights)

Where:
  sample = all recorded prices for same part + vehicle make/model/year
  minimum 3 purchase records required; otherwise KB indicative_price_range_usd.mid
```

Feedback signals are written per job and consolidated in a shared store (`runs/restoration_feedback.db`, SQLite WAL mode) so learning accumulates across runs. The `FeedbackSignal` record carries a denormalized `category` field (populated from the manifest at signal-creation time) to prevent learning-ledger misattribution when manifest categories change after the signal was recorded.

**KB population — three paths (bootstrap, auto-extraction, curation):** The KB is not shipped empty. (1) A bootstrap script (`scripts/seed_restoration_kb.py`) populates an initial dataset at install time from a bundled static CSV (`orchestrator/prompts/packs/restoration_kb_seed.csv`, ≥205 entries covering brake, suspension, engine, body, interior, electrical, exhaust, fuel, cooling, and transmission parts for the most common American vintage vehicles: 1960s–70s Camaro, Mustang, Charger, Chevelle, Nova, C10). The seed CSV is committed to the repository — a one-time offline import, not a runtime API dependency. The 13-column CSV schema and per-category minimum entry counts are defined in §5; the bootstrap script validates the counts and fails with a non-zero exit code if any category is under its minimum, and `scripts/validate_kb_seed.py` independently re-checks entry count, non-empty OEM numbers, price ranges, per-category minimums, **and duplicate `part_id` uniqueness** after seeding. (2) Auto-extraction: when the operator locks a manifest or records a purchase, confirmed parts with no KB entry are proposed as KB additions; the operator approves or rejects them in U3's KB sub-panel. Approved entries are written to `restoration_kb.yaml` and loaded on next workflow start. This is the primary KB growth mechanism — the system proposes, the operator approves. (3) Manual curation via U3 and the KB REST endpoints (FR-049).

**Cold-start pricing acknowledgment:** For vehicles not covered by the seed KB (e.g., a 1957 Bel Air), the budget ruling (FR-009) will return `INSUFFICIENT_DATA` because all estimated costs are null. The operator must supply manual cost estimates or rely on the learning ledger's historical purchase data (which is empty for a new vehicle type). This is the honest cold-start state; the budget ruling surfaces it explicitly rather than fabricating numbers. The pricing "novelty" is a data-accumulation play: the system's pricing improves as the shop completes jobs. A-011 validates KB seed coverage; A-014 tracks cold-start pricing behavior.

**Currency decision:** v1 is USD-only. The data model uses `budget_ceiling_usd` and `price_usd` throughout. Multi-currency support is a future enhancement.

**API cost ceiling (B0 balanced posture):** API costs (BFL, Meshy, LLM, TTS) are tracked per job (FR-051) and excluded from the parts budget. A configurable per-job API cost ceiling (default $100, `defaults.yaml::restoration_api_cost_ceiling_usd`) provides the API-cost analog of the parts-budget enforcement: at 80% of ceiling, U4 and U1 show a warning; at 100%, new async tasks that would incur API costs are blocked, and the operator must override (reason + audit event `api_cost_ceiling_overridden` written to the SQLite `events` table) to proceed (FR-065). **Calibration note:** the $100 default is a starting safety bound for small jobs. A 200-part restoration with 3D mesh generation, BFL image generation, Meshy meshing, OpenAI TTS, and LLM vision calls may exceed $100. The ceiling is configurable per job via `POST /restoration/projects/{id}/api-cost/override` and should be scaled with manifest size: a rough estimate is $0.50–$2.00 per part for identification + sourcing, $5–$15 per sub-assembly for 3D generation, and $0.10–$0.50 per step for TTS. A future enhancement (A-016) will auto-scale the ceiling based on manifest size. The ceiling is a guardrail, not a budget — it prevents runaway costs, not normal operation.

**HEIC/WebP storage policy (pinned):** HEIC files are transcoded to JPEG at upload time via `pillow-heif` (quality 85) for thumbnails; the original HEIC is preserved in `intake/photos/` byte-identical to the upload. WebP files are preserved as-is (universally supported by modern browsers). JPEG and PNG are preserved as-is. The vision pipeline consumes JPEG thumbnails from `intake/thumbnails/`, never HEIC originals (FR-002). The mobile guide serves JPEG thumbnails and WebP/JPEG/PNG originals — never raw HEIC — so Chrome and other non-HEIC browsers render correctly. `photo_refs` stores the relative path to the original file; the format is determined by file extension at serve time with correct `Content-Type` headers (FR-061). This policy is tested by AC-003. *Design rationale: preserving the original upload byte-identically keeps the intake auditable (SHA-256 verifiable evidence for insurance, dispute, and before/after artifact use) while the vision and guide pipelines consume only universally decodable derivatives.*

**Authority status of upstream artifacts:**

| Artifact | Status | Handling in this contract |
|---|---|---|
| B0 operator intent | Present and binding (goal, solo team, balanced risk) | Traced to §2, §4, §8, §10, §11 |
| B2 evidence ledger | C-001 [operator_assumption]: "Anything associated with fixing up and restoring classic cars." Provenance is `operator_assumption`, not verified fact; honored as the domain boundary and nothing more. | §1 boundary; §4 domain scoping |
| B1, B6, B7, B8, B9, B10, B11, B12 | Declared absent (commercial evidence gaps) | Not silently converted to requirements. The Derived Build Seed is adopted as the working slice definition and labeled `[seed-derived]` where it is the sole authority. |

**IN scope `[seed-derived]`:**
1. Photo and parts-list intake yielding a tagged inventory of the car's current condition plus an itemized full-restoration manifest. Automation settles the large majority of parts; people touch only the cases automation genuinely cannot. A confidence threshold (FR-004, pinned at 0.70 default, 0.85 in VLM-only mode) separates auto-accept from review.
2. Worldwide sourcing under a firm budget ceiling with per-part budget allocation (FR-012): an affordability ruling comes before any hunt; purchasable and tradeable candidates are found inside budget via a tiered source-registry-first + research-primitive-fallback approach; anything unsourceable carries a coded reason, suggested substitutes, and — where producible — a 3D fabrication reference. A post-sourcing cost gate (FR-052) prevents total selected spend from exceeding the budget. Every negotiation and purchase is executed by the operator, by hand. Operator-manual candidate entry is a first-class workflow, not a fallback. System-discovered coverage (≥50%, AC-008) and total viability including manual entries (≥90% outcome forecast, AC-038) are reported separately.
3. Vehicle-specific visual assembly guidance with tiered degradation (FR-044): full 3D (static-per-step GLB via the frozen game-pipeline route, 3–5 step positions per sub-assembly) → single exploded-view GLB with callout navigation → auto-generated 2D annotated diagrams → text + audio. Visual guidance never disappears entirely while any visual asset exists.
4. Phone-delivered installation guidance: the mechanic taps to move step to step in guided mode, or switches to free-explore mode to orbit/zoom the assembly, browse all steps, and look up glossary terms. Each step pairs its visual view with narration (OpenAI TTS `tts-1`, voice `alloy`, normalized to -16 LUFS via `pyloudnorm`) describing the action, tool callouts, part callouts, and safety warnings. The guide is offline-capable after initial preload via Service Worker caching with defined preload priority, speculative preload of the next 3 steps, a preload-time budget (≤30 s at 5 Mbps for a 20-step assembly), iOS Safari eviction recovery, and step-position persistence via IndexedDB.
5. Authentication, storage, and model orchestration ride the shop's existing Sneferu host.
6. A reference KB with three population paths: bootstrap seed (CSV schema and per-category minimums defined), auto-extraction from completed jobs, and operator curation.
7. A learning ledger that records operator corrections and outcomes and feeds back to bias future identifications, cost estimates, candidate ranking, and KB growth, using the concrete formulas in FR-066.
8. Shop-level analytics (U8) aggregating cost trends, supplier reliability, estimation accuracy, failure patterns, and KB growth.
9. Customer-facing artifact export for client proposals (A4 PDF, 300 DPI, defined template).
10. A curated source registry for trusted parts sources with pinned search-template interpolation.

**OUT of scope `[seed-derived]`:** resale platform or multi-tenant SaaS; autonomous buying, haggling, or trade execution; generic instructions untied to the photographed car; physical labor and mechanic certification; AR/webcam-overlay guidance — the phone camera is used at intake and for flag-a-problem photo documentation only; alternative 3D mesh methods outside the frozen game-pipeline route (unless the route is proven infeasible during spec validation, at which point the fallback is 2D annotated diagrams + text + audio, not an alternate 3D generator); Windows deployment (POSIX-only, FR-062); automated vendor outreach (v2 candidate); batch purchase optimization (v2 candidate); trade-partner relationship management beyond candidate-level tracking (v2 candidate).

**Committed calls where the drafts at the table split:**

1. **Deployment shape — one process inside the orchestrator host, POSIX-only.** A separate application tier with its own services, reverse proxy, and staging VM was proposed and rejected: it collides with the constraint that nothing outside Sneferu may be required, and a solo operator cannot babysit a service fleet. This product adds routes, pages, and a module to the existing FastAPI server, matching the house pattern visible across the API Surface (`GET /game-autopilot-ui`, `GET /build-board-ui`, etc.). Deployment is restricted to Linux/macOS because `fcntl.flock` is POSIX-only (FR-062). Single-worker uvicorn is a v1 implementation limitation (not a B0 constraint); the async task queue (FR-056) keeps the worker responsive. Multi-worker deployment would require a shared lock service for JSON writes — documented as a known limitation in FR-047 and tracked as A-015.

2. **Mechanic surface — a mobile browser page with offline Service Worker caching, reached by revocable token/QR.** The seed offered "webcam or mobile app"; the lightest changeable choice that still survives shop-floor conditions (unreliable Wi-Fi) is the browser page with a Service Worker. No app-store build, no mechanic login, no webcam-AR overlay. The phone camera is used at intake and for flag-a-problem documentation only. The Service Worker caches guide assets in priority order (HTML shell → text scripts → still images / 2D diagrams → audio → GLB) with speculative preload of the next 3 steps, a preload-time budget (≤30 s at 5 Mbps), iOS Safari eviction recovery, and a 40 MB bundle size budget. Per-token step-position persistence is stored in IndexedDB (FR-032) so the mechanic resumes at their last step on tab reopen.

3. **Sourcing — tiered approach with source registry; infrastructure/API distinction resolved.** The prior position forbade supplier APIs but allowed OpenAI/BFL/Meshy — an inconsistency flagged at the table. The resolved position: "no external infrastructure" means no new *running process the operator must manage* (database server, message broker); stateless API calls routed through Sneferu's existing bridge layer are the same pattern as BFL/Meshy/OpenAI and are permitted. A curated source registry (`restoration_sources.yaml`, a local YAML file) lists trusted vendor URLs, search templates, and forum endpoints. The `research` primitive is tiered with the pinned order from §1 ("Procurement tier order"): registry first, LLM-mediated web search fallback for parts with <3 registry candidates, `unstructured_lead` for parse failures. The LLM-mediated web search is characterized honestly: the configured reasoning bridge (OpenAIResponsesBridge or CoworkBridge) is prompted with a structured query (part name, OEM number, vehicle make/model/year, budget ceiling) and instructed to search vintage parts marketplaces and forums; the LLM generates search URLs and parses result descriptions from its training data and any web-browsing capability the bridge exposes — it does not issue direct HTTP requests `[unverified — A-010]`. No new infrastructure is introduced. The 90% sourcing coverage aspiration is retained as an outcome forecast (A-004); the system-property target is ≥50% system-discovered coverage (FR-013, AC-008) because that is what can be mechanically tested with a mock primitive; total viability including manual entries is measured separately (AC-038).

4. **3D readiness confronted with tiered fallback.** Current Runtime Truth marks the game line **NOT VERIFIED / NOT PRODUCTION-READY**. The contract does not halt on that; mesh publishing is gated behind a dimensional QA rung, and a four-tier fallback ensures visual guidance never disappears: (T1) full 3D static-per-step GLB when QA passes; (T2) single exploded-view GLB with callout-hotspot navigation when multi-mesh fails but single-mesh succeeds — the "advance" interaction becomes hotspot-to-hotspot highlighting rather than 3D position switching, explicitly documented so the interaction change is designed, not accidental; (T3) auto-generated 2D annotated diagrams (vehicle-specific, composited from the job's intake photos with callout labels, step numbers, and arrows via Pillow) rendered in a 2D canvas viewer when all 3D fails; (T4) text + audio only as last resort. If QA pass rate <30% across a sub-assembly, the operator can publish as T3. *Design rationale: drafts that honestly confronted the NOT VERIFIED status scored higher on risk awareness; the tiered fallback keeps a visual scaffold in every degradation.*

5. **Persistence — hybrid JSON + SQLite with boot-time crash reconciliation.** JSON for write-once artifacts (project, manifest, budget, assembly graph). SQLite for transactional state requiring incremental writes and concurrent access: sourcing ledger, negotiation records, purchase records, guide tokens, events, review log, async tasks, API costs, mechanic flags, KB proposals. SQLite is embedded (single file, no external service), satisfying the no-external-infrastructure constraint. The JSON index (`restoration_index.json`) is a U1 cache, not a source of truth — it is rebuilt from SQLite and project.json files by the boot-time reconciliation job if missing or corrupt. To close the dual-write crash-recovery gap, a boot-time reconciliation job (`orchestrator/core/restoration_reconcile.py`, FR-067) runs on server start: because SQLite is already the canonical store for transactional state (FR-028), the job rebuilds stale JSON snapshots from SQLite, corrects `project.json` status conflicts toward the latest SQLite `restoration_stage_changed` event, marks `running` tasks `interrupted`, and imports/exports event-log divergences in both directions. Every correction is logged (`crash_reconciliation_sync`, `event_log_divergence`) and surfaced in U1/U7 with an on-demand reconcile action — self-healing with visibility, not silent rewriting. *Design rationale: the hybrid approach keeps JSON artifacts diffable (operator can inspect them with standard tools) while SQLite handles concurrent transactional writes. The JSON index is explicitly a cache, not a parallel source of truth — it is always reconstructable from SQLite + project.json. The boot-time reconciliation closes the drift window. Eliminating JSON entirely would reduce diffability for the solo operator who benefits from readable artifacts.*

6. **Surface count — 3 effective surfaces, 8 panels.** The 8 panels (U1–U8) are tabbed sections within a single operator console HTML page. The effective surface count is 3: the operator console (with tabs), the mobile guide (U6), and the REST API surface. U8 (Shop Insights) addresses the analytics gap; U7 (Engine Room) is retained with explicit write actions (FR-050: pause/resume/failover/recheck) and a documented operator decision tree.

7. **Animation approach — static-per-step, not morph targets.** Morph targets are for vertex deformation, not rigid-body assembly. The approach: a static exploded-view GLB per sub-assembly plus sequential per-step static GLB meshes; the WebGL viewer displays the exploded view, then advances through install positions on each tap with client-side camera-path interpolation (orbit + zoom, not vertex deformation). 3–5 step positions per sub-assembly (exploded → positioning → install → torque/finishing), justified by the observed mechanic workflow: exploded view for orientation, positioning for alignment, install for seating, torque/finishing for final securement — fewer than 3 steps provides insufficient guidance for complex assemblies; more than 5 creates excessive fragmentation of a single procedure and exceeds Meshy's single-mesh output capacity and the iOS bundle budget. Each step position carries a `step_position_label` field in `WalkthroughStep` (e.g., "exploded", "positioning", "install", "torque") so the semantic meaning of each per-step mesh is explicit in the data model. If Meshy cannot produce spatially aligned multi-mesh outputs (A-008), tier T2/T3 fallbacks apply (call #4).

8. **TTS — OpenAI TTS `tts-1`, voice `alloy`, -16 LUFS normalization via `pyloudnorm`, async processing.** FR-019 specifies OpenAI TTS (`tts-1`, voice `alloy`) via a TTS dispatch path through the existing bridge layer. This is the pinned provider and model — not "e.g." Audio normalization to -16 LUFS via `pyloudnorm` (a mandatory post-bridge step — OpenAI `tts-1` does not guarantee exact LUFS natively) runs as an async background task and does not block guide publication — the guide is published with audio segments as they complete; un-normalized audio is served until the background job replaces it. The -16 LUFS target is encoded in the data model as `WalkthroughAssembly.audio_lufs_target: float = -16.0` and in `bundle_meta.json` as `audio_lufs_target: -16`. The target is configurable per shop via `defaults.yaml::audio_lufs_target` (default -16.0). **Fallback behavior (pinned):** if the TTS bridge is unavailable (bridge registration fails per A-007, or the OpenAI API returns errors, or the API cost ceiling is hit), the guide publishes as screen-only text (`audio_available: false` per step) — the text-only fallback is the documented default behavior when TTS is unavailable, not a degraded mode. There is no secondary TTS provider in v1; the text-only fallback is the complete fallback chain. A secondary TTS provider (e.g., Anthropic, local pyttsx3) is a v2 enhancement. Narration content per step is specified: action description, tool callout, part callout, safety warning (FR-019). A-007 carries the bridge-registration verification task; AC-039 tests LUFS compliance; AC-040 tests audio intelligibility in simulated shop noise.

9. **Task execution — async task queue with resume mechanism.** Long-running operations (identification, sourcing, 3D generation, TTS, audio normalization) run as async background tasks via `asyncio.create_task` within the single uvicorn worker, yielding the event loop between dispatches so U1–U7 remain responsive during 10–30 minute mesh generation. Tasks are persisted in the SQLite `tasks` table and polled via `GET /restoration/tasks/{task_id}`; on restart, `running` tasks are marked `interrupted` and can be resumed via `POST /restoration/tasks/{task_id}/resume` — which re-runs the task from the beginning (no partial-resume; checkpointing is a v2 enhancement) while preserving the original `task_id`, recording a `resumed_from` timestamp, and retaining the SQLite state from the prior partial execution — or re-triggered from U1. The resume endpoint is distinct from re-triggering: resume preserves the original `task_id`; re-triggering creates a new one.

10. **POSIX constraint.** `fcntl.flock` is POSIX-only; Windows is not supported in v1. When `os_supported: false` (detected via `fcntl` import failure), the restoration module refuses to create new projects — `POST /restoration/projects` returns 409 with `{"error": "os_not_supported", "message": "Restoration Copilot requires Linux or macOS for file locking. See FR-062."}`. Existing projects remain read-only (U1 displays them, but state-changing endpoints return 409). This prevents silent data corruption from missing file locks. The install contract (§7) states the precondition; `/restoration/health` reports `os_supported` and returns HTTP 200 with `os_supported: false` (not 500) when the OS is unsupported — a 500 would be misinterpreted by load balancers as a crash; the health endpoint is reporting a known, expected state, not a failure. A cross-platform locking library (`portalocker` or `filelock`) is a documented future enhancement, not a v1 requirement.

**Inherited-decision trace table:**

| Source | Decision (status) | Implemented in |
|---|---|---|
| B0 goal: win work + ease workday | Customer-facing artifact export (proposal-ready evidence) + guided workflow | §1 boundary; §2 U1, U5; FR-055; §3 journey |
| B0 `solo` | One person administers everything; zero staffing assumptions; staged workload model | §1 workload model; §2 permissions; §5 authZ; §8 ops |
| B0 `balanced` | Fail safe on money with documented, reversible override; post-sourcing cost gate; API cost ceiling + visibility | FR-009…FR-011, FR-051, FR-052, FR-065; AC-006, AC-007, AC-026, AC-034, AC-045 |
| B2 C-001 | Domain = classic-car fix-up and restoration (operator_assumption) | §1 boundary; §4 domain scoping; §5 reference KB |
| Seed deliverable 1 | Intake → tagged inventory + manifest | FR-001…FR-008; U2, U3 |
| Seed deliverable 2 | Affordability-first worldwide sourcing, manual purchase | FR-009…FR-015, FR-037, FR-042, FR-043, FR-045, FR-052; U4 |
| Seed deliverable 3 | Vehicle-specific meshes + walkthroughs, game route only, tiered fallback | FR-016…FR-020, FR-044, FR-058; U5 |
| Seed deliverable 4 | Touch-advanced narrated phone guide, offline-capable, free-explore, step persistence | FR-021…FR-025, FR-031, FR-032, FR-046, FR-053, FR-054; U6 |
| Seed deliverable 5 | Sneferu auth / storage / orchestration | FR-026…FR-030; §5 |
| Seed constraint: firm budget ceiling | Ruling before hunting; per-part allocation; post-sourcing gate; breach refuses unless overridden | FR-009…FR-012, FR-052 |
| Seed constraint: untrained mechanic | Plain words, big targets, narration-first, free-explore, glossary, skip-ahead, step persistence | U6; FR-024, FR-032, FR-053 |
| Seed constraint: game-pipeline-only meshes | Frozen provider route, no alternate generator; 2D diagram fallback | FR-016, FR-044, FR-058; §6 assets |
| Seed acceptance: ≥80% auto-ID | Outcome forecast (A-003), not system-property AC | §10 A-003; AC-004 [system] |
| Seed acceptance: ≥90% sourced | Split: ≥50% system-discovered (AC-008 [system]); ≥90% total viability incl. manual (AC-038 [outcome forecast A-004]) | §10 A-004; AC-008, AC-038 |
| Seed falsification: 3D dimensional sufficiency | Meshes match real vehicle geometry within tolerances | §10 A-001; AC-010, AC-022, AC-051 |
| Seed falsification: second-vehicle generalization | System works on a second, unseen vehicle | §10 A-006; AC-016 |
| Runtime Truth 2026-07-20 | 3D line not production-verified | QA rung FR-017; §10 A-001; tiered fallback FR-044 |
| API Surface | Operator sessions, `*-ui` pages, bridge health, service control | §2, §5, §7, §8 |
| Runtime Truth — Bridge Dispatch | CoworkBridge, GPTDesktopBridge, API fallback bridges | §5 integration |
| Runtime Truth — Process Lifecycle | `launch.sh` canonical, `launch-dev.sh` development | §7 start commands |

## 2. Product surfaces

All operator panels are modular HTML with ES module scripts, served by the existing Sneferu FastAPI server as new routes. The operator console is a single HTML shell (`restoration_copilot.html`) that loads panel-specific ES modules. The mobile guide is a separate HTML page (`bay_guide.html`) with its own ES modules and a Service Worker for offline caching. The third surface is the REST API (§5).

**U1 — Job Board (operator)**
- **Purpose:** List every vehicle job with state, headline metrics (automation coverage %, system-discovered sourcing coverage %, total sourcing coverage %, critical-path coverage %, mesh QA pass %, visual tier, API cost-to-date and ceiling status), and deep links into U2–U5, U7, U8; resume any interrupted job; abandon or reopen jobs; export customer-facing artifacts.
- **Entry point:** `GET /restoration-ui` (default landing).
- **Inputs:** Filters (state, date), job search.
- **Outputs:** Job cards with state badges, metric chips, "needs attention" markers (including open mechanic flags, interrupted tasks surfaced by crash reconciliation, and API cost ceiling warnings), navigation links, abandon/reopen actions, export-artifact action, task progress indicators for in-flight async operations.
- **Empty state:** First-run card pointing to U2 with a shot-list cheat sheet.
- **Loading state:** Skeleton cards while the job list loads from the `restoration_index.json` cache (rebuilt from SQLite + project.json if missing/corrupt).
- **Error state:** Jobs whose last stage parked surface a visible recovery action; if the index is missing or corrupt, U1 falls back to scanning `runs/*/restoration/project.json` and rebuilds the index.
- **Permissions:** Authenticated operator session (API Surface: `POST /admin/operator/session`).
- **Responsive/accessibility:** Desktop-first, fully usable on tablet; WCAG AA contrast; keyboard-complete navigation.

**U2 — Intake Bay (operator only, tablet-friendly)**
- **Purpose:** Create a job, push photo sets and parts lists, watch intake completeness.
- **Entry point:** Job Board → "New vehicle job".
- **Inputs:** Optional vehicle metadata (year/make/model/trim/engine), multi-file photo upload (JPEG/PNG/HEIC/WebP, ≤25 MB each, up to 50 per batch), parts-list upload (CSV, TSV, or free-text).
- **Outputs:** Job ID, per-file ingestion receipts (content hash, thumbnail path, stored format), parsed parts rows with per-row confidence, intake gap list.
- **HEIC/WebP storage policy:** HEIC files are transcoded to JPEG at upload time via `pillow-heif` (quality 85) for thumbnails; the original HEIC is preserved byte-identical in `intake/photos/`. WebP, JPEG, and PNG are preserved as-is. The vision pipeline consumes JPEG thumbnails, never HEIC originals (FR-002). The mobile guide serves JPEG thumbnails and WebP/JPEG/PNG originals — never raw HEIC — so all browsers render correctly. `photo_refs` stores the relative path; the format is determined by extension at serve time.
- **Empty state:** Shot-list guidance card with recommended angles.
- **Loading state:** Per-file progress indicators; resumable upload queue.
- **Error state:** Per-file rejection with reason (type, size, corrupt header — content-based, not extension-only); job-level banner when fewer than six usable frames remain.
- **Permissions:** Operator session only. The mechanic's only surface is U6 via token.
- **Responsive/accessibility:** Tablet-friendly layout; large touch targets (≥48 px); status never conveyed by color alone.

**U3 — Parts Bench (operator)**
- **Purpose:** Review the machine-built tagged inventory and draft manifest; settle only the review queue; lock the manifest; curate reference KB entries and approve auto-extracted KB proposals.
- **Entry point:** Job room → "Manifest" tab. KB management is a sub-panel within U3.
- **Inputs:** Identification output (per-part tags with confidence, `biasing_context` where adjusted, and evidence-photo refs), reference-KB matches, review cases, KB entry add/edit forms, proposed KB entries.
- **Outputs:** Confirmed/edited lines, review-case resolutions (with audit delta in the SQLite `review_log` table), the locked manifest version with its automation-coverage metric, KB entry list with add/edit/delete actions, KB proposal accept/reject actions.
- **Review confidence threshold (pinned):** Parts with `confidence < 0.70` route to the review queue. When VLM-only mode is active (no KB match for the vehicle), the threshold is raised to `0.85`; parts identified VLM-only with `confidence < 0.50` are additionally tagged "low confidence — VLM only". The threshold is configurable in `defaults.yaml::restoration_confidence_threshold` (default 0.70) and `defaults.yaml::restoration_vlm_only_threshold` (default 0.85).
- **VLM-only indicator:** When no KB entry exists for the vehicle, a persistent banner reads "VLM-only mode — no reference KB data for this vehicle. Identification confidence may be less reliable. Budget ruling will likely return INSUFFICIENT_DATA; consider entering manual cost estimates."
- **Hallucination defense:** Identified part names are cross-checked against the built-in category taxonomy (brake, suspension, engine, electrical, body, interior, exhaust, fuel, cooling, transmission) and a validation pattern; non-matching names are flagged for review regardless of confidence with a "possible hallucination" note.
- **KB management sub-panel:** Add/edit/delete KB entries via the FR-049 endpoints; proposed auto-extracted entries (from resolved review cases and purchase records) appear with accept/reject actions.
- **Empty state:** "Identification hasn't run" with the run control.
- **Loading state:** Per-photo-batch progress via task polling; interim results accessible as they complete.
- **Error state:** Per-photo identification failure with retry; no photo ever silently dropped.
- **Permissions:** Operator session.
- **Responsive/accessibility:** Table and list views; confidence shown as text plus icon (never color alone); keyboard-navigable rows.

**U4 — Wallet Desk (operator)**
- **Purpose:** Set the budget (USD only), read the affordability ruling, manage the source registry, run the worldwide hunt, review candidate cards and unsourced flags, manually add candidates, record negotiation status and purchase outcomes, accept partial sourcing coverage with explicit acknowledgment, view per-job API cost tracking and ceiling status, and clear the post-sourcing cost gate.
- **Entry point:** Job room → "Budget & sourcing" tab.
- **Inputs:** Budget amount (USD), critical-part policy, the override action, manual candidate entries, negotiation status updates, purchase outcome records, source registry edits (add/edit/disable sources), API cost ceiling override.
- **Outputs:** Ruling (`AFFORDABLE` / `TIGHT` / `SHORTFALL_CRITICAL` / `INSUFFICIENT_DATA`) with roll-up detail and `unknown_cost_count`; per-part budget allocation display (critical 60% / standard 30% / optional 10% of pool); candidate cards; unsourced flags; live hunt coverage shown as a system-discovered vs. total (including manual) split; critical-path coverage; negotiation status board; batch purchase opportunity cards; running total of actual spend vs. budget; per-job API cost summary ("API costs for this job: $X.XX / $Y.YY ceiling") with per-provider breakdown, 80% warning badge, and 100% blocking message; post-sourcing cost gate (sum of selected candidate prices vs. ceiling).
- **Budget-ruling thresholds (pinned):** `total_estimated_cost ≤ 80% of ceiling → AFFORDABLE`; `> 80% and ≤ 100% of ceiling → TIGHT`; `> 100% of ceiling → SHORTFALL_CRITICAL`; `unknown_cost_count > 30% of total parts → INSUFFICIENT_DATA` (null costs excluded from sum, not zeroed). Thresholds are configurable in `defaults.yaml::restoration_budget_affordable_pct` (default 0.80) and `defaults.yaml::restoration_budget_tight_pct` (default 1.00).
- **Real-time partial results:** During the hunt, candidates appear as they arrive (not only after all queries complete). The operator can pause and resume the hunt (`POST .../sourcing/pause`, `POST .../sourcing/resume`); paused hunt progress (which queries completed, which candidates were found) is preserved in SQLite. The hunt has a configurable wall-clock timeout (`hunt_timeout_seconds`, default 3600 s, FR-070) — if exceeded, the hunt halts with partial results and the project transitions to `SOURCING_INSUFFICIENT`.
- **Post-sourcing cost gate:** Before sealing, U4 displays the total of selected candidate prices vs. the ceiling; if the total exceeds the budget, sealing is blocked and the same override workflow as the pre-sourcing gate is offered.
- **Source registry panel:** Operator adds/edits/removes trusted source entries (vendor name, URL, search template, specialty, trade-partner flag, contact info, rate limit); registry persists in `restoration_sources.yaml`. The search template uses placeholders `{part_name}`, `{oem_number}`, `{vehicle_make}`, `{vehicle_model}`, `{vehicle_year}` — the research primitive (not the restoration module) consumes these templates, substituting fields from `PartSourcingQuery` at query time (FR-012). **Entries without a `search_template`** (e.g., trade-partner phone contacts) are displayed in a "Trade Partners" sub-panel with click-to-call/click-to-email links and are skipped by the research primitive (no URL to query).
- **Empty state:** "Set a budget to get a ruling" with input form.
- **Loading state:** Per-line hunt progress with partial results visible.
- **Error state:** Per-line hunt failure (retryable — distinct from *unsourced*); framework-unreachable blocking message.
- **Permissions:** Operator session; the override, registry edits, and API cost ceiling override write audit events (actor, timestamp, reason) to the SQLite `events` table.
- **Responsive/accessibility:** Desktop-first, readable on tablet; sortable columns; large status badges.

**U5 — Model Shop (operator)**
- **Purpose:** Review built meshes and QA receipts; confirm or adjust the drafted assembly graph; supply reference dimensions when KB is absent; publish the guide bundle; manage guide versions and tokens (including expiry extension for multi-month restorations); generate additional sub-assemblies; export customer-facing artifacts; review and resolve mechanic flags.
- **Entry point:** Job room → "3D & assembly" tab.
- **Inputs:** GLB QA receipts, the drafted assembly graph, operator-supplied reference dimensions, publish action, export action, flag resolution notes, token extension action.
- **Outputs:** Confirmed graph, per-part QA status and visual tier (T1/T2/T3), the publish action, per-assembly guide list with `bundle_version` history, token management (mint, revoke, supersede, bulk revoke, extend expiry), exported artifacts, flag review items.
- **Operator-supplied reference dimensions:** When no KB entry exists for a part, the operator enters `{length_mm, width_mm, height_mm}` via `POST /restoration/projects/{id}/parts/{part_id}/dimensions`. These are stored in `reference_dimensions_override.json` and used by the QA rung (precedence: KB → operator override → `unverified_dimensions`); QA receipts record `dimension_source`. If neither KB nor operator dimensions exist, the mesh publishes with `qa_status: "unverified_dimensions"` (the deviation check is skipped; the gap is logged and surfaced to the operator, not blocked).
- **Bundle version discovery:** The assembly list displays each assembly's current `bundle_version`; the token-minting form pre-fills it. Re-publishing auto-increments the version; prior tokens can be superseded (old guide remains accessible with a "newer version available" notice) or revoked.
- **Token expiry extension:** U5 shows each token's expiry date and surfaces an "extend expiry" action when expiry is within 7 days. For multi-month restorations, the operator extends a token's expiry via `POST /restoration/projects/{id}/tokens/{token_id}/extend` with `{extends_days: int}` (default 30, max 365). The extension writes an audit event with actor, timestamp, and new `expires_at`, and keeps the existing token string (and printed QR) valid. This is distinct from supersession (a version change) and revocation (a kill).
- **Mechanic flag review:** Flags submitted by mechanics (FR-054) appear as review items in U5; the operator resolves via `POST /restoration/projects/{id}/flags/{flag_id}/resolve` with `{resolution_notes}`. Resolved flags that identify identification or sourcing errors are also written as `FeedbackSignal` entries to the learning ledger (type `identification_correction` or `sourcing_selection`), closing the loop between mechanic feedback and system learning.
- **Empty state:** "Nothing built yet" with the build control and provider posture.
- **Loading state:** Per-part pipeline progress (render → mesh → QA) via task polling.
- **Error state:** Per-part quarantine reason with rebuild control; "3D pipeline degraded" warning when QA pass rate <30%.
- **Permissions:** Operator session.

**U6 — Bay Guide (mechanic, smartphone) — the primary value surface**
- **Purpose:** Touch-advanced, narrated, visual installation steps for the exact car. Offline-capable after initial preload (≤30 s at 5 Mbps for a 20-step assembly). Guided mode (step-by-step) and free-explore mode (browse, orbit/zoom, glossary), skip-ahead, flag-a-problem, and step-position persistence across tab close/reopen.
- **Entry point:** QR code or short link, `GET /guide/{token}` — revocable, scoped to one published bundle version, no account, time-bounded expiry (30 days default, extendable per FR-040).
- **Inputs:** One-tap next/back, audio replay, free-explore toggle, glossary term tap, skip-ahead gesture (swipe left on step title to open the step list), "flag a problem" button.
- **Outputs:** Per-step screen — visual view (T1 WebGL 3D position, T2 exploded GLB with highlighted callout, T3 2D annotated diagram, T4 still image + text), narration for the full step, plain-language caption, tool/part chip; progress bar; completion screen.
- **Step-position persistence:** The current step index is stored in IndexedDB per token (`guide_progress` store: `{token_id, step_index, timestamp}`), written on every step advance. On tab close and reopen, the guide reads the stored index and resumes at that step. If the stored index exceeds the bundle's total steps (e.g., after a re-publish with fewer steps), the guide starts at step 0 and clears the stale entry. This is per-token, not per-mechanic (no login); IndexedDB is more persistent than the Service Worker cache under iOS Safari eviction.
- **Free-explore mode:** Mechanic toggles "explore" to orbit/pan/zoom the exploded-view assembly freely; part callouts are tappable to show part name, tool required, one-line description, and installation step number. All steps are browsable in an overview grid; an experienced mechanic can jump ahead. Dismissing explore returns to the current step.
- **Glossary:** Technical terms (wheel cylinder, master cylinder, torque wrench…) are underlined; tapping opens a plain-language definition popup. Terms come from the base glossary pack merged into `bundle_meta.json` at publish and are cached offline; the operator can add custom terms via U5.
- **Flag-a-problem:** Opens a small form: problem-type selector (wrong part shown, step unclear, tool missing, safety concern, other), free-text notes, an automatic screenshot of the current view (`canvas.toDataURL()`), and an optional phone-camera photo (`<input type="file" accept="image/*" capture="environment">`). The flag is queued in the IndexedDB `flag_queue` store (offline-capable) with the screenshot stored as a data URL, the photo as a Blob, and a `sync_status` field (`pending|synced|failed`). On reconnect, the Service Worker fires a `sync` event; the guide's `flag_sync.js` module reads the queue, POSTs each flag sequentially to `POST /restoration/projects/{id}/flags`, and removes it from the queue only on a 201 response. Failed syncs remain in the queue and retry on next reconnect. The mechanic sees "Problem reported. The operator will review." Resolved flags that identify errors feed into the learning ledger as `FeedbackSignal` entries (FR-054).
- **Empty state:** "Guide not published yet" (token valid, bundle missing).
- **Loading state:** Bundle preload with progress; assets cached by the Service Worker in priority order: (1) HTML shell + JS, (2) text scripts for all steps, (3) still images / 2D diagrams, (4) audio files, (5) GLB files. Speculative preload: during playback of step N, assets for steps N+1…N+3 are fetched. Cache refresh on connectivity return. **Preload-time budget:** ≤30 seconds over a 5 Mbps connection for a 20-step assembly with 3D assets. If preload exceeds this, the guide shows a "slow connection — loading" indicator and serves text + 2D diagrams first (best-effort partial preload) while heavier assets continue loading.
- **Minimum cache threshold:** The guide is marked "ready for offline" only when all text scripts and still images/2D diagrams are cached; GLB and audio are best-effort with per-step fallback.
- **Asset size budget:** Bundles target ≤40 MB per sub-assembly (below the ~50 MB iOS Safari PWA storage ceiling with headroom). Draco GLB compression (via `draco3d`) is applied automatically when a bundle exceeds 30 MB; audio is already 64 kbps mono. The operator is warned at publish time if the bundle exceeds 40 MB (iOS eviction risk) and offered a "compress assets" action. On iOS, if the bundle still exceeds 40 MB after compression, the Service Worker restricts offline caching to text scripts + 2D diagrams (GLB and audio fetched on demand when online). As a last resort the operator can publish a text + image bundle (≤15 MB) excluding GLB and audio.
- **Cache versioning and eviction (pinned):** The Service Worker cache name includes `bundle_version`. On a version increment, the prior version's GLB and audio assets are evicted on next activation (version-aware LRU); the current version's text scripts and 2D diagrams are always retained. Total cache size is bounded by the 40 MB bundle budget — not a fixed asset count — so a 20-step assembly with full assets always fits.
- **Mid-session offline degradation (pinned):** If connectivity drops after the bundle is loaded, the guide continues from cache; a persistent "offline" indicator appears in the UI header. If a required asset is missing from cache (e.g., a GLB that was not preloaded), the per-step fallback ladder fires: GLB → 2D diagram → still image → text-only. No wake-lock demands connectivity. The speculative preload of the next 3 steps continues from cache if those assets were already fetched; if not, the guide serves the best available tier for the next step. The mechanic is never blocked by a missing asset — text is always available from IndexedDB.
- **Superseded token UX (pinned):** When a mechanic accesses a superseded token, the server returns HTTP 200 with the old bundle plus an `X-Guide-Superseded: true` response header (the machine-readable signal the guide and Service Worker use to render the banner even when serving mixed cached/online content). The guide loads and renders normally, with a persistent banner at the top: "A newer version of this guide is available. Contact the shop operator for the updated link." The old guide remains fully functional — this is the safest default because a mechanic mid-procedure should not be disrupted by a version change. The banner is dismissible but reappears on next load.
- **Expired token UX (pinned):** When a mechanic accesses an expired token, the server returns HTTP 410 with a JSON body `{"error": "token_expired", "message": "This guide link has expired. Contact the shop operator for a new guide link."}`. If the guide was previously loaded and cached by the Service Worker, the cached version remains usable read-only (the mechanic can continue working), but a banner reads "This guide link has expired. Contact the shop operator to renew." The banner is non-dismissible. If no cached version exists, the mechanic sees the 410 error page with the contact message. Flag-sync POSTs authenticated with the expired token receive 410; queued flags remain in the IndexedDB `flag_queue` until a renewed token is provided.
- **Error state:** Asset failure shows retry plus the step's full text script and 2D diagram/still image — never a dead end.
- **Offline behavior:** Service Worker serves cached assets; IndexedDB stores the current step index per token, the flag queue (with screenshot/photo Blobs), and a redundant copy of all text scripts (iOS resilience). On tab reopen, the mechanic resumes at their last step.
- **iOS Safari cache eviction recovery:** Eviction is detected on load via `caches.match()` on the HTML shell. If the cache is gone and network is available, the guide shows "cache lost — reconnecting" and automatically re-preloads. If offline, it shows "Offline assets were cleared by your phone. Reconnect to Wi-Fi to reload the guide" with a reload button; text scripts in IndexedDB provide partial fallback.
- **Permissions:** Token only — no operator session. Token format: 32-byte random URL-safe string. Rate limiting: 60 requests per token per hour. Expiry: 30 days from minting, configurable, extendable. Revocation/supersession via U5 or REST. **Token security threat model:** the token URL may leak via browser history, server access logs, or referrer headers. Mitigations: (1) 30-day default expiry limits exposure window; (2) revocation and supersession are operator-initiated and immediate; (3) the guide contains no sensitive personal data — only vehicle-specific assembly instructions for a shop's own restoration; (4) access logs are per-run and operator-controlled; (5) the `Referrer-Policy: no-referrer` header is set on guide pages to prevent leakage if the mechanic clicks any external link; (6) token URLs are not indexed by search engines (the page includes `<meta name="robots" content="noindex">`). This is documented as the v1 threat model; device binding and one-time-use tokens are v2 enhancements.
- **Responsive/accessibility:** Mobile-first, one-hand targets ≥48 px, narration understandable with the screen pocketed, captions always present, screen wake-lock during playback (requires HTTPS or localhost — see A-009).

**U7 — Engine Room (operator, with explicit write actions and decision tree)**
- **Purpose:** Restoration-relevant provider posture and deep links into Sneferu's existing health surfaces. Operator can pause/resume provider routes, force-failover to backup bridges, clear error counters, and trigger health rechecks. These are explicit write actions — U7 is not surveillance-only. Event-log divergence and crash-reconciliation alerts also surface here.
- **Entry point:** Job room → "System" tab.
- **Provider mapping:**

| Provider | Primary bridge | Backup bridge | Affected stage | In-flight behavior on pause |
|---|---|---|---|---|
| Vision (identification) | Configured vision-capable route (CoworkBridge or AnthropicAPIBridge) | AnthropicAPIBridge → OpenAIResponsesBridge | Identification (J-2) | In-flight dispatches complete; new dispatches blocked |
| BFL (image generation) | BFL bridge `[unverified]` | FireworksBridge (image models) | 3D generation (J-6) | In-flight complete; new blocked; ETA shown for in-flight |
| Meshy (3D mesh) | Meshy bridge `[unverified]` | None (no alternative 3D provider in scope) | 3D generation (J-6) | In-flight complete; new blocked; U5 shows "3D generation paused" |
| Sourcing (research) | Configured LLM bridge (OpenAIResponsesBridge or CoworkBridge) | AnthropicAPIBridge | Sourcing (J-5) | In-flight complete; new blocked; partial results preserved |
| TTS | OpenAI TTS (`tts-1`, voice `alloy`) via bridge dispatch (A-007) | None (fallback to screen-only text) | Guide generation (J-6/J-7) | In-flight complete; new guides publish without audio |

- **Operator decision tree:** When a provider degrades: (1) U7 surfaces the blocked stage and affected jobs; (2) operator can pause (in-flight jobs complete, new jobs blocked); (3) operator can force-failover to the backup bridge (new dispatches route to backup); (4) operator can trigger a health recheck; (5) operator can resume. TTS pause degrades gracefully to text-only guides — no job is blocked. Each action writes an audit event with actor, timestamp, action, provider name, and affected job IDs. Jobs affected by a paused provider show a "needs attention" badge in U1 linking to U7.
- **U7 write actions (pinned, FR-050):** `POST /restoration/provider/pause` (block new dispatches; in-flight complete), `POST /restoration/provider/resume`, `POST /restoration/provider/failover` (route new dispatches to the named backup bridge), `POST /restoration/provider/recheck`. These are explicit operator interventions that change system behavior — pause blocks, failover reroutes, resume unblocks. The Engine Room is actionable, not surveillance-only.
- **Event log divergence alert:** When the boot-time reconciliation (FR-067) detects divergence between `events.jsonl` and the SQLite `events` table, U7 surfaces an "Event log divergence detected for run {run_id}" alert with a "Reconcile now" action (`POST /restoration/reconcile/{run_id}`). The resolution policy: SQLite is canonical; `events.jsonl` entries missing from SQLite are imported; SQLite entries missing from `events.jsonl` are re-exported. The operator is always alerted; the run is not paused.
- **Inputs:** None for surveillance; pause/resume/failover/recheck actions.
- **Outputs:** Per-provider status (configured / healthy / degraded / unverified / paused), last receipt per provider, error counters, affected jobs list, event-log divergence alerts.
- **Empty state:** "No providers configured — see Sneferu admin."
- **Loading state:** Polling indicators.
- **Error state:** Provider unreachable surfaces the bridge name and error class; operator directed to the affected job surface.
- **Permissions:** Operator session.

**U8 — Shop Insights (operator)**
- **Purpose:** Lightweight analytics aggregating completed restoration data to inform future bids and operations.
- **Entry point:** Operator console → "Insights" tab; data via `GET /restoration/insights`.
- **Inputs:** Date range filter, vehicle make filter.
- **Outputs:** Cost trends (average actual spend vs. estimated spend per job over time); estimation accuracy ((estimated / actual) × 100 per job and as a trend); common failure points (top 10 QA-quarantined parts, most frequent unsourced categories); supplier reliability (per-vendor on-time delivery rate from `ordered_at`→`received_at`, price competitiveness vs. KB indicative range, selection frequency, return/dispute rate); sourcing difficulty (average system-discovered coverage per vehicle make, shown alongside total coverage); KB growth (entries, additions per month, pending proposals); job count by state; average automation coverage over time.
- **Empty state:** "No completed jobs yet — insights will appear after your first restoration."
- **Loading state:** Aggregation query progress.
- **Error state:** "Unable to compute insights — check that restoration.db files are accessible."
- **Permissions:** Operator session.
- **Responsive/accessibility:** Desktop-first; charts use text labels and ARIA descriptions (never color alone).
- **Data source:** Computed at query time from all `runs/*/restoration/restoration.db` databases, `runs/*/restoration/*.json` artifacts, and the shared `runs/restoration_feedback.db`. No separate analytics database or external service.

## 3. Primary end-to-end journey

**State spine:**

```
DRAFT → INTAKE_OPEN → INTAKE_SEALED → IDENTIFYING → REVIEW_OPEN → MANIFEST_LOCKED →
BUDGET_RULED → HUNTING → {HUNT_SEALED | SOURCING_INSUFFICIENT} →
MESHING → GRAPH_REVIEW → PUBLISHED →
{MESHING (next assembly) | PUBLISHED (v{N+1} re-publish) | IN_SERVICE → CLOSED}

Side states:
- Any state → ABANDONED (operator-initiated, with required reason; terminal, read-only;
  all pending AsyncTasks cancelled, provider resources released)
- CLOSED → MANIFEST_LOCKED (re-open, with operator approval; sourcing and 3D artifacts preserved)
- Any state → PARKED (flag, durable partials, with reason)
```

**Status enum:** `draft, intake_open, intake_sealed, identifying, review_open, manifest_locked, budget_ruled, hunting, sourcing_insufficient, hunt_sealed, meshing, graph_review, published, in_service, closed, abandoned`

Parking is modeled via `parked: bool` + `parked_reason` on `RestorationProject`; transitions are blocked while parked and resume returns to the pre-park state. Hunt pause is modeled separately via `hunt_paused: bool` on the sourcing task record — it does not change project state.

**ABANDONED transition (pinned):** `POST /restoration/projects/{id}/abandon` with a required `{reason: str}` transitions from any state to `ABANDONED`. The reason is stored as `abandoned_reason` on `RestorationProject`. **All pending AsyncTask entries for that project are automatically cancelled** (status set to `cancelled`, `api_cost_ceiling_reached` event written if any task was in-flight and consuming API budget) — this prevents API-cost-accruing tasks from running on an abandoned project. Abandoned projects are read-only: all state-changing endpoints return 409 with "Project is abandoned." U1 shows an "Abandoned" badge with the reason. Abandoned projects cannot be re-opened; the operator must create a new project (optionally referencing the abandoned one via `cloned_from` metadata). This is a deliberate design choice: abandoned means abandoned, not paused.

**PUBLISHED → IN_SERVICE transition criteria:** `POST /restoration/projects/{id}/in-service` requires a `checklist: list[str]` containing at minimum "all critical sub-assemblies published" and "operator has verified the vehicle is road-ready"; the operator may add custom items. Checklist items are defined in `defaults.yaml::restoration_in_service_checklist` as a list of strings (default: `["all critical sub-assemblies published", "operator has verified the vehicle is road-ready"]`); the operator confirms each item via U4 before the transition fires. The checklist is stored in `project.json` as `in_service_checklist`. The transition is an explicit operator sign-off, never a system guess. The API layer validates that every default checklist item is present in the submitted list; missing items return 400 naming the missing items.

**Re-open from CLOSED:** `POST /restoration/projects/{id}/reopen` with `{reason: str}` transitions to `MANIFEST_LOCKED`. Prior sourcing results, negotiation records, purchase records, guide bundles, and tokens are **preserved**. Parts with prior sourcing results are marked `previously_sourced`; new or modified parts trigger new sourcing queries. Existing guide tokens remain valid until revoked or expired (extendable per FR-040); the operator may bulk-revoke via `DELETE /restoration/projects/{id}/tokens`. `reopened_from` and a `prior_run_summary` are recorded and an audit event is written.

**Re-publish / version flow:** Re-publishing a corrected guide creates `bundle_version` v{N+1}, stored alongside prior versions under `guides/{assembly_id}/v{N}/`; prior versions are marked `superseded: true` in their `bundle_meta.json`. **`bundle_version` increments on every `PUBLISHED → PUBLISHED` re-publish of the same assembly — this is the sole increment trigger.** The increment does not fire on `IN_SERVICE → PUBLISHED` (that path does not exist; IN_SERVICE is post-publication). Prior tokens can be marked `superseded` (the old guide remains accessible with a "newer version available" notice) or revoked. `GET /restoration/projects/{id}/assemblies` returns each assembly with its current and prior versions.

**`audio_lufs_target` in the journey:** The -16 LUFS target is set at publish time and stored in both `WalkthroughAssembly.audio_lufs_target` and `bundle_meta.json`. It is not per-step — it is per-assembly. The `pyloudnorm` normalization runs as an async background task after TTS generation and does not block publication; un-normalized audio is served until the background job replaces it (file modification time advances). The target is configurable per shop via `defaults.yaml::audio_lufs_target` (default -16.0).

**Multi-sub-assembly workflow:** After `PUBLISHED`, the operator can return to `MESHING` for the next sub-assembly from U5. Each sub-assembly has its own `WalkthroughAssembly` with its own `bundle_version` starting at 1. The `total_duration_s` field is bounded: maximum 600 s (10 minutes) per sub-assembly for a 5-step assembly (120 s per step average); this is a product-quality bound, not a hard technical limit — if exceeded, U5 warns "audio narration exceeds 10 minutes — consider splitting the sub-assembly."

**Negotiation workflow (pinned):** The `NegotiationRecord` status flow is: `pending → negotiating → ordered → received`, with `passed`, `returned`, and `disputed` as the failure/exception branches. Transitions:
- `pending → negotiating`: operator clicks "Contact vendor" from candidate card in U4; system records `negotiating` status with timestamp.
- `negotiating → ordered`: operator confirms a purchase was placed; requires a `final_price_usd` value (the negotiated price); system records `ordered` status with `ordered_at` timestamp.
- `negotiating → passed`: operator declines during negotiation (e.g., price too high, part no longer needed); requires `notes`; terminal for this candidate.
- `ordered → received`: operator confirms physical receipt; system records `received` status with `received_at` timestamp; triggers a `purchase_outcome` feedback signal and a KB pricing proposal (FR-043).
- `ordered → passed`: operator decided not to proceed after ordering (e.g., found a better source); no charge or charge reversed; terminal for this candidate.
- `received → returned`: wrong part or warranty return; operator records return reason. Terminal.
- `received → disputed`: quality or compatibility issue under resolution; operator records dispute notes. Can transition to `returned` (resolved negatively) or back to `received` (resolved positively).
- Invalid transitions (e.g., `pending → received`, `received → negotiating`) return 409 naming the current status and the valid next statuses.
- `passed`, `returned`, `disputed` are terminal or semi-terminal states; the system never conducts negotiations — all transitions are operator-initiated via `POST /restoration/projects/{id}/negotiation`.

## 4. Functional contract

**Intake and identification:**

- **FR-001** — `POST /restoration/projects` creates a project with `vehicle_meta` (year/make/model/trim/engine, all optional), generates a `project_id` and `run_id`, registers the workflow via `POST /runs/start` with `workflow="restoration_pipeline"`, creates the run directory structure, initializes `project.json` and `restoration.db`, and transitions to `INTAKE_OPEN`. Rejects with 409 if `os_supported: false` (FR-062). Returns `201: {project_id, run_id}`.
- **FR-002** — `POST /restoration/projects/{id}/intake` accepts multipart photo uploads (JPEG/PNG/HEIC/WebP, ≤25 MB each, up to 50 per batch) and an optional parts-list file (CSV/TSV/free-text). Photos are validated by magic bytes and byte count (not extension): JPEG (`FF D8 FF`), PNG (`89 50 4E 47`), HEIC (`ftypheic`/`ftypheix` box signature), WebP (`RIFF....WEBP`). **HEIC transcoding:** HEIC files are transcoded to JPEG via `pillow-heif` (quality 85) for thumbnails; the original HEIC is preserved byte-identical in `intake/photos/`. WebP, JPEG, and PNG are preserved as-is. Thumbnails are generated for all formats and stored in `intake/thumbnails/`. The vision pipeline consumes JPEG thumbnails, never HEIC originals. Returns `200: {receipts, gap_list}` with per-file content hash, thumbnail path, and stored format.
- **FR-003** — `POST /restoration/projects/{id}/intake/seal` transitions to `INTAKE_SEALED` and triggers identification as an async task. Returns `200: {status}`. Rejects with 409 if fewer than 6 usable photos.
- **FR-004** — Run identification as an async task via the configured vision-capable bridge. The identification primitive consumes JPEG thumbnails (not HEIC originals) and produces `ComponentRecord` entries with per-part confidence scores, `biasing_context` where the learning-ledger formula adjusted confidence, `photo_refs`, and `source` (auto/manual). **Confidence threshold (pinned):** parts with `adjusted_confidence ≥ 0.70` are auto-accepted; parts with `adjusted_confidence < 0.70` route to the review queue. When VLM-only mode is active (no KB match for the vehicle), the threshold is raised to `0.85`; parts identified VLM-only with `confidence < 0.50` are additionally tagged "low confidence — VLM only". Thresholds are configurable in `defaults.yaml::restoration_confidence_threshold` (default 0.70) and `defaults.yaml::restoration_vlm_only_threshold` (default 0.85). Hallucination defense: identified part names are cross-checked against the category taxonomy; non-matching names are flagged for review regardless of confidence.
- **FR-005** — Produce `ManifestEntry` records from `ComponentRecord` entries. `sourcing_status` is a single enum field: `{pending, sourced, unsourceable, fabrication_ref, previously_sourced}`. `fabrication_ref` = 3D fab GLB attached (FR-015); `previously_sourced` = sourced in a prior run before re-open (FR-035). No separate booleans.
- **FR-006** — [OUTCOME FORECAST — A-003] Automated identification handles at least 80% of parts without manual intervention, measured as `(correct + 0.5 × refined) / total × 100`. This is a forecast about ML/VLM behavior, not a system-property guarantee; AC-004 tests the system property (content-dependent output, not a threshold gate). The 80% target is validated by A-003.
- **FR-007** — Operator resolves review cases via `POST /restoration/projects/{id}/manifest/resolve` with `{part_id, name, condition, notes}`. The resolution is stored in the SQLite `review_log` table (FR-057) with before/after values, actor, and timestamp. A `feedback_signal` (type `identification_correction`) is written to the learning ledger with the before/after values, vehicle make/model/year, and **denormalized `category`** from the manifest at signal-creation time.
- **FR-008** — `POST /restoration/projects/{id}/manifest/lock` transitions to `MANIFEST_LOCKED`, writes the locked manifest version, and computes `automation_coverage_pct`. KB auto-extraction proposals are generated for confirmed parts with no KB entry. Proposal content derives directly from the triggering record's fields (part name, OEM number, category, vehicle make/model/year) — never placeholder values.

**Budget and sourcing:**

- **FR-009** — `POST /restoration/projects/{id}/budget` with `{budget_ceiling_usd: float}` computes a ruling by comparing total estimated cost (sum of `ManifestEntry.estimated_cost_usd`, excluding nulls) against the ceiling. **Budget-ruling thresholds (pinned):** `total_estimated_cost ≤ 80% of ceiling → AFFORDABLE`; `> 80% and ≤ 100% of ceiling → TIGHT`; `> 100% of ceiling → SHORTFALL_CRITICAL`; `unknown_cost_count > 30% of total parts → INSUFFICIENT_DATA` (null costs excluded from sum, not zeroed). Thresholds configurable in `defaults.yaml::restoration_budget_affordable_pct` (default 0.80) and `defaults.yaml::restoration_budget_tight_pct` (default 1.00). Returns `{ruling, detail, unknown_cost_count}`. Transitions to `BUDGET_RULED`.
- **FR-010** — Per-part budget allocation: critical parts share 60% of the pool, standard 30%, optional 10%. **Formula (pinned):** `per_part_ceiling = (tier_allocation_pct × budget_ceiling_usd) / tier_part_count`. For example, if the budget is $5000, there are 10 critical parts, 20 standard, and 5 optional: each critical part gets `(0.60 × 5000) / 10 = $300`; each standard part gets `(0.30 × 5000) / 20 = $75`; each optional part gets `(0.10 × 5000) / 5 = $100`. If a tier has zero parts, its allocation is redistributed proportionally to the tiers that have parts. Carried on `PartSourcingQuery.per_part_budget_ceiling_usd`.
- **FR-011** — Override `SHORTFALL_CRITICAL` or `INSUFFICIENT_DATA` via `POST /restoration/projects/{id}/budget/override` with `{reason: str}`. Requires operator override requiring explicit confirmation and a free-text reason; write an immutable audit entry (actor, timestamp, reason) to `budget.json` before sourcing proceeds. Override is permitted only from `SHORTFALL_CRITICAL` or `INSUFFICIENT_DATA`.
- **FR-012** — Search for purchasable and tradeable options scoped to the exact vehicle make/model/year/modifications via the tiered approach with pinned order (sequential, not parallel): (1) query the source registry (`restoration_sources.yaml`) first through Sneferu's bridge layer — the research primitive formats each entry's `search_template` by substituting `PartSourcingQuery` fields with **RFC 3986 percent-encoding** applied to all placeholder values before substitution: `{part_name}` → `urlencode(query.part_name)`, `{oem_number}` → `urlencode(query.oem_number)` (omitted from the URL if null — see below), `{vehicle_make}` → `urlencode(query.vehicle_make)`, `{vehicle_model}` → `urlencode(query.vehicle_model)`, `{vehicle_year}` → `urlencode(query.vehicle_year)` — and fetches via the bridge layer (LLM-mediated extraction of structured data from the returned page). **Null `oem_number` interpolation behavior (pinned):** if `oem_number` is null, the `{oem_number}` token is removed entirely from the template string before URL construction; if the token was the sole value in a query parameter (e.g., `&oem={oem_number}`), the entire parameter is dropped; if it was part of a compound value (e.g., `q={part_name}+{oem_number}`), the token is removed and adjacent `+` separators are collapsed. **Registry entries without a `search_template`** (e.g., trade-partner phone contacts) are skipped by the research primitive and surfaced in U4 as manual-contact sources. (2) Fall back to LLM-mediated web search through the configured reasoning bridge (OpenAIResponsesBridge or CoworkBridge) for parts with <3 candidates from the registry — the bridge is prompted with a structured query and instructed to search vintage parts marketplaces and forums; the LLM generates search URLs and parses result descriptions from its training data and any web-browsing capability the bridge exposes, and does not issue direct HTTP requests. (3) Flag unparseable results `unstructured_lead` and route to manual entry. The research primitive (not the restoration module) consumes the registry templates, performs interpolation and URL construction — the module passes the registry to the primitive and never builds URLs or fetches pages directly. **Deduplication key (pinned):** `part_id + vendor + oem_number + similar price (±5%)` — `SourcingCandidate` carries an `oem_number` field for this purpose. Hallucination defenses: returned URLs validated via HEAD request (5 s timeout, non-resolving URLs flagged `unverified_url` but still shown with a warning badge); prices validated as positive numbers. Timeout 30 s per query; 3 retries with exponential backoff (2 s, 4 s, 8 s); after retries exhausted the part is marked `unsourced` with reason `no_vendor_response`. Rate limit: 1 query per `rate_limit_seconds` per source (default 2 s), applied as a per-source sleep in the research primitive; queries sequential per project. `[unverified — needs orchestrator/core/research_primitives.py — A-010]`
- **FR-013** — The sourcing pipeline executes as an async task and returns `SourcingCandidate` and `UnsourceableFlag` records. **System-discovered coverage formula:** `system_coverage = (parts with ≥1 SourcingCandidate where provenance ∈ {source_registry, research_primitive}) / total manifest parts × 100`. `unstructured_lead` and `manual_entry` do NOT count as system-discovered. `manual_entry` candidates arrive via `POST /restoration/projects/{id}/sourcing/manual` (a separate REST path, not the research primitive) — this is why `manual_entry` is absent from the research primitive's JSON output schema. **Total coverage formula:** `total_coverage = (parts with ≥1 SourcingCandidate where provenance ∈ {source_registry, research_primitive, manual_entry}) / total manifest parts × 100`. Parts with an `UnsourceableFlag` plus a `fabrication_reference_glb` count as covered in both formulas. Critical-path coverage applies the system formula to `criticality == critical` parts only. The ≥50% system-discovered target is tested by AC-008; the ≥90% total-coverage aspiration is outcome forecast A-004, exercised by AC-038.
- **FR-014** — For unsourceable parts, emit a specific reason code (`discontinued`, `no_aftermarket_reproduction`, `regional_unavailability`, `exceeds_budget`, `no_vendor_response`) derived from the actual search outcome (not part-name lookup) and suggest at least one alternative (substitute part, rebuilder, custom fabricator).
- **FR-015** — Attach a 3D fabrication reference to unsourceable parts only when the game pipeline can produce a dimensionally sufficient model matching the vehicle's make/model/year/modifications; link the GLB from the sourcing report.

**3D walkthrough generation:**

- **FR-016** — Generate vehicle-specific 3D part meshes exclusively via the documented game-pipeline approach (BFL `flux-2-max` → Meshy `meshy-6`) per the Current Runtime Truth — GAME production-line override; meshes must respect make/model/year and visible fitment-changing modifications.
- **FR-017** — Gate mesh publishing behind a dimensional QA rung with a pinned precedence chain and deviation algorithm. **GLB unit-scale normalization (mandatory pre-step):** before the deviation check, the generated GLB is loaded via `trimesh` and its bounding box is normalized to real-world millimeters by scaling the mesh so that the longest axis of the AABB matches the corresponding reference dimension. This step is required because GLB files from Meshy/BFL are inherently unitless; without normalization, dimensional comparison is mathematically impossible. **Reference-dimension precedence:** (1) KB `reference_dimensions_mm` (if present); (2) operator-supplied dimensions from `reference_dimensions_override.json` (FR-060); (3) neither → publish with `qa_status: "unverified_dimensions"` (the deviation check is skipped; the gap is logged and surfaced in U5 — a warning, not a block). **Deviation calculation algorithm (pinned):** (1) load the normalized GLB via `trimesh`; (2) compute the axis-aligned bounding box (AABB) of the mesh; (3) for each axis (length, width, height): `axis_deviation_pct = abs(mesh_dim - ref_dim) / ref_dim × 100`; (4) the maximum of the three axis deviations is the part's deviation score; (5) pass/fail against per-category tolerance: structural ≤2%, mechanical ≤5%, cosmetic ≤10%. The mesh must also pass parse success and watertight-manifold validation (`trimesh`, vertex count > 50). The algorithm is deterministic (AC-051 verifies repeatability). Quarantine failures with provider name and error detail; QA receipts record `dimension_source` (`kb`, `operator_supplied`, or `none`), the per-axis deviation values, and `scale_factor_applied` (the unit-normalization factor); a subsequent successful generation clears the quarantine.
- **FR-018** — Generate walkthroughs as a static exploded-view GLB per sub-assembly plus sequential per-step static GLB meshes (3–5 positions: exploded → positioning → install → torque/finishing). Each step position carries a `step_position_label` in `WalkthroughStep` (values: `"exploded"`, `"positioning"`, `"install"`, `"torque"`, `"finishing"`) so the semantic meaning of each per-step mesh is explicit in the data model. The WebGL viewer shows the exploded view, then advances through install positions per tap with client-side camera-path interpolation (orbit + zoom, no vertex deformation, no morph targets). Part visibility: exploded view shows all parts; each install position highlights the current part (emissive boost) with previously installed parts in place. `WalkthroughAssembly.step_count` records the actual count. `len(glb_paths) == 1` is a valid T2 state (exploded view only, no per-step positions — the advance interaction becomes hotspot-to-hotspot highlighting). If Meshy cannot produce spatially aligned multi-mesh outputs (A-008), fall back per FR-044 tier T2/T3. `[unverified — A-008]`
- **FR-019** — Generate per-step audio narration via OpenAI TTS (`tts-1`, voice `alloy`) through a TTS dispatch path in the bridge layer. The provider and model are pinned — no "e.g."; bounded assumption A-007 tracks bridge registration. Narration content per step (generated from `WalkthroughStep` fields): (a) action description, (b) tool callout, (c) part callout, (d) safety warning where applicable. MP3, 64 kbps mono (speech-optimized, bundle-size-aware). **Normalization to -16 LUFS via `pyloudnorm` is an explicit mandatory post-bridge step — OpenAI `tts-1` does not guarantee exact LUFS natively; `pyloudnorm` is the named enforcement tool.** Normalization runs as an async background task — publication is not blocked; un-normalized audio is served until the background job replaces it. The target is recorded as `WalkthroughAssembly.audio_lufs_target: float = -16.0` and in `bundle_meta.json` as `audio_lufs_target: -16`; the target is configurable per shop via `defaults.yaml::audio_lufs_target` (default -16.0). AC-039 verifies measured loudness on sample output. **Fallback behavior (pinned, complete chain):** if the TTS bridge is unavailable (bridge registration fails per A-007, or the OpenAI API returns errors, or the API cost ceiling is hit), the guide publishes as screen-only text (`audio_available: false` per step) — the text-only fallback is the documented default behavior when TTS is unavailable, not a degraded mode. There is no secondary TTS provider in v1; the text-only fallback is the complete fallback chain. A secondary TTS provider (e.g., Anthropic, local pyttsx3) is a v2 enhancement.
- **FR-020** — Publish the guide bundle as a versioned artifact under `runs/<run_id>/restoration/guides/{assembly_id}/v{N}/`; mint a revocable, time-bounded token (30-day default, extendable via `POST .../tokens/{token_id}/extend` per FR-040) scoped to the bundle version; render as QR code and short URL on U5. Re-publish auto-increments `bundle_version` (the sole increment trigger is `PUBLISHED → PUBLISHED` re-publish of the same assembly); prior versions persist with `superseded: true`. Token format: 32-byte random URL-safe string; rate limit 60 requests/token/hour. **Asset size budget:** bundles target ≤40 MB (iOS Safari ~50 MB PWA ceiling with headroom); Draco GLB compression (`draco3d`) applied automatically when a bundle exceeds 30 MB; operator warned at publish if the bundle exceeds 40 MB and offered "compress assets"; on iOS, if still >40 MB after compression, the Service Worker restricts offline caching to text + 2D diagrams; last resort is a text + image bundle (≤15 MB) excluding GLB and audio. **`total_duration_s` bound:** maximum 600 s (10 minutes) per sub-assembly; if exceeded, U5 warns "audio narration exceeds 10 minutes — consider splitting the sub-assembly."

**Mobile guidance delivery:**

- **FR-021** — Deliver the guide via `GET /guide/{token}` — revocable, time-bounded, bundle-scoped, no account or operator session; render a mobile-optimized HTML page in a standard smartphone browser (iOS Safari, Android Chrome); no app-store install. Pages include `<meta name="robots" content="noindex">` and `Referrer-Policy: no-referrer` headers.
- **FR-022** — Render the stepwise visual in-browser: T1 WebGL with the published GLB (default camera: front-3/4 view of the current part at 70% zoom; touch orbit/pan/zoom); T2 exploded GLB with the active callout highlighted; T3 2D annotated diagram in a canvas viewer; T4 still image. Always display step number, total steps, and progress bar. The `step_position_label` (FR-018) is shown as a caption (e.g., "Step 3: Install").
- **FR-023** — Play per-step audio via HTML5 audio as the primary instruction channel (understandable with the screen pocketed); provide replay per step. If TTS is unavailable (A-007), audio is absent and on-screen text is primary.
- **FR-024** — Require a manual tap to advance; never auto-progress; support pause, resume, back navigation, skip-ahead (swipe left on the step title for the step list), and free-explore (FR-053); maintain screen wake-lock during playback (requires HTTPS or localhost — A-009).
- **FR-025** — Fallback chain per step: 3D → 2D annotated diagram → still image + full text script; audio failure → on-screen text. Never present a dead-end error to the mechanic. **Per-step GLB decode failure:** if a GLB fails to decode at runtime (corrupt asset, WebGL context loss), the guide immediately falls back to 2D diagram or still image for that step and logs a `glb_decode_failure` event for operator review. This is the runtime fallback, distinct from the assembly-level `qa_status` decision.
- **FR-031** — Implement a Service Worker (`bay_guide/service_worker.js`) caching guide assets during preload in priority order: (1) HTML shell + JS, (2) text scripts for all steps, (3) still images / 2D diagrams, (4) audio files, (5) GLB files. Speculative preload: during step N, fetch assets for steps N+1…N+3. Resume caching on connectivity return. Minimum safe cache: text scripts for all steps must be cached before "preload complete" / "ready for offline" is declared; GLB and audio are best-effort. **Preload-time budget:** ≤30 seconds over a 5 Mbps connection for a 20-step assembly with 3D assets (AC-042); if exceeded, the guide serves text + 2D diagrams first (best-effort partial preload) while heavier assets continue. **Asset size budget:** 40 MB cap with the graded compression and iOS restriction rules in FR-020. **Cache versioning and eviction (pinned):** the Service Worker cache name includes `bundle_version`; on a version increment, the prior version's GLB and audio assets are evicted on next activation (version-aware LRU); the current version's text scripts and 2D diagrams are always retained. Total cache size is bounded by the 40 MB bundle budget — not a fixed asset count — so a 20-step assembly with full assets always fits. The asset list is discovered from `bundle_meta.json` (schema defined in §5).
- **FR-032** — Store per-token state in IndexedDB: current step index (`guide_progress` store: `{token_id, step_index, timestamp}` — restore on tab reopen; this is the mechanic's session persistence mechanism, no login or server-side step tracking needed), the flag-a-problem queue (`flag_queue` store: `{flag_id, problem_type, description, screenshot_data_url, photo_blob, created_at, sync_status}`), and a redundant copy of all text scripts (`text_scripts` store — iOS eviction resilience). Checkpoints are per-token, not per-mechanic. If the stored step index exceeds the bundle's total steps (after re-publish with fewer steps), the guide starts at step 0 and clears the stale entry.

**Sneferu integration and persistence:**

- **FR-026** — Authenticate the operator via the existing Sneferu operator-session endpoints; no separate account creation. The module invokes exactly these Sneferu API endpoints (which must remain stable — same path, same request/response schema):

| Endpoint | Purpose | Stability requirement |
|---|---|---|
| `POST /admin/operator/session` | Operator login | Must remain 200 on valid credentials, 401 on invalid |
| `GET /admin/operator/session` | Session validation | Must remain 200 with session info, 401 without |
| `GET /live/status` | General liveness | Must remain 200 with `{"status": "ok"}` |
| `GET /bridge/health` | Per-bridge health | Must remain 200 with bridge health statuses |
| `POST /runs/start` | Workflow registration | Must accept `workflow="restoration_pipeline"` and return run_id |

No other Sneferu endpoint is called by the restoration module. All new endpoints are additions; the module does not modify existing ones. This enumeration is the complete Sneferu dependency surface.

- **FR-027** — Persist state hybrid JSON + SQLite. Static artifacts (project metadata, intake files, inventory, manifest, budget ruling, assembly graph, GLB/audio/PNG/PDF assets) as JSON + binary under `runs/<run_id>/restoration/`. Transactional state (sourcing candidates, negotiation records, purchase records, guide tokens, events, review log, tasks, api_costs, mechanic_flags, kb_proposals) in `runs/<run_id>/restoration/restoration.db` (WAL mode, 5 s busy timeout). Learning-ledger signals consolidate into the shared `runs/restoration_feedback.db` (WAL mode). Rehydrate from both on reload or restart, with boot-time crash reconciliation per FR-067. **Lock disciplines:** JSON writes use `fcntl.flock` advisory locking on a per-file `.lock` sidecar. `restoration_index.json` uses the single-writer lock discipline in FR-048. SQLite WAL handles per-run and cross-run database concurrency (no additional file lock needed under single-worker). **`restoration_index.json` is a cache, not a source of truth** — it is always reconstructable from SQLite + `project.json` files. U1 queries the index for speed; if the index is missing or corrupt, U1 falls back to scanning `runs/*/restoration/project.json` and rebuilds the index.
- **FR-028** — **The SQLite `events` table is the canonical audit source.** `events.jsonl` is the orchestrator event-bus output and the recovery source — it remains in the runtime write path because the orchestrator event bus consumes it for cross-module event routing, but it is explicitly a secondary, non-authoritative output. Synchronization rule: every event is written to SQLite first (canonical), then to `events.jsonl` (bus export). If the SQLite write fails, the event is captured in `events.jsonl` with a `sqlite_event_write_failed` warning and retried on the next write cycle; if the JSONL write fails, the event is already in SQLite and a `jsonl_event_write_failed` error is logged. **`events.jsonl` schema and rotation:** each line is a JSON object with fields `{event_id, project_id, event_type, timestamp, actor, metadata}`. The file is per-run (`runs/<run_id>/restoration/events.jsonl`), append-only during a run, and rotated when the file exceeds 10 MB (renamed to `events.{N}.jsonl` with N incrementing; a maximum of 5 rotated files are retained per run, oldest deleted). **Divergence resolution:** on server start, the FR-067 reconciliation job imports any `events.jsonl` entries missing from SQLite and re-exports any SQLite entries missing from `events.jsonl`; a summary `event_log_divergence` event is written with the count and direction of the discrepancy; the operator is alerted via a U7 badge with a "Reconcile now" action; the run continues (self-healing, not a pause).
- **FR-029** — Restore run state after restart by reading persisted JSON artifacts and SQLite, verified and corrected by the FR-067 reconciliation job; resume at the last persisted state. Tasks with `status: "running"` are marked `interrupted`; the operator resumes via `POST /restoration/tasks/{task_id}/resume` (FR-056) or re-triggers them from U1.
- **FR-030** — Register the restoration workflow with the Sneferu workflow runner via `POST /runs/start` with `workflow="restoration_pipeline"` and the domain prompt pack loaded by the Prompt Pack Loader. `POST /restoration/projects` delegates to the same registration logic.

**State machine and lifecycle:**

- **FR-033** — Enforce valid state transitions per §3 (including ABANDONED from any state with required `abandoned_reason` and automatic AsyncTask cancellation, and re-open from CLOSED → MANIFEST_LOCKED with required `reason`). Reject invalid transitions with HTTP 409 naming the current state and required precondition. Transitions are blocked while `parked: true`. Enforcement lives at the API layer. ABANDONED projects are read-only: all state-changing endpoints return 409. **`in_service_checklist` source (pinned):** checklist items are defined in `defaults.yaml::restoration_in_service_checklist` (default: `["all critical sub-assemblies published", "operator has verified the vehicle is road-ready"]`); the operator confirms each item via U4 before the PUBLISHED → IN_SERVICE transition fires; the API validates that every default item is present in the submitted list and returns 400 naming any missing default items. The checklist is stored in `project.json` as `in_service_checklist`.
- **FR-034** — Support `ABANDONED`: `POST /restoration/projects/{id}/abandon` with a required `{reason: str}` from any state (except already ABANDONED). The reason is stored as `abandoned_reason` on `RestorationProject`. **All pending AsyncTask entries for the project are automatically cancelled** (status set to `cancelled`, any in-flight provider dispatches are allowed to complete but no new dispatches are issued, `async_task_cancelled` events written) — this releases provider resources and prevents API-cost-accruing tasks from running on an abandoned project. Abandoned projects are read-only and badged in U1 with the reason. Abandoned projects cannot be re-opened; the operator must create a new project (optionally with `cloned_from` referencing the abandoned project).
- **FR-035** — Support re-open from `CLOSED`: `POST /restoration/projects/{id}/reopen` with `{reason: str}` → `MANIFEST_LOCKED`. Prior sourcing results, negotiation records, purchase records, guide bundles, and tokens are preserved; previously sourced parts are marked `previously_sourced`; new/modified parts trigger new sourcing; existing tokens remain valid until revoked/expired (extendable per FR-040; bulk revoke available). Record `reopened_from` and `prior_run_summary`; write an audit event.
- **FR-036** — Support multi-sub-assembly: after `PUBLISHED`, `POST /restoration/projects/{id}/generate_3d` with a new `assembly_id` starts the next assembly; each has its own bundle and tokens.
- **FR-037** — Support `SOURCING_INSUFFICIENT`: when system-discovered coverage <50%, transition per §3. Manual candidate entry recomputes total coverage in real time; the seal action is re-offered at threshold or on explicit partial acceptance (audit event). Operator may also adjust budget (→ `BUDGET_RULED`) or abandon.
- **FR-038** — Support parking: any stage can park via `parked: bool` + `parked_reason`; parked jobs show a "Parked" badge and resume action in U1; async task state persists in SQLite. Hunt pause is distinct: `hunt_paused: bool` on the sourcing task record via `POST /restoration/projects/{id}/sourcing/pause` and `/resume`; paused progress (completed queries, found candidates) is preserved and resumed without changing project state.

**Token management:**

- **FR-039** — Mint tokens via `POST /restoration/projects/{id}/tokens` with `{assembly_id, bundle_version}`; the current version is discoverable via `GET /restoration/projects/{id}/assemblies` (default: latest published). Returns `201: GuideToken`. Storage: `guide_tokens` table.
- **FR-040** — Revoke via `DELETE /restoration/projects/{id}/tokens/{token_id}` (sets `revoked_at`, `revoked_by`; subsequent guide requests return 404). Bulk revoke via `DELETE /restoration/projects/{id}/tokens`. Supersede via `POST /restoration/projects/{id}/tokens/{token_id}/supersede` — distinct from revoke: **the old guide remains accessible with a persistent "A newer version of this guide is available. Contact the shop operator for the updated link" banner at the top of the page.** The banner is dismissible but reappears on next load. The old guide is fully functional — a mechanic mid-procedure should not be disrupted by a version change. **Extend expiry** via `POST /restoration/projects/{id}/tokens/{token_id}/extend` with `{extends_days: int}` (default 30, max 365) — writes an audit event with actor, timestamp, and new `expires_at`; the token string (and printed QR) stays valid. This is the documented renewal mechanism for multi-month restorations; no separate re-mint flow is needed.
- **FR-041** — Validate tokens on every `GET /guide/{token}`: existence, expiry, revocation, superseded status, and rate limit (429 beyond 60 requests/hour). Update `last_accessed_at` and `access_count`. **Expired token UX (pinned):** expired tokens return HTTP 410 with a JSON body `{"error": "token_expired", "message": "This guide link has expired. Contact the shop operator for a new guide link."}`. If the guide was previously loaded and cached by the Service Worker, the cached version remains usable read-only with a non-dismissible "This guide link has expired. Contact the shop operator to renew" banner. If no cached version exists, the mechanic sees the 410 error page with the contact message. Flag-sync POSTs authenticated with an expired token receive 410; the flags remain in the IndexedDB `flag_queue` until a renewed token is provided. Revoked tokens return 404. **Superseded-token response (pinned):** superseded tokens return HTTP 200 with the old bundle plus an `X-Guide-Superseded: true` response header (the machine-readable signal the guide and Service Worker use to render the banner even when serving mixed cached/online content) and the visible "newer version available" banner per FR-040.

**Negotiation and purchase tracking:**

- **FR-042** — Track negotiation status per candidate via `POST /restoration/projects/{id}/negotiation` with `{part_id, candidate_id, status, notes, final_price_usd?}`. **State transitions (pinned):** `pending → negotiating`; `negotiating → ordered` (requires `final_price_usd`); `negotiating → passed` (terminal; requires `notes`); `ordered → received` (triggers a `purchase_outcome` feedback signal and KB pricing proposal per FR-043); `ordered → passed` (terminal; order cancelled, no charge or charge reversed); `received → returned` (terminal); `received → disputed`; `disputed → returned` (resolved negatively) or `disputed → received` (resolved positively). Invalid transitions (e.g., `pending → received`, `received → negotiating`) return 409 naming the current status and the valid next statuses. All transitions are operator-initiated; the system never conducts negotiations. Records in the `negotiation_records` table.
- **FR-043** — Record purchase outcomes via `POST /restoration/projects/{id}/purchase` with `{part_id, vendor, price_usd, condition, ordered_at, received_at?, notes?, batch_id?}`. `batch_id` links group buys. Records in `purchase_records`. Each purchase writes a `feedback_signal` (type `purchase_outcome`: vendor, final price, vehicle make/model/year, denormalized `category`) to the learning ledger and triggers a KB pricing proposal (FR-049). KB proposals must contain the actual purchased part's vendor, price, and candidate part name from the manifest — never placeholder values.

**Degraded-mode and fallback:**

- **FR-044** — Tiered 3D degradation: (T1) full static-per-step GLB when QA passes; (T2) single exploded-view GLB with callout-hotspot navigation when multi-mesh fails but single-mesh succeeds (`len(glb_paths) == 1` is valid) — the advance interaction becomes hotspot-to-hotspot highlighting, documented to the mechanic; (T3) auto-generated 2D annotated diagrams (FR-058) in a 2D canvas viewer when all 3D fails; (T4) text + audio only as last resort. If QA pass rate <30% across a sub-assembly, U5 warns "3D pipeline degraded" and the operator may publish as T3. If the pipeline fails consistently, the operator can disable 3D generation via U7 (`provider=mesh_3d`). U6 always renders the best available visual; words-only only when all visual generation failed. **Threshold justification:** 30% is a bounded default (configurable in `defaults.yaml::restoration_3d_degradation_threshold`) — below it, the majority of meshes are unverified and the operator gets more value from always-correct 2D diagrams than from mostly-wrong 3D; if raised above 50%, the product effectively defaults to T3 for all assemblies.
- **FR-045** — Sourcing degraded mode: if tiered sourcing returns <50% system-discovered coverage, U4 surfaces "sourcing assistance limited", highlights manual entry, and shows the source registry for manual searching. Manual candidates are accepted at any time via `POST /restoration/projects/{id}/sourcing/manual`. **Threshold justification:** 50% is a bounded default (configurable in `defaults.yaml::restoration_sourcing_floor`) — below it, the majority of parts have no system-discovered candidates and the sourcing automation is not meaningfully contributing; the SOURCING_INSUFFICIENT state ensures explicit acknowledgment.
- **FR-046** — Offline degraded mode: incomplete Service Worker cache → "limited offline mode" indicator, fall back to cached text scripts + 2D diagrams for remaining steps. **Mid-session connectivity loss:** if connectivity drops after the bundle is loaded, the guide continues from cache; a persistent "offline" indicator appears in the UI header. If a required asset is missing from cache, the per-step fallback ladder fires: GLB → 2D diagram → still image → text-only. The speculative preload of the next 3 steps continues from cache if those assets were already fetched. The mechanic is never blocked — text is always available from IndexedDB. iOS Safari eviction → detect via `caches.match()` on the HTML shell; if online, auto re-preload ("cache lost — reconnecting"); if offline, show "Offline assets were cleared by your phone. Reconnect to Wi-Fi to reload the guide" with a reload button; IndexedDB text scripts provide partial fallback. Without HTTPS the Service Worker does not register at all — offline caching is entirely absent (not degraded) and the guide becomes online-only (A-009, FR-063).

**Concurrency and locking:**

- **FR-047** — JSON writes use `fcntl.flock` advisory locking on per-file `.lock` sidecars (POSIX-only; see FR-062). SQLite uses WAL mode with a 5-second busy timeout. `launch.sh` runs uvicorn with a single worker. Long-running operations run as async tasks (FR-056), yielding the event loop between dispatches so U1–U7 stay responsive during 10–30 minute mesh generation. Single-worker is a v1 implementation limitation (not a B0 constraint); if multi-worker deployment is ever needed, SQLite WAL handles database concurrency but JSON locking would require a shared lock service — documented known limitation tracked as A-015.
- **FR-048** — Concurrent projects are supported: each has its own run directory and SQLite database; `events.jsonl` is per-run. `runs/restoration_index.json` caches project metadata for U1 and is updated atomically using a **single-writer lock discipline**: read current index → acquire `fcntl.flock` on `runs/.restoration_index.lock` → re-read (in case another writer updated between read and lock) → merge update → write to temp file → `os.rename(temp, index)` (atomic on POSIX) → release lock. Only one writer holds the lock at a time; readers may see the old or new version but never a partially written file. If the index is missing/corrupt or drifts from directory state (checked via `project.json` existence), U1 falls back to scanning and rebuilds it. The index is a cache, never a source of truth. The shared `runs/restoration_feedback.db` uses SQLite WAL mode with a 5-second busy timeout; concurrent writes from different projects are serialized by SQLite's internal locking. AC-024 tests concurrent project creation; AC-041 tests concurrent writes to the same `restoration.db`.
- **FR-069** — **Global sourcing concurrency limit:** maximum 1 concurrent sourcing task per project, 3 concurrent sourcing tasks across all projects. A simple in-memory queue (`asyncio.Semaphore`) manages the global limit; per-project limit is enforced at task creation. If the global limit is reached, new sourcing tasks are queued (`status: "pending"`) and started when a slot frees. This prevents accidental overload and cost spikes from concurrent multi-hour hunts. Configurable in `defaults.yaml::restoration_max_concurrent_sourcing` (default 3) and `defaults.yaml::restoration_max_sourcing_per_project` (default 1).
- **FR-070** — **Hunt-level timeout:** `hunt_timeout_seconds` (default 3600 s, configurable in `defaults.yaml::hunt_timeout_seconds`). If a sourcing hunt exceeds this wall-clock duration, it halts with partial results: all completed queries' candidates are preserved in SQLite, the sourcing task status transitions to `completed` with a `timeout_reached` flag, a `sourcing_hunt_timeout` event is written, and the project transitions to `SOURCING_INSUFFICIENT` with the partial candidates available for review and manual entry in U4. The operator can resume the hunt via `POST .../sourcing/resume` (continues from where it left off, not from scratch) or accept partial coverage.

**Reference KB:**

- **FR-049** — Load the KB from `orchestrator/prompts/packs/restoration_kb.yaml` at workflow start via the Prompt Pack Loader. Error handling: missing file → WARNING + empty-KB default (VLM-only) applied silently; malformed YAML → catch the parse exception, log `kb_load_error` with detail, apply empty-KB default, and surface a warning on U3/U7. The workflow never crashes on KB load. Bootstrap: `scripts/seed_restoration_kb.py` converts the bundled `restoration_kb_seed.csv` (13-column schema and per-category minimums defined in §5) to `ReferenceKBEntry` format at install time and validates the per-category minimums **and duplicate `part_id` uniqueness**, failing with a non-zero exit code on shortfall or duplicate; `scripts/validate_kb_seed.py` independently re-checks entry count, non-empty OEM numbers, price-range validity, per-category minimums, **and duplicate `part_id` uniqueness** after seeding. Curation endpoints: `POST /restoration/kb/entries`, `GET /restoration/kb/entries` (with `?make=&model=&year=` filters), `PUT /restoration/kb/entries/{part_id}`, `DELETE /restoration/kb/entries/{part_id}` — writes are atomic (temp + rename) and reload the KB. Auto-extraction proposals are stored in the per-run `kb_proposals` table, surfaced in U3, and approved via `POST /restoration/kb/approve`, which appends to `restoration_kb.yaml`. Purchase outcomes update `indicative_price_range_usd` proposals. All proposals are operator-gated — never automatic overwrites — and proposal content must derive directly from the triggering record's fields (FR-008, FR-043).

**Provider management:**

- **FR-050** — **U7 write actions (not surveillance-only):** `POST /restoration/provider/pause` (block new dispatches; in-flight complete), `POST /restoration/provider/resume`, `POST /restoration/provider/failover` (route new dispatches to the named backup bridge), `POST /restoration/provider/recheck`. Each writes an audit event with actor, timestamp, action, provider name, and affected job IDs to the SQLite `events` table. The provider-to-backup mapping and operator decision tree are defined in §2 U7. These are explicit operator interventions that change system behavior — pause blocks, failover reroutes, resume unblocks. The Engine Room is actionable, not a dashboard.

**API cost tracking and ceiling:**

- **FR-051** — Log each bridge dispatch (BFL, Meshy, LLM, TTS) with estimated cost (from configured pricing in `defaults.yaml::restoration_api_pricing`) to the `api_costs` table. `RestorationProject.api_cost_to_date_usd` aggregates per job; U4 shows "API costs for this job: $X.XX / $Y.YY ceiling" with per-provider breakdown; U8 shows aggregate trends; `GET /restoration/projects/{id}/api-costs` returns `{total, per_provider, ceiling, pct_of_ceiling}`. Costs are configured estimates, not actual billing. API costs are excluded from the parts budget (FR-009) but visible under the B0 `balanced` posture.
- **FR-065** — API cost ceiling gate: a configurable per-job ceiling (default $100, `defaults.yaml::restoration_api_cost_ceiling_usd`; also carried on `RestorationProject.api_cost_ceiling_usd`). At 80% of ceiling, U4 and U1 show a warning badge (`api_cost_ceiling_warning` event). At 100%, new async tasks that would incur API costs (identification, sourcing, 3D generation, TTS) are blocked with a 409 "API cost ceiling reached" error (`api_cost_ceiling_reached` event). The operator can override via `POST /restoration/projects/{id}/api-cost/override` with `{reason: str}` (immutable audit entry: actor, timestamp, reason written to the SQLite `events` table as an `api_cost_ceiling_overridden` event; `api_cost_override_reason` set on `RestorationProject`). The ceiling is checked before each async task starts, not during. **Calibration note:** the $100 default is a starting guardrail for small jobs; a 200-part restoration with 3D+TTS+LLM may exceed $100. The ceiling should be scaled with manifest size; a rough estimate is $0.50–$2.00 per part for identification + sourcing, $5–$15 per sub-assembly for 3D, $0.10–$0.50 per step for TTS. Auto-scaling based on manifest size is tracked as A-016. The ceiling is a guardrail, not a budget. Tested by AC-045.

**Post-sourcing cost gate:**

- **FR-052** — Before hunt sealing, compute the total of the operator's *selected* candidate prices and compare against the ceiling. Breach blocks sealing (409) and offers the FR-011 override workflow (reason + audit event). The seal response includes `{status, total_selected_cost, budget_ceiling, cost_gate_passed}`.

**Mechanic empowerment:**

- **FR-053** — Free-explore mode in U6: orbit/pan/zoom the exploded-view assembly freely; tappable callouts show part name, tool, one-line description, and installation step number; all steps browsable in an overview grid with jump-to-step. Glossary: underlined terms open plain-language definitions sourced from the base glossary pack merged into `bundle_meta.json`; operator can add custom terms via U5. Skip-ahead via swipe-left on the step title.
- **FR-054** — Flag-a-problem: U6 captures problem type (wrong part shown, step unclear, tool missing, safety concern, other), free-text notes, an automatic screenshot (`canvas.toDataURL()`), and an optional phone-camera photo. **Offline persistence:** flags queue in the IndexedDB `flag_queue` store with the screenshot as a data URL, the photo as a Blob, and a `sync_status` field (`pending|synced|failed`). On reconnect, the Service Worker fires a `sync` event; the guide's `flag_sync.js` module reads the queue, POSTs each flag sequentially to `POST /restoration/projects/{id}/flags` with screenshot/photo as base64 data URLs, and removes it from the queue only on a 201 response; failed syncs remain queued and retry on next reconnect. Synced flags are stored in the SQLite `mechanic_flags` table. Open flags surface as "needs attention" in U1 and as review items in U5; the operator resolves via `POST /restoration/projects/{id}/flags/{flag_id}/resolve` with `{resolution_notes}`. **Downstream routing (pinned):** resolved flags that identify identification errors (problem_type = "wrong_part") are written as `FeedbackSignal` entries (type `identification_correction`) to the learning ledger; resolved flags that identify sourcing or tool errors are written as `FeedbackSignal` entries (type `sourcing_selection`). Flags that are purely usability feedback (problem_type = "step_unclear" or "other") are stored in `mechanic_flags` only and do not generate feedback signals. This closes the loop between mechanic feedback and system learning for substantive corrections.

**Customer-facing artifacts:**

- **FR-055** — `POST /restoration/projects/{id}/export-artifact` generates a one-page PDF via `reportlab` using the committed template `orchestrator/prompts/packs/restoration_pdf_template.json`. **PDF template schema (defined in §5):** `{page_size: "A4", dpi: 300, margin_mm: 15, sections: [{name: "header", fields: [...]}, {name: "before_after_photos", layout: "2_column", max_pairs: 3, photo_size_mm: [80, 60]}, {name: "assembly_screenshots", angles: ["front", "side", "top", "exploded"], screenshot_size_mm: [70, 70]}, {name: "restoration_summary", fields: [...]}, {name: "footer", text: "Generated by Restoration Copilot", include_version: true}]}`. The template is validated at load time by `reportlab` (malformed JSON → `pdf_template_error` event, export returns 500). **Output format:** A4 (210 × 297 mm), 300 DPI for images. Artifacts are stored in `runs/<run_id>/restoration/artifacts/{project_id}_restoration_summary.pdf` and downloadable from U1 and U5. AC-032 verifies format and content.

**Async task execution:**

- **FR-056** — Long-running operations (identification, sourcing, 3D generation, TTS, audio normalization) run as `asyncio.create_task` background tasks within the single worker. Each task is registered in the SQLite `tasks` table (`task_id` UUID, `project_id`, `task_type`, `status` ∈ `pending|running|completed|failed|interrupted|cancelled`, `progress_pct`, `result` JSON, `error`, `created_at`, `updated_at`, `resumed_from`). Trigger endpoints return `202: {task_id}` immediately; status polls via `GET /restoration/tasks/{task_id}`. **Resume mechanism:** `POST /restoration/tasks/{task_id}/resume` re-runs an `interrupted` or `failed` task from the beginning (no partial-resume; checkpointing is a v2 enhancement), preserving the original `task_id`, recording a `resumed_from` timestamp, and retaining the SQLite state from the prior partial execution. Resume is distinct from re-triggering, which creates a new `task_id`. On restart, `running` → `interrupted` (via FR-067). The event loop yields between dispatches so other requests are served during long tasks. **ABANDONED cancellation:** when a project transitions to ABANDONED (FR-034), all `pending` and `running` tasks for that project are set to `cancelled`; in-flight provider dispatches are allowed to complete but no new dispatches are issued.

**Review-case audit storage:**

- **FR-057** — Review-case resolutions are stored in the SQLite `review_log` table (`review_id, project_id, part_id, field_name, old_value, new_value, actor, timestamp, notes`) and queryable via `GET /restoration/projects/{id}/reviews`. The manifest entry reflects the resolved values. The store is SQLite, not JSON.

**2D diagram generation:**

- **FR-058** — When 3D generation fails for a sub-assembly (or QA pass rate <30% and the operator chooses T3), generate 2D annotated diagrams with `scripts/generate_2d_diagram.py`: composite the job's own intake photos with callout labels (part name, tool, fastener — text derived from the assembly graph's `WalkthroughStep.part_callout` and `WalkthroughStep.tool_callout` values), step numbers, and arrows using Pillow; output `step_{N}_diagram.png` per step into the guide bundle. Diagrams are vehicle-specific (derived from actual intake photos), not generic templates; if no suitable photo exists for a step, a stock illustration from the restoration pack is used and marked as such.

**Shop analytics:**

- **FR-059** — U8 computes shop-level analytics on demand via `GET /restoration/insights?from=&to=&make=`: cost trends (actual vs. estimated), estimation accuracy, common failure points (top QA-quarantined parts, frequent unsourced categories), supplier reliability (on-time rate, price competitiveness, selection frequency, return/dispute rate), sourcing difficulty per make (average system-discovered coverage), KB growth, job counts by state, automation coverage over time. Sources: all per-run SQLite databases, JSON artifacts, and the shared feedback store. No external analytics service.

**Operator-supplied reference dimensions:**

- **FR-060** — `POST /restoration/projects/{id}/parts/{part_id}/dimensions` accepts `{length_mm, width_mm, height_mm}` and stores them in `reference_dimensions_override.json`. The QA rung (FR-017) uses them when no KB entry exists (precedence: KB → operator override → `unverified_dimensions`) and records `dimension_source: "operator_supplied"` in the QA receipt. U5 provides the entry form whenever a part has `qa_status: "unverified_dimensions"`.

**Static routes:**

- **FR-061** — `GET /restoration-ui` serves the operator console (`restoration_copilot.html`); `GET /guide/{token}` serves the mobile guide (`bay_guide.html`); static assets (ES modules, CSS) are served from `/static/restoration/`; guide bundle assets are served from `GET /restoration/projects/{id}/assemblies/{assembly_id}/assets/{filename}` with correct content-type headers (determined by file extension: `.glb` → `model/gltf-binary`, `.mp3` → `audio/mpeg`, `.png` → `image/png`, `.jpg` → `image/jpeg`, `.webp` → `image/webp`, `.txt` → `text/plain`).

**OS restriction:**

- **FR-062** — The module requires a POSIX-compliant OS (Linux or macOS); `fcntl.flock` is POSIX-only. Windows is not supported in v1. `GET /restoration/health` checks `fcntl` availability and returns HTTP 200 with `{"os_supported": false, ...}` when unavailable (not 500). **`os_supported: false` runtime behavior (pinned):** when `os_supported` is false, `POST /restoration/projects` returns 409 with `{"error": "os_not_supported", "message": "Restoration Copilot requires Linux or macOS for file locking. See FR-062."}`. Existing projects remain read-only (U1 displays them, but all state-changing endpoints return 409). This prevents silent data corruption from missing file locks. Future Windows support would upgrade locking to `portalocker`/`filelock` — documented, not v1.

**HTTPS for Service Worker testing:**

- **FR-063** — Service Worker registration and screen wake-lock require HTTPS (or localhost). For local development and testing, `launch-dev.sh` accepts a `--https` flag that starts uvicorn with a self-signed certificate. This enables Service Worker tests to run mechanically without external proxy setup. **Production HTTPS requirement:** for phone access from the shop floor, HTTPS with a **trusted certificate** is required for Service Worker registration — self-signed certificates are rejected by mobile browsers for Service Worker registration in practice. The operator must configure a reverse proxy (Caddy with internal CA, nginx with Let's Encrypt, or a trusted self-signed CA installed on the mechanic's phone). **Production HTTPS checklist** (in §8): (1) configure reverse proxy with trusted cert, (2) verify `GET /guide/{token}` loads over HTTPS without cert warnings, (3) verify `navigator.serviceWorker.controller` is non-null in the browser console, (4) verify screen wake-lock API is available. Without HTTPS, the Service Worker does not register — offline caching is entirely absent (not degraded) and the guide becomes online-only (A-009).

**`--e2e` test flag:**

- **FR-064** — The `--e2e` flag used in test commands (§7) is a pytest custom option registered in `tests/restoration/conftest.py` via `pytest_addoption`. When passed, it enables tests marked with `@pytest.mark.e2e` — these tests execute the full end-to-end pipeline against real provider bridges and require API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BFL_API_KEY`, `MESHY_API_KEY`); the conftest fails fast with a clear message if any are missing. Without `--e2e`, marked tests are skipped. The flag also sets `RUNS_ROOT` to `tests/restoration/tmp_runs/` for isolation. Mock-based tests do NOT require `--e2e` and run by default.

**Learning ledger formula:**

- **FR-066** — The learning-ledger confidence adjustment is the frequency-weighted function pinned in §1: `adjusted_confidence = base_confidence + K * (agreement_rate - 0.5)` with `K = 0.2` (configurable in `defaults.yaml`), `agreement_rate = (matching_corrections + 0.5 * partial_corrections) / total_corrections` over the sample of corrections for the same part category and vehicle make/model/year, **minimum 5 samples (below which no adjustment is applied and `adjusted_confidence = base_confidence` — this guard also handles `total_corrections == 0`, preventing division by zero)**, recency weight `0.95 ^ months_old` per correction with corrections older than 12 months excluded, and clamping to [0.0, 1.0]. Every adjusted confidence carries a `biasing_context` object (`{sample_count, agreement_rate, K, decay_factor, adjusted_value}`) in the identification output for auditability. Vendor ranking and weighted-median cost estimation follow the §1 formulas with the same recency weighting (minimum 3 purchase records for cost estimation, else KB midpoint). Implemented in pure Python with SQL queries — not an ML model. Tested by AC-044. **`FeedbackSignal` carries a denormalized `category` field** (populated from the manifest at signal-creation time) to prevent learning-ledger misattribution when manifest categories change after the signal was recorded.

**Boot-time crash reconciliation:**

- **FR-067** — On server startup, `reconcile_run_state()` in `orchestrator/core/restoration_reconcile.py` runs for each restoration run: (1) reads `project.json` for current status and the SQLite `tasks` table for task statuses; (2) tasks with `status: "running"` are marked `interrupted`; if the project status implies a running async task but none exists, the project is flagged "needs attention — possible interrupted task" in U1; (3) if `sourcing.json` is missing or stale (older than the latest `sourcing_candidates` row), it is rebuilt from SQLite; (4) if `project.json` status conflicts with the SQLite `events` table's latest `restoration_stage_changed` event, the SQLite event wins and `project.json` is corrected; (5) event-log divergence is resolved per FR-028 (import JSONL→SQLite, re-export SQLite→JSONL, summary `event_log_divergence` event); (6) if `budget.json` shows `overridden` but no corresponding audit event exists, a `reconciliation_warning` event is logged; (7) every correction is logged as `crash_reconciliation_sync` and surfaced in U1/U7. The job is also callable on demand via `POST /restoration/reconcile/{run_id}`. Tested by AC-047 and AC-048.

**Stale lock cleanup:**

- **FR-068** — `launch.sh` "clears stale locks on boot" by checking `runs/.restoration_index.lock` and per-file `.lock` sidecars: if a lock file exists but the holding PID (recorded inside the lock file) is not alive (checked via `os.kill(pid, 0)`), the lock file is removed. `fcntl.flock` advisory locks are auto-released on process exit and do not need cleanup — this routine handles the edge case where a process was killed before releasing a lock file (e.g., SIGKILL during a write). The cleanup is logged as `stale_lock_cleared` with the file path and dead PID.

## 5. Data, integration, and security contract

**Data model:**

```python
class RestorationProject:
    project_id: str
    run_id: str
    vehicle_meta: VehicleMeta
    status: str  # draft, intake_open, intake_sealed, identifying,
                 # review_open, manifest_locked, budget_ruled,
                 # hunting, sourcing_insufficient, hunt_sealed,
                 # meshing, graph_review, published, in_service,
                 # closed, abandoned
    parked: bool = False
    parked_reason: Optional[str] = None
    abandoned_reason: Optional[str] = None  # FR-034: required for ABANDONED; terminal
    cloned_from: Optional[str] = None       # optional reference to an abandoned project
    in_service_checklist: Optional[list[str]] = None  # FR-033: from defaults.yaml
    created_at: datetime
    updated_at: datetime
    budget_ceiling_usd: Optional[float]  # USD only (v1)
    budget_override_reason: Optional[str]
    api_cost_ceiling_usd: float = 100.0       # FR-065: per-job API cost ceiling
    api_cost_override_reason: Optional[str]   # FR-065
    automation_coverage_pct: Optional[float]
    system_sourcing_coverage_pct: Optional[float]  # FR-013: system-discovered only
    total_sourcing_coverage_pct: Optional[float]   # FR-013: including manual entries
    critical_path_coverage_pct: Optional[float]
    mesh_qa_pass_rate: Optional[float]
    actual_spend_usd: Optional[float]      # sum of confirmed purchase prices
    api_cost_to_date_usd: float = 0.0      # FR-051
    reopened_from: Optional[datetime]      # FR-035

class VehicleMeta:
    year: Optional[str]
    make: Optional[str]
    model: Optional[str]
    trim: Optional[str]
    engine_code: Optional[str]
    notes: Optional[str]

class ComponentRecord:
    part_id: str
    name: str
    category: str
    condition: str  # present, deteriorated, missing
    confidence: float
    photo_refs: list[str]
    location_on_vehicle: Optional[str]
    source: str  # auto, manual
    kb_match: Optional[str]
    biasing_context: Optional[dict]  # FR-066: {sample_count, agreement_rate, K,
                                     # decay_factor, adjusted_value} — present when
                                     # the learning-ledger formula adjusted confidence

class ManifestEntry:
    part_id: str
    name: str
    oem_number: Optional[str]
    aftermarket_alternatives: list[str]
    quantity: int
    criticality: str  # critical, standard, optional
    estimated_cost_usd: Optional[float]  # KB midpoint or None
    sourcing_status: str  # FR-005 enum: pending, sourced, unsourceable,
                          # fabrication_ref, previously_sourced
                          # (all values are members of this single field —
                          # no separate booleans)
    confidence: float
    requires_review: bool

class PartSourcingQuery:
    part_id: str
    part_name: str
    oem_number: Optional[str]
    vehicle_make: str
    vehicle_model: str
    vehicle_year: str
    per_part_budget_ceiling_usd: float  # from 60/30/10 criticality allocation (FR-010)
    criticality: str  # critical, standard, optional

class SourcingCandidate:
    part_id: str
    candidate_id: str
    vendor: str
    oem_number: Optional[str]  # FR-012: used in deduplication key
    price_usd: float
    condition: str
    availability: str
    region: str
    url_or_contact: str
    tradeable: bool
    provenance: str  # source_registry, research_primitive, manual_entry,
                     # unstructured_lead, unverified_url
                     # NOTE: manual_entry is absent from the research primitive's
                     # JSON output schema because manual entries arrive via a
                     # separate REST path (POST .../sourcing/manual), not via
                     # the research primitive.
    fetched_at: datetime
    trade_partner_id: Optional[str]

PartSourcingResult = SourcingCandidate  # typed alias used by the research primitive

class UnsourceableFlag:
    part_id: str
    reason_code: str  # discontinued, no_aftermarket_reproduction,
                      # regional_unavailability, exceeds_budget, no_vendor_response
    alternative_suggestion: Optional[str]
    fabrication_reference_glb: Optional[str]

class NegotiationRecord:
    part_id: str
    candidate_id: str
    status: str  # pending, negotiating, ordered, received, passed, returned, disputed
    notes: str
    final_price_usd: Optional[float]  # required for ordered transition
    updated_at: datetime

class PurchaseRecord:
    part_id: str
    vendor: str
    price_usd: float
    condition: str
    ordered_at: datetime
    received_at: Optional[datetime]
    notes: Optional[str]
    batch_id: Optional[str]  # group-buy linking

class AssemblyGraphStep:
    step_index: int
    part_ids: list[str]
    description: str
    tool_callout: Optional[str]
    safety_warning: Optional[str]
    estimated_duration_s: float

class AssemblyGraph:
    assembly_id: str
    steps: list[AssemblyGraphStep]
    tool_list: list[str]

class WalkthroughAssembly:
    assembly_id: str
    name: str
    glb_paths: list[str]
    # Invariant: when glb_paths is non-empty, glb_paths[0] is always the
    # exploded-view GLB; glb_paths[1:] are per-step positions.
    # len(glb_paths) == 1 is a valid T2 state (exploded view only).
    # In T3 (2D diagrams) and T4 (text-only), glb_paths is empty.
    qa_status: str  # pending, passed, quarantined, unverified_dimensions,
                    # text_only (T4), has_2d_diagrams (T3)
    # Consistency invariant: qa_status determines the boolean fields:
    #   qa_status == "text_only"        ⟺ text_only == True
    #   qa_status == "has_2d_diagrams"  ⟺ has_2d_diagrams == True and text_only == False
    #   otherwise                       ⟺ both False
    # The booleans are derived from qa_status (computed properties, never
    # independently settable) to prevent disagreement.
    qa_reason: Optional[str]
    step_count: int  # 3–5 per sub-assembly (FR-018)
    audio_format: str  # mp3
    audio_lufs_target: float = -16.0  # FR-019: configurable via defaults.yaml
    total_duration_s: float  # bounded: max 600s per sub-assembly (FR-020)
    text_only: bool = False        # T4 — derived from qa_status
    has_2d_diagrams: bool = False  # T3 — derived from qa_status
    bundle_version: int = 1        # auto-incremented on PUBLISHED→PUBLISHED re-publish
    superseded: bool = False

class WalkthroughStep:
    assembly_id: str
    step_index: int
    description: str
    step_position_label: str  # FR-018: "exploded", "positioning", "install",
                              # "torque", "finishing" — semantic meaning of
                              # the per-step mesh position
    audio_path: str
    audio_available: bool  # false when TTS unavailable
    duration_s: float
    glb_file: str          # which GLB in glb_paths (empty in T3/T4)
    has_2d_diagram: bool
    diagram_path: Optional[str]
    tool_callout: Optional[str]
    part_callout: Optional[str]
    safety_warning: Optional[str]
    text_fallback: str
    still_image_path: Optional[str]
    glossary_terms: list[str]

class GuideToken:
    token_id: str  # 32-byte random URL-safe string
    project_id: str
    assembly_id: str
    bundle_version: int
    minted_at: datetime
    expires_at: datetime  # default minted_at + 30 days; extendable (FR-040)
    revoked_at: Optional[datetime]
    revoked_by: Optional[str]
    superseded_at: Optional[datetime]
    superseded_by: Optional[str]  # token_id of superseding token
    last_accessed_at: Optional[datetime]
    access_count: int

class ReferenceKBEntry:
    part_id: str
    name: str
    oem_number: Optional[str]
    aftermarket_alternatives: list[str]
    category: str
    criticality: str  # critical, standard, optional
    reference_dimensions_mm: Optional[dict]  # {length, width, height}
    indicative_price_range_usd: Optional[dict]  # {min, max, mid}
    interchange: list[str]  # compatible vehicle make/model/years

class FeedbackSignal:  # learning ledger (FR-007, FR-043, FR-049, FR-054, FR-066)
    signal_id: str  # UUID
    project_id: str
    signal_type: str  # identification_correction, sourcing_selection, purchase_outcome
    part_id: Optional[str]
    category: Optional[str]  # DENORMALIZED from manifest at signal-creation time
                              # to prevent learning-ledger misattribution when
                              # manifest categories change after the signal was recorded
    vehicle_make: Optional[str]
    vehicle_model: Optional[str]
    vehicle_year: Optional[str]
    field_name: Optional[str]
    old_value: Optional[str]
    new_value: Optional[str]
    vendor: Optional[str]
    final_price_usd: Optional[float]
    created_at: datetime

class AsyncTask:
    task_id: str  # UUID
    project_id: str
    task_type: str  # identify, source, generate_3d, tts, audio_normalize
    status: str  # pending, running, completed, failed, interrupted, cancelled
    progress_pct: float
    result: Optional[dict]
    error: Optional[str]
    created_at: datetime
    updated_at: datetime
    resumed_from: Optional[datetime]  # set when resumed via POST .../resume (FR-056)

class APICostRecord:
    project_id: str
    provider: str  # bfl, meshy, llm, tts
    operation: str  # image_generation, mesh_generation, vision, sourcing, tts
    cost_usd: float
    timestamp: datetime
    description: str

class ReviewLogEntry:
    review_id: str
    project_id: str
    part_id: str
    field_name: str
    old_value: str
    new_value: str
    actor: str
    timestamp: datetime
    notes: Optional[str]

class SourceRegistryEntry:
    source_id: str
    vendor_name: str
    url: str
    search_template: Optional[str]  # URL template with {part_name}, {oem_number},
                                    # {vehicle_make}, {vehicle_model}, {vehicle_year}
                                    # Consumed by the research primitive (FR-012),
                                    # not by the restoration module directly.
                                    # Entries with search_template=None are
                                    # trade-partner contacts skipped by the
                                    # research primitive and surfaced in U4
                                    # as manual-contact sources.
    specialty: Optional[str]
    is_trade_partner: bool = False
    contact_info: Optional[str]
    rate_limit_seconds: int = 2  # per-source sleep enforced in the research primitive

class MechanicFlag:
    flag_id: str
    project_id: str
    assembly_id: str
    step_index: int
    problem_type: str  # wrong_part, step_unclear, tool_missing, safety_concern, other
    description: str
    screenshot_path: Optional[str]
    photo_path: Optional[str]
    status: str  # open, resolved
    created_at: datetime
    resolved_at: Optional[datetime]
    resolution_notes: Optional[str]
    # Downstream routing (FR-054):
    # - wrong_part flags → FeedbackSignal (type=identification_correction)
    # - tool_missing flags → FeedbackSignal (type=sourcing_selection)
    # - step_unclear/other flags → mechanic_flags table only (no feedback signal)
```

*Note: Exact Pydantic schemas are `[unverified — needs orchestrator/core/restoration_models.py]`. The field set above is the implementation target. The `text_only` and `has_2d_diagrams` booleans are derived from `qa_status` (computed properties), not independent fields, to prevent consistency violations.*

**Durable-state rules:** Hybrid JSON + SQLite persistence with boot-time crash reconciliation (FR-067).

```
runs/<run_id>/restoration/
├── project.json              # RestorationProject (JSON, fcntl.flock on .lock sidecar)
├── intake/
│   ├── photos/               # uploaded originals (HEIC preserved, others as-is)
│   ├── thumbnails/           # JPEG thumbnails (HEIC transcoded, others generated)
│   │                         # — vision pipeline consumes these, NOT originals (FR-002)
│   └── parts_list.csv        # optional imported list
├── inventory.json            # list[ComponentRecord] (JSON, written once)
├── manifest.json             # locked manifest with version + coverage metric (JSON, written once)
├── budget.json               # ruling + override audit trail (JSON, written once)
├── sourcing.json             # summary snapshot (JSON; rebuilt from SQLite by reconciliation)
├── reference_dimensions_override.json  # operator-supplied dimensions (FR-060)
├── assembly_graph.json       # AssemblyGraph: steps, part placement, tools (JSON)
├── guides/
│   └── {assembly_id}/
│       └── v{N}/
│           ├── bundle_meta.json      # asset manifest, glossary, preload priority,
│           │                         # audio_lufs_target (FR-031)
│           ├── exploded_view.glb
│           ├── step_{N}.glb
│           ├── step_{N}.mp3
│           ├── step_{N}_text.txt
│           ├── step_{N}_diagram.png  # T3 2D annotated diagram
│           └── step_{N}_image.jpg    # still image fallback
├── artifacts/                # customer-facing PDFs (FR-055, A4 300 DPI)
├── flags/                    # mechanic flag screenshots/photos (FR-054)
├── qa_receipts/
│   └── {assembly_id}.json    # includes per-axis deviation values, dimension_source,
│                             # and scale_factor_applied (FR-017)
└── restoration.db            # SQLite (WAL mode, 5s busy timeout):
    ├── sourcing_candidates
    ├── negotiation_records
    ├── purchase_records
    ├── guide_tokens
    ├── events                # CANONICAL audit source (FR-028)
    ├── review_log            # FR-057
    ├── tasks                 # FR-056
    ├── api_costs             # FR-051
    ├── kb_proposals          # FR-049 auto-extraction proposals
    └── mechanic_flags        # FR-054

runs/restoration_feedback.db  # shared cross-run learning ledger (feedback_signals)
                              # SQLite WAL mode, 5s busy timeout
runs/restoration_index.json   # U1 cache (atomic updates via single-writer lock, FR-048)
                              # NOT a source of truth — always reconstructable from
                              # SQLite + project.json files
runs/.restoration_index.lock  # single-writer lock for index updates
```

**`events.jsonl` schema and rotation (pinned):**

```jsonl
# Per-run file: runs/<run_id>/restoration/events.jsonl
# Each line is a JSON object:
{"event_id": "uuid", "project_id": "str", "event_type": "str", "timestamp": "ISO 8601", "actor": "str", "metadata": {}}
# Rotation: when the file exceeds 10 MB, it is renamed to events.{N}.jsonl (N increments).
# Maximum 5 rotated files retained per run; oldest deleted.
# The file is append-only during a run.
```

**Reference KB runtime schema:**

```yaml
# orchestrator/prompts/packs/restoration_kb.yaml
makes:
  Chevrolet:
    models:
      Camaro:
        years:
          "1969":
            parts:
              - part_id: "chevy_camaro_69_brake_caliper_front"
                name: "Front Brake Caliper"
                oem_number: "5463628"
                aftermarket_alternatives: ["PBR-4356", "A1-Cardone-19B1524"]
                category: "brake"
                criticality: "critical"
                reference_dimensions_mm: {length: 180, width: 95, height: 120}
                indicative_price_range_usd: {min: 45, max: 180, mid: 112}
                interchange: ["1967-1969 Camaro", "1968-1972 Nova"]
```

**KB seed CSV schema (falsifiable):**

```csv
# orchestrator/prompts/packs/restoration_kb_seed.csv
# Columns (in order):
# part_id, name, oem_number, aftermarket_alternatives (semicolon-separated),
# category, criticality,
# reference_dimensions_length_mm, reference_dimensions_width_mm, reference_dimensions_height_mm,
# indicative_price_min_usd, indicative_price_max_usd, indicative_price_mid_usd,
# interchange (semicolon-separated make-model-year ranges)
#
# Per-category minimums (validated by scripts/seed_restoration_kb.py and
# scripts/validate_kb_seed.py):
# brake ≥30, suspension ≥25, engine ≥40, body ≥30, interior ≥25,
# electrical ≥15, exhaust ≥10, fuel ≥10, cooling ≥10, transmission ≥10
# Total ≥205 entries across ≥5 distinct vehicle make/model/year combinations
# DUPLICATE part_id check: validate_kb_seed.py fails with exit code 1 if any
# part_id appears more than once in the CSV.
chevy_camaro_69_brake_caliper_front,Front Brake Caliper,5463628,PBR-4356;A1-Cardone-19B1524,brake,critical,180,95,120,45,180,112,1967-1969 Camaro;1968-1972 Nova
```

**Source registry schema:**

```yaml
# orchestrator/prompts/packs/restoration_sources.yaml
# search_template placeholders (consumed by the research primitive, FR-012):
#   {part_name}     → PartSourcingQuery.part_name (RFC 3986 percent-encoded)
#   {oem_number}    → PartSourcingQuery.oem_number (omitted from URL if null;
#                     if sole value in a query param, the param is dropped)
#   {vehicle_make}  → PartSourcingQuery.vehicle_make (RFC 3986 percent-encoded)
#   {vehicle_model} → PartSourcingQuery.vehicle_model (RFC 3986 percent-encoded)
#   {vehicle_year}  → PartSourcingQuery.vehicle_year (RFC 3986 percent-encoded)
# Entries with search_template=null are trade-partner contacts:
#   skipped by the research primitive, surfaced in U4 as manual-contact sources.
sources:
  - source_id: "hemmings"
    vendor_name: "Hemmings"
    url: "https://hemmings.com/search"
    search_template: "https://hemmings.com/search?q={part_name}+{vehicle_make}+{vehicle_year}"
    specialty: "classic car parts marketplace"
    is_trade_partner: false
    rate_limit_seconds: 5
  - source_id: "local_rebuilder_01"
    vendor_name: "Joe's Brake Rebuilding"
    url: "tel:555-123-4567"
    search_template: null  # no URL template — manual-contact source
    specialty: "brake system rebuilding"
    is_trade_partner: true
    contact_info: "Joe, 555-123-4567, joesbrakes@example.com"
    rate_limit_seconds: 2
```

**Glossary schema:**

```yaml
# orchestrator/prompts/packs/restoration_glossary.yaml
terms:
  - term: "wheel cylinder"
    definition: "A hydraulic component that pushes brake shoes against the drum."
  - term: "master cylinder"
    definition: "The primary hydraulic pump that converts pedal pressure to hydraulic pressure."
```

**PDF template schema (committed, validated at load):**

```json
{
  "page_size": "A4",
  "dpi": 300,
  "margin_mm": 15,
  "sections": [
    {"name": "header", "fields": ["shop_name", "vehicle_metadata", "date"]},
    {"name": "before_after_photos", "layout": "2_column", "max_pairs": 3, "photo_size_mm": [80, 60]},
    {"name": "assembly_screenshots", "angles": ["front", "side", "top", "exploded"], "screenshot_size_mm": [70, 70]},
    {"name": "restoration_summary", "fields": ["vehicle_metadata", "assembly_name", "parts_count", "system_sourcing_coverage", "total_sourcing_coverage", "estimated_cost", "actual_cost", "step_list"]},
    {"name": "footer", "text": "Generated by Restoration Copilot", "include_version": true}
  ]
}
```
Validator: `reportlab` loads the template JSON at export time; malformed JSON → `pdf_template_error` event, export returns 500. AC-032 verifies format and content.

**`bundle_meta.json` schema (per published guide):**

```json
{
  "assembly_id": "brake_system",
  "bundle_version": 2,
  "published_at": "2026-07-24T12:00:00Z",
  "text_only": false,
  "has_2d_diagrams": true,
  "supersedes": 1,
  "audio_lufs_target": -16,
  "steps": [
    {
      "step_index": 0,
      "description": "Exploded view of brake system",
      "step_position_label": "exploded",
      "audio_path": "step_0.mp3",
      "audio_available": true,
      "glb_file": "exploded_view.glb",
      "has_2d_diagram": true,
      "diagram_path": "step_0_diagram.png",
      "text_fallback": "step_0_text.txt",
      "still_image_path": "step_0_image.jpg",
      "tool_callout": "13mm socket",
      "part_callout": "Front brake caliper",
      "safety_warning": "Do not over-torque the banjo bolt — 25 ft-lbs maximum",
      "glossary_terms": ["caliper", "torque wrench"]
    }
  ],
  "glossary": {
    "caliper": "The component that squeezes the brake pads against the rotor to stop the wheel.",
    "torque_wrench": "A tool that clicks when you reach a set tightness, preventing over-tightening."
  },
  "total_size_mb": 35.8,
  "total_duration_s": 180.5,
  "preload_priority": ["html", "text", "images", "audio", "glb"],
  "preload_time_budget_s": 30
}
```

**REST API surface:**

| Method | Path | Request Body | Response | Errors | State Transition |
|---|---|---|---|---|---|
| GET | /restoration-ui | — | 200: HTML operator console | 401: no session | — |
| GET | /guide/{token} | — | 200: HTML guide page | 404: invalid/revoked, 410: expired, 429: rate limited; 200 + `X-Guide-Superseded: true` header: superseded | — |
| POST | /restoration/projects | `{vehicle_meta: VehicleMeta}` | 201: `{project_id, run_id}` | 400, 401, 409 (os_not_supported) | → INTAKE_OPEN |
| GET | /restoration/projects | `?state=&search=` | 200: `[{project_id, status, metrics}]` | 401 | — |
| GET | /restoration/projects/{id} | — | 200: `RestorationProject` | 404 | — |
| POST | /restoration/projects/{id}/intake | multipart: `photos[]`, `parts_list?` | 200: `{receipts, gap_list}` | 400, 413 | — |
| POST | /restoration/projects/{id}/intake/seal | — | 200: `{status}` | 409 | → INTAKE_SEALED |
| POST | /restoration/projects/{id}/identify | — | 202: `{task_id}` | 409 | → IDENTIFYING |
| GET | /restoration/tasks/{task_id} | — | 200: `AsyncTask` | 404 | — |
| POST | /restoration/tasks/{task_id}/resume | — | 202: `{task_id}` | 409 | — |
| GET | /restoration/projects/{id}/manifest | — | 200: `{entries, coverage, review_cases}` | 404 | — |
| POST | /restoration/projects/{id}/manifest/resolve | `{part_id, name, condition, notes}` | 200: `{entry, audit_delta}` | 400, 404, 409 (not in review) | — |
| GET | /restoration/projects/{id}/reviews | — | 200: `[ReviewLogEntry]` | 404 | — |
| POST | /restoration/projects/{id}/manifest/lock | — | 200: `{manifest_version, coverage}` | 409 | → MANIFEST_LOCKED |
| POST | /restoration/projects/{id}/budget | `{budget_ceiling_usd: float}` | 200: `{ruling, detail, unknown_cost_count}` | 400 | → BUDGET_RULED |
| POST | /restoration/projects/{id}/budget/override | `{reason: str}` | 200: `{override_record}` | 409 (not shortfall/insufficient) | — |
| POST | /restoration/projects/{id}/source | — | 202: `{task_id}` | 409 | → HUNTING |
| POST | /restoration/projects/{id}/sourcing/pause | — | 200: `{status}` | 409 | — |
| POST | /restoration/projects/{id}/sourcing/resume | — | 200: `{status}` | 409 | — |
| GET | /restoration/projects/{id}/sourcing | — | 200: `{candidates, flags, system_coverage, total_coverage, critical_coverage}` | 404 | — |
| POST | /restoration/projects/{id}/sourcing/seal | — | 200: `{status, total_selected_cost, budget_ceiling, cost_gate_passed}` | 409 (cost gate / state) | → HUNT_SEALED or SOURCING_INSUFFICIENT |
| POST | /restoration/projects/{id}/sourcing/manual | `{part_id, vendor, price_usd, condition, ...}` | 200: `{candidate}` | 400 | — |
| POST | /restoration/projects/{id}/negotiation | `{part_id, candidate_id, status, notes, final_price_usd?}` | 200: `{record}` | 400 (missing required field), 409 (invalid transition) | — |
| POST | /restoration/projects/{id}/purchase | `{part_id, vendor, price_usd, condition, ordered_at, received_at?, notes?, batch_id?}` | 200: `{record}` | 400 | — |
| POST | /restoration/projects/{id}/parts/{part_id}/dimensions | `{length_mm, width_mm, height_mm}` | 200: `{dimensions}` | 400, 404 | — |
| POST | /restoration/projects/{id}/generate_3d | `{assembly_id}` | 202: `{task_id}` | 409 | → MESHING |
| GET | /restoration/projects/{id}/assemblies | — | 200: `[WalkthroughAssembly]` (incl. `bundle_version`) | — | — |
| GET | /restoration/projects/{id}/assemblies/{assembly_id}/assets/{filename} | — | 200: binary (GLB/MP3/PNG/JPG/TXT) | 404 | — |
| POST | /restoration/projects/{id}/assembly/graph | `{graph: AssemblyGraph}` | 200: `{graph}` | 400 | → GRAPH_REVIEW |
| POST | /restoration/projects/{id}/publish | `{assembly_id}` | 200: `{bundle, token}` | 409 | → PUBLISHED |
| POST | /restoration/projects/{id}/export-artifact | — | 200: `{artifact_path}` | 404, 500 (template error) | — |
| POST | /restoration/projects/{id}/in-service | `{checklist: list[str]}` | 200: `{status}` | 400 (incomplete checklist, names missing items), 409 | → IN_SERVICE |
| POST | /restoration/projects/{id}/abandon | `{reason: str}` | 200: `{status, cancelled_tasks}` | 400 (missing reason), 409 (already abandoned) | → ABANDONED |
| POST | /restoration/projects/{id}/reopen | `{reason: str}` | 200: `{status, preserved_artifacts}` | 409 (not CLOSED) | → MANIFEST_LOCKED (from CLOSED only) |
| POST | /restoration/projects/{id}/flags | `{assembly_id, step_index, problem_type, description, screenshot_data_url?, photo_data_url?}` | 201: `{flag_id}` | 400, 410 (token expired) | — |
| POST | /restoration/projects/{id}/flags/{flag_id}/resolve | `{resolution_notes}` | 200: `{flag}` | 404 | — |
| POST | /restoration/projects/{id}/tokens | `{assembly_id, bundle_version}` | 201: `GuideToken` | 404 | — |
| DELETE | /restoration/projects/{id}/tokens/{token_id} | — | 200: `{revoked}` | 404 | — |
| DELETE | /restoration/projects/{id}/tokens | — | 200: `{revoked_count}` | — | — |
| POST | /restoration/projects/{id}/tokens/{token_id}/supersede | — | 200: `{superseded}` | 404 | — |
| POST | /restoration/projects/{id}/tokens/{token_id}/extend | `{extends_days: int}` | 200: `{token}` | 404, 400 (max 365) | — |
| GET | /restoration/projects/{id}/api-costs | — | 200: `{total, per_provider, ceiling, pct_of_ceiling}` | 404 | — |
| POST | /restoration/projects/{id}/api-cost/override | `{reason: str}` | 200: `{override_record}` | 409 | — |
| POST | /restoration/reconcile/{run_id} | — | 200: `{reconciled, discrepancies_fixed}` | 404 | — |
| GET | /restoration/insights | `?from=&to=&make=` | 200: `{cost_trends, failure_points, supplier_reliability, estimation_accuracy, kb_growth, sourcing_difficulty}` | — | — |
| GET | /restoration/health | — | 200: `{module_loaded, active_projects, pipeline_route, os_supported, version}` | 200 with `os_supported: false` when fcntl unavailable; 500 only on module-instantiation failure | — |
| POST | /restoration/provider/pause | `{provider: str}` | 200: `{status, affected_jobs}` | 400 | — |
| POST | /restoration/provider/resume | `{provider: str}` | 200: `{status}` | 400 | — |
| POST | /restoration/provider/failover | `{provider: str, fallback: str}` | 200: `{status}` | 400 | — |
| POST | /restoration/provider/recheck | `{provider: str}` | 200: `{status}` | 400 | — |
| GET | /restoration/kb/entries | `?make=&model=&year=` | 200: `[ReferenceKBEntry]` | — | — |
| POST | /restoration/kb/entries | `ReferenceKBEntry` | 201: `{part_id}` | 400 | — |
| PUT | /restoration/kb/entries/{part_id} | `ReferenceKBEntry` | 200: `{entry}` | 404 | — |
| DELETE | /restoration/kb/entries/{part_id} | — | 200: `{deleted}` | 404 | — |
| POST | /restoration/kb/approve | `{proposal_id: str}` | 200: `{entry}` | 404 | — |
| GET | /restoration/sources | — | 200: `[SourceRegistryEntry]` | — | — |
| POST | /restoration/sources | `SourceRegistryEntry` | 201: `{source_id}` | 400 | — |
| PUT | /restoration/sources/{source_id} | `SourceRegistryEntry` | 200: `{entry}` | 404 | — |
| DELETE | /restoration/sources/{source_id} | — | 200: `{deleted}` | 404 | — |

**Research primitive interface (pinned):**

```python
# orchestrator/core/research_primitives.py
# [unverified — A-010: open construction task with validation gate]

# JSON output schema per PartSourcingQuery:
# {
#   "part_id": "string",
#   "candidates": [
#     {
#       "part_id": "string", "candidate_id": "string", "vendor": "string",
#       "oem_number": "string|null", "price_usd": float, "condition": "new|used|rebuilt|nos",
#       "availability": "in_stock|backorder|special_order", "region": "string",
#       "url_or_contact": "string", "tradeable": bool,
#       "provenance": "source_registry|research_primitive|unstructured_lead|unverified_url",
#       "fetched_at": "ISO 8601 datetime", "trade_partner_id": "string|null"
#     }
#   ],
#   "unsourceable": {
#     "part_id": "string",
#     "reason_code": "discontinued|no_aftermarket_reproduction|regional_unavailability|exceeds_budget|no_vendor_response",
#     "alternative_suggestion": "string|null",
#     "fabrication_reference_glb": "string|null"
#   } | null,
#   "errors": [
#     {"part_id": "string", "error": "string", "retryable": bool}
#   ]
# }
#
# NOTE: "manual_entry" is absent from this schema because manual entries
# arrive via a separate REST path (POST .../sourcing/manual), not via
# the research primitive. The SourcingCandidate Python class includes
# "manual_entry" in its provenance enum to cover both paths.

def research_part_sourcing(
    query: PartSourcingQuery,
    source_registry: list[SourceRegistryEntry],  # from restoration_sources.yaml
    bridge_dispatcher: Dispatcher                # Sneferu's bridge dispatch
) -> dict:
    """
    Tiered sourcing (pinned order — serial, not parallel):
    1. Source registry: for each entry WITH a search_template, the primitive
       interpolates PartSourcingQuery fields into the entry's search_template
       with RFC 3986 percent-encoding applied to all placeholder values:
         {part_name}→urlencode(query.part_name),
         {oem_number}→urlencode(query.oem_number) (omitted from URL if null:
           if sole value in a query param, the param is dropped entirely;
           if part of a compound value, the token is removed and adjacent
           separators collapsed),
         {vehicle_make}→urlencode(query.vehicle_make),
         {vehicle_model}→urlencode(query.vehicle_model),
         {vehicle_year}→urlencode(query.vehicle_year)
       and fetches the formatted URL through the bridge layer. Entries
       WITHOUT a search_template are skipped (trade-partner contacts).
       Rate limit: sleep rate_limit_seconds between requests to the same
       source; enforced in this function, not in the restoration module.
    2. LLM-mediated web search: for parts with <3 candidates from tier 1,
       the configured reasoning bridge is prompted with a structured query.
       The LLM generates search URLs and parses result descriptions from
       its training data and any web-browsing capability the bridge exposes;
       it does NOT issue direct HTTP requests. [unverified — A-010]
    3. Unstructured fallback: results that fail structured extraction are
       returned with provenance="unstructured_lead" for operator manual entry.

    Hallucination defenses:
    - URLs validated via HEAD request (5s timeout); non-resolving URLs flagged
      provenance="unverified_url" (still surfaced, with warning).
    - Prices validated as positive numbers; invalid prices set null.
    - Duplicates deduplicated by part_id + vendor + oem_number + similar price ±5%.

    Per-query timeout: 30s. Retries: 3 with exponential backoff (2s, 4s, 8s).
    After retries exhausted: part marked unsourced, reason "no_vendor_response".
    Rate limit: 1 query per rate_limit_seconds per source. Sequential per project.

    Returns: dict per the JSON schema above (candidates + unsourceable + errors).

    Error taxonomy:
    - BridgeTimeoutError: the bridge layer timed out; retryable.
    - BridgeUnavailableError: the bridge layer is down; non-retryable, surfaces to U7.
    - ParseError: structured extraction failed; result flagged unstructured_lead.
    - RateLimitExceeded: per-source rate limit hit; waits and retries.
    """
```

**Sneferu API dependency enumeration (complete):** See FR-026 for the table of exactly 5 endpoints. No other Sneferu endpoint is called by the restoration module.

**Integration boundaries:** All model dispatch, vision analysis, 3D generation, TTS, and sourcing queries travel through Sneferu's existing bridge layer. BFL and Meshy are provider endpoints within the frozen game-pipeline route. TTS via OpenAI TTS (`tts-1`, voice `alloy`) is bounded by A-007. The source registry is a local YAML file; registry URL queries route through the bridge layer via the research primitive, not direct HTTP from the restoration module. No external databases, message brokers, or hosted services are introduced. SQLite is embedded.

**Authentication and authorization:** Single-shop, single-operator. Operator authenticates via existing Sneferu operator-session endpoints. The mechanic surface (U6) requires only a revocable, time-bounded, extendable token — no operator session. Budget override requires the operator's own session. API cost ceiling override requires the operator's own session. Token rate limiting: 60 requests per token per hour. Token security: see U6 token security threat model (noindex, no-referrer, 30-day expiry, revocation).

**Secrets handling:** No new secrets beyond existing Sneferu bridge API keys. Keys are read from environment variables or `.env` at process start; no secret is written to the repository, logged, or persisted in run artifacts.

**Validation:** Photos validated by magic bytes and byte count (not extension; signatures in FR-002). Parts-list rows validated by field presence (part name required; quantity defaults 1). Budget values validated as positive numbers (USD). Dimensions validated as positive millimeters. Token validity checked on every U6 request. KB YAML validated on load (FR-049 error handling). KB seed CSV validated by `scripts/validate_kb_seed.py` after seeding (entry count, non-empty OEM numbers, price ranges, per-category minimums, **duplicate `part_id` uniqueness**). PDF template JSON validated at load by `reportlab`.

**Privacy:** Vehicle photographs, manifests, and sourcing data live per run in the shop's own `runs/` directory. No data leaves the Sneferu host except through the bridge layer to configured model providers. No telemetry, analytics, or third-party sharing. Guide pages include `noindex` and `no-referrer` headers.

**Retention:** Run artifacts persist until the operator deletes the run or Sneferu's standard retention applies. Guide tokens expire after 30 days (configurable, extendable per FR-040); underlying bundles persist. `events.jsonl` rotates at 10 MB with 5 rotated files retained per run. The shared `runs/restoration_feedback.db` persists across runs — it is the learning mechanism.

**Migration:** Not applicable for JSON artifacts (additive field defaults). Per-run SQLite databases are created on first access with additive schema; the shared feedback DB is created once. No cross-run migration.

**Concurrency strategy:** Single-worker uvicorn (v1 implementation limitation). JSON writes use `fcntl.flock` on per-file `.lock` sidecars. SQLite WAL mode with 5 s busy timeout. `restoration_index.json` atomic updates via the single-writer lock discipline (FR-048). `restoration_feedback.db` uses SQLite WAL for concurrent cross-run writes. Async tasks keep the worker responsive (FR-056). Global sourcing concurrency limit (FR-069). POSIX-only deployment (FR-062).

## 6. Packaging and repository contract

**Repository layout:** Extends the existing `claudopus` repository.

```
orchestrator/
├── core/
│   ├── restoration_pipeline.py    # workflow definitions, state machine, primitive orchestration
│   ├── restoration_models.py      # Pydantic schemas (§5 data model)
│   ├── restoration_reconcile.py   # boot-time crash reconciliation (FR-067)
│   └── research_primitives.py     # research_part_sourcing implementation [unverified — A-010]
├── ui/web/
│   ├── restoration_copilot.html   # operator console shell (loads ES modules)
│   ├── restoration_copilot/
│   │   ├── job_board.js           # U1
│   │   ├── intake_bay.js          # U2
│   │   ├── parts_bench.js         # U3 (incl. KB sub-panel)
│   │   ├── wallet_desk.js         # U4 (incl. source registry panel)
│   │   ├── model_shop.js          # U5
│   │   ├── engine_room.js         # U7 (with write actions per FR-050)
│   │   ├── shop_insights.js       # U8
│   │   └── shared.js
│   ├── bay_guide.html             # mobile guide shell
│   ├── bay_guide/
│   │   ├── guide_view.js          # U6 main logic
│   │   ├── service_worker.js      # offline caching (version-aware LRU eviction)
│   │   ├── explore_mode.js        # free-explore mode
│   │   ├── glossary.js            # glossary popups
│   │   ├── flag_problem.js        # flag-a-problem (IndexedDB queue)
│   │   ├── flag_sync.js           # sync-on-reconnect logic
│   │   └── shared.js
│   ├── restoration_styles.css
│   └── static/restoration/        # static assets (JS, CSS, images)
└── prompts/packs/
    ├── restoration_pipeline.yaml      # domain prompt pack
    ├── restoration_kb.yaml            # reference KB (seeded by bootstrap script)
    ├── restoration_kb_seed.csv        # bundled static seed data (≥205 entries, schema per §5)
    ├── restoration_sources.yaml       # curated source registry (initially minimal)
    ├── restoration_glossary.yaml      # base technical glossary
    └── restoration_pdf_template.json  # customer-facing PDF template (FR-055)

scripts/
├── seed_restoration_kb.py         # KB bootstrap (one-time, post-install; validates per-category minimums + duplicate part_id)
├── validate_kb_seed.py            # KB seed validation (entry count, OEM, prices, categories, duplicate part_id uniqueness)
├── generate_2d_diagram.py         # 2D annotated diagram generator (Pillow)
└── generate_test_cert.py          # self-signed cert generator for HTTPS testing (FR-063)

tests/
└── restoration/
    ├── conftest.py                # pytest config; registers --e2e (FR-064) and --browser flags
    ├── test_intake.py
    ├── test_manifest.py
    ├── test_sourcing.py           # includes negotiation state machine test (AC-059)
    ├── test_3d_generation.py
    ├── test_2d_diagram.py
    ├── test_mobile_guide.py       # Playwright; --browser flag
    ├── test_offline.py            # Playwright; --browser flag; requires --https or localhost
    ├── test_offline_resilience.py # Playwright; mid-session degradation + token expiry/supersession UX
    ├── test_tokens.py
    ├── test_state_machine.py      # includes in-service checklist enforcement test (AC-060)
    ├── test_concurrency.py        # includes concurrent SQLite write test (AC-041) + global sourcing concurrency (AC-055)
    ├── test_async_tasks.py        # includes resume-after-interrupt test (AC-056)
    ├── test_kb_loading.py
    ├── test_provider_actions.py   # U7 write actions: pause/resume/failover/recheck (AC-028)
    ├── test_feedback_signals.py
    ├── test_flags.py
    ├── test_insights.py
    ├── test_audio_lufs.py         # AC-039: pyloudnorm LUFS validation
    ├── test_audio_intelligibility.py  # AC-040: WER < 5% in simulated 85 dBA shop noise
    ├── test_pdf_export.py         # AC-032: A4, 300 DPI, text extraction
    ├── test_preload_time.py       # AC-042: preload-time budget
    ├── test_step_persistence.py   # AC-043: step-position persistence
    ├── test_api_cost_ceiling.py   # AC-045: API cost ceiling enforcement
    ├── test_research_primitive_interface.py  # AC-046: primitive interface contract
    ├── test_reconciliation.py     # AC-047, AC-048: crash reconciliation + divergence
    ├── test_health.py             # AC-002, AC-049: health endpoint + os_supported
    ├── test_https_sw.py           # AC-050: HTTPS dev + Service Worker registration
    └── test_end_to_end.py         # AC-053 journey smoke; --e2e for real-bridge variant
```

**Dependency and lock manifests:** Uses existing `pyproject.toml` and `uv.lock`. New dependencies:

| Dependency | Purpose | Required by |
|---|---|---|
| `pillow-heif` | HEIC decoding for photo intake thumbnails | FR-002 |
| `Pillow` | Thumbnails, 2D diagram compositing | FR-002, FR-058 |
| `trimesh` | GLB manifold/watertight QA validation, bounding-box computation, unit normalization | FR-017 |
| `qrcode` | QR generation for guide tokens | FR-020 |
| `pyloudnorm` | LUFS normalization for TTS audio (mandatory post-bridge step) | FR-019, AC-039 |
| `aiosqlite` | Async SQLite access | FR-027 |
| `draco3d` | Draco GLB compression | FR-020, FR-031 |
| `reportlab` | Customer-facing PDF generation | FR-055 |
| `playwright` (dev) | Browser automation for AC-011, AC-018, AC-035, AC-036, AC-042, AC-043, AC-050 | §9 |
| `pytest-asyncio` (dev) | Async test support | test suite |
| `soundfile` (dev) | Audio loading for LUFS verification | AC-039 |
| `openai-whisper`, `noisereduce` (dev) | STT + noise overlay for the WER intelligibility test (or equivalent STT) | AC-040 |
| `PyPDF2` (dev) | PDF dimension/content verification | AC-032 |

**Configuration files:** `defaults.yaml` extended with: the `restoration_pipeline` workflow definition, fiscal threshold defaults (`restoration_budget_affordable_pct`: 0.80, `restoration_budget_tight_pct`: 1.00), confidence thresholds (`restoration_confidence_threshold`: 0.70, `restoration_vlm_only_threshold`: 0.85), game-pipeline route bindings, `restoration_api_pricing` for API cost estimates, `restoration_api_cost_ceiling_usd` (default 100), `restoration_3d_degradation_threshold` (default 0.30), `restoration_sourcing_floor` (default 0.50), `hunt_timeout_seconds` (default 3600), `restoration_max_concurrent_sourcing` (default 3), `restoration_max_sourcing_per_project` (default 1), `restoration_in_service_checklist` (default: `["all critical sub-assemblies published", "operator has verified the vehicle is road-ready"]`), `audio_lufs_target` (default -16.0), and learning-ledger formula constants (`K=0.2`, `minimum_samples=5`, `recency_decay_base=0.95`, `max_correction_age_months=12`). Prompt packs loaded by the existing Prompt Pack Loader.

**Generated/static assets:** GLB meshes, MP3 audio, 2D diagram PNGs, still images, and export PDFs are generated per run. No static build step for HTML surfaces — native ES modules.

**Database migrations:** Not applicable. Per-run SQLite databases are created with additive schema; the shared feedback DB is created once.

**Files that constitute the runnable product:**
- `orchestrator/core/restoration_pipeline.py`
- `orchestrator/core/restoration_models.py`
- `orchestrator/core/restoration_reconcile.py`
- `orchestrator/core/research_primitives.py` `[unverified — A-010]`
- `orchestrator/ui/web/restoration_copilot.html` + `orchestrator/ui/web/restoration_copilot/*.js`
- `orchestrator/ui/web/bay_guide.html` + `orchestrator/ui/web/bay_guide/*.js`
- `orchestrator/ui/web/restoration_styles.css`
- `orchestrator/prompts/packs/restoration_pipeline.yaml`, `restoration_kb.yaml`, `restoration_kb_seed.csv`, `restoration_sources.yaml`, `restoration_glossary.yaml`, `restoration_pdf_template.json`
- `scripts/seed_restoration_kb.py`, `scripts/validate_kb_seed.py`, `scripts/generate_2d_diagram.py`, `scripts/generate_test_cert.py`
- `tests/restoration/`

**Completion integrity checks:**

```bash
# File existence + import smoke
python -c "from orchestrator.core.restoration_models import RestorationProject; print('models OK')"
python -c "from orchestrator.core.restoration_pipeline import RestorationPipeline; print('pipeline OK')"
python -c "from orchestrator.core.restoration_reconcile import reconcile_run_state; print('reconcile OK')"
python -c "import orchestrator.core.research_primitives; print('research OK')"

# KB seed validation (includes duplicate part_id check)
python scripts/validate_kb_seed.py
# Expected: "KB validation passed: N entries across M categories" (exit 0)

# Health check
curl http://localhost:8000/restoration/health
# Expected: 200 with module_loaded: true

# Full test suite (pass/fail exit code)
pytest tests/restoration/ -v
# Expected: all tests pass (exit 0)
```

## 7. Install, start, and test contract

**Clean-machine preconditions:** Linux or macOS (POSIX required for `fcntl.flock` — Windows unsupported in v1, FR-062). Python 3.10+ with `uv` installed. Provider API keys available as environment variables. No pre-existing database or external service required. HTTPS capability for Service Worker testing (self-signed cert via `launch-dev.sh --https`).

**Install commands:**
```bash
git clone <repo_url> claudopus
cd claudopus
uv sync
python scripts/seed_restoration_kb.py   # seed KB from bundled CSV (≥205 entries; validates per-category minimums + duplicate part_id)
python scripts/validate_kb_seed.py      # independent re-check: entry count, OEM numbers, prices, categories, duplicate part_id uniqueness
```

**Development start (HTTP, no Service Worker):**
```bash
./launch-dev.sh
```
Server on `http://localhost:8000` with `--reload`. Single worker. Note: Service Worker and screen wake-lock do NOT register over plain HTTP origins other than localhost; use `--https` for offline/PWA testing.

**Development start (HTTPS, for Service Worker / offline testing):**
```bash
./launch-dev.sh --https
```
Generates a self-signed certificate via `scripts/generate_test_cert.py` and starts uvicorn with SSL on `https://localhost:8443` (FR-063). Service Worker registration and screen wake-lock are functional. The browser will warn about the self-signed cert — accept to proceed.

**Production start:**
```bash
./launch.sh
```
Server on configured host/port (default `0.0.0.0:8000`). No `--reload`; clears stale locks on boot (FR-068); prints resolved default cast to the log. Single worker. **Production HTTPS checklist (required for mobile guide Service Worker):**
1. Configure a reverse proxy (Caddy with internal CA, nginx with Let's Encrypt, or a trusted self-signed CA installed on the mechanic's phone) — self-signed certs are rejected by mobile browsers for Service Worker registration.
2. Verify `GET /guide/{token}` loads over HTTPS without certificate warnings.
3. Open browser console on the mechanic's phone and verify `navigator.serviceWorker.controller` is non-null.
4. Verify screen wake-lock API is available (`navigator.wakeLock`).
5. Without HTTPS, the Service Worker does not register — offline caching is entirely absent and the guide becomes online-only (A-009).

**Automated test commands:**
```bash
# Phase 1 (skeleton, intake, state machine, reconciliation)
pytest tests/restoration/test_intake.py tests/restoration/test_state_machine.py \
  tests/restoration/test_concurrency.py tests/restoration/test_async_tasks.py \
  tests/restoration/test_health.py tests/restoration/test_reconciliation.py -v

# Phase 2 (identification, manifest, KB)
pytest tests/restoration/test_manifest.py tests/restoration/test_kb_loading.py \
  tests/restoration/test_feedback_signals.py -v

# Phase 3 (budget, sourcing, API cost ceiling — MVP gate)
pytest tests/restoration/test_sourcing.py tests/restoration/test_research_primitive_interface.py \
  tests/restoration/test_api_cost_ceiling.py -v

# Phase 4 (3D, QA, 2D diagrams, TTS, publish, export)
pytest tests/restoration/test_3d_generation.py tests/restoration/test_2d_diagram.py \
  tests/restoration/test_audio_lufs.py tests/restoration/test_audio_intelligibility.py \
  tests/restoration/test_pdf_export.py tests/restoration/test_provider_actions.py -v

# Phase 5 (mobile guide, offline, tokens, empowerment) — includes test_https_sw.py
playwright install chromium
pytest tests/restoration/test_mobile_guide.py tests/restoration/test_offline.py \
  tests/restoration/test_offline_resilience.py tests/restoration/test_tokens.py \
  tests/restoration/test_flags.py tests/restoration/test_step_persistence.py \
  tests/restoration/test_preload_time.py tests/restoration/test_https_sw.py -v --browser

# Phase 6 (analytics, lifecycle, generalization, deployment)
pytest tests/restoration/test_insights.py -v

# Full suite (mock bridges; no API keys required)
pytest tests/restoration/ -v

# End-to-end (requires API keys and real provider access — FR-064)
pytest tests/restoration/test_end_to_end.py -v --e2e

# Whole-repo regression
pytest -v
```

**`--e2e` flag definition (FR-064):** The `--e2e` flag is a pytest custom option registered in `tests/restoration/conftest.py`. When passed, it enables tests marked with `@pytest.mark.e2e` — these tests execute the full end-to-end pipeline against real provider bridges and require `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BFL_API_KEY`, and `MESHY_API_KEY` to be set; the conftest fails fast if any are missing. Without `--e2e`, marked tests are skipped. The flag also sets `RUNS_ROOT` to `tests/restoration/tmp_runs/` for isolation. Mock-based tests do NOT require `--e2e`.

**Readiness probes:**
```bash
curl http://localhost:8000/live/status
# Expected: 200 with {"status": "ok"}

curl http://localhost:8000/bridge/health
# Expected: 200 with bridge health statuses

curl http://localhost:8000/restoration/health
# Expected: 200 with {"module_loaded": true, "active_projects": N,
#   "pipeline_route": "configured", "os_supported": true, "version": "<git_sha>"}
```

**Expected ports/URLs:**
- Operator console: `http://localhost:8000/restoration-ui`
- Mobile guide: `http://localhost:8000/guide/{token}` (HTTPS required for Service Worker)
- Module health: `http://localhost:8000/restoration/health`
- Guide assets: `http://localhost:8000/restoration/projects/{id}/assemblies/{assembly_id}/assets/{filename}`
- HTTPS dev server: `https://localhost:8443/restoration-ui` and `https://localhost:8443/guide/{token}` (with `--https`)

**Required environment variables (names only):**
- `OPENAI_API_KEY` — OpenAI provider bridge (vision, TTS `tts-1`/`alloy` per FR-019, fallback)
- `ANTHROPIC_API_KEY` — Anthropic provider bridge
- `FIREWORKS_API_KEY` — Fireworks provider bridge
- `RUNS_ROOT` — root directory for run storage (defaults to `./runs/`)
- `BFL_API_KEY` — BFL provider `[unverified — needs BFL bridge registration]`
- `MESHY_API_KEY` — Meshy provider `[unverified — needs Meshy bridge registration]`

## 8. Deployment and operations contract

**Deployment shape:** Monolithic, in-process extension of the existing Sneferu orchestrator on the shop server (Linux/macOS only). No separate application tier, no reverse proxy beyond optional HTTPS termination for phone access, no staging VM. Single worker with async task queue for long-running operations.

**Build artifacts:** None. Pure Python and HTML/JS additions.

**Environment configuration:** Existing `.env` or exported environment variables for bridge API keys.

**Health checks:**
- `GET /live/status` — general Sneferu liveness.
- `GET /bridge/health` — per-bridge health.
- `GET /restoration/health` — dynamically computes `active_projects` by scanning run directories, validates `pipeline_route` via the workflow runner, checks `os_supported` via `fcntl` import (returns 200 with `os_supported: false` if unavailable, NOT 500 — FR-062), returns `version` as the current git commit SHA. Returns 500 only on module-instantiation failure.

**Logs/metrics:** SQLite `events` table is canonical (FR-028). `events.jsonl` is the orchestrator-bus output (per-run, 10 MB rotation, 5 rotated files retained). Restoration-specific events: `restoration_stage_changed`, `mesh_qa_passed`, `mesh_qa_quarantined`, `mesh_qa_unverified_dimensions`, `sourcing_candidate_found`, `sourcing_unsourceable`, `sourcing_manual_added`, `sourcing_hunt_timeout`, `guide_published`, `guide_token_revoked`, `guide_token_superseded`, `guide_token_extended`, `guide_text_only_published`, `negotiation_status_changed`, `provider_paused`, `provider_resumed`, `provider_failover`, `provider_recheck`, `project_abandoned`, `async_task_cancelled`, `async_task_interrupted`, `async_task_resumed`, `project_reopened`, `kb_load_error`, `kb_entry_added`, `kb_entry_approved`, `mechanic_flag_submitted`, `mechanic_flag_synced`, `mechanic_flag_resolved`, `api_cost_logged`, `api_cost_ceiling_warning`, `api_cost_ceiling_reached`, `api_cost_ceiling_overridden`, `event_log_divergence`, `crash_reconciliation_sync`, `reconciliation_warning`, `stale_lock_cleared`, `pdf_template_error`, `glb_decode_failure`.

**Backup/restore:** Filesystem backups of `runs/` (SQLite WAL files included), plus the shared `runs/restoration_feedback.db`. Restore: copy back `runs/` and restart. The boot-time reconciliation job (FR-067) verifies consistency after restore and corrects drift from the canonical SQLite state.

**Rollback:**
```bash
git log --oneline -1
git checkout <previous_commit>
./launch.sh
curl http://localhost:8000/restoration/health
# Verify "version" matches the checked-out commit SHA.
```

**Stale lock cleanup (FR-068):** `launch.sh` checks `runs/.restoration_index.lock` and per-file `.lock` sidecars on boot: if a lock file exists but the holding PID (recorded inside the lock file) is not alive (checked via `os.kill(pid, 0)`), the lock file is removed and a `stale_lock_cleared` event is logged. `fcntl.flock` advisory locks are auto-released on process exit — this routine handles the SIGKILL edge case.

**Provider failover UX:** U7 surfaces blocked stage, fallback in effect, and affected jobs; the decision tree is documented in §2 U7 with explicit write actions (pause/resume/failover/recheck — FR-050); every action writes an audit event.

**Degraded-mode operations:**
- 3D degraded (QA pass rate <30%): U5 warns; publish as T3 2D-diagram guide. FR-044. Tested by AC-022.
- Sourcing limited (system-discovered coverage <50%): U4 warns; manual entry + registry highlighted. FR-045. Tested by AC-008.
- API cost ceiling (80% warning, 100% block): U4/U1 show warning at 80%; new API-incurring tasks blocked at 100% with override path. FR-065. Tested by AC-045.
- TTS unavailable: text-only guides — documented default behavior. FR-019, A-007. No secondary TTS provider in v1. Tested by AC-039.
- Network drop on guide: Service Worker cache; partial cache → text + 2D diagrams; mid-session "offline" indicator. FR-031, FR-046. Tested by AC-042.
- iOS Safari eviction: auto re-preload if online; reconnect prompt + IndexedDB text fallback if offline. FR-046. Tested by AC-018.
- Hunt timeout: partial results preserved, SOURCING_INSUFFICIENT transition, resume available. FR-070. Tested by AC-057.
- Async task failure: `failed` with error detail; operator retries. Interrupted: resumable. FR-056. Tested by AC-012.
- Event-log divergence or stale JSON snapshots: boot-time reconciliation. FR-028, FR-067. Tested by AC-047, AC-048.

**Smallest deploy procedure that can be exercised by a test:**
```bash
git pull
python -c "from orchestrator.core.restoration_models import RestorationProject; print('OK')"
./launch.sh
curl http://localhost:8000/restoration/health
# Expected: {"module_loaded": true, "os_supported": true, "version": "<sha>", ...}
curl -X POST http://localhost:8000/restoration/projects \
  -H "Content-Type: application/json" \
  -d '{"vehicle_meta": {"year": "1969", "make": "Chevrolet", "model": "Camaro"}}'
# Expected: 201 with project_id and run_id
ls runs/*/restoration/project.json
ls runs/*/restoration/restoration.db
```

## 9. Mechanical acceptance matrix

| ID | Proves | Setup | Command / action | Expected observable | Evidence |
|---|---|---|---|---|---|
| AC-001 | Clean install, KB seed population with per-category + duplicate validation, and workflow registration [system] | Fresh clone on Linux/macOS with Python 3.10+ and uv | `uv sync && python scripts/seed_restoration_kb.py && python scripts/validate_kb_seed.py && ./launch.sh` then `curl http://localhost:8000/restoration/health` then `curl -X POST http://localhost:8000/restoration/projects -H "Content-Type: application/json" -d '{"vehicle_meta":{"make":"Chevrolet","model":"Camaro","year":"1969"}}'` | Server starts; seed script exits 0 after validating per-category minimums and duplicate part_id uniqueness; validator exits 0 reporting ≥205 entries across ≥5 vehicle combos; health returns 200 with `module_loaded: true`, `os_supported: true`; POST returns 201 with `project_id` and `run_id`; `project.json` and `restoration.db` exist | Console output; validator output with category counts and uniqueness check; curl outputs 200/201; `cat runs/*/restoration/project.json` |
| AC-002 | Health endpoint is functional, not static [system] | Running server from AC-001 with ≥1 project | `curl http://localhost:8000/restoration/health` then create a second project and re-curl | JSON with `module_loaded: true`, `active_projects` matching actual count (increments to 2), `pipeline_route: "configured"`, `os_supported: true`, `version` = `git rev-parse HEAD` | Response body; `git rev-parse HEAD` matches `version` |
| AC-003 | Photo intake with HEIC transcoding, exact persistence, and format policy [system] | Server running, project created | `curl -X POST .../intake -F "photos=@engine.jpg" -F "photos=@bay.heic"` | 200 with per-file receipts (content hash, thumbnail path, stored format); stored photos in `intake/photos/` byte-identical to uploads (SHA-256 match); HEIC has a transcoded JPEG thumbnail in `intake/thumbnails/`; thumbnail decodes as valid image via Pillow; `photo_refs` stores original path; guide serves JPEG thumbnails (never raw HEIC) | `sha256sum` match; `python -c "from PIL import Image; Image.open('.../engine.jpg').verify()"`; `ls .../thumbnails/bay.jpg` |
| AC-004 | Identification produces structured, content-dependent output with pinned confidence threshold [system] — NOTE: ≥80% auto-ID is outcome forecast A-003, not this AC; this AC tests the system property (content-dependent output and threshold routing), not a coverage threshold | Two projects with distinct photo sets (1969 Camaro vs. 1965 Mustang) plus an empty-engine-bay control set | `POST .../identify` for both; poll task; `GET .../manifest` for both | Both manifests have per-part confidence scores and `requires_review` flags; parts with `confidence ≥ 0.70` are auto-accepted; parts with `confidence < 0.70` route to review queue; manifests differ in ≥30% of part names (content-reactive); empty-bay control yields ≤2 parts at low confidence; when ≥5 historical corrections exist, adjusted parts carry `biasing_context` | Two `manifest.json` files compared; threshold routing verified; `biasing_context` fields inspected |
| AC-005 | Review-case resolution with audit delta and SQLite storage [system] | Manifest with part P005 `requires_review: true` | `POST .../manifest/resolve` with corrected values; attempt resolve on non-existent P999 and non-review part; `GET .../reviews` | Resolve succeeds (200) only when part exists and is in review queue; P999 → 404; non-review part → 409; `ReviewLogEntry` with before/after values; `feedback_signal` written with denormalized `category`; manifest shows updated values | SQLite `review_log` row; `feedback_signals` row with `category` field; `manifest.json` updated |
| AC-006 | Budget feasibility with pinned thresholds, null-cost handling, INSUFFICIENT_DATA [system] | Locked manifest with randomized known total; some parts null cost | `POST .../budget -d '{"budget_ceiling_usd": <test_value>}'` for values straddling the known sum; repeat with >30% null-cost manifest | Ruling matches: ≤80% ceiling → AFFORDABLE; >80% and ≤100% → TIGHT; >100% → SHORTFALL_CRITICAL; >30% null → INSUFFICIENT_DATA; null costs excluded (not zeroed); `unknown_cost_count` correct | `budget.json` rulings match harness expectation; threshold boundaries verified |
| AC-007 | Budget override with enforceable state machine [system] | Budget ruling `SHORTFALL_CRITICAL` | `POST .../budget/override -d '{"reason":"panel price increase"}'`; attempt override when ruling is `AFFORDABLE` | Override accepted (200) only from SHORTFALL_CRITICAL or INSUFFICIENT_DATA; audit entry with reason, actor, timestamp; override from AFFORDABLE → 409 | `budget.json` override record; 409 response |
| AC-008 | System-discovered sourcing coverage using mock primitive, tier order, dedup, and hunt timeout [system] — NOTE: ≥90% total coverage is outcome forecast A-004 (AC-038), not this AC; this AC tests the system property (tier ordering, coverage formula, dedup, timeout), not a coverage threshold | Budget affordable; mock research primitive returns structured candidates for 60% of parts, `unstructured_lead` for 10%, no results for 30%; configure `hunt_timeout_seconds: 5` for timeout test | `POST .../source`; poll task; `GET .../sourcing`; for timeout: configure mock to sleep >5s per query | `SourcingCandidate` records with `oem_number` field populated; `system_coverage` = 60% (excludes `unstructured_lead` and `manual_entry`); `total_coverage` = 60% (no manual entries in this test); `critical_coverage` present; registry-tier candidates appear before LLM-search candidates (provenance timestamps); dedup by `part_id + vendor + oem_number + price ±5%`; hunt timeout halts with partial results and `SOURCING_INSUFFICIENT` transition | `restoration.db` `sourcing_candidates` rows with `oem_number`; coverage values match; tier ordering verified; timeout event logged |
| AC-009 | Unsourceable flagging with outcome-derived reason codes [system] | Mock primitive configured: part A no results, part B only over-budget, part C discontinued | `GET .../sourcing` | Part A `reason_code: "no_vendor_response"`; part B `"exceeds_budget"`; part C `"discontinued"`; codes from mock outcomes, not part-name mapping; each `alternative_suggestion` non-empty | SQLite `unsourceable` records match mock outcomes |
| AC-010 | 3D mesh generation with dimensional QA, GLB unit normalization, and provider-specific quarantine [system] | Sourcing sealed; mock Meshy returns valid GLB, oversized GLB, HTTP 503 | `POST .../generate_3d`; poll task; inspect QA receipts; re-trigger 503 part | Valid GLB: unit-normalized via `trimesh` bounding-box scaling, then per-axis AABB deviation within per-category tolerance vs. KB dimensions; `dimension_source: "kb"`, per-axis deviations, and `scale_factor_applied` recorded; oversized GLB quarantined; 503 part quarantined with "Meshy"/"503"; re-trigger clears quarantine (`qa_status: "passed"`) | `qa_receipts/*.json` with provider, status, per-axis deviations, `dimension_source`, `scale_factor_applied`; `trimesh.load()` succeeds; receipt shows quarantine cleared |
| AC-011 | Mobile guide playback is assembly-specific, with TTS available and unavailable branches [system] — Playwright-automated | Two published guides (brake_system with mock TTS available; suspension with mock TTS unavailable) | Playwright (`--browser`): load `GET /guide/{token_A}` and `GET /guide/{token_B}`; on A check WebGL context, audio `readyState > 0`, transcript has ≥3 assembly-specific terms; on B verify text-only renders, no audio element, on-screen text has ≥3 graph-derived terms; tap through 3 steps on both | Token A: WebGL context non-null, audio functional and assembly-specific; step counter increments. Token B: text-only fallback; step counter increments; no dead-end error | Playwright output: WebGL context, readyState, transcript/term matches, step counter, URL paths; `bundle_meta.json` `audio_available` flags |
| AC-012 | Persistence across restart with interrupted-task resume [system] | Job in `MESHING` with partial artifacts and a running task | Modify `project.json` to `status: "PARKED_CUSTOM_TEST_123"`, `parked: true`; restart server; `GET /restoration-ui`; `GET .../tasks/{task_id}`; `POST .../tasks/{task_id}/resume` | U1 shows the exact injected status; JSON artifacts and SQLite intact; previously running task shows `status: "interrupted"`; resume returns 202, preserves original `task_id`, records `resumed_from`, transitions to `running`; reconciliation logged | `project.json` with injected status; U1 render; `SELECT status FROM tasks` returns `interrupted`; resume returns 202; log shows `reconcile_run_state` |
| AC-013 | Authorization — unauthenticated access blocked [system] | No operator session | `curl .../restoration-ui`; `curl -X POST .../projects -d '{}'`; `curl .../guide/{valid_token}` — all without session | 401 or login redirect for operator endpoints; 200 for valid token guide (token-only access) | HTTP status codes: 401/redirect ×2, 200 ×1 |
| AC-014 | Invalid input rejection with content-based validation [system] | Server running, project created | `curl -X POST .../intake -F "photos=@fake.jpg"` where `fake.jpg` has `.jpg` extension but `GIF89a` header bytes, alongside one valid JPEG | 400/422 with per-file rejection naming the file and reason ("format mismatch: expected JPEG header, got GIF89a"); valid file accepted and stored; fake file not stored | Error response text; intake receipts contain only valid file; `ls intake/photos/` lacks fake.jpg |
| AC-015 | Failure recovery — distinct provider errors and quarantine clearing [system] | Sub-assembly selected; mock returns BFL 400 for part one, Meshy 503 for part two, then success | `POST .../generate_3d`; inspect quarantines; re-trigger with mock success | First run: quarantines name actual provider and status ("BFL"/"400", "Meshy"/"503"); server stays healthy; second run: quarantines cleared, meshes pass QA | `events` table shows `mesh_qa_quarantined` with provider+status; `qa_receipts` error detail; `/live/status` 200 throughout; post-rerun receipts `passed` |
| AC-016 | Second-vehicle generalization against ground truth [outcome forecast] | First vehicle job complete; operator-curated ground-truth manifest for a 1965 Mustang | Create Mustang project; run full pipeline (intake → identify → manifest); compare manifest to ground truth | Manifest recall ≥70% on part names/categories vs. ground truth; Mustang-specific parts present absent from Camaro manifest; pipeline completes end-to-end without schema changes | Manifest vs. ground-truth diff with recall computation; pipeline reaches `MANIFEST_LOCKED` |
| AC-017 | Deployment smoke with version verification and rollback readiness [system] | Server running at a recorded SHA | `git rev-parse HEAD` → record; `curl /restoration/health` → verify `version` matches; `git checkout <earlier_commit_with_module>`; `./launch.sh`; re-curl; `git checkout -` | Health `version` equals `git rev-parse HEAD` at each checkout; after rollback reflects earlier SHA (or 404 if that commit lacks the module — correct); returning restores original SHA | Captured `git rev-parse HEAD` outputs matching health `version` |
| AC-018 | Offline guide playback via Service Worker with assembly-specific, byte-identical assets [system] — Playwright-automated | Published guide with valid token; preload completed to "ready for offline"; HTTPS dev server | Playwright (`--browser`): load `GET /guide/{token}` over HTTPS, wait for SW + cache completion, `context.setOffline(true)`, reload, tap through 3 steps | Guide renders from cache; visual (GLB or 2D diagram) displays; audio plays from cached MP3 where available; step counter increments; asset URLs contain assembly_id; step text matches `bundle_meta.json`; zero network requests; offline step text is byte-identical to online (content-hash match); step position restored from IndexedDB on reload | Playwright offline run: page loads, WebGL/canvas renders, audio plays, counter increments, zero network requests; URLs and text matched; asset hash matches; IndexedDB step index verified |
| AC-019 | Token revocation, supersession, bulk revoke, expiry extension, and superseded/expired token UX [system] | Published guide with multiple valid tokens; re-published v2 bundle | `GET /guide/{token}` → 200; `DELETE .../tokens/{token_id}` → `GET /guide/{token}` → 404; `POST .../tokens/{old_token}/supersede` → old token shows 200 with `X-Guide-Superseded: true` header and "newer version available" banner (not 404); `DELETE .../tokens` bulk → all 404; `POST .../tokens/{token_id}/extend -d '{"extends_days":30}'` → new `expires_at` 30 days later; simulate expiry → `GET /guide/{expired_token}` returns 410 with `{"error": "token_expired", ...}`; if cached, guide remains usable with non-dismissible expiry banner and flag-sync POSTs receive 410 | 200 before; 404 after revoke; superseded token serves old bundle with header + dismissible banner; bulk revoke sets `revoked_at` on all rows; extended token has new `expires_at` and same token string; expired token returns 410; cached expired guide shows non-dismissible banner; flag-sync POST with expired token → 410, flags remain queued | HTTP codes and headers; SQLite `guide_tokens` shows `revoked_at`/`superseded_at`/`expires_at`; audit events; Playwright render of banner states; IndexedDB `flag_queue` retains unsynced flags |
| AC-020 | ABANDONED state with required reason, read-only enforcement, no re-open, and automatic AsyncTask cancellation [system] | Project in `HUNTING` with 2 running async tasks | `POST .../abandon -d '{"reason":"customer cancelled"}'`; attempt `POST .../source`; attempt abandon without reason; attempt `POST .../reopen`; inspect task statuses | Status becomes `abandoned`; `abandoned_reason` stored; subsequent state-changing calls return 409; abandon without reason → 400; reopen on abandoned → 409; both running tasks show `status: "cancelled"` with `async_task_cancelled` events written; U1 shows "Abandoned" badge with reason | `project.json` status and `abandoned_reason`; 409/400 responses; `SELECT status FROM tasks WHERE project_id=...` returns `cancelled`; `events` table has `async_task_cancelled` rows; U1 badge |
| AC-021 | Multi-sub-assembly workflow with distinct, graph-derived content and `step_position_label` [system] | First sub-assembly guide published | `POST .../generate_3d -d '{"assembly_id":"suspension"}'`; complete meshing, graph review, publish | Second bundle exists; `GET .../assemblies` lists both with distinct `assembly_id` and `bundle_version`; GLB hashes differ; second guide's narration contains ≥2 assembly-specific terms matching the suspension `AssemblyGraph`'s `WalkthroughStep.part_callout` values; `step_position_label` values populated per step ("exploded", "positioning", "install", "torque") | Two `WalkthroughAssembly` entries; two `guides/{id}/v1/` directories; hash comparison; narration terms matched against assembly graph step definitions; `step_position_label` verified |
| AC-022 | Degraded mode — high QA pass and low QA pass branches with qa_status consistency and `len(glb_paths)` edge case [system] | Mock producing >80% QA pass for run A; <30% pass for run B | Run A: generate + publish; Run B: generate, observe U5 warning, publish as T3; also test a T2 assembly with `len(glb_paths) == 1` | Run A: `qa_status: "passed"`, `text_only: false`, `has_2d_diagrams: false`, WebGL canvas present. Run B: `qa_status: "has_2d_diagrams"`, derived booleans consistent, 2D diagrams + audio render, no WebGL canvas. T2: `glb_paths` has exactly 1 entry (exploded view), advance interaction is hotspot-to-hotspot; both guides have visual content (never bare text) | `WalkthroughAssembly` fields; `bundle_meta.json` flags; Playwright renders confirm canvas vs. diagram vs. hotspot; boolean/qa_status consistency verified; `len(glb_paths)` verified |
| AC-023 | Coverage metrics (system-discovered, total, critical-path) with explicit formulas [system] | Sourcing complete on a manifest with known critical and standard parts incl. one `unstructured_lead` and one `manual_entry` candidate | `GET .../sourcing` | Response includes `system_coverage` (excludes `unstructured_lead` and `manual_entry`), `total_coverage` (includes `manual_entry`), and `critical_coverage` (critical parts only) per FR-013 formulas; fabrication-ref parts count as covered; values match hand computation | Response body values equal manual computation from manifest `criticality` and candidate `provenance` |
| AC-024 | Concurrent project creation does not corrupt state or index [system] | Running server | 3 simultaneous `POST .../projects` with distinct metadata | 3 distinct `project_id`s; 3 correct `project.json` files; `restoration_index.json` contains all 3 entries and remains valid JSON; no lock errors logged; index update followed single-writer lock discipline | 3 IDs; 3 files; index parses and matches; server log free of flock errors |
| AC-025 | SQLite transaction integrity on mid-write crash [system] | Project in `HUNTING` with partial sourcing results | SIGKILL the server during an `INSERT` into `sourcing_candidates`; restart; query sourcing and task state | Database opens without error; partial transaction rolled back (WAL); committed candidates intact; job resumes at `hunting`; in-flight task marked `interrupted`; reconciliation runs | `SELECT count(*) FROM sourcing_candidates` = pre-crash committed count; `project.json` status `hunting`; task row `interrupted`; `reconcile_run_state` logged |
| AC-026 | Post-sourcing cost gate blocks overspend sealing [system] | Sourcing complete; operator-selected candidates total exceeds ceiling | `POST .../sourcing/seal` | Seal blocked with 409; response shows `total_selected_cost > budget_ceiling` and `cost_gate_passed: false`; override path offered; after override, seal succeeds with audit event | 409 response body with cost comparison; `budget.json` override audit; subsequent seal 200 |
| AC-027 | KB loading and fallback (valid / malformed / missing) [system] | Three server starts: (a) valid KB, (b) malformed YAML, (c) missing file | (a) Start and run identification; (b) corrupt YAML, restart, run identification; (c) delete file, restart, run identification | (a) KB matches used in manifest; (b) `kb_load_error` event with parse detail, U3 warning, VLM-only mode, workflow completes; (c) silent empty-KB default, VLM-only banner, workflow completes | `events` table `kb_load_error`; U3 banner in (b) and (c); manifests produced in all three runs |
| AC-028 | Provider write actions (U7) with audit events and dispatch blocking [system] | Running server with mock providers | `POST .../provider/pause -d '{"provider":"mesh_3d"}'`; attempt `POST .../generate_3d`; let in-flight mock dispatch complete; `POST .../provider/resume`; `POST .../provider/failover -d '{"provider":"bfl","fallback":"fireworks"}'`; `POST .../provider/recheck` | Each action returns 200 and writes an audit event (actor, timestamp, action, provider, affected jobs) to SQLite `events`; after pause, new generate_3d blocked with "provider paused" error while in-flight completes; after resume, generate_3d returns 202; failover routes new dispatches to backup | `events` table rows for all four actions; blocked-call error message; in-flight task `completed`; post-resume 202 |
| AC-029 | Learning loop — corrections and purchases produce signals with denormalized `category` and KB proposals [system] | Project with review cases and a recorded purchase | Resolve a review case with corrected name "Front Brake Caliper"; `POST .../purchase` with vendor "NAPA", price 89.99; inspect `feedback_signals` and U3 KB proposals; approve via `POST .../kb/approve` | `feedback_signals` rows exist for `identification_correction` (before/after values match, `category` field populated from manifest) and `purchase_outcome` (vendor="NAPA", final_price=89.99, `category` populated); KB proposal in U3 with purchased part's vendor, price, candidate part name — no placeholders; approval appends to `restoration_kb.yaml` and `GET .../kb/entries` returns it | SQLite rows with exact field correspondence including `category`; U3 proposal list; updated KB YAML |
| AC-030 | 2D diagram fallback generation from intake photos with assembly-graph-matched labels [system] | Sub-assembly whose meshes all fail QA (mock) | Trigger generate_3d with failing mock; publish as T3; load the guide | `step_{N}_diagram.png` files exist in the bundle and are derived from the job's intake photos; callout labels correspond to the step's `part_callout` and `tool_callout` from the assembly graph (verified via OCR on the rendered PNG); `bundle_meta.json` has `has_2d_diagrams: true`; guide renders diagrams — mechanic never sees bare text | PNG files under `guides/{assembly_id}/v1/`; `bundle_meta.json`; Playwright render of a diagram step; OCR-extracted labels match assembly graph values |
| AC-031 | Async tasks do not block the request-serving worker [system] | Project with a long-running (mock-delayed) 3D task | Start generate_3d; while `running`, time `GET .../projects` and `GET .../health`; poll `GET .../tasks/{task_id}` | U1 and health respond in <1 s during the 3D task; task status is pollable and transitions `running → completed` | Response-time measurements; task record transitions |
| AC-032 | Customer-facing artifact export (A4, 300 DPI, template-defined, validated) [system] | Completed job with photos and a published guide | `POST .../export-artifact` | PDF exists in `artifacts/`; page size is A4 (210×297 mm); 300 DPI images; text extraction shows vehicle metadata, assembly name, parts count, system and total sourcing coverage, estimated vs. actual cost, and step list with tool/part callouts; before/after photos and 4-angle assembly screenshots present; template file `restoration_pdf_template.json` exists and was used; downloadable from U1/U5 | PDF file present; `python -c "from PyPDF2 import PdfReader; r=PdfReader('...'); p=r.pages[0]; assert abs(float(p.mediabox.width)/72*25.4 - 210) < 1"`; text extraction shows required content; U1/U5 download links work |
| AC-033 | Re-open from CLOSED preserves artifacts [system] | Closed job with sourcing results, purchases, and published guides | `POST .../reopen -d '{"reason":"customer added scope"}'`; inspect state, sourcing, tokens | Status → `manifest_locked`; `reopened_from` set; prior candidates/purchases intact with parts marked `previously_sourced`; prior guide bundles on disk; prior tokens still validate (200) until revoked | `project.json` fields; SQLite row counts unchanged; `GET .../assemblies` lists prior bundles; `GET /guide/{old_token}` → 200 |
| AC-034 | API cost tracking visibility [system] | Project that ran identification, sourcing, 3D, and TTS (mock bridges) | `GET .../projects/{id}`; `GET .../api-costs`; inspect U4 and U8 | `api_cost_to_date_usd` > 0 and equals sum of `api_costs` rows; endpoint returns `{total, per_provider, ceiling, pct_of_ceiling}`; U4 shows "API costs: $X.XX / $Y.YY ceiling" with per-provider breakdown; U8 shows aggregate trend data | `api_costs` table rows; project field equals sum; endpoint response; U4/U8 renders |
| AC-035 | Free-explore mode, glossary, and skip-ahead in U6 [system] — Playwright-automated | Published guide with valid token | Playwright (`--browser`): load guide; toggle explore; orbit/zoom via gestures; tap a callout; open glossary and search "master cylinder"; swipe left on the step title and jump two steps ahead; dismiss explore | Explore shows full assembly; gestures move camera; callout tap shows part name/tool/description/step number; glossary returns definition; step jump updates counter; dismissing explore returns to the jumped-to step | Playwright event log: camera matrix changes, callout info panel content, glossary definition text, step counter values |
| AC-036 | Mechanic flag submission, offline queueing, sync-on-reconnect, operator resolution, and feedback-signal routing [system] — Playwright-automated | Published guide with valid token; HTTPS dev server | Playwright (`--browser`): load guide offline; submit a flag (type "wrong_part", notes, screenshot); verify IndexedDB `flag_queue` entry with `sync_status: "pending"`; go online; verify sync; operator resolves via `POST .../flags/{flag_id}/resolve`; check U1, U5, and `feedback_signals` | Flag queued in IndexedDB while offline with screenshot data URL and `sync_status: "pending"`; on reconnect it POSTs (removed from queue only on 201) and appears in `mechanic_flags` with screenshot stored under `flags/`; `sync_status` becomes `"synced"`; U1 shows "needs attention"; U5 lists the flag; after resolve, `status: "resolved"` with notes; a `FeedbackSignal` (type `identification_correction`) is written because `problem_type = "wrong_part"` | IndexedDB queue entry (pre-sync); SQLite `mechanic_flags` row; `feedback_signals` row with `identification_correction`; `ls runs/*/restoration/flags/`; U1/U5 renders; resolve response 200 |
| AC-037 | Operator-supplied reference dimensions drive QA with fallback [system] | Part with no KB entry; operator enters dimensions; second part with no KB entry and no operator dimensions | `POST .../parts/{part_id}/dimensions -d '{"length_mm":180,"width_mm":95,"height_mm":120}'`; trigger generate_3d for both parts | QA rung uses operator dimensions for first part (precedence: KB → operator → unverified); `qa_receipts` show `dimension_source: "operator_supplied"` and per-axis deviation values; pass/fail computed against supplied bounding box. Second part publishes with `qa_status: "unverified_dimensions"` (deviation check skipped, gap logged, not blocked) | `reference_dimensions_override.json` content; `qa_receipts/{assembly}.json` fields; both branches observed |
| AC-038 | Total sourcing viability including manual entries [outcome forecast — A-004] — NOTE: ≥90% total coverage is a viability forecast routed to A-004 validation, not a build-correctness gate | Budget affordable; mock primitive returns 50% system coverage; operator manually enters candidates for the remaining 40% | `POST .../source`; add manual candidates via `POST .../sourcing/manual`; `GET .../sourcing` | `system_coverage` = 50% (system-discovered only); `total_coverage` = 90% (includes manual entries); metrics reported separately; seal allowed at threshold or via explicit partial acceptance | Response body with both coverage values; `sourcing_candidates` rows with mixed provenance |
| AC-039 | TTS audio normalization to -16 LUFS (pyloudnorm post-bridge enforcement) [system] | Published guide with mock TTS audio after background normalization completes | `pytest tests/restoration/test_audio_lufs.py -v` | Each sampled `step_{N}.mp3` measures integrated loudness within ±1 LUFS of -16.0 (via `pyloudnorm`); `WalkthroughAssembly.audio_lufs_target` = -16.0 and `bundle_meta.json` `audio_lufs_target` = -16; before background task completes, un-normalized audio is served and then replaced (file modification time advances) | `python -c "import pyloudnorm, soundfile; a,sr=soundfile.read('step_0.mp3'); m=pyloudnorm.Meter(sr); l=m.integrated_loudness(a); assert abs(l - (-16.0)) < 1.0"`; test output shows pass |
| AC-040 | Audio narration intelligibility in simulated shop noise (WER < 5%) [outcome forecast] — NOTE: WER < 5% is a viability forecast routed to A-005; the build is correct if the *mechanism* (normalization + noise simulation + WER computation) is implemented | Published guide with mock TTS; sample narration audio | `pytest tests/restoration/test_audio_intelligibility.py -v` | Test generates narration from `WalkthroughStep` description, overlays 85 dBA white noise (simulated shop environment), runs speech-to-text (whisper-tiny or equivalent), and computes word error rate against the original description; WER < 5% required for pass. **Metric:** WER computed as `(substitutions + deletions + insertions) / reference_word_count × 100`. **Fixture:** fixed transcript from `WalkthroughStep.description` fields. **Acceptance threshold:** WER < 5% in simulated 85 dBA noise | Test output: WER value per step, all < 5%; STT transcript vs. original description comparison |
| AC-041 | Concurrent SQLite writes to the same restoration.db do not corrupt [system] | Running server; project in `HUNTING` | `pytest tests/restoration/test_concurrency.py -v -k concurrent_sqlite` — two simultaneous `POST .../sourcing/manual` calls to the same project | Both writes succeed; no `database is locked` errors; SQLite WAL handles concurrent access; `PRAGMA integrity_check` passes; both candidates present in `sourcing_candidates` | Two 200 responses; integrity check output; `SELECT count(*) FROM sourcing_candidates` = 2; server log free of lock errors |
| AC-042 | Guide preload-time budget (≤30 s at 5 Mbps for a 20-step assembly) [system] — Playwright-automated | Published guide with 20 steps and 3D assets (≤40 MB bundle); HTTPS dev server | `pytest tests/restoration/test_preload_time.py -v` — Playwright with network throttled to 5 Mbps download; measure time from first request to "ready for offline" indicator | Preload completes within 30 seconds; "ready for offline" indicator appears; all text scripts and still images/2D diagrams cached; GLB and audio best-effort; if exceeded, guide serves text + 2D diagrams first (partial preload) and continues loading | Playwright network timing; Service Worker cache contents via `page.evaluate('caches.keys()')`; elapsed time measurement |
| AC-043 | Mechanic step-position persistence across tab sessions [system] — Playwright-automated | Published guide with valid token; mechanic at step 5 of 10 | Playwright (`--browser`): load `GET /guide/{token}`, navigate to step 5, close tab, reopen `GET /guide/{token}`; then simulate a re-publish with fewer steps and reopen | Guide resumes at step 5 (reads `guide_progress` from IndexedDB); step counter shows 5/10; no network request needed for position restore; when stored index exceeds bundle's total steps, the guide starts at step 0 and clears the stale entry | Playwright: step counter on reopen = 5; IndexedDB `guide_progress` store has `{token_id, step_index: 5}`; stale-entry branch observed |
| AC-044 | Learning-ledger biasing formula correctness with zero-sample guard [system] | 10 historical corrections for a part category (7 matching, 2 partial, 1 miss) on the same vehicle; plus a second part with 0 corrections | Create a project for the same vehicle; run identification; inspect `biasing_context` on the relevant part; inspect the second part | `agreement_rate = (7 + 0.5×2) / 10 = 0.8`; `adjusted_confidence = base + 0.2 × (0.8 − 0.5) = base + 0.06`; `biasing_context` present with `sample_count: 10, agreement_rate: 0.8, K: 0.2`; recency decay applied; second part with 0 corrections: `adjusted_confidence = base_confidence` (guard fires, no division by zero, no `biasing_context`); parts with <5 corrections show no adjustment | `ComponentRecord.biasing_context` fields; manual computation matches; zero-sample part has no `biasing_context` |
| AC-045 | API cost ceiling enforcement (80% warning, 100% block, override) [system] | Project with mock pricing accumulating to 80% and then 100% of the $100 ceiling | Configure mock pricing to accumulate to $80; trigger identification; observe warning. Configure to $100; attempt `POST .../generate_3d`; then `POST .../api-cost/override -d '{"reason":"client approved"}'` and retry | At 80%: U4/U1 show warning badge, tasks proceed, `api_cost_ceiling_warning` event. At 100%: generate_3d returns 409 "API cost ceiling reached" (`api_cost_ceiling_reached` event). After override: tasks proceed; `api_cost_ceiling_overridden` event in SQLite `events` table with reason, actor, timestamp; `api_cost_override_reason` set on project | `api_costs` table sum; 409 response; override audit event in `events` table; post-override 202 |
| AC-046 | Research primitive interface contract (schema, interpolation, rate limit, retries, URL encoding, null oem_number, null-template skip) [system] | Mock research primitive returning the §5 JSON schema; mock `PartSourcingQuery` and `SourceRegistryEntry` list including one entry with `search_template: null` | `pytest tests/restoration/test_research_primitive_interface.py -v` | Output validates against the §5 JSON schema (candidates array with required fields incl. `oem_number`, `unsourceable` object, `errors` array with `retryable` flags); `{part_name}` etc. interpolation maps to `query.*` fields per FR-012 with RFC 3986 percent-encoding verified; null `oem_number` behavior: token removed from template, sole-param dropped, compound-param collapsed; **registry entries with `search_template: null` are skipped (no query issued) and surfaced as manual-contact sources**; per-source rate-limit sleep observed; timeout produces `no_vendor_response` after exactly 3 retries with 2/4/8 s backoff; invalid provenance values rejected; `manual_entry` absent from primitive output (separate REST path) | Test assertions on schema fields, interpolation mapping, encoding, null behavior, skip behavior, timing, retry count; schema validation output |
| AC-047 | Boot-time crash reconciliation corrects stale JSON from canonical SQLite [system] | Project with `sourcing.json` showing 3 candidates while SQLite has 5 (injected divergence); `project.json` status conflicting with SQLite events; a running task | SIGKILL server; restart; inspect `sourcing.json`, `project.json`, SQLite, task status, U1 | Reconciliation runs: `sourcing.json` rebuilt from SQLite (5 candidates — SQLite canonical); `project.json` status corrected to match SQLite event; running task marked `interrupted`; corrections logged as `crash_reconciliation_sync`; U1 shows "needs attention" where applicable | `sourcing.json` matches SQLite count; `project.json` status matches SQLite events; `SELECT status FROM tasks` returns `interrupted`; server log shows reconciliation events |
| AC-048 | Event-log divergence detection and bidirectional reconciliation with rotation [system] | Running server; inject divergence by deleting a row from SQLite `events` that exists in `events.jsonl`; also generate >10 MB of events to trigger rotation | Restart server; check `events` table, U7, and rotated files; then `POST .../reconcile/{run_id}` | Boot reconciliation detects missing SQLite entry, imports it from `events.jsonl`, writes `event_log_divergence` event with count and direction; U7 shows "Event log divergence detected" alert with "Reconcile now" action; manual reconcile also works; SQLite and JSONL consistent afterward; rotated files `events.{N}.jsonl` exist and oldest is deleted beyond 5 | `events` table has `event_log_divergence` row; U7 alert render; post-reconcile row counts match; `ls runs/*/restoration/events.*.jsonl` shows rotated files with max 5 retained |
| AC-049 | Health endpoint returns 200 with os_supported: false and project creation blocked [system] | Server running; `fcntl` import monkeypatched to fail (simulating Windows) | `curl http://localhost:8000/restoration/health`; `curl -X POST .../projects -d '{"vehicle_meta":{...}}'` | Health returns HTTP 200 (not 500) with `{"os_supported": false, "module_loaded": true, ...}`; project creation returns 409 with `{"error": "os_not_supported", "message": "..."}`; existing projects remain visible in U1 (read-only) | HTTP status codes: 200 for health, 409 for project creation; response bodies contain expected fields |
| AC-050 | HTTPS dev server and Service Worker registration [system] | `./launch-dev.sh --https` running (cert auto-generated) | `curl -k https://localhost:8443/guide/{token}`; Playwright (`--browser`): load guide over HTTPS, check `navigator.serviceWorker.controller` and wake-lock API availability | Service Worker registered over HTTPS; `navigator.serviceWorker.controller` non-null; screen wake-lock API available; offline test (AC-018) passes against this origin | Playwright output: SW controller, wake-lock API; `curl -k` 200 |
| AC-051 | Dimensional QA deviation algorithm repeatability with GLB unit normalization [system] | Two QA runs of the same mock GLB against the same KB reference dimensions; plus a unitless GLB test | Run the QA rung twice on the same GLB and dimensions; also run on a GLB with non-unit bounding box to verify normalization | Per-axis deviation values identical across both runs; `scale_factor_applied` identical across both runs; pass/fail determination identical; the FR-017 AABB algorithm is deterministic; unitless GLB is normalized via `trimesh` bounding-box scaling before deviation check | Two `qa_receipts/*.json` with identical deviation values and `scale_factor_applied`; normalization step verified via `trimesh.load()` bounding-box inspection before and after |
| AC-052 | WalkthroughAssembly invariant: glb_paths[0] is exploded-view when non-empty; booleans derived from qa_status; len(glb_paths)==1 valid T2 [system] | Two assemblies: T1 (full 3D) and T3 (2D diagrams only) and T2 (single exploded view) | `GET .../assemblies`; inspect `glb_paths`, `qa_status`, and derived booleans for each | T1: `glb_paths` non-empty, `glb_paths[0]` is the exploded-view GLB; T3: `glb_paths` empty; T2: `glb_paths` has exactly 1 entry (exploded view), advance interaction is hotspot-to-hotspot; `text_only`/`has_2d_diagrams` match `qa_status` exactly and cannot be set inconsistently | `WalkthroughAssembly` JSON; file existence check; derived-boolean verification; `len(glb_paths)` verified |
| AC-053 | End-to-end journey smoke across the state spine [system] | Fresh server with mock bridges for all providers | `pytest tests/restoration/test_end_to_end.py -v` (mock variant; `--e2e` variant uses real bridges per FR-064) | A project traverses INTAKE_OPEN → INTAKE_SEALED → IDENTIFYING → REVIEW_OPEN → MANIFEST_LOCKED → BUDGET_RULED → HUNTING → HUNT_SEALED with no 500 errors; artifacts exist at each persistence boundary; invalid transitions rejected with 409 | Test output showing state progression; artifact files present at each boundary; 409 responses for injected invalid transitions |
| AC-054 | Mid-session offline degradation, superseded/expired token UX, and stale-lock cleanup [system] — Playwright-automated | Published guide with valid token; HTTPS dev server; a stale lock file with a dead PID | Playwright (`--browser`): load guide, go offline mid-session, verify "offline" indicator and per-step fallback ladder (GLB → 2D → still → text); access a superseded token (verify header + banner); access an expired token (verify 410 or cached-with-banner); restart server with stale lock file | Mid-session offline: "offline" indicator appears, guide continues from cache, missing GLB falls back to 2D/still/text; superseded token: `X-Guide-Superseded: true` header + dismissible "newer version available" banner, guide functional; expired token: 410 response or cached read-only with non-dismissible banner; stale lock: `stale_lock_cleared` event logged, lock file removed, server starts cleanly | Playwright event log: offline indicator, fallback chain, banner states; response headers; `events` table `stale_lock_cleared` row; `ls runs/.restoration_index.lock` absent after cleanup |
| AC-055 | Global sourcing concurrency limit prevents overload [system] | Running server; 4 projects in `BUDGET_RULED` state | Simultaneously `POST .../source` on all 4 projects | Only 3 sourcing tasks start (`status: "running"`); the 4th is queued (`status: "pending"`); when one completes, the 4th starts; no `database is locked` errors; per-project limit (max 1) prevents two concurrent hunts on the same project | `SELECT status, project_id FROM tasks WHERE task_type='source'` shows 3 running + 1 pending; after one completes, 4th transitions to running |
| AC-056 | Async task resume after interrupt with original task_id preserved [system] | Project with an interrupted 3D generation task | `POST .../tasks/{task_id}/resume`; poll `GET .../tasks/{task_id}` | Resume returns 202 with the same `task_id`; task transitions to `running`; `resumed_from` timestamp recorded; prior SQLite state (previously recorded candidates, costs) retained; task completes and transitions to `completed` | `SELECT task_id, status, resumed_from FROM tasks` shows original `task_id`, `running`/`completed`, `resumed_from` populated |
| AC-057 | Hunt timeout halts with partial results and SOURCING_INSUFFICIENT transition [system] | Project in `HUNTING`; `hunt_timeout_seconds` configured to 5; mock primitive sleeps 3s per query | `POST .../source`; wait for timeout; `GET .../sourcing` | After ~5s, hunt halts; `sourcing_hunt_timeout` event written; partial candidates preserved in SQLite; project transitions to `SOURCING_INSUFFICIENT`; operator can resume via `POST .../sourcing/resume` | `events` table has `sourcing_hunt_timeout`; `SELECT count(*) FROM sourcing_candidates` > 0 (partial results); `project.json` status = `sourcing_insufficient`; resume returns 200 |
| AC-058 | `total_duration_s` bound and warning [system] | Published guide with 5 steps totaling >600s narration | Inspect `WalkthroughAssembly.total_duration_s` and U5 | `total_duration_s` recorded in assembly; U5 shows warning "audio narration exceeds 10 minutes — consider splitting the sub-assembly" when >600s | `WalkthroughAssembly` JSON; U5 warning render |
| AC-059 | Negotiation state machine enforces valid transitions with required fields [system] | Project with sourcing candidates in `HUNTING` | `POST .../negotiation` through the valid chain (`pending→negotiating→ordered→received`); attempt `ordered` without `final_price_usd`; attempt invalid transitions (`pending→received`, `received→negotiating`); then `negotiating→passed` with notes on a second candidate | Valid transitions return 200 and update `NegotiationRecord` (`ordered_at`, `received_at` set); `ordered` without `final_price_usd` → 400; invalid transitions → 409 naming current status and valid next statuses; `negotiating→passed` terminal with notes recorded; `received` transition triggers `purchase_outcome` feedback signal and KB pricing proposal | SQLite `negotiation_records` rows; 400/409 response bodies naming valid next statuses; `feedback_signals` row; `kb_proposals` row |
| AC-060 | In-service checklist enforcement sourced from defaults.yaml [system] | Project in `PUBLISHED` state; default checklist in `defaults.yaml::restoration_in_service_checklist` | `POST .../in-service -d '{"checklist": ["all critical sub-assemblies published"]}'` (missing the road-ready item); then resubmit with the complete default checklist plus one custom item | First attempt → 400 naming the missing item ("operator has verified the vehicle is road-ready"); second attempt → 200, status transitions to `in_service`, full checklist (default + custom) stored in `project.json` as `in_service_checklist`; `restoration_stage_changed` event written | 400 response body with missing item names; 200 response; `project.json` `in_service_checklist` field; `events` table row |

**Property type classification:** Each AC is classified as `system` (mechanically testable with mocks/stubs, no external dependencies) or `outcome` (depends on real-world behavior of unverified components). Outcome ACs carry falsification clauses routed to §10.

| AC | Property type | Falsification clause (if outcome) |
|---|---|---|
| AC-001 … AC-015 | system | — |
| AC-016 | outcome | If second-vehicle recall <70% after 3 tuning iterations, escalate to A-006 falsification: the generalization claim is falsified and per-vehicle KB entries are required |
| AC-017 … AC-037 | system | — |
| AC-038 | outcome | If total coverage (including manual entries) falls below the 50% system floor on 5 test manifests, escalate to A-004 falsification: the tiered-sourcing approach is not viable and structured supplier feeds are required |
| AC-039 | system | — |
| AC-040 | outcome | If WER ≥5% in simulated 85 dBA noise after 3 normalization iterations, escalate to A-005 falsification: TTS quality is insufficient for hands-free use and text co-primary mode is activated |
| AC-041 … AC-060 | system | — |

**Per-FR dedicated AC coverage:** The traceability matrix in §11 confirms that every FR is linked to at least one dedicated AC with explicit assertions verifying that exact requirement's behavior. No FR is solely covered by AC-053 (end-to-end smoke); each has its own dedicated test.

## 10. Assumptions and nonblocking validation backlog

| ID | Assumption | Bounded default | Reversibility | Observable that would change it | Validation task |
|---|---|---|---|---|---|
| A-001 | [ASSUMPTION] The game pipeline (BFL `flux-2-max` → Meshy `meshy-6`) can produce dimensionally sufficient static meshes matching real vehicle geometry within per-category tolerances (structural ±2%, mechanical ±5%, cosmetic ±10%). NOT VERIFIED per Current Runtime Truth. | Frozen game-pipeline route with GLB unit normalization (FR-017), per-axis AABB QA rung; tiered fallback T2→T3→T4; publish as T3 when QA pass rate <30%. | Reversible by upgrading to photogrammetry, switching mesh provider, or disabling 3D while retaining T3/T4 fallbacks. | QA quarantines >50% of meshes across multiple sub-assemblies; technicians report parts do not fit; T3 becomes the default for all assemblies. | Compare mesh bounding-box proportions to photo-derived proportions for 3 diverse sub-assemblies. Owner: operator. Result: deviation ≤10% for ≥50% of parts, or documented tolerance waiver. |
| A-002 | [ASSUMPTION] Sneferu exposes stable, callable services for asset storage, model orchestration, and session management. The 5 endpoints enumerated in FR-026 are the complete Sneferu dependency surface. | Assume the Sneferu v1 API surface (5 endpoints) is sufficient. | Reversible by adding restoration-specific endpoints. | Sneferu API returns 5xx or times out during pipeline stages; operator-session rejects the module. | Integration test against the 5 listed endpoints with the module registered. Owner: operator. Result: all return 2xx with expected schema. |
| A-003 | [ASSUMPTION — OUTCOME FORECAST] Photo-based identification achieves ≥80% automated identification, measured as `(correct + 0.5 × refined) / total × 100`. Forecast about ML/VLM behavior, not a system-property guarantee; AC-004 tests the system property (content-dependent output and threshold routing), not a coverage threshold. | ≥80% threshold with human-in-the-loop for the remainder; VLM-only fallback with raised threshold (0.85) when no KB match. | Reversible by lowering the threshold, adding manual cataloging, or expanding the KB. | Accuracy drops below 80% on 3 diverse deteriorated vehicles. | Run intake on 3 diverse vehicles; measure accuracy per the formula with per-category breakdown. Owner: operator. Result: per-vehicle accuracy report. |
| A-004 | [ASSUMPTION — OUTCOME FORECAST] Tiered sourcing (registry + research primitive + manual entry) locates options for ≥90% of required items within budget (total coverage including manual entries). Aspirational; the system-property target is ≥50% system-discovered (AC-008). Total viability is exercised by AC-038. | Tiered sourcing; system-discovered coverage <50% triggers SOURCING_INSUFFICIENT with manual entry and partial-acceptance paths; hunt timeout (FR-070) halts with partial results. | Reversible by expanding the registry, adding structured supplier feeds through the bridge, or adjusting the threshold. | Measured system-discovered coverage falls below the 50% floor on 5 test manifests; total coverage including manual entries falls below 90% across 5 completed jobs. | Execute sourcing on 5 test manifests; audit hit rate with per-reason-code breakdown; track total coverage across completed jobs. Owner: operator. Result: per-manifest coverage report split by system-discovered vs. manual, plus per-job total-coverage trend. |
| A-005 | [ASSUMPTION — OUTCOME FORECAST] OpenAI TTS (`tts-1`, `alloy`) audio quality suffices for hands-free instruction in a shop environment at 85 dBA ambient noise. | TTS normalized to -16 LUFS via `pyloudnorm` (async, always applied when audio present); AC-039 tests LUFS; AC-040 tests WER <5% in simulated 85 dBA noise; if TTS unavailable, screen-only text is the documented default (no secondary TTS provider in v1). | Reversible by switching TTS provider/voice, adjusting normalization, making text co-primary, or adding a secondary TTS provider (v2 enhancement). | WER ≥5% in simulated shop noise after 3 normalization iterations; mechanic cannot follow narration without looking at the screen. | Play generated audio with 85 dBA noise overlay; compute WER via speech-to-text; mechanic follows 3 consecutive steps audio-only. Owner: operator. Result: WER <5% and 3 steps completed correctly, or documented text-only default. |
| A-006 | [ASSUMPTION — OUTCOME FORECAST] The system generalizes to a second, unseen vehicle without per-vehicle re-engineering. AC-016 tests the system property (≥70% recall). | Same pipeline configuration across all vehicles; KB grows via auto-extraction. | Reversible by adding per-vehicle KB entries or configuration profiles. | Second vehicle of a different make/decade produces <70% recall against ground truth after 3 tuning iterations. | Run the full pipeline on a second vehicle with curated ground truth. Owner: operator. Result: recall metric and failure-point list. |
| A-007 | [ASSUMPTION] A TTS bridge dispatching to OpenAI TTS (`tts-1`, voice `alloy`) can be registered in Sneferu's bridge layer. No TTS bridge is documented in Current Runtime Truth. Provider and model are pinned; the `[unverified]` tag reflects bridge registration status, not provider choice. `pyloudnorm` is the mandatory post-bridge normalization tool. | OpenAI TTS via a new dispatch path; if unavailable, guides publish text-only (`audio_available: false`) — the documented default, not a degradation. No secondary TTS provider in v1. | Reversible by switching TTS provider or implementing a native bridge. | TTS bridge registration fails; OpenAI TTS API errors; audio quality insufficient (A-005). | Attempt bridge registration; generate sample narration; verify playback, loudness (-16 LUFS via `pyloudnorm`), and WER. Owner: operator. Result: playable MP3 at -16 LUFS with WER <5%, or documented text-only default. |
| A-008 | [ASSUMPTION] Meshy can produce multiple spatially aligned per-step static GLB meshes for one sub-assembly. Meshy is primarily single-mesh; multi-mesh output is unverified. `len(glb_paths) == 1` (T2) is a valid fallback state. | Static-per-step GLB (3–5 positions with `step_position_label`); if multi-mesh fails, T2 single exploded-view GLB with callout navigation; if that fails, T3 2D diagrams. | Reversible via T2/T3 fallbacks or a different mesh provider. | Meshy API cannot return multiple aligned meshes; per-step meshes are identical to the exploded view. | Request multiple meshes for a sample sub-assembly. Owner: operator. Result: ≥2 distinct aligned GLBs, or documented T2 fallback as default. |
| A-009 | [ASSUMPTION] The operator configures HTTPS with a **trusted certificate** for phone access. `launch.sh` serves HTTP by default; `launch-dev.sh --https` provides a self-signed cert for testing (FR-063). Self-signed certs are rejected by mobile browsers for Service Worker registration in practice. | HTTP on localhost for development. For production phone access, the operator configures a reverse proxy (Caddy with internal CA, nginx with Let's Encrypt, or a trusted self-signed CA installed on the mechanic's phone). Without HTTPS, the Service Worker does not register at all — offline caching is non-functional (entirely absent, not degraded). The guide becomes online-only and screen wake-lock is unavailable. This is a hard requirement. | Reversible by configuring HTTPS at any time; the Service Worker activates on next page load. | Service Worker fails to register (HTTP origin); wake-lock API undefined; screen sleeps during playback. | Configure Caddy with a trusted cert; load `GET /guide/{token}` over HTTPS; verify SW registration and wake-lock activation. Owner: operator. Result: SW registered and wake-lock active, or documented online-only operation. |
| A-010 | [ASSUMPTION] The `research` workflow primitive can return structured data extractable into `SourcingCandidate` records. Interface and JSON output schema defined in §5; implementation `[unverified]`. The LLM is expected to generate search URLs and parse result descriptions from training data and any bridge-exposed web capability — it does not issue direct HTTP requests; this capability is unverified. Per-query timeout 30s; hunt-level timeout `hunt_timeout_seconds` (default 3600s, FR-070); global concurrency limit (FR-069). URL interpolation uses RFC 3986 percent-encoding (FR-012). | Tiered approach with structured-output parsing; parse failures flagged `unstructured_lead` and routed to manual entry; AC-008 uses a mock primitive; AC-046 tests the interface contract; hunt timeout halts with partial results. | Reversible by implementing a dedicated sourcing bridge, adding structured supplier feeds, or improving the parser. | Primitive returns unstructured text for >50% of queries; parser cannot extract fields; registry sources block automated queries; the LLM cannot produce usable search URLs. | Inspect `research_primitives.py`; run 10 test queries; measure structured-extraction yield. Owner: operator. Result: ≥50% yield, or documented manual-first operating mode. |
| A-011 | [ASSUMPTION] The bundled KB seed CSV (≥205 entries for common 1960s–70s American vehicles) provides meaningful day-one KB coverage for the operator's typical jobs. Per-category minimums and duplicate `part_id` uniqueness validated by the bootstrap script and `validate_kb_seed.py`. | Seed covers brake, suspension, engine, body, interior, electrical, exhaust, fuel, cooling, transmission for Camaro, Mustang, Charger, Chevelle, Nova, C10; VLM-only fallback for vehicles outside the seed set; KB grows via auto-extraction and curation. | Reversible by expanding the seed CSV, adding entries via curation endpoints, or approving auto-extracted proposals. | Seed does not cover the operator's primary vehicle types; identification on seed-covered vehicles shows no confidence/review improvement over VLM-only. | Run identification on a seed-covered vehicle (1969 Camaro) and a non-covered vehicle (e.g., 1957 Bel Air); compare confidence distributions and review-queue sizes. Owner: operator. Result: covered vehicle shows higher confidence and fewer review cases, or seed expansion task filed. |
| A-012 | [ASSUMPTION] The competitive gap claimed in §1 (no purpose-built integrated tooling for vintage restoration as of July 2026) remains accurate. The §1 survey of 6 tool categories is the current evidence. **Re-verification cadence: every 6 months or before each major version release.** The last survey date is recorded in `orchestrator/prompts/packs/restoration_competitive_survey.json` (`{"last_survey_date": "2026-07-01", "surveyed_tools": [...], "gap_confirmed": true}`) so the operator can see staleness. | Proceed with the build regardless — the operator needs the tool for his own shop; the positioning claim affects marketing, not construction. | Reversible by softening or removing the positioning claim if the survey is invalidated. | A survey identifies ≥3 existing tools providing equivalent integrated workflow (photo intake + parts ID + sourcing + visual guided assembly) for vintage restoration. | Re-verify the competitive landscape against ≥5 named tools every 6 months or before a major version release. Owner: operator. Result: updated gap analysis or revised positioning statement, with timestamp recorded in `restoration_competitive_survey.json`. |
| A-013 | [ASSUMPTION] iOS Safari will retain Service Worker caches for the duration of a restoration session. iOS aggressively evicts caches under storage pressure. | Redundant storage: text scripts in both Service Worker cache and IndexedDB; eviction detection via `caches.match()` on the HTML shell; auto re-preload when online; reconnect prompt + reload button when offline; ≤40 MB bundle budget with graded Draco compression; version-aware LRU eviction of superseded bundle assets; iOS-specific restriction to text + 2D caching when over budget. | Reversible by building a native iOS wrapper with persistent storage if web caching proves insufficient. | Eviction occurs during multi-hour sessions; mechanics report mid-session reload prompts despite <40 MB bundles. | Test on iOS Safari under cache pressure (load several large sites to force eviction); verify detection, re-preload, and IndexedDB text fallback. Owner: operator. Result: eviction detected and recovered, or documented limitation with operator guidance. |
| A-014 | [ASSUMPTION] For vehicles not in the seed KB, the budget ruling cannot produce cost estimates (all nulls → INSUFFICIENT_DATA). The initial budget phase relies on operator-supplied estimates until the KB covers the target vehicle or the learning ledger accumulates purchase data. | INSUFFICIENT_DATA verdict surfaces explicitly; operator manually estimates; KB grows via auto-extraction. | Reversible by expanding the seed CSV, adding KB entries, or accumulating purchase history. | Operator consistently encounters INSUFFICIENT_DATA on primary vehicle types; budget rulings are unreliable. | Track the ratio of INSUFFICIENT_DATA rulings over the first 10 jobs; if >50%, prioritize KB expansion. Owner: operator. Result: ratio report and KB expansion plan if needed. |
| A-015 | [ASSUMPTION] Single-worker uvicorn is sufficient for the shop's workload. Multi-worker deployment would require a shared lock service for JSON writes. | Single worker with async task queue (FR-056). | Reversible by migrating to multi-worker with `portalocker`/`filelock` or a Redis-based lock service, or migrating JSON artifacts to SQLite. | Operator experiences UI unresponsiveness during heavy 3D generation; async tasks are insufficient. | Monitor response times during peak load; if U1 responses exceed 2 s consistently, evaluate multi-worker. Owner: operator. Result: response-time report and multi-worker evaluation if needed. |
| A-016 | [ASSUMPTION] The default $100 per-job API cost ceiling is calibrated for small jobs. A 200-part restoration with 3D+TTS+LLM may exceed $100. The ceiling is a guardrail, not a budget. | $100 default; operator can override per job; rough estimate is $0.50–$2.00 per part for identification + sourcing, $5–$15 per sub-assembly for 3D, $0.10–$0.50 per step for TTS. | Reversible by auto-scaling the ceiling based on manifest size. | Operator consistently hits the ceiling on normal-sized jobs and must override. | Track ceiling-override frequency over the first 10 jobs; if >50% require override, implement auto-scaling or raise the default. Owner: operator. Result: override-frequency report and auto-scaling implementation if needed. |
| A-017 | [ASSUMPTION — NONBLOCKING] The learning-ledger defensibility argument (shop-specific data flywheel) is an assertion, not a benchmarked property. A competitor who pre-seeds a larger KB could outpace the shop's data accumulation without the flywheel mattering. | The learning ledger is implemented with pinned formulas (FR-066); the defensibility claim is stated honestly as a data flywheel, not a guarantee. | Reversible by adding a benchmark task. | The learning-biased identification and sourcing show no measurable improvement over a seed-KB-only baseline after N completed jobs. | **Benchmark task (operator-triggerable, non-blocking):** compare, offline, the performance of the learning-biased identification and sourcing against a fresh, unbiased instance using the seed KB only. Run after N completed jobs (N ≥ 5). Measure identification accuracy delta and sourcing success rate delta. Owner: operator. Result: numeric deltas showing improvement or no improvement, documented in the validation log. This is a fitness check, not an acceptance gate. |

## 11. Requirement trace and handoff

**Requirement-to-acceptance trace:** Each mapping includes the surface and journey step; outcome forecasts route to §10 alongside the system-property AC. No FR is solely covered by AC-053 (end-to-end smoke); each has dedicated ACs.

| FR | AC | Surface | Journey step |
|---|---|---|---|
| FR-001 | AC-001, AC-024, AC-049 | U2 | J-1 |
| FR-002 | AC-003, AC-014 | U2 | J-1 |
| FR-003 | AC-003 | U2 | J-1 |
| FR-004 | AC-004, AC-027, AC-044 | U3 | J-2 |
| FR-005 | AC-004 | U3 | J-2 |
| FR-006 | AC-004 [system], A-003 [outcome] | U3 | J-2 |
| FR-007 | AC-005, AC-029 | U3 | J-3 |
| FR-008 | AC-005, AC-029 | U3 | J-3 |
| FR-009 | AC-006 | U4 | J-4 |
| FR-010 | AC-006 | U4 | J-4 |
| FR-011 | AC-007 | U4 | J-4 |
| FR-012 | AC-008 [system], AC-046, A-004 [outcome], A-010 [assumption] | U4 | J-5 |
| FR-013 | AC-008 [system], AC-023, AC-038 [outcome], A-004 [outcome] | U4 | J-5 |
| FR-014 | AC-009 | U4 | J-5 |
| FR-015 | AC-009 | U4, U5 | J-5 |
| FR-016 | AC-010, A-001, A-008 | U5 | J-6 |
| FR-017 | AC-010, AC-015, AC-037, AC-051 | U5 | J-6 |
| FR-018 | AC-010, AC-021, AC-022, AC-052, A-008 | U5 | J-6 |
| FR-019 | AC-011, AC-039, AC-040, A-005, A-007 | U5 | J-6 |
| FR-020 | AC-011, AC-019, AC-058 | U5, U6 | J-7 |
| FR-021 | AC-011, AC-019 | U6 | J-8 |
| FR-022 | AC-011, AC-035 | U6 | J-8 |
| FR-023 | AC-011, A-005 | U6 | J-8 |
| FR-024 | AC-011, AC-035 | U6 | J-8 |
| FR-025 | AC-015, AC-018, AC-022, AC-030, AC-054 | U6 | J-8 |
| FR-026 | AC-013 | U1–U5, U7 | J-0 |
| FR-027 | AC-012, AC-025, AC-047 | All | All |
| FR-028 | AC-015, AC-048 | U7 | All |
| FR-029 | AC-012, AC-047 | U1 | J-0 |
| FR-030 | AC-001, AC-002 | U7 | J-0 |
| FR-031 | AC-018, AC-042, AC-054 | U6 | J-8 |
| FR-032 | AC-018, AC-036, AC-043, AC-054 | U6 | J-8 |
| FR-033 | AC-020, AC-021, AC-053, AC-060 | All | All |
| FR-034 | AC-020 | U1 | All |
| FR-035 | AC-033 | U1 | All |
| FR-036 | AC-021 | U5 | J-9 |
| FR-037 | AC-008, AC-026, AC-057 | U4 | J-5 |
| FR-038 | AC-012 | U1 | All |
| FR-039 | AC-019 | U5, U6 | J-7 |
| FR-040 | AC-019 | U5, U6 | J-7 |
| FR-041 | AC-019, AC-054 | U6 | J-8 |
| FR-042 | AC-008, AC-029, AC-059 | U4 | J-5 |
| FR-043 | AC-029, AC-038 | U4 | J-5 |
| FR-044 | AC-022, AC-030, AC-052 | U5 | J-6 |
| FR-045 | AC-008 | U4 | J-5 |
| FR-046 | AC-018, AC-050, AC-054 | U6 | J-8 |
| FR-047 | AC-024, AC-025, AC-031, AC-041 | All | All |
| FR-048 | AC-024 | U1 | All |
| FR-049 | AC-001, AC-027, AC-029 | U3 | J-2 |
| FR-050 | AC-028 | U7 | All |
| FR-051 | AC-034 | U4, U8 | All |
| FR-052 | AC-026 | U4 | J-5a |
| FR-053 | AC-035 | U6 | J-8 |
| FR-054 | AC-036, AC-054 | U6, U1, U5 | J-8 |
| FR-055 | AC-032 | U1, U5 | J-7 |
| FR-056 | AC-012, AC-031, AC-056 | U1–U7 | All |
| FR-057 | AC-005 | U3 | J-3 |
| FR-058 | AC-030 | U5 | J-6 |
| FR-059 | AC-034 | U8 | J-10 |
| FR-060 | AC-037 | U5 | J-6 |
| FR-061 | AC-001, AC-011, AC-013 | All | All |
| FR-062 | AC-001, AC-002, AC-049 | All | J-0 |
| FR-063 | AC-018, AC-050 | U6 | J-8 |
| FR-064 | AC-053 (mock variant); e2e variant via `--e2e` | All | All |
| FR-065 | AC-045 | U4, U1 | J-4/J-5 |
| FR-066 | AC-044 | U3 | J-2 |
| FR-067 | AC-047, AC-048 | U1, U7 | J-0 |
| FR-068 | AC-054 | All | J-0 |
| FR-069 | AC-055 | All | J-5 |
| FR-070 | AC-057 | U4 | J-5 |

**B0 goal trace:** Each B0 goal is covered by at least one AC that directly tests the feature(s) designed to fulfill that goal — not just a system heartbeat.

| B0 goal | How addressed | Testable feature | AC | Where |
|---|---|---|---|---|
| "Win restoration work" | Customer-facing artifact export: proposal-ready A4 PDFs (300 DPI, template-defined) with before/after photos, assembly screenshots, and restoration summaries; the product produces evidence, not just capability | `POST .../export-artifact` generates PDF via `reportlab` using `restoration_pdf_template.json` — AC-032 verifies PDF dimensions, DPI, text content, and download links | AC-032 | §1 boundary; §2 U1, U5; FR-055; §3 J-7 |
| "Make work easier" | Guided workflow: automated intake/identification, sourcing surfacing, tiered visual instructions, narrated phone guidance, free-explore, glossary, flag-a-problem, step persistence, learning ledger, shop analytics | End-to-end journey from intake to guided installation; mechanic completes a sub-assembly using only the phone guide — AC-011 verifies guide playback, AC-035 verifies free-explore/glossary/skip-ahead, AC-043 verifies step persistence, AC-053 verifies full journey | AC-011, AC-035, AC-043, AC-053 | §1 boundary; §2 U1–U8; §3 journey; FR-007, FR-043, FR-049, FR-059 |
| B0 `solo` | One person administers everything; zero staffing assumptions; staged workload model with explicit system/operator split; async tasks prevent blocking | Operator runs the full workflow alone; async tasks keep UI responsive — AC-031 verifies non-blocking, AC-028 verifies U7 write actions | AC-031, AC-028 | §1 workload model; §2 permissions; §5 authZ; §8 ops |
| B0 `balanced` | Fail safe on money with documented, reversible override; post-sourcing cost gate; API cost ceiling + visibility; tiered degraded modes | Budget enforcement (4 verdicts + pinned thresholds + override); API cost ceiling (80% warn, 100% block, override); cost gate — AC-006, AC-007, AC-026, AC-045 each test specific enforcement behaviors | AC-006, AC-007, AC-026, AC-045 | FR-009…FR-011, FR-044…FR-046, FR-051, FR-052, FR-065 |
| B2 C-001 | Domain = classic-car fix-up and restoration (operator_assumption) | KB seed covers 1960s–70s American vehicles; VLM-only fallback for others — AC-001 verifies KB seeding, AC-027 verifies KB loading/fallback | AC-001, AC-027 | §1 boundary; §4 domain scoping; §5 reference KB |

**MVP definition:** The minimum viable slice is Phases 1–3 (module skeleton, intake, identification, manifest, budget, sourcing). After Phase 3 the operator can use the system as a restoration tracking and sourcing assistant — automated identification, budget enforcement, tiered sourcing, negotiation/purchase tracking, and cost visibility — even without 3D or the mobile guide. **MVP acceptance criterion (observable outcome):** a project proceeds end-to-end from intake → identification → manifest lock → budget ruling → sourcing (with mock primitive) → hunt seal, producing a sourcing report with candidates, flags, coverage metrics, and a cost gate result; the operator can record a negotiation and purchase; the system writes feedback signals to the learning ledger — all with no 500 errors and AC-001 through AC-009 passing. Full product criterion: AC-001 through AC-060 passing.

**Implementation handoff:**

1. **Phase 1 — Module skeleton, data models, intake, async tasks, reconciliation (FR-001, FR-002, FR-003, FR-026, FR-027, FR-028, FR-029, FR-030, FR-033, FR-047, FR-048, FR-056, FR-057, FR-061, FR-062, FR-063, FR-064, FR-067, FR-068).** Files to create: `restoration_models.py`, `restoration_pipeline.py`, `restoration_reconcile.py`, `restoration_copilot.html`, `job_board.js`, `intake_bay.js`, `seed_restoration_kb.py`, `validate_kb_seed.py`, `generate_test_cert.py`. Smoke test: `pytest tests/restoration/test_intake.py tests/restoration/test_state_machine.py tests/restoration/test_concurrency.py tests/restoration/test_async_tasks.py tests/restoration/test_health.py tests/restoration/test_reconciliation.py -v`. Gating ACs: AC-001, AC-002, AC-003, AC-013, AC-014, AC-024, AC-031, AC-047, AC-049, AC-056, AC-060. **Phase 1 accepted when:** a project can be created, photos ingested with content-based validation and HEIC transcoding, state transitions enforce (including in-service checklist validation), concurrent creation is safe, health endpoint returns dynamic data, and the async task resume mechanism works — no 500 errors.

2. **Phase 2 — Identification, manifest, and KB (FR-004, FR-005, FR-006, FR-007, FR-008, FR-049, FR-066).** Files to create: `parts_bench.js`, `restoration_kb.yaml`, `restoration_kb_seed.csv`, `restoration_glossary.yaml`. Smoke test: `pytest tests/restoration/test_manifest.py tests/restoration/test_kb_loading.py tests/restoration/test_feedback_signals.py -v`. Gating ACs: AC-004, AC-005, AC-027, AC-029, AC-044. **Phase 2 accepted when:** identification produces content-dependent output with pinned threshold routing, review cases resolve with audit deltas and denormalized `category` in feedback signals, KB proposals generate from corrections, and the biasing formula computes correctly with zero-sample guard.

3. **Phase 3 — Budget, sourcing, source registry, API cost ceiling (FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-037, FR-042, FR-043, FR-045, FR-051, FR-052, FR-065, FR-069, FR-070).** Files to create: `wallet_desk.js`, `research_primitives.py`, `restoration_sources.yaml`. Smoke test: `pytest tests/restoration/test_sourcing.py tests/restoration/test_research_primitive_interface.py tests/restoration/test_api_cost_ceiling.py -v`. Gating ACs: AC-006, AC-007, AC-008, AC-009, AC-023, AC-026, AC-034, AC-038, AC-045, AC-046, AC-055, AC-057, AC-059. **Phase 3 accepted when (MVP):** a complete end-to-end workflow from intake through sourcing seal works with no 500 errors, budget enforcement is correct with pinned thresholds, tiered sourcing with URL encoding and dedup works, hunt timeout and global concurrency limit enforce, both coverage metrics report, the negotiation state machine enforces valid transitions, API cost ceiling warns/blocks/overrides, and the research primitive interface contract is verified. **MVP SHIPPABLE HERE.**

4. **Phase 4 — 3D generation, QA, 2D diagrams, TTS, publish, export (FR-016, FR-017, FR-018, FR-019, FR-020, FR-044, FR-050, FR-055, FR-058, FR-060).** Files to create: `model_shop.js`, `engine_room.js`, `generate_2d_diagram.py`, `restoration_pdf_template.json`. Smoke test: `pytest tests/restoration/test_3d_generation.py tests/restoration/test_2d_diagram.py tests/restoration/test_audio_lufs.py tests/restoration/test_audio_intelligibility.py tests/restoration/test_pdf_export.py tests/restoration/test_provider_actions.py -v`. Gating ACs: AC-010, AC-015, AC-022, AC-028, AC-030, AC-032, AC-037, AC-039, AC-051, AC-052, AC-058. **Phase 4 accepted when:** meshes pass dimensional QA with GLB unit normalization and recorded deviation values (including `scale_factor_applied`), TTS audio normalizes to -16 LUFS via `pyloudnorm`, degraded-mode fallback produces graph-labeled 2D diagrams, guides publish with tokens and `step_position_label`, U7 write actions work, PDFs export in the correct format, and `total_duration_s` bound is enforced.

5. **Phase 5 — Mobile guide, offline, tokens, empowerment (FR-021, FR-022, FR-023, FR-024, FR-025, FR-031, FR-032, FR-039, FR-040, FR-041, FR-046, FR-053, FR-054).** Files to create: `bay_guide.html`, `bay_guide/*.js`. Smoke test: `playwright install chromium && pytest tests/restoration/test_mobile_guide.py tests/restoration/test_offline.py tests/restoration/test_offline_resilience.py tests/restoration/test_tokens.py tests/restoration/test_flags.py tests/restoration/test_step_persistence.py tests/restoration/test_preload_time.py tests/restoration/test_https_sw.py -v --browser`. Gating ACs: AC-011, AC-012, AC-018, AC-019, AC-025, AC-035, AC-036, AC-041, AC-042, AC-043, AC-050, AC-054. **Phase 5 accepted when:** the guide plays offline with assembly-specific assets, preloads within budget, resumes at the last step on tab reopen, mid-session offline degradation works (per-step fallback ladder, "offline" indicator), flags sync from offline with feedback-signal routing, tokens are revocable/extendable, superseded/expired token UX works (including `X-Guide-Superseded` header and flag-sync 410), and HTTPS Service Worker registration is verified. **`test_https_sw.py` is included in the Phase 5 gate.**

6. **Phase 6 — Analytics, lifecycle completion, generalization, deployment (FR-034, FR-035, FR-036, FR-059).** Files to create: `shop_insights.js`, `restoration_competitive_survey.json`. Smoke test: `pytest tests/restoration/test_insights.py tests/restoration/test_reconciliation.py tests/restoration/test_end_to_end.py -v`. Gating ACs: AC-016, AC-017, AC-020, AC-021, AC-033, AC-040, AC-048, AC-053. **Phase 6 accepted when:** a second vehicle generalizes with ≥70% recall, ABANDONED/re-open transitions behave (with AsyncTask cancellation), analytics compute, deployment/rollback is verified, and stale-lock cleanup works.

**Parallelization plan (with dependency proof):**

| Phase pair | Shared dependencies | Proof of independence |
|---|---|---|
| Phase 4 ↔ Phase 5 | `WalkthroughAssembly`/`WalkthroughStep` schemas, `bundle_meta.json` format, asset endpoint paths | Phase 4 produces bundles; Phase 5 consumes them via `GET /guide/{token}` and `GET .../assets/{filename}`. The shared interface is the `bundle_meta.json` schema (defined in §5) and the REST asset endpoints — both frozen before either phase starts. Phase 5 can be built against mock bundles conforming to the schema; Phase 4 can be built and tested without the mobile viewer. No shared Python code. A CI pipeline builds each phase's code in isolation using mocks/stubs for the shared contract; both test suites must pass in isolation mode. |
| Phase 3 ↔ Phase 4 (partial overlap) | `ManifestEntry.sourcing_status`, `UnsourceableFlag.fabrication_reference_glb` | Phase 4's fabrication reference depends on Phase 3's schemas (frozen in §5), not on Phase 3's sourcing implementation. 3D pipeline development can proceed while sourcing is tested. |

Phase 6 depends on data from Phases 3–5 and must be last.

**Files demonstrating completion:**
- All files listed in §6, verified by the §6 completion integrity checks (existence + import smoke + KB validation including duplicate `part_id` + health + full test suite).
- All AC-001 through AC-060 passing.
- Operator has run a real vehicle end-to-end from intake to guided installation.

```bash
# Phase 1 completion (skeleton)
pytest tests/restoration/test_intake.py tests/restoration/test_state_machine.py \
  tests/restoration/test_concurrency.py tests/restoration/test_async_tasks.py \
  tests/restoration/test_health.py tests/restoration/test_reconciliation.py -v

# Phase 3 completion (MVP — shippable as restoration tracking and sourcing assistant)
pytest tests/restoration/test_manifest.py tests/restoration/test_sourcing.py \
  tests/restoration/test_kb_loading.py tests/restoration/test_research_primitive_interface.py \
  tests/restoration/test_api_cost_ceiling.py -v

# Phase 5 completion (full product — includes test_https_sw.py)
pytest tests/restoration/test_mobile_guide.py tests/restoration/test_offline.py \
  tests/restoration/test_offline_resilience.py tests/restoration/test_tokens.py \
  tests/restoration/test_flags.py tests/restoration/test_step_persistence.py \
  tests/restoration/test_preload_time.py tests/restoration/test_https_sw.py -v --browser

# Final completion — all tests pass (pass/fail exit code, not mere file existence)
pytest tests/restoration/ -v

# End-to-end with real bridges (requires API keys)
pytest tests/restoration/test_end_to_end.py -v --e2e
```

## Obligation Responses

OBL-1: ADDRESSED — U7 has four explicit write actions (FR-050: pause/resume/failover/recheck) that change system behavior and write audit events; the Engine Room is actionable, not surveillance-only; tested by AC-028.
OBL-2: ADDRESSED — HEIC/WebP storage policy pinned in §1 and FR-002: HEIC transcoded to JPEG (quality 85) for thumbnails via `pillow-heif`; original HEIC preserved byte-identical; WebP/JPEG/PNG preserved as-is; vision pipeline consumes JPEG thumbnails; mobile guide serves JPEG thumbnails and non-HEIC originals; magic-byte signatures pinned (JPEG `FF D8 FF`, PNG `89 50 4E 47`, HEIC `ftypheic`/`ftypheix`, WebP `RIFF....WEBP`); tested by AC-003.
OBL-3: ADDRESSED — FR-004 pins confidence threshold at 0.70 (default), 0.85 in VLM-only mode; configurable in `defaults.yaml`; tested by AC-004 which verifies threshold routing.
OBL-4: ADDRESSED — FR-009 pins budget-ruling thresholds: ≤80% → AFFORDABLE, >80% and ≤100% → TIGHT, >100% → SHORTFALL_CRITICAL, >30% null → INSUFFICIENT_DATA; configurable in `defaults.yaml`; tested by AC-006.
OBL-5: ADDRESSED — FR-034 pins that ABANDONED transition automatically cancels all pending AsyncTask entries, writes `async_task_cancelled` events, and allows in-flight dispatches to complete but blocks new ones; tested by AC-020.
OBL-6: ADDRESSED — FR-069 pins global sourcing concurrency limit: max 1 per project, 3 total across all projects, managed via `asyncio.Semaphore` in-memory queue; configurable in `defaults.yaml`; tested by AC-055.
OBL-7: ADDRESSED — FR-012 pins per-query timeout (30s), FR-070 pins hunt-level timeout (`hunt_timeout_seconds`, default 3600s) with partial-results behavior, FR-069 pins concurrency discipline (sequential per project, global limit 3); all labeled with validation task A-010; tested by AC-008, AC-046, AC-055, AC-057.
OBL-8: ADDRESSED — `WalkthroughStep.step_position_label` field added to the data model (values: "exploded", "positioning", "install", "torque", "finishing") modeling the semantic meaning of each per-step mesh position; tested by AC-021.
OBL-9: ADDRESSED — FR-019 pins TTS fallback behavior: if TTS bridge unavailable (registration fails, API errors, or cost ceiling hit), guide publishes as screen-only text (`audio_available: false`); text-only is the documented default, not a degraded mode; no secondary TTS provider in v1; the complete fallback chain is specified.
OBL-10: ADDRESSED — §2 U6 "Mid-session offline degradation" pins: "offline" indicator in UI header, per-step fallback ladder (GLB → 2D diagram → still image → text-only), speculative preload continues from cache, text always available from IndexedDB; tested by AC-054.
OBL-11: ADDRESSED — AC-004 and AC-008 rows in §9 explicitly note: "≥80% auto-ID is outcome forecast A-003, not this AC" and "≥90% total coverage is outcome forecast A-004 (AC-038), not this AC"; system-property vs. outcome-forecast distinction is explicit in the matrix.
OBL-12: ADDRESSED — `audio_lufs_target` treated in §3 (set at publish time, configurable via `defaults.yaml`, per-assembly not per-step); `bundle_version` increment rule pinned in §3 ("the sole increment trigger is PUBLISHED → PUBLISHED re-publish of the same assembly"); both are explicit in the journey, not just data model defaults.
OBL-13: ADDRESSED — FR-026 enumerates exactly 5 Sneferu endpoints (`POST /admin/operator/session`, `GET /admin/operator/session`, `GET /live/status`, `GET /bridge/health`, `POST /runs/start`) with per-endpoint stability requirements; states "No other Sneferu endpoint is called by the restoration module"; A-002 is backed by this enumeration.
OBL-14: ADDRESSED — FR-017 pins reference-dimension precedence (KB → operator override → `unverified_dimensions`), GLB unit-scale normalization as a mandatory pre-step, and the AABB per-axis deviation algorithm; when KB is missing and no operator dimensions supplied, mesh publishes with `qa_status: "unverified_dimensions"` (deviation check skipped, gap logged, not blocked); tested by AC-010, AC-037, AC-051.
OBL-15: ADDRESSED — Same as OBL-2: HEIC transcoding/storage policy pinned in §1, FR-002, and U2; tested by AC-003.
OBL-16: ADDRESSED — FR-054 pins downstream routing: `wrong_part` flags → `FeedbackSignal` (type `identification_correction`); `tool_missing` flags → `FeedbackSignal` (type `sourcing_selection`); `step_unclear`/`other` flags → `mechanic_flags` table only (no feedback signal); tested by AC-036.
OBL-17: ADDRESSED — FR-020 and AC-058 pin `total_duration_s` bound: maximum 600s (10 minutes) per sub-assembly; if exceeded, U5 warns "audio narration exceeds 10 minutes — consider splitting the sub-assembly."
OBL-18: ADDRESSED — PDF template schema fully shown in §5 (`page_size`, `dpi`, `margin_mm`, `sections` with fields/layouts/sizes); validator is `reportlab` (malformed JSON → `pdf_template_error` event, export returns 500); tested by AC-032.
OBL-19: ADDRESSED — FR-065 pins that API cost ceiling override writes an `api_cost_ceiling_overridden` event to the SQLite `events` table (canonical audit source per FR-028) with actor, timestamp, reason; `api_cost_override_reason` set on `RestorationProject`; tested by AC-045.
OBL-20: ADDRESSED — FR-028 pins `events.jsonl` schema (`{event_id, project_id, event_type, timestamp, actor, metadata}` per line), per-run scope, rotation policy (10 MB threshold, renamed to `events.{N}.jsonl`, max 5 rotated files retained, oldest deleted), append-only during a run; tested by AC-048.
OBL-21: ADDRESSED — AC-040 pins the intelligibility metric: WER computed as `(substitutions + deletions + insertions) / reference_word_count × 100`, fixture is fixed transcript from `WalkthroughStep.description` fields, acceptance threshold is WER < 5% in simulated 85 dBA white noise; tagged as outcome forecast routed to A-005.
OBL-22: ADDRESSED — §5 research primitive JSON schema and `SourcingCandidate` Python class both clarify: `manual_entry` is absent from the research primitive's JSON output because manual entries arrive via a separate REST path (`POST .../sourcing/manual`); the Python class includes `manual_entry` in its provenance enum to cover both paths; tested by AC-046.
OBL-23: ADDRESSED — FR-012 pins RFC 3986 percent-encoding for all placeholder values in `search_template` interpolation; tested by AC-046.
OBL-24: ADDRESSED — FR-012 pins null `oem_number` behavior: if null, the `{oem_number}` token is removed entirely from the template string; if sole value in a query parameter, the entire parameter is dropped; if part of a compound value, the token is removed and adjacent `+` separators collapsed; tested by AC-046.
OBL-25: ADDRESSED — FR-070 pins `hunt_timeout_seconds` (default 3600s, configurable in `defaults.yaml`): if exceeded, hunt halts with partial results, `sourcing_hunt_timeout` event written, project transitions to `SOURCING_INSUFFICIENT`, operator can resume; tested by AC-057.
OBL-26: ADDRESSED — FR-033 pins `in_service_checklist` source: items defined in `defaults.yaml::restoration_in_service_checklist` (default: `["all critical sub-assemblies published", "operator has verified the vehicle is road-ready"]`); operator confirms each via U4 before PUBLISHED → IN_SERVICE transition; the API validates every default item is present and returns 400 naming missing items; stored in `project.json`; tested by AC-060.
OBL-27: ADDRESSED — FR-062 pins `os_supported: false` runtime behavior: `POST .../projects` returns 409 with `{"error": "os_not_supported", ...}`; existing projects remain read-only (U1 displays them, state-changing endpoints return 409); prevents silent data corruption; tested by AC-049.
OBL-28: ADDRESSED — FR-049 and `validate_kb_seed.py` both check duplicate `part_id` uniqueness; seed script and validator fail with non-zero exit code on duplicate; tested by AC-001.
OBL-29: ADDRESSED — `FeedbackSignal` class gains denormalized `category: Optional[str]` field populated from manifest at signal-creation time; prevents learning-ledger misattribution when manifest categories change; tested by AC-005, AC-029.
OBL-30: ADDRESSED — FR-040, FR-041, and U6 pin superseded token UX: old guide remains fully functional, served with HTTP 200 plus an `X-Guide-Superseded: true` response header (machine-readable signal for the guide and Service Worker) and a persistent, dismissible "A newer version of this guide is available. Contact the shop operator for the updated link" banner; reappears on next load; tested by AC-019, AC-054.
OBL-31: ADDRESSED — FR-041 and U6 pin expired token UX: server returns HTTP 410 with `{"error": "token_expired", "message": "..."}`; if cached by Service Worker, guide remains usable read-only with a non-dismissible "This guide link has expired. Contact the shop operator to renew" banner; flag-sync POSTs with the expired token receive 410 and flags remain queued in IndexedDB; if no cache, 410 error page with contact message; tested by AC-019, AC-054.
OBL-32: ADDRESSED — Same as OBL-21: AC-040 pins WER < 5% as the machine-checkable metric with defined fixture and acceptance threshold.
OBL-33: ADDRESSED — FR-068 pins "clears stale locks on boot" mechanism: checks `runs/.restoration_index.lock` and per-file `.lock` sidecars; if lock file exists but holding PID (recorded inside lock file) is not alive (`os.kill(pid, 0)`), lock file is removed and `stale_lock_cleared` event logged; `fcntl.flock` advisory locks auto-release on process exit — this handles the SIGKILL edge case; tested by AC-054.
OBL-34: ADDRESSED — Same as OBL-2/OBL-15: HEIC transcoding/storage policy pinned in §1, FR-002, U2; tested by AC-003.
OBL-35: ADDRESSED — AC-008 is explicitly a system-property test (tier ordering, dedup, coverage formula, hunt timeout) tagged [system]; the ≥90% total coverage aspiration is outcome forecast A-004 exercised by AC-038 tagged [outcome forecast]; the distinction is explicit in the §9 matrix notes.
OBL-36: ADDRESSED — §2 U6 defines full offline-mode contract: IndexedDB schema (`guide_progress`, `flag_queue`, `text_scripts` stores), Service Worker asset manifest (`bundle_meta.json` with asset list and preload priority), mid-session degradation UX ("offline" indicator, per-step fallback ladder, speculative preload), token-expiry/supersession UX (410 response, cached read-only with banner, `X-Guide-Superseded` header + dismissible superseded banner), and version-aware LRU cache eviction bounded by the 40 MB budget; tested by AC-018, AC-042, AC-043, AC-054.
OBL-37: ADDRESSED — FR-012 pins per-query timeout (30s), retries (3 with 2/4/8s backoff), rate limit (1 per `rate_limit_seconds` per source), sequential per project; FR-070 pins hunt-level timeout; FR-069 pins global concurrency limit; A-010 carries validation task for parsing strategy; AC-046 tests interface contract including timeout/retry/rate-limit.
OBL-38: ADDRESSED — `SourcingCandidate` gains `oem_number: Optional[str]` field for deduplication; FR-012 dedup key is `part_id + vendor + oem_number + similar price (±5%)`; research primitive JSON schema includes `oem_number` per candidate; tested by AC-008, AC-046.
OBL-39: ADDRESSED — FR-010 pins the 60/30/10 formula: `per_part_ceiling = (tier_allocation_pct × budget_ceiling_usd) / tier_part_count` with a worked example and empty-tier redistribution; tested by AC-006.
OBL-40: ADDRESSED — Same as OBL-14: FR-017 pins reference-dimension source (KB → operator override → `unverified_dimensions`), GLB unit normalization, and AABB per-axis deviation algorithm with per-category tolerances.
OBL-41: ADDRESSED — Same as OBL-1: U7 has four explicit write actions (FR-050) tested by AC-028.
OBL-42: ADDRESSED — Same as OBL-2/OBL-15/OBL-34: HEIC transcoding/storage policy pinned and tested.
OBL-43: ADDRESSED — §3 "Negotiation workflow (pinned)" and FR-042 define the state machine: `pending → negotiating`; `negotiating → ordered` (requires `final_price_usd`); `negotiating → passed` (terminal, requires notes); `ordered → received` (triggers feedback signal and KB proposal); `ordered → passed` (terminal, order cancelled); `received → returned` (terminal); `received → disputed` (→ `returned` or back to `received`); invalid transitions return 409 naming current status and valid next statuses; all operator-initiated; tested by AC-059.
OBL-44: ADDRESSED — FR-063 and §8 production HTTPS checklist require a trusted certificate (Caddy with internal CA, nginx with Let's Encrypt, or trusted self-signed CA installed on phone); self-signed certs are explicitly noted as rejected by mobile browsers for Service Worker registration; without HTTPS, Service Worker does not register and guide is online-only; checklist includes 4 verification steps; tested by AC-050.
OBL-45: ADDRESSED — §1 API cost ceiling calibration note and A-016 provide worked cost estimate ($0.50–$2.00 per part for identification + sourcing, $5–$15 per sub-assembly for 3D, $0.10–$0.50 per step for TTS) and track auto-scaling as a validation task; the ceiling is described as a guardrail, not a budget; tested by AC-045.
OBL-46: ADDRESSED — U6 token security threat model documented: 30-day default expiry limits exposure window; revocation/supersession is immediate; guide contains no sensitive personal data; access logs are operator-controlled; `Referrer-Policy: no-referrer` header prevents referrer leakage; `<meta name="robots" content="noindex">` prevents indexing; device binding and one-time-use tokens are v2 enhancements.
OBL-47: ADDRESSED — FR-019 pins the complete TTS fallback chain: if OpenAI TTS is unavailable, guide publishes as screen-only text (`audio_available: false`); no secondary TTS provider in v1; text-only is the documented default, not a degraded mode; secondary TTS provider (e.g., Anthropic, local pyttsx3) is a v2 enhancement.
OBL-48: ADDRESSED — Phase 5 completion test command in §7 and §11 explicitly includes `tests/restoration/test_https_sw.py` in the gate; AC-050 is a gating AC for Phase 5.
OBL-49: ADDRESSED — FR-012 and §5 source registry schema specify: entries without a `search_template` (e.g., `local_rebuilder_01` with `search_template: null`) are skipped by the research primitive and surfaced in U4 as manual-contact sources in a "Trade Partners" sub-panel with click-to-call/click-to-email links; AC-046 verifies the skip behavior.
OBL-50: ADDRESSED — FR-066 and §1 formula explicitly guard the zero/below-minimum-samples case: "IF total_corrections < minimum_samples: adjusted_confidence = base_confidence (no adjustment, no computation)" and "When total_corrections == 0, the guard fires and adjusted_confidence = base_confidence (no division by zero)"; tested by AC-044.
OBL-51: ADDRESSED — Same as OBL-7/OBL-35: AC-008 is a system-property test (tier ordering, dedup, hunt timeout); AC-038 is a separate coverage-forecast metric; FR-012 pins per-query timeout (30s) and URL encoding (RFC 3986); A-010 carries validation task.
OBL-52: ADDRESSED — Same as OBL-36: full offline-mode contract defined in §2 U6 with IndexedDB schema, asset manifest, mid-session degradation UX, token-expiry/supersession behaviour; `test_offline_resilience.py` added to test suite; tested by AC-018, AC-042, AC-043, AC-054.
OBL-53: ADDRESSED — Same as OBL-3/OBL-4/OBL-14/OBL-26: identification confidence pinned at 0.70/0.85; budget-ruling bands pinned at ≤80%/80-100%/>100%; dimensional QA comparison uses KB reference dimensions with AABB per-axis deviation; in-service checklist source pinned in `defaults.yaml`.
OBL-54: ADDRESSED — Same as OBL-1/OBL-41: U7 has four explicit write actions (FR-050) tested by AC-028; the Engine Room is actionable.
OBL-55: DISPUTED — `restoration_index.json` is explicitly a cache, not a source of truth (FR-027, FR-048); it is always reconstructable from SQLite + `project.json` files; U1 falls back to scanning if the index is missing/corrupt; the boot-time reconciliation job (FR-067) rebuilds it; eliminating it entirely would reduce U1 query performance for operators with many jobs; the hybrid approach keeps JSON artifacts diffable for the solo operator while SQLite handles transactional state; the index is not a parallel source of truth — it is a cache with a defined rebuild path.
OBL-56: ADDRESSED — Same as OBL-7/OBL-25/OBL-51: FR-070 pins `hunt_timeout_seconds` (default 3600s) with partial-results behavior and SOURCING_INSUFFICIENT transition; FR-038 pins hunt pause/resume via `POST .../sourcing/pause` and `/resume` with preserved progress; tested by AC-057.
OBL-57: ADDRESSED — FR-017 pins GLB unit-scale normalization as a mandatory pre-step: "the generated GLB is loaded via `trimesh` and its bounding box is normalized to real-world millimeters by scaling the mesh so that the longest axis of the AABB matches the corresponding reference dimension"; the normalization factor is recorded in the QA receipt as `scale_factor_applied`; tested by AC-010, AC-051.
OBL-58: ADDRESSED — FR-019 pins `pyloudnorm` as the mandatory post-processing tool for -16 LUFS normalization: "OpenAI `tts-1` does not guarantee exact LUFS natively; `pyloudnorm` is the named enforcement tool"; tested by AC-039.
OBL-59: ADDRESSED — Same as OBL-36: IndexedDB schema explicitly defined (`guide_progress`: `{token_id, step_index, timestamp}`; `flag_queue`: `{flag_id, problem_type, description, screenshot_data_url, photo_blob, created_at, sync_status}`; `text_scripts`: redundant copy for iOS resilience); Service Worker cache eviction strategy pinned in FR-031: cache name includes `bundle_version`, version-aware LRU eviction of the prior version's GLB and audio on next activation, current version's text scripts and 2D diagrams always retained, total size bounded by the 40 MB bundle budget (not a fixed asset count, so a 20-step assembly with full assets always fits), priority-order caching, Draco compression above 30 MB, iOS restriction to text + 2D when over budget, eviction detection via `caches.match()`, auto re-preload.
OBL-60: ADDRESSED — A-012 in §10 includes re-verification cadence: "every 6 months or before each major version release"; last survey date recorded in `orchestrator/prompts/packs/restoration_competitive_survey.json` (`{"last_survey_date": "2026-07-01", ...}`) so operator can see staleness.
OBL-61: ADDRESSED — A-017 in §10 adds a non-blocking benchmark validation task: compare learning-biased identification and sourcing against a seed-KB-only baseline after N completed jobs (N ≥ 5); measure identification accuracy delta and sourcing success rate delta; operator-triggerable, non-blocking fitness check, not an acceptance gate.