// Shared constants — single source for tenant scoping, session keys, and the
// status → action gating matrix (SPEC §9). The matrix is hand-mirrored from the
// spec table; the generated transitionMap.ts (spec §4.3 step 8) replaces it.

export const TENANT_ID = "shop-001";
export const SESSION_KEY = `restoration.${TENANT_ID}.operatorSession`;
export const INTENDED_ROUTE_KEY = "restoration.intendedRoute";

export interface StatusMeta {
  label: string;
  tone: "accent" | "ok" | "signal" | "muted" | "faint";
  hint: string;
}

// Hue + label, never hue alone (DESIGN.md §3).
export const STATUS_META: Record<string, StatusMeta> = {
  draft: { label: "Draft", tone: "faint", hint: "Created, intake not open" },
  intake_open: { label: "Intake open", tone: "accent", hint: "Photos and parts list accepted" },
  intake_sealed: { label: "Intake sealed", tone: "accent", hint: "Ready for identification" },
  identifying: { label: "Identifying", tone: "accent", hint: "Part identification running" },
  review_open: { label: "Review open", tone: "accent", hint: "Identifications awaiting review" },
  manifest_locked: { label: "Manifest locked", tone: "ok", hint: "Parts list frozen" },
  budget_ruled: { label: "Budget ruled", tone: "ok", hint: "Ceiling set and ruled" },
  hunting: { label: "Hunting", tone: "accent", hint: "Sourcing hunt running" },
  sourcing_insufficient: { label: "Sourcing short", tone: "signal", hint: "Coverage below floor" },
  hunt_sealed: { label: "Hunt sealed", tone: "ok", hint: "Sourcing sealed by operator" },
  meshing: { label: "Meshing", tone: "accent", hint: "3D generation running" },
  graph_review: { label: "Graph review", tone: "accent", hint: "Assembly graph under review" },
  published: { label: "Published", tone: "ok", hint: "Guide bundle live" },
  in_service: { label: "In service", tone: "ok", hint: "Vehicle back on the road" },
  closed: { label: "Closed", tone: "faint", hint: "Job complete" },
  abandoned: { label: "Abandoned", tone: "signal", hint: "Job abandoned" },
};

export function statusMeta(status: string): StatusMeta {
  return (
    STATUS_META[status] ?? {
      label: status.replace(/_/g, " "),
      tone: "muted",
      hint: "Custom status",
    }
  );
}

// SPEC §9 Status → Action Matrix (console gating). Export is omitted: the
// endpoint is PHASE-PENDING and renders disabled-with-tooltip everywhere.
export type LifecycleAction =
  | "seal_intake"
  | "lock_manifest"
  | "set_budget"
  | "start_hunt"
  | "seal_sourcing"
  | "generate_3d"
  | "publish"
  | "go_in_service"
  | "abandon"
  | "reopen"
  | "park";

const ALL_PARKABLE = new Set([
  "draft",
  "intake_open",
  "intake_sealed",
  "identifying",
  "review_open",
  "manifest_locked",
  "budget_ruled",
  "hunting",
  "sourcing_insufficient",
  "hunt_sealed",
  "meshing",
  "graph_review",
  "published",
  "in_service",
]);

const MATRIX: Record<string, Set<LifecycleAction>> = {
  review_open: new Set<LifecycleAction>(["lock_manifest"]),
  manifest_locked: new Set<LifecycleAction>(["set_budget"]),
  budget_ruled: new Set<LifecycleAction>(["set_budget", "start_hunt"]),
  hunting: new Set<LifecycleAction>(["seal_sourcing"]),
  sourcing_insufficient: new Set<LifecycleAction>(["start_hunt", "seal_sourcing"]),
  hunt_sealed: new Set<LifecycleAction>(["generate_3d"]),
  graph_review: new Set<LifecycleAction>(["generate_3d", "publish"]),
  published: new Set<LifecycleAction>(["go_in_service"]),
};

export function allowedActions(status: string, parked: boolean): Set<LifecycleAction> {
  const actions = new Set<LifecycleAction>(MATRIX[status] ?? []);
  if (status === "closed" || status === "abandoned") {
    actions.add("reopen");
  } else {
    actions.add("abandon");
    if (ALL_PARKABLE.has(status)) actions.add("park");
  }
  if (parked) actions.delete("park"); // unpark offered separately
  return actions;
}

export const STATUS_ORDER: string[] = [
  "draft",
  "intake_open",
  "intake_sealed",
  "identifying",
  "review_open",
  "manifest_locked",
  "budget_ruled",
  "hunting",
  "sourcing_insufficient",
  "hunt_sealed",
  "meshing",
  "graph_review",
  "published",
  "in_service",
  "closed",
  "abandoned",
];

export const API_COST_WARN_RATIO = 0.8;
