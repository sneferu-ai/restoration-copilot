// Shared hooks — offline composite (D18/OBL-4), read-only latch (§8.4/OBL-22),
// next-action engine (§6.0 layer 1), contextual alerts (§6.0 layer 2).

import { createContext, useContext, useEffect, useState } from "react";
import type React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api-client";
import { keys } from "./keys";
import type { BiasingContext, HealthResponse, KBEntry, RestorationProject } from "./types";

/** D18: navigator.onLine AND last health-check success within 10 seconds. */
export function useOfflineState(): boolean {
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [lastHealthOk, setLastHealthOk] = useState<number>(Date.now());
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const tick = setInterval(() => setNow(Date.now()), 2000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(tick);
    };
  }, []);

  const health = useQuery({
    queryKey: keys.health(),
    queryFn: () => api<HealthResponse>("/restoration/health"),
    refetchInterval: 10000,
    retry: 1,
  });

  useEffect(() => {
    if (health.isSuccess) setLastHealthOk(Date.now());
  }, [health.isSuccess, health.dataUpdatedAt]);

  const healthFresh = now - lastHealthOk < 10000;
  return !online || !healthFresh;
}

const ReadOnlyContext = createContext<boolean>(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/** §8.4: latches on os_not_supported from mutation errors or offline state;
 *  resets on a successful health check (OBL-22 explicit hook export above). */
export function ReadOnlyProvider({ children }: { children: React.ReactNode }) {
  const [readOnly, setReadOnly] = useState(false);
  const queryClient = useQueryClient();
  const isOffline = useOfflineState();

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event?.type !== "updated") return;
      const error = event.mutation.state.error;
      if (error instanceof ApiError && error.code === "os_not_supported") {
        setReadOnly(true);
      }
    });
  }, [queryClient]);

  useEffect(() => {
    if (isOffline) setReadOnly(true);
  }, [isOffline]);

  const { data: health } = useQuery({
    queryKey: keys.health(),
    queryFn: () => api<HealthResponse>("/restoration/health"),
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (readOnly && health?.os_supported === true && !isOffline) setReadOnly(false);
  }, [health, readOnly, isOffline]);

  return <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>;
}

export interface NextAction {
  label: string;
  to?: string;
  reason: string;
}

/**
 * §6.0 Layer 1 — deterministic state-machine lookup. Workflow guidance, not
 * AI: the next required action per status, rendered as the single visible CTA.
 * `details` (review/sourcing counts) upgrades generic messages inside JobRoom.
 */
export function useNextAction(
  project: RestorationProject | undefined,
  details?: { openReviews?: number; sourcingCoverage?: number | null },
): NextAction | null {
  if (!project) return null;
  if (project.parked) {
    return { label: "Unpark job", reason: project.parked_reason ?? "Parked by operator" };
  }
  const base = `#/jobs/${project.project_id}`;
  switch (project.status) {
    case "draft":
      return { label: "Open intake", to: `${base}/intake`, reason: "Photos and a parts list get this job moving." };
    case "intake_open":
      return { label: "Upload photos", to: `${base}/intake`, reason: "Six accepted photos are required to seal intake." };
    case "intake_sealed":
      return { label: "Run identification", to: `${base}/intake`, reason: "Intake is sealed — identify parts next." };
    case "identifying":
      return { label: "Identification running", reason: "The identify task is in flight; results land in review." };
    case "review_open": {
      const n = details?.openReviews;
      return {
        label: n ? `Resolve ${n} review${n === 1 ? "" : "s"}` : "Resolve reviews",
        to: `${base}/manifest`,
        reason: "Unreviewed identifications block the manifest lock.",
      };
    }
    case "manifest_locked":
      return { label: "Set budget", to: `${base}/budget`, reason: "The manifest is frozen — rule the ceiling." };
    case "budget_ruled":
      return { label: "Start hunt", to: `${base}/budget`, reason: "Budget is ruled — source the parts." };
    case "hunting":
      return {
        label: "Review sourcing",
        to: `${base}/budget`,
        reason:
          details?.sourcingCoverage != null
            ? `Hunt running — ${details.sourcingCoverage.toFixed(0)}% coverage so far.`
            : "The sourcing hunt is in flight.",
      };
    case "sourcing_insufficient":
      return { label: "Fix coverage or seal partial", to: `${base}/budget`, reason: "Coverage is below the floor — add candidates or accept partial." };
    case "hunt_sealed":
      return { label: "Generate 3D", to: `${base}/assembly`, reason: "Sourcing is sealed — build the assembly guidance." };
    case "meshing":
      return { label: "3D generation running", reason: "Mesh generation is in flight." };
    case "graph_review":
      return { label: "Review assembly graph", to: `${base}/assembly`, reason: "Approve the step graph to publish." };
    case "published":
      return { label: "Go in-service", to: `${base}/system`, reason: "The guide is live — close the loop when the vehicle ships." };
    case "in_service":
      return { label: "Close job", to: `${base}/system`, reason: "Vehicle is in service." };
    case "closed":
      return null;
    case "abandoned":
      return null;
    default:
      return null;
  }
}

export interface Alert {
  severity: "info" | "warn" | "critical";
  title: string;
  body?: string;
}

/** §6.0 Layer 2 — arithmetic over already-loaded data. Calculation-based
 *  notifications, not intelligent insights. */
export function useCopilotAlerts(projects: RestorationProject[] | undefined): Alert[] {
  if (!projects) return [];
  const alerts: Alert[] = [];
  const attention = projects.filter((p) => p.needs_attention != null && !p.parked);
  if (attention.length) {
    const names = attention
      .slice(0, 4)
      .map((p) =>
        [p.vehicle_meta.year, p.vehicle_meta.make, p.vehicle_meta.model].filter(Boolean).join(" "),
      )
      .filter(Boolean)
      .join(", ");
    alerts.push({
      severity: "warn",
      title: `${attention.length} project${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} attention`,
      body: names || undefined,
    });
  }
  for (const p of projects) {
    if (p.api_cost_ceiling_usd > 0 && p.api_cost_to_date_usd / p.api_cost_ceiling_usd >= 0.8) {
      alerts.push({
        severity: p.api_cost_to_date_usd >= p.api_cost_ceiling_usd ? "critical" : "warn",
        title: `API cost at ${Math.round((p.api_cost_to_date_usd / p.api_cost_ceiling_usd) * 100)}% of ceiling`,
        body: [p.vehicle_meta.year, p.vehicle_meta.make, p.vehicle_meta.model].filter(Boolean).join(" ") || p.project_id,
      });
    }
  }
  return alerts;
}

export interface StaleKbWarningState {
  oemMismatch: boolean;
  lowAgreement: boolean;
  staleEntry: boolean;
  kbOem: string | null;
  identifiedOem: string | null;
  agreementRate: number | null;
  kbEntryAgeDays: number | null;
  hasWarnings: boolean;
}

/**
 * §6.0 Layer 3 — Stale-KB warning. Basic referential integrity: primary-key
 * (OEM number) comparison and timestamp checks, not ML or pattern detection
 * (OBL-66). Computed from already-loaded data — no new endpoints.
 */
export function useStaleKbWarning(
  kbEntry: KBEntry | null | undefined,
  identifiedOem: string | null | undefined,
  biasingContext: BiasingContext | null | undefined,
): StaleKbWarningState {
  const kbOem = kbEntry?.oem_number ?? null;
  const oemMismatch =
    kbOem != null &&
    kbOem.trim() !== "" &&
    identifiedOem != null &&
    identifiedOem.trim() !== "" &&
    kbOem.trim().toUpperCase() !== identifiedOem.trim().toUpperCase();

  const agreementRate = biasingContext?.agreement_rate ?? null;
  const lowAgreement = agreementRate != null && agreementRate < 0.5;

  const kbUpdated = kbEntry?.updated_at ? new Date(kbEntry.updated_at).getTime() : null;
  const kbEntryAgeDays = kbUpdated != null && Number.isFinite(kbUpdated)
    ? Math.floor((Date.now() - kbUpdated) / (24 * 3600 * 1000))
    : null;
  // §6.0: entry older than 365 days, or no timestamp → stale.
  const staleEntry = kbUpdated == null || (kbEntryAgeDays != null && kbEntryAgeDays > 365);

  const hasWarnings = oemMismatch || lowAgreement || staleEntry;

  return {
    oemMismatch,
    lowAgreement,
    staleEntry,
    kbOem,
    identifiedOem: identifiedOem ?? null,
    agreementRate,
    kbEntryAgeDays,
    hasWarnings,
  };
}
