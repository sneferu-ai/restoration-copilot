# Restoration Copilot — UI

Two web surfaces exist, both served by the Python backend:

1. **Operator console** (`/restoration-ui`) — React SPA for the shop owner (spec panels U1–U5, U7, U8).
2. **Bay Guide** (`/guide/{token}`) — React PWA for the mechanic on a smartphone (U6), token-gated, offline-oriented.

Both are one Vite project (`orchestrator/ui/app/`) with two entry points, built to `orchestrator/ui/web/static/restoration/app/` and **committed** — the backend serves the build without any Node.js at runtime. When the build is absent, the backend falls back to legacy plain-HTML pages (`orchestrator/ui/web/restoration_copilot.html` for the console, `bay_guide.html` for the guide). The design contract is [../DESIGN.md](../DESIGN.md); the brand is frozen in [../BRAND_IDENTITY.md](../BRAND_IDENTITY.md).

## Stack and tooling

React 18 + TypeScript 5.5, react-router-dom 6 (BrowserRouter for the console, HashRouter for the guide), @tanstack/react-query 5 for server state, zod for payload validation, Tailwind 3 + CSS tokens. Vite 5 builds; vitest + Testing Library + msw test; jsdom environment.

| Command (in `orchestrator/ui/app`) | What it does | Verified |
|---|---|---|
| `npm install` / `npm ci` | Install dependencies (`package-lock.json` committed) | ✅ npm ci |
| `npm run dev` | Vite dev server on :5173, proxies `/restoration` `/admin` `/bridge` `/guide` to :8000 | config |
| `npm test` | vitest — 5 brand-asset tests | ✅ 5 passed |
| `npm run typecheck` | `tsc -b --noEmit` | ✅ clean |
| `npm run build` | `tsc -b && vite build` → `../web/static/restoration/app/` | ✅ 819 ms |
| `npm run audit:tokens` | Fails on raw hex/px/ms outside `tokens.css` | present |

`npm run build` has a `postbuild` gate (`scripts/verify-static-assets.mjs`) that fails the build if the frozen `brand-mark.svg` (SHA-256 `44a8f432…`), `guide-sw.js`, or either entry page is missing from the output.

## How the UI talks to the backend

`src/shared/http.ts` builds a fetch client that attaches `Authorization: Bearer <session>` from the session context and normalizes errors into `ApiError {status, body}`; `withAuth` logs the operator out on any 401. `src/shared/hooks.ts` wraps every endpoint in react-query hooks (`useProjects`, `useProject`, `useManifest`, `useSourcing`, `useApiCosts`, `useKbEntries`, `useSources`, `useTokens`, `useFlags`, `useCapabilities`, mutations for create/seal/lock/resolve/mint/extend/revoke…). The session token is held in React state (login via `POST /admin/operator/session`).

**Capability gating.** `useCapabilities()` reads a `capabilities` object from `GET /restoration/health`. Today's backend health response carries no such object, so every gate (`insights`, 3D/QA/publish/graph in the Model Shop) evaluates to unavailable and the affected screens render named placeholders instead of hiding the missing backend. The Shop Insights screen additionally re-probes health every 60 s so it turns itself on when the endpoint lands.

## Operator console — screen inventory

Routes from `src/operator/OperatorApp.tsx`. Unauthenticated visitors always land on the login screen.

| Path | Screen (spec panel) | Purpose |
|---|---|---|
| `*` (unauthenticated) | **Login** | Operator auth gate; single primary action; honest error strings. |
| `/` | **Job Board** (U1) | Landing. One dominant job-list field + right rail (filters/attention). Job cards with status pip, coverage metrics, needs-attention markers; create-job form; abandon/reopen/export actions on selection; empty state with shot-list guidance; skeleton cards while loading. |
| `/projects/:projectId` | **Job Room** (U2 detail) | Vehicle header, status + coverage + API-cost chips, flags needing attention, sub-navigation into the per-job rooms. |
| `/projects/:projectId/intake` | **Intake Bay** (U2) | Vehicle metadata form, multi-file photo upload, parts-list upload, intake completeness; "Seal intake & identify" action. |
| `/projects/:projectId/manifest` | **Parts Bench** (U3) | The manifest table (criticality, OEM, sourcing status, confidence, review flags). Review-queue drawer for `requires_review` rows; per-row Copilot panel ("why identified", alternatives, sourcing difficulty); "Lock manifest" gated on an empty review queue. |
| `/projects/:projectId/budget` | **Budget Room** (U4, wallet half) | Budget ceiling vs actual spend, API-cost ceiling with per-provider breakdown, coverage summary, ruling display. |
| `/projects/:projectId/sourcing` | **Sourcing Room** (U4, hunt half) | Candidates per part, coverage split (system vs total), best prices, hunt progress; seal/pause/resume actions. |
| `/projects/:projectId/model` | **Model Shop** (U5) | Always-on: manual assembly creation (multipart, ≥1 step), assembly list, token manager (mint / revoke / bulk-revoke / extend), mechanic-flag review drawer. Gated: 3D viewer, QA inspector, publish wizard, graph editor — each names the capability it waits on. |
| `/projects/:projectId/system`, `/engine-room` | **Engine Room** (U7) | Bridge health (`/bridge/health`), module health (`/restoration/health`), capability map. Provider write actions ride the [provider endpoints](API.md#provider-management-fr-050fr-066). |
| `/insights` | **Shop Insights** (U8) | Capability-gated (G-1). Today: make/date filters driven by real closed projects, a ledger placeholder naming what's coming, 60 s retry probe. When the endpoint lands: summary cards + accessible data tables (charts deferred deliberately — tables first for screen readers). |
| `/knowledge` | **Knowledge & Sources** (U3/U4 reference) | KB entries (known parts, OEM numbers) and the source registry (suppliers, trade partners) with CRUD affordances. |
| `*` | **Not found** | Honest 404 inside the shell. |

### Console states and accessibility

Every screen implements the four lifecycle states (loading via `<Skeleton>` rows/cards, empty via `<EmptyState>` naming the next action, error via `<ErrorBanner>` with retry, success transitions). DESIGN.md §6 pins six component states for buttons/inputs/cards/modals/nav/tables/badges/toasts. Accessibility: focus-visible 2 px ring on every interactive element, keyboard-complete navigation, status never conveyed by color alone (badges carry icon + label), WCAG-AA-verified token pairs, `prefers-reduced-motion` honored (opacity-only).

## Bay Guide (U6)

Entry: `GET /guide/{token}` serves the guide shell with `window.__GUIDE_META__ = {"token_id", "assembly_id"}` injected (see [API.md — guide page](API.md#get-guidetoken--bay-guide-token)). The React app (`src/guide/GuideApp.tsx`) validates the bootstrap with zod, extracts the token from the path, and routes inside a HashRouter:

| Hash route | Component | Purpose |
|---|---|---|
| `#/now` | **StepPlayer** | The step-by-step player: visual pane (text-only T4 today — the bundle endpoint is spec-future), caption, tool/part chips, next/back. Step position persisted per token. |
| `#/explore` | **Glossary (explore mode)** | Free-explore placeholder, tier-aware. |
| `#/glossary` | **Glossary** | Plain-language definitions from the bundle's merged glossary. |
| (modal) | **FlagModal** | Flag-a-problem: problem-type select, notes, automatic canvas screenshot, optional camera photo. Queues offline and replays on reconnect. |

### Token-state UX

The app maps backend verdicts to explicit states: 404 "Token not found or revoked", 410 "guide link has expired… content locked but still readable", 429 rate-limit notice, superseded banner when the `X-Guide-Superseded` header is present, offline message when `navigator.onLine` is false. Malformed bundle payloads hit a "degraded" state via zod validation instead of crashing.

### Offline machinery (implemented client-side)

- **IndexedDB** (`src/guide/db.ts`, raw API, no dependency): `guide_state` store holds `{token_id, step_index, bundle_version, updated_at}` — the resume position, with a `localStorage` backup key `rc-guide:{token}:step`; `flag_queue` holds offline flags with `sync_status: pending|synced|failed`. On `online`, queued flags POST sequentially to `/guide/{token}/flags` and are marked synced only on success (that token-scoped route is spec-future — submissions currently fail safe and stay queued).
- **Service worker** (`public/guide-sw.js`, built un-hashed for a stable registration path): cache-first for `/static/restoration/app/*`, network-first for `/guide/*/bundle` and `/guide/*/flags`, version cleanup on activate. Registration requires HTTPS or localhost (FR-063); over plain HTTP the guide is online-only.

## Legacy fallback pages

`orchestrator/ui/web/restoration_copilot.html` (+ `restoration_copilot/job_board.js`, `intake_bay.js`, `shared.js`) and `bay_guide.html` (+ `bay_guide/guide_view.js`), styled by `restoration_styles.css`. These are the functional round-1 surfaces (job board + intake; guide shell with IndexedDB persistence and superseded/expired banners) and are served only when the compiled React build is missing. New work targets the React apps; the legacy pages are kept as the zero-build fallback.

## Design system reference

Everything visual is pinned by [../DESIGN.md](../DESIGN.md) and enforced mechanically:

- **Palette (dark primary):** plum base `#15111B`, elevated `#241B2D`, warm foreground `#FFF5E8`, one coral accent `#FF6B5F`, amber signal `#E6B655`; status colors for running/paused/halted/complete/failed/orphan. A light variant exists for guide readability.
- **Type:** Inter (`@fontsource/inter`, tabular numerals for operational numbers) + JetBrains Mono for IDs/run-ids/tokens; 1.2 modular scale; mobile body 16 px to avoid iOS auto-zoom.
- **Spacing/radii/shadows:** 8 pt spacing scale, one radius scale (4/6/8/12 px), hairline borders preferred over shadows.
- **Motion:** 50/150/200/350 ms durations, two easings, choreographed page entrance, skeletons over spinners for known layouts.
- **Voice:** shop-floor direct — exact numbers, no exclamation, empty states name the next action ("Create job", "Seal intake & identify", "Start hunt", "Mint token").
- **Anti-defaults:** 17 explicit "NOT" patterns (no gradient heroes, no KPI-card rows, no emoji icons, no gray-500-on-gray-50, no pure #000/#FFF…).
- **Audit gates:** `npm run audit:tokens` (raw hex/px/ms ban), `scripts/verify-static-assets.mjs` (frozen brand mark + entry pages), `src/test/brand-assets.test.ts` (byte-identity + served-URL pins).

## Known gaps (honest)

- **Guide bundle data is spec-future.** `GET /guide/{token}/bundle` returns 404 from this backend; the guide app shows its error state. The player shell, persistence, flag queue, and service worker are built and testable.
- **Model Shop 3D/QA/publish/graph sections are gated placeholders** until the Phase-4 backend lands; manual assembly creation posts to `/restoration/projects/{id}/assemblies/manual`, which is also spec-future (404 today).
- **Shop Insights** waits on `GET /restoration/insights`; the filter UI already runs on real closed-project data.
- **Job Board export-artifact action** posts to the spec-future `/export-artifact` route and surfaces the 404 as an error toast.
- **The token rate limiter and provider posture are in-memory** — a server restart resets them (documented in [OPERATIONS.md](OPERATIONS.md#troubleshooting)).
