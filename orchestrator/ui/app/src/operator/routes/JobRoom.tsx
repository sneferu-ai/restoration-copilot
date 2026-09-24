// U2 — Job Room. The detail view for a single restoration project.
// Shows vehicle header, status + coverage, and sub-navigation to intake,
// manifest, sourcing. Lists flags (problems that need operator attention).

import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useProject, useFlags, useApiCosts } from "@/shared/hooks";
import { useSession } from "@/shared/session";
import { useToast } from "@/shared/ui/Toast";
import { Card } from "@/shared/ui/Card";
import { Badge, StatusPip } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { statusOf, statusAtOrPast } from "@/shared/status";
import { usd, pct, shortId, vehicleTitle, datetime, dateOnly } from "@/shared/format";
import type { Flag, ProjectStatus } from "@/shared/api-types";

// Spec §8.0: "secondary tabs (Intake → Manifest → Budget → Model → System).
// Tabs disabled by status; disabled tabs show inline helper text."

interface TabDef {
  to: string;
  label: string;
  icon: string;
  gate?: ProjectStatus;
  disabledReason?: string;
}

const TABS: TabDef[] = [
  { to: "intake", label: "Intake", icon: ICONS.clipboard },
  { to: "manifest", label: "Parts manifest", icon: ICONS.package, gate: "intake_sealed", disabledReason: "Seal the intake to start the identification scan." },
  { to: "budget", label: "Budget", icon: ICONS.bolt, gate: "manifest_locked", disabledReason: "The parts manifest must be locked before budget ruling." },
  { to: "sourcing", label: "Sourcing", icon: ICONS.search, gate: "budget_ruled", disabledReason: "The budget must be ruled before the sourcing hunt begins." },
  { to: "model", label: "3D model", icon: ICONS.layers, gate: "hunt_sealed", disabledReason: "Sourcing must be sealed before 3D model generation." },
  { to: "system", label: "System", icon: ICONS.wrench, gate: "published", disabledReason: "System health is available after the job is published." },
];

export function JobRoom() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const flags = useFlags(projectId);
  const apiCosts = useApiCosts(projectId);
  const navigate = useNavigate();
  const { token } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [exporting, setExporting] = useState(false);

  async function parkAction(endpoint: "park" | "unpark", reason?: string) {
    if (!projectId) return;
    try {
      const res = await fetch(`/restoration/projects/${projectId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(reason ? { reason } : {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.push("info", endpoint === "park" ? "Job parked." : "Job unpaused.");
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : `Couldn't ${endpoint} the job.`);
    }
  }

  async function reopenAction() {
    if (!projectId) return;
    try {
      const res = await fetch(`/restoration/projects/${projectId}/reopen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.push("info", "Job reopened.");
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't reopen the job.");
    }
  }

  async function exportPdf() {
    if (!projectId) return;
    setExporting(true);
    try {
      const res = await fetch(`/restoration/projects/${projectId}/export-artifact`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      const contentType = res.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/pdf")) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${projectId}-report.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.push("success", "Report downloaded.");
      } else {
        const data = await res.json().catch(() => null);
        if (data?.download_url) {
          window.open(data.download_url, "_blank", "noopener,noreferrer");
          toast.push("success", "Report opened in a new tab.");
        } else {
          toast.push("info", "Export queued. Check back shortly.");
        }
      }
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't export the report.");
    } finally {
      setExporting(false);
    }
  }

  if (project.isLoading) {
    return (
      <div className="flex flex-col gap-4" style={{ padding: "var(--space-6)" }} aria-live="polite" aria-busy="true">
        <Skeleton style={{ height: "3rem", width: "20rem" }} />
        <Skeleton style={{ height: "4rem" }} />
        <Skeleton style={{ height: "16rem" }} />
      </div>
    );
  }

  if (project.isError || !project.data) {
    return (
      <div style={{ padding: "var(--space-6)" }}>
        <ErrorBanner
          title="Couldn't load this job"
          message={project.error instanceof Error ? project.error.message : "The project may not exist or the server is unreachable."}
          retry={() => project.refetch()}
          retryLoading={project.isFetching}
        />
      </div>
    );
  }

  const p = project.data;
  const cfg = statusOf(p.status);
  const title = vehicleTitle(p.vehicle_meta);
  const overBudget = p.budget_ceiling_usd != null && p.actual_spend_usd != null && p.actual_spend_usd > p.budget_ceiling_usd;
  const openFlags = (flags.data ?? []).filter((f) => f.status === "open");

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-fg-tertiary">
        <Link to="/" className="hover:text-fg-secondary">Jobs</Link>
        <Icon d={ICONS.chevronRight} width={12} height={12} />
        <span className="text-fg-secondary truncate">{title}</span>
      </nav>

      {/* Vehicle header */}
      <header className="flex items-start gap-4 flex-wrap animate-enter">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <StatusPip color={cfg.pipColor} label={cfg.label} />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight truncate">{title}</h1>
            <p className="text-sm text-fg-tertiary tnum">
              {shortId(p.project_id)} · Created {dateOnly(p.created_at)} · Updated {datetime(p.updated_at)}
            </p>
          </div>
        </div>
        <Badge hue={cfg.pipColor} soft={cfg.softColor} icon={cfg.icon} label={cfg.label} />
        {p.parked && (
          <Badge hue="var(--status-halted)" icon={ICONS.pin} label="Parked" />
        )}
      </header>

      {/* Coverage bar */}
      <CoverageStrip project={p} />

      {/* API cost strip */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="flex flex-col gap-1" style={{ padding: "var(--space-4)" }}>
          <span className="text-xs text-fg-tertiary uppercase tracking-wider">API cost to date</span>
          <span className={`text-lg font-semibold tnum ${apiCosts.data && apiCosts.data.to_date_usd > apiCosts.data.ceiling_usd ? "text-status-failed" : "text-fg-primary"}`}>
            {usd(apiCosts.data?.to_date_usd ?? p.api_cost_to_date_usd)}
          </span>
          <span className="text-xs text-fg-tertiary tnum">ceiling {usd(apiCosts.data?.ceiling_usd ?? p.api_cost_ceiling_usd)}</span>
        </Card>
        <Card className="flex flex-col gap-1" style={{ padding: "var(--space-4)" }}>
          <span className="text-xs text-fg-tertiary uppercase tracking-wider">Parts budget</span>
          <span className={`text-lg font-semibold tnum ${overBudget ? "text-status-failed" : "text-fg-primary"}`}>
            {usd(p.actual_spend_usd)}
          </span>
          <span className="text-xs text-fg-tertiary tnum">ceiling {usd(p.budget_ceiling_usd)}</span>
        </Card>
        <Card className="flex flex-col gap-1" style={{ padding: "var(--space-4)" }}>
          <span className="text-xs text-fg-tertiary uppercase tracking-wider">Open flags</span>
          <span className="text-lg font-semibold tnum text-fg-primary">{openFlags.length}</span>
          <span className="text-xs text-fg-tertiary">{openFlags.length === 0 ? "All clear" : "Needs operator review"}</span>
        </Card>
      </div>

      {/* Sub-navigation — spec §8.0: tabs disabled by status with helper text */}
      <nav aria-label="Project sections" className="flex items-center gap-1 flex-wrap">
        {TABS.map((tab) => {
          const disabled = tab.gate ? !statusAtOrPast(p.status, tab.gate) : false;
          if (disabled) {
            return (
              <span
                key={tab.to}
                className="btn btn-ghost btn-sm"
                style={{ opacity: 0.4, cursor: "not-allowed" }}
                aria-disabled="true"
                title={tab.disabledReason}
              >
                <Icon d={tab.icon} width={15} height={15} />
                {tab.label}
              </span>
            );
          }
          return (
            <Link
              key={tab.to}
              to={`/projects/${projectId}/${tab.to}`}
              className="btn btn-ghost btn-sm"
            >
              <Icon d={tab.icon} width={15} height={15} />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {/* Flags section */}
      <section className="flex flex-col gap-3 animate-enter stagger-1">
        <div className="flex items-center justify-between">
          <h2 className="lead-rule text-lg font-semibold">Flags</h2>
          {openFlags.length > 0 && (
            <span className="badge" style={{ color: "var(--signal-amber)", background: "var(--signal-amber-soft)", borderColor: "var(--signal-amber)" }}>
              {openFlags.length} open
            </span>
          )}
        </div>

        {flags.isLoading && <Skeleton style={{ height: "4rem" }} />}
        {flags.isError && (
          <ErrorBanner message="Couldn't load flags." retry={() => flags.refetch()} inline />
        )}
        {flags.data && flags.data.length === 0 && (
          <EmptyState icon={ICONS.flag} title="No flags recorded" description="Flags are raised when the pipeline needs operator input — ambiguous parts, budget overruns, or sourcing gaps." />
        )}
        {flags.data && flags.data.length > 0 && (
          <ul className="flex flex-col gap-2">
            {flags.data.map((flag) => (
              <FlagRow key={flag.flag_id} flag={flag} />
            ))}
          </ul>
        )}
      </section>

      {/* Lifecycle actions */}
      <div className="flex items-center gap-2 flex-wrap" style={{ paddingTop: "var(--space-4)", borderTop: "0.0625rem solid var(--border-subtle)" }}>
        <Button variant="ghost" icon={ICONS.file} onClick={exportPdf} loading={exporting} loadingLabel="Exporting…" disabled={p.status === "draft" || p.status === "abandoned"} disabledReason={p.status === "draft" ? "Seal the intake before exporting a report." : p.status === "abandoned" ? "Abandoned jobs can't be exported." : undefined}>
          Export PDF
        </Button>
        {p.parked ? (
          <Button variant="ghost" icon={ICONS.refresh} onClick={() => parkAction("unpark")}>
            Unpark job
          </Button>
        ) : (
          <Button variant="ghost" icon={ICONS.pin} onClick={() => parkAction("park")}>
            Park job
          </Button>
        )}
        <Button variant="ghost" icon={ICONS.refresh} disabled={p.status !== "closed"} onClick={reopenAction} disabledReason={p.status !== "closed" ? "Reopen is available for closed jobs only." : undefined}>
          Reopen
        </Button>
        <Button variant="ghost" icon={ICONS.layers} disabled disabledReason="Cloning a job is not available in this build.">
          Clone
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => navigate("/")} iconRight={ICONS.chevronRight}>
          Back to jobs
        </Button>
      </div>
    </div>
  );
}

function CoverageStrip({ project }: { project: import("@/shared/api-types").RestorationProject }) {
  const bars = [
    { label: "Automation", value: project.automation_coverage_pct, color: "var(--accent)" },
    { label: "System sourcing", value: project.system_sourcing_coverage_pct, color: "var(--signal-blue)" },
    { label: "Critical path", value: project.critical_path_coverage_pct, color: "var(--signal-amber)" },
  ];

  return (
    <Card className="flex flex-col gap-3" style={{ padding: "var(--space-4)" }}>
      {bars.map((bar) => (
        <div key={bar.label} className="flex items-center gap-3">
          <span className="text-xs text-fg-tertiary" style={{ minWidth: "8rem" }}>{bar.label}</span>
          <div
            className="flex-1 rounded-full overflow-hidden"
            style={{ height: "0.375rem", background: "var(--bg-elevated)" }}
            role="progressbar"
            aria-valuenow={bar.value ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${bar.label} coverage`}
          >
            <div
              style={{
                height: "100%",
                width: "100%",
                transform: `scaleX(${Math.min((bar.value ?? 0) / 100, 1)})`,
                transformOrigin: "left center",
                background: bar.color,
                transition: "transform var(--dur-fast) var(--ease-default)",
              }}
            />
          </div>
          <span className="text-xs tnum text-fg-secondary" style={{ minWidth: "3.5rem", textAlign: "right" }}>
            {pct(bar.value)}
          </span>
        </div>
      ))}
    </Card>
  );
}

function FlagRow({ flag }: { flag: Flag }) {
  const isOpen = flag.status === "open";
  return (
    <li>
      <Card hover className="flex items-start gap-3" style={{ padding: "var(--space-3) var(--space-4)" }}>
        <span
          style={{ color: isOpen ? "var(--signal-amber)" : "var(--status-complete)", flexShrink: 0, marginTop: "0.0625rem" }}
          aria-hidden
        >
          <Icon d={ICONS.flag} width={16} height={16} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-primary">{flag.problem_type}</span>
            <Badge
              hue={isOpen ? "var(--signal-amber)" : "var(--status-complete)"}
              soft={isOpen ? "var(--signal-amber-soft)" : "var(--status-complete-soft)"}
              label={flag.status}
            />
            {flag.part_id && <span className="text-xs text-fg-tertiary tnum">{shortId(flag.part_id)}</span>}
          </div>
          <p className="text-sm text-fg-secondary" style={{ marginTop: "0.25rem" }}>{flag.description}</p>
          {flag.resolution_notes && (
            <p className="text-xs text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
              Resolved: {flag.resolution_notes}
            </p>
          )}
        </div>
        <span className="text-xs text-fg-tertiary tnum" style={{ flexShrink: 0 }}>
          {dateOnly(flag.created_at)}
        </span>
      </Card>
    </li>
  );
}
