// Status → visual config. Hue + icon + label, never hue alone (DESIGN.md §6, §9).
// Icons are inline SVG (one set, one stroke weight — Lucide 1.5px-equivalent).

import { ProjectStatus } from "./api-types";

export interface StatusConfig {
  label: string;
  pipColor: string;       // CSS var reference
  softColor: string;      // CSS var reference for soft backgrounds
  icon: string;           // svg path d (24x24 viewBox, stroke)
  attention?: boolean;    // does this status warrant attention marker?
}

const PATHS = {
  draft: "M12 4v16M4 12h16",
  intake: "M4 4h16v16H4z M4 9h16 M9 4v16",
  scan: "M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2",
  hunt: "M12 2a10 10 0 1 0 10 10 M12 2a10 10 0 0 1 10 10 M2 12h20",
  sealed: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  wrench: "M14.7 6.3a4 4 0 0 0-5.7 5.7L3 18v3h3l6-6a4 4 0 0 0 5.7-5.7l-2.4 2.4-2.3-.6-.6-2.3z",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18 M6 6l12 12",
  alert: "M12 9v4 M12 17h.01 M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z",
};

export const STATUS_CONFIG: Record<ProjectStatus, StatusConfig> = {
  draft: {
    label: "Draft",
    pipColor: "var(--status-halted)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.draft,
  },
  intake_open: {
    label: "Intake open",
    pipColor: "var(--status-running)",
    softColor: "var(--status-running-soft)",
    icon: PATHS.intake,
  },
  intake_sealed: {
    label: "Intake sealed",
    pipColor: "var(--status-paused)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.sealed,
  },
  identifying: {
    label: "Identifying",
    pipColor: "var(--status-running)",
    softColor: "var(--status-running-soft)",
    icon: PATHS.scan,
  },
  review_open: {
    label: "Review open",
    pipColor: "var(--status-paused)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.check,
  },
  manifest_locked: {
    label: "Manifest locked",
    pipColor: "var(--status-paused)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.sealed,
  },
  budget_ruled: {
    label: "Budget ruled",
    pipColor: "var(--status-paused)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.sealed,
  },
  hunting: {
    label: "Hunting",
    pipColor: "var(--status-running)",
    softColor: "var(--status-running-soft)",
    icon: PATHS.hunt,
    attention: true,
  },
  sourcing_insufficient: {
    label: "Sourcing insufficient",
    pipColor: "var(--signal-amber)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.alert,
    attention: true,
  },
  hunt_sealed: {
    label: "Hunt sealed",
    pipColor: "var(--status-paused)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.sealed,
  },
  meshing: {
    label: "Meshing",
    pipColor: "var(--status-running)",
    softColor: "var(--status-running-soft)",
    icon: PATHS.scan,
  },
  graph_review: {
    label: "Graph review",
    pipColor: "var(--status-paused)",
    softColor: "var(--status-paused-soft)",
    icon: PATHS.check,
  },
  published: {
    label: "Published",
    pipColor: "var(--status-complete)",
    softColor: "var(--status-complete-soft)",
    icon: PATHS.check,
  },
  in_service: {
    label: "In service",
    pipColor: "var(--status-complete)",
    softColor: "var(--status-complete-soft)",
    icon: PATHS.wrench,
  },
  closed: {
    label: "Closed",
    pipColor: "var(--status-complete)",
    softColor: "var(--status-complete-soft)",
    icon: PATHS.check,
  },
  abandoned: {
    label: "Abandoned",
    pipColor: "var(--status-failed)",
    softColor: "var(--status-failed-soft)",
    icon: PATHS.x,
  },
};

export function statusOf(status: string): StatusConfig {
  return (STATUS_CONFIG as Record<string, StatusConfig>)[status] ?? {
    label: status || "Unknown",
    pipColor: "var(--status-orphan)",
    softColor: "var(--status-failed-soft)",
    icon: PATHS.alert,
  };
}

export const ATTENTION_ICON = PATHS.alert;

// Spec §8.0: the linear status ladder. Used by tab-gating and manifest-lock checks.
export const STATUS_ORDER: ProjectStatus[] = [
  "draft", "intake_open", "intake_sealed", "identifying", "review_open",
  "manifest_locked", "budget_ruled", "hunting", "sourcing_insufficient",
  "hunt_sealed", "meshing", "graph_review", "published", "in_service", "closed",
];

export function statusAtOrPast(status: ProjectStatus, gate: ProjectStatus): boolean {
  const si = STATUS_ORDER.indexOf(status);
  const gi = STATUS_ORDER.indexOf(gate);
  return si >= 0 && gi >= 0 && si >= gi;
}
