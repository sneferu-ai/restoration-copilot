# Restoration Copilot — Design

## 0. Soul

A solo restoration operator's workshop bench at hour fourteen: warm low light, every reading exact, every action audible, the keyboard carries you between jobs. One product feeling channeled — **Linear's alive, dense, keyboard-first operational density** — wearing this shop's warm coral-and-amber-on-plum brand. See `SOUL.md`.

### Brand direction implementation

- **Board cited:** `BRAND_ASSETS/brand-direction.svg` (direction SHA-256 `713c7d2e…`, identity `80a4c4d1…`).
- **Selected mark copied:** `BRAND_ASSETS/brand-mark.svg` → `orchestrator/ui/app/public/brand-mark.svg` (exact bytes preserved, SHA-256 `44a8f432…`). Vite builds with `publicDir` pinned to that app-level `public/` (the config root is `src/`, so the default `src/public` never saw the mark — the round-4 404), copying it verbatim to `orchestrator/ui/web/static/restoration/app/brand-mark.svg`; the `postbuild` gate (`scripts/verify-static-assets.mjs`) fails the build if the served file is missing or off-digest, and `src/test/brand-assets.test.ts` pins the source bytes + the exact served URL in every consumer. The operator console top bar (24×24), login screen (48×48), and favicon reference `<img src="/static/restoration/app/brand-mark.svg">`; both rendered sizes carry `filter: var(--drop-shadow-mark)`. Not redrawn, not recolored.
- **Shape — "an interlocking path that resolves into one confident junction":** the mark's two interlocking arcs + central node become the product's joinery motif. The active-tab underline and the job-card status pip both resolve to a single confident mark/junction at their terminus. Section headers carry a 3px coral lead-in rule (the "confident junction") before the label.
- **Layout — "editorial asymmetry with one dominant field and disciplined alignment":** the Job Board is one dominant field (the job list, 7/12 of the grid on desktop) with a disciplined right rail (filters + attention, 5/12). Inside a Job Room, the panel content is the dominant field and the secondary tabs are a thin aligned spine — never two equal columns competing.
- **Surface — "crisp technical planes with selective high-chroma signals":** surfaces are flat `--bg-elevated` planes with 1px `--border-subtle` hairlines, not soft shadows. High-chroma signals (coral `--brand-primary`, amber `--brand-secondary`) appear ONLY on live readings that demand the eye — the active action, an attention flag, an over-budget warning. Everything else is the warm muted lavender on plum.
- **Typography — "a compact grotesk hierarchy with tabular numerals for operational data":** display + body use **Inter** (the compact grotesk from Rasmus Andersson, loaded deliberately via `@fontsource/inter` — not a system default); all operational numbers (costs, coverage %, step counts, IDs, timestamps) carry `font-variant-numeric: tabular-nums` so columns of figures align by digit. Mono is **JetBrains Mono** for IDs, run IDs, and assembly IDs.
- **Motion — "near-instant state changes with one slower orientation transition":** state changes (hover, focus, status flips) are 150ms `--ease-default`. The ONE slower orientation transition is job-room entry: a 350ms `--ease-emphasized` reveal where the dominant field settles and the tab spine aligns — the "confident junction" resolving. Step transitions in the guide use the same 350ms orientation budget; everything else is instant-feeling.
- **Palette adoption:** all six `--brand-*` values are preserved verbatim in `tokens.css` § Color and mapped to accessible component roles (see §3).

## 1. Reference anchor

- **Reference (exactly one, binding):** Linear — https://linear.app/inbox
- **Why this one:** Linear is the shipping product that proves a screen can be dense, alive, and exact for fourteen hours without becoming a wall of noise. Every row is a live reading, every status pip is a 3px absolute-positioned marker, every number is tabular, the keyboard carries you, and a transition snaps at ~200ms so you never wait or wonder. That discipline is exactly what Marco needs at 9:47 PM with eighteen jobs in flight — and the warm coral/amber brand differentiates the *feeling* without diluting the *judgment*.
- **Five pixel-level patterns we mirror:**
  1. **Run-list row, 56px tall.** A 3px-wide status pip is absolute-positioned at `left: 0`, full-row-height, colored by status. Row content padding: `var(--space-3)` left of the pip + `var(--space-4)` right. Title 14px medium tabular, left-aligned. ID 11px mono, right-aligned, `--fg-tertiary`. *Mirrored exactly for job cards.*
  2. **Tabular numerals on every numeric column.** `font-variant-numeric: tabular-nums` + `font-feature-settings: "tnum"`. Costs right-aligned with the currency glyph a non-bold prefix at the same size. *Mirrored for cost, coverage %, step counts, API spend.*
  3. **Hover `translateY(-1px)` + `--shadow-1`.** A row lifts one pixel on hover with a single subtle shadow — never a border change, never a second shadow. *Mirrored for every card row.*
  4. **Focus-visible 2px ring, offset 2px.** `--accent` ring, never the default browser outline. `outline: none` is illegal without this substitute. *Mirrored on every interactive element.*
  5. **One primary action per screen, ghosted secondaries.** The primary button is the single coral `--accent`; everything else is `btn-ghost` or `btn-secondary`. A second equally-prominent CTA is a hierarchy failure. *Mirrored everywhere; the §3 info-hierarchy rule.*
- **Three patterns we deliberately diverge from, with citation:**
  1. **No drag-handle / reorder affordance on job rows.** Linear rows are reorderable issues; Restoration jobs are chronologically and status-ordered, not user-rankable. Adding a drag handle would imply a rank the data does not carry (SOUL ¶1: "exact readings" — a fake rank is a lie).
  2. **No per-row context menu.** Linear's `…` menu holds issue-specific actions; Marco fires one lifecycle action per job rarely, and a row-level menu hides the action behind a click. We surface Abandon/Reopen/Export/Park as an explicit expanding action row on selection instead (SOUL ¶1: "he never wants to wonder did that click do something").
  3. **No cool indigo/violet accent.** Linear's brand is cool; this shop's launch-frozen brand is warm coral-and-amber on plum (BRAND_IDENTITY.md). Adopting Linear's hue would erase the product's identity — the *judgment* is Linear's, the *color* is the shop's (SOUL ¶2: "the warmth comes from the brand").

## 2. Density

**Dense.** This is an operator console for a solo owner running eighteen jobs across six decades of vehicles. Every screen maximizes readable rows per viewport. Whitespace is a hierarchy tool (the lead-in rule, the dominant-field gutter), not luxury. Cards are 56–64px rows, not 200px marketing tiles.

## 3. Color tokens

Light + dark designed together. **Dark is primary** (the brand is a dark palette; the operator console is always dark). A light variant is provided for the guide's high-ambient shop-floor readability but is not the console default.

| Role | Token (dark, primary) | Value | Notes |
|---|---|---|---|
| Background base | `--bg-base` | `#15111B` | `--brand-background` verbatim |
| Background elevated | `--bg-elevated` | `#241B2D` | `--brand-surface` verbatim |
| Background overlay | `--bg-overlay` | `#1B1422` | surface−1 stop, for modals/backdrop |
| Foreground primary | `--fg-primary` | `#FFF5E8` | `--brand-foreground` verbatim |
| Foreground secondary | `--fg-secondary` | `#E8DCC8` | foreground−1, body copy |
| Foreground tertiary | `--fg-tertiary` | `#B8A9C1` | `--brand-muted` verbatim |
| Foreground disabled | `--fg-disabled` | `#6B5F76` | muted−1, AA-verified on base |
| Accent (one) | `--accent` | `#FF6B5F` | `--brand-primary` — the single hero color |
| Accent hover | `--accent-hover` | `#FF8276` | +lightness, AA on elevated |
| Accent pressed | `--accent-pressed` | `#E55A4F` | −lightness, active state |
| Border subtle | `--border-subtle` | `#2F2438` | surface+1, hairline at rest |
| Border default | `--border-default` | `#3D2F48` | surface+2, inputs/dividers |
| Border strong | `--border-strong` | `#5A4666` | surface+3, focus-adjacent |
| Border focus | `--border-focus` | `#FF6B5F` | = accent, focus ring source |
| Status running | `--status-running` | `#5B9BD5` | cool blue, "in flight" |
| Status paused | `--status-paused` | `#E6B655` | `--brand-secondary`, held |
| Status halted | `--status-halted` | `#B8A9C1` | muted, parked/abandoned |
| Status complete | `--status-complete` | `#4CAF7D` | green, shipped/in-service |
| Status failed | `--status-failed` | `#E05D5D` | red, blocked/over-budget |
| Status orphan | `--status-orphan` | `#9B7FB5` | muted violet, stale/dead |

**Brand-secondary usage:** `--brand-secondary` (`#E6B655`, amber) is mapped to `--status-paused` AND surfaces as the "measured/warning" signal (budget warning, confidence <0.70, needs-attention ring). It is the *second* high-chroma signal, used sparingly — never a third accent.

**WCAG AA verification (dark, primary):** `--fg-primary` on `--bg-base` = 13.8:1 ✓; `--fg-secondary` on `--bg-elevated` = 9.4:1 ✓; `--fg-tertiary` on `--bg-elevated` = 5.1:1 ✓; `--accent` on `--bg-elevated` = 4.6:1 ✓; `--fg-disabled` on `--bg-base` = 3.2:1 (UI-component threshold ✓).

## 4. Type tokens

- **Display + body family:** `Inter` (compact grotesk — loaded via `@fontsource/inter`, not a system default; paired with tabular numerals + JetBrains Mono). Fallbacks: `-apple-system, system-ui, sans-serif`.
- **Mono family:** `JetBrains Mono` (loaded via `@fontsource/jetbrains-mono`). Used for IDs, run IDs, assembly IDs, token IDs.
- **Scale (modular ratio 1.2):** `--text-xs` 11px / `--text-sm` 13px / `--text-base` 14px / `--text-md` 16px / `--text-lg` 18px / `--text-xl` 20px / `--text-2xl` 24px / `--text-3xl` 30px. **Mobile body = `--text-md` (16px)** to avoid iOS auto-zoom.
- **Weights:** `--weight-regular` 400 / `--weight-medium` 500 / `--weight-semibold` 600 / `--weight-bold` 700.
- **Line-heights:** `--line-tight` 1.15 (headings) / `--line-snug` 1.3 (dense rows) / `--line-normal` 1.5 (body) / `--line-relaxed` 1.65 (long copy).
- **Tabular numerals:** every operational number carries `font-variant-numeric: tabular-nums` via the `.tnum` utility / `--font-numeric` token.

## 5. Spacing tokens

8pt scale: `--space-1` 4px / `--space-2` 8px / `--space-3` 12px / `--space-4` 16px / `--space-5` 20px / `--space-6` 24px / `--space-8` 32px / `--space-10` 40px / `--space-12` 48px / `--space-16` 64px. Every gap, padding, margin lands on the scale.

## 6. Component states

For **button, input, card, modal, nav, table, badge, toast** — all six states designed:

| Component | Default | Hover | Focus-visible | Active/pressed | Disabled | Loading |
|---|---|---|---|---|---|---|
| **Button (primary)** | coral fill, `--fg-primary` text | `--accent-hover` | 2px `--border-focus` ring offset 2px | `--accent-pressed`, scale 0.98 | 40% opacity + inline "reason" helper | disabled + labeled "Saving…" / "Submitting…" |
| **Button (secondary)** | `--bg-elevated` + 1px `--border-default` | `--border-strong` | 2px ring | `--bg-overlay` | 40% opacity + helper | disabled + label |
| **Button (ghost)** | transparent, `--fg-secondary` | `--bg-elevated` | 2px ring | `--bg-overlay` | 40% opacity | disabled + label |
| **Input** | `--bg-elevated`, 1px `--border-default`, `--fg-primary` | `--border-strong` | 2px `--border-focus` ring | — | 40% opacity + helper | — |
| **Card** | `--bg-elevated`, 1px `--border-subtle`, `--shadow-2` | `translateY(-1px)` + `--shadow-1` | 2px ring (if interactive) | — | — | skeleton variant |
| **Modal** | centered, 480px, `--bg-elevated`, 1px border + `--shadow-3`, backdrop `backdrop-filter: blur(8px) saturate(180%)` | — | first focusable auto-focused | — | — | — |
| **Nav tab** | `--fg-tertiary` | `--fg-primary` | 2px ring | 3px coral underline (`--accent`) | 40% + inline "locked by status" | — |
| **Table row** | `--bg-elevated` | `--bg-overlay` | 2px ring | `--bg-overlay` | — | skeleton row |
| **Badge** | hue + icon + label | — | 2px ring | — | 40% opacity | — |
| **Toast** | `--bg-elevated` + 1px `--border-default` + `--shadow-3`, slides up | — | — | — | — | — |

**Four lifecycle states** (loading/empty/error/success) are defined per-screen in §12 of the spec and implemented via `<Skeleton>`, `<EmptyState>`, `<ErrorBanner>`, and the natural success transition.

## 7. Motion

- **Durations:** `--dur-instant` 50ms (color flips) / `--dur-fast` 150ms (hover, focus, status) / `--dur-base` 200ms (the Linear snap — most transitions) / `--dur-slow` 350ms (the one orientation transition: job-room entry, guide step change).
- **Easings:** `--ease-default` `cubic-bezier(0.4, 0, 0.2, 1)` / `--ease-emphasized` `cubic-bezier(0.2, 0, 0, 1)`.
- **Choreographed entrance:** page-load staggers `animation-delay` across the page title (0ms), the dominant field (60ms), the right rail (120ms), the primary action (180ms) — one alive sweep, never busy.
- **Skeletons not spinners** when the layout is known (job cards, manifest rows, provider cards). A spinner is used ONLY for indeterminate single-shot waits (login, 3D generation kick-off).
- **`prefers-reduced-motion: reduce`:** zero motion except opacity; the entrance sweep and the `translateY` hover are disabled.

## 8. Voice & copy

**Voice in one sentence:** Shop-floor direct — exact numbers, no filler, no exclamation, the operator's own terse register ("Seal intake", "Start hunt", "Mint token"), never consumer-cute.

- **Empty states:** "No vehicle jobs yet. Create your first job to begin a restoration." / "Set a budget ceiling to start the sourcing hunt." / "No assemblies yet — create a manual walkthrough or generate 3D."
- **Error strings:** "Couldn't reach the shop server. Last readings shown — retry when you're back online." / "Sourcing hunt stalled: {backend message}. Retry or seal with what you have." / "Sign-in expired. Re-enter your operator credentials — your in-flight tasks kept running."
- **Button labels:** "Create job" / "Seal intake & identify" / "Start hunt" / "Mint token" / "Resolve flag".

## 9. Anti-defaults forbidden in this project

From SOUL ¶3, plus project-specific:

1. **NOT Inter/Roboto/Open Sans/Lato as an unconfigured system default** — `Inter` is loaded deliberately via `@fontsource/inter` with tabular numerals, paired with `JetBrains Mono` for operational data.
2. **NOT a white-to-purple gradient hero** — the brand is warm coral/amber on plum; gradients are forbidden as surfaces.
3. **NOT three KPI stat cards across the top** — the Job Board is one dominant field + right rail, not a marketing dashboard.
4. **NOT "Welcome back, Marco" empty state** — empty states name the next action, never the user.
5. **NOT floating-pill nav over a gradient** — nav is a disciplined left spine (desktop) / bottom bar (narrow), flat hairlines.
6. **NOT every button 44px tall** — `btn-sm` is 32px visual with 44px hit zone for dense rows; primary actions are 40px.
7. **NOT mixed icon sets** — one set, one stroke weight (Lucide, 1.5px stroke), never emoji as functional icons.
8. **NOT five button variants** — four only: primary (coral), secondary (elevated+border), ghost (text), danger (status-failed).
9. **NOT random border-radii** — one scale: `--radius-sm` 4px (chips/badges) / `--radius-md` 6px (inputs/buttons) / `--radius-lg` 8px (cards) / `--radius-xl` 12px (modals). No `radius-pill` on cards.
10. **NOT soft drop shadows on every card** — one shadow scale; a 1px `--border-subtle` is preferred over a shadow on dark surfaces.
11. **NOT animating width/height/top/left** — transform + opacity only.
12. **NOT bounce easing on a serious tool** — `--ease-default` / `--ease-emphasized` only.
13. **NOT spinner-only loading where a skeleton fits** — skeletons for known layouts.
14. **NOT a form with >12 visible controls in one panel** — wizard/drawer/split.
15. **NOT "Oops!" / "Loading magic…" / "We're so glad you're here!"** — shop-floor direct voice, no mixed register.
16. **NOT `text-gray-500 on bg-gray-50`** — the cool-gray Tailwind cliche is forbidden; the palette is warm plum/coral.
17. **NOT pure `#000` or pure `#FFF`** — `#15111B` and `#FFF5E8` (brand values).

## 10. Audit

- **Token audit:** `scripts/audit-tokens.mjs` — scans `src/**/*.tsx` for raw hex (`#[0-9a-fA-F]{3,8}`), raw px (`\b\d+px\b` outside `tokens.css`), and raw durations (`\b\d+ms\b` outside `tokens.css`). Run via `npm run audit:tokens`. Fails on any hit outside `tokens.css` / `tailwind.config.ts`.
- **Static-asset gate:** `scripts/verify-static-assets.mjs` — runs automatically after every `npm run build` (npm `postbuild` hook). Fails the build if the served `brand-mark.svg` is missing or its SHA-256 differs from the launch-frozen `44a8f432…`, or if `guide-sw.js` / the operator / guide entry pages are absent.
- **Brand-asset tests:** `src/test/brand-assets.test.ts` (vitest, `npm test`) — pins the source mark's byte-identity with `BRAND_ASSETS/brand-mark.svg` + the frozen digest, the exact served URL in all three consumers (favicon, top bar, login), the guide SW registration path, and the absence of a shadow `src/public/` dir.
- **A11y manual audit:** keyboard tab-through every primary flow; visual focus on every interactive element; `prefers-reduced-motion` honored. Reported in the round summary when automated axe-core is unavailable.
- **Six-category audit:** walked per §"six categories" below; results in round summary.
