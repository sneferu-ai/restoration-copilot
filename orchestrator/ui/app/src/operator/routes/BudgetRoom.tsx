// U4 — Budget Room (Wallet Desk). Parts budget ceiling vs actual spend,
// API cost ceiling vs to-date, per-provider breakdown, and coverage summary.
// Real data from useProject + useApiCosts + useManifest hooks.

import { Link, useParams } from "react-router-dom";
import { useProject, useApiCosts, useManifest } from "@/shared/hooks";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { ICONS } from "@/shared/ui/Icon";
import { statusOf } from "@/shared/status";
import { usd, pct, shortId, vehicleTitle } from "@/shared/format";

export function BudgetRoom() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const costs = useApiCosts(projectId);
  const manifest = useManifest(projectId);

  if (project.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton style={{ height: "2rem", width: "16rem" }} />
        <Skeleton style={{ height: "7.5rem" }} />
        <Skeleton style={{ height: "7.5rem" }} />
      </div>
    );
  }

  if (project.error) {
    return (
      <ErrorBanner
        title="Couldn't load the project"
        message={project.error instanceof Error ? project.error.message : "The project data didn't load."}
        retry={() => project.refetch()}
        retryLoading={project.isFetching}
      />
    );
  }

  const p = project.data;
  if (!p) return null;

  const partsCeiling = p.budget_ceiling_usd;
  const partsActual = p.actual_spend_usd;
  const partsPct = partsCeiling && partsActual != null && partsCeiling > 0
    ? Math.min((partsActual / partsCeiling) * 100, 999)
    : null;
  const partsOver = partsCeiling != null && partsActual != null && partsActual > partsCeiling;

  const apiCeiling = p.api_cost_ceiling_usd;
  const apiToDate = p.api_cost_to_date_usd;
  const apiPct = apiCeiling > 0 && apiToDate != null
    ? Math.min((apiToDate / apiCeiling) * 100, 999)
    : null;
  const apiOver = apiToDate > apiCeiling;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-fg-tertiary">
            <Link to={`/projects/${projectId}`} className="hover:text-fg-secondary transition-colors">
              {vehicleTitle(p.vehicle_meta)}
            </Link>
            <span aria-hidden>›</span>
            <span>Budget</span>
          </div>
          <h1 className="text-xl font-semibold text-fg-primary" style={{ marginTop: "0.25rem" }}>
            Budget & API costs
          </h1>
          <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
            {shortId(p.project_id)} · {statusOf(p.status).label}
          </p>
        </div>
        <Link to={`/projects/${projectId}`}>
          <Button variant="ghost" size="sm" icon={ICONS.chevronLeft}>
            Back to job
          </Button>
        </Link>
      </div>

      {/* Parts budget card */}
      <Card className="flex flex-col gap-3" style={{ padding: "var(--space-5)" }}>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-fg-primary">Parts budget</h2>
          {partsOver ? (
            <Badge hue="var(--status-failed)" soft="var(--status-failed-soft)" label="Over ceiling" />
          ) : partsPct != null && partsPct >= 80 ? (
            <Badge hue="var(--signal-amber)" soft="var(--signal-amber-soft)" label="Near ceiling" />
          ) : (
            <Badge hue="var(--status-complete)" soft="var(--status-complete-soft)" label="Within budget" />
          )}
        </div>
        <div className="flex items-baseline gap-6 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em" }}>Ceiling</p>
            <p className="text-lg font-semibold tnum text-fg-primary">{partsCeiling != null ? usd(partsCeiling) : "Not set"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em" }}>Actual spend</p>
            <p className="text-lg font-semibold tnum text-fg-primary">{partsActual != null ? usd(partsActual) : "—"}</p>
          </div>
          {partsPct != null && (
            <div>
              <p className="text-xs uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em" }}>Used</p>
              <p className="text-lg font-semibold tnum" style={{ color: partsOver ? "var(--status-failed)" : "var(--fg-primary)" }}>
                {pct(partsPct)}
              </p>
            </div>
          )}
        </div>
        {/* Budget bar — transform: scaleX (anti-default #11: transform+opacity only) */}
        {partsCeiling != null && partsCeiling > 0 && partsActual != null && (
          <div
            className="w-full"
            style={{
              height: "0.375rem",
              background: "var(--bg-input)",
              borderRadius: "var(--radius-full)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                transform: `scaleX(${Math.min((partsPct ?? 0) / 100, 1)})`,
                transformOrigin: "left center",
                background: partsOver ? "var(--status-failed)" : partsPct != null && partsPct >= 80 ? "var(--signal-amber)" : "var(--accent)",
                borderRadius: "var(--radius-full)",
                transition: "transform var(--dur-base) var(--ease-default)",
              }}
            />
          </div>
        )}
        {p.budget_override_reason && (
          <p className="text-xs text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
            Override: {p.budget_override_reason}
          </p>
        )}
      </Card>

      {/* API cost card */}
      <Card className="flex flex-col gap-3" style={{ padding: "var(--space-5)" }}>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-fg-primary">API cost</h2>
          {apiOver ? (
            <Badge hue="var(--status-failed)" soft="var(--status-failed-soft)" label="Over ceiling" />
          ) : apiPct != null && apiPct >= 80 ? (
            <Badge hue="var(--signal-amber)" soft="var(--signal-amber-soft)" label="Near ceiling" />
          ) : (
            <Badge hue="var(--status-complete)" soft="var(--status-complete-soft)" label="Within budget" />
          )}
        </div>
        <div className="flex items-baseline gap-6 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em" }}>Ceiling</p>
            <p className="text-lg font-semibold tnum text-fg-primary">{usd(apiCeiling)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em" }}>To date</p>
            <p className="text-lg font-semibold tnum text-fg-primary">{usd(apiToDate)}</p>
          </div>
          {apiPct != null && (
            <div>
              <p className="text-xs uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em" }}>Used</p>
              <p className="text-lg font-semibold tnum" style={{ color: apiOver ? "var(--status-failed)" : "var(--fg-primary)" }}>
                {pct(apiPct)}
              </p>
            </div>
          )}
        </div>
        {/* API cost bar — transform: scaleX (anti-default #11) */}
        {apiCeiling > 0 && (
          <div
            className="w-full"
            style={{
              height: "0.375rem",
              background: "var(--bg-input)",
              borderRadius: "var(--radius-full)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                transform: `scaleX(${Math.min((apiPct ?? 0) / 100, 1)})`,
                transformOrigin: "left center",
                background: apiOver ? "var(--status-failed)" : apiPct != null && apiPct >= 80 ? "var(--signal-amber)" : "var(--accent)",
                borderRadius: "var(--radius-full)",
                transition: "transform var(--dur-base) var(--ease-default)",
              }}
            />
          </div>
        )}
        {p.api_cost_override_reason && (
          <p className="text-xs text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
            Override: {p.api_cost_override_reason}
          </p>
        )}

        {/* Per-provider breakdown */}
        {costs.isLoading ? (
          <Skeleton style={{ height: "5rem" }} />
        ) : costs.error ? (
          <ErrorBanner
            inline
            title="API cost breakdown unavailable"
            message={costs.error instanceof Error ? costs.error.message : "The per-provider breakdown didn't load."}
            retry={() => costs.refetch()}
            retryLoading={costs.isFetching}
          />
        ) : costs.data?.by_provider && costs.data.by_provider.length > 0 ? (
          <div style={{ marginTop: "var(--space-2)" }}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em", marginBottom: "var(--space-2)" }}>
              By provider
            </h3>
            <ul className="flex flex-col gap-1">
              {costs.data.by_provider.map((row) => (
                <li
                  key={row.provider}
                  className="flex items-center justify-between gap-4 text-sm"
                  style={{ padding: "var(--space-2) 0", borderBottom: "0.0625rem solid var(--border-subtle)" }}
                >
                  <span className="text-fg-secondary">{row.provider}</span>
                  <span className="tnum text-fg-tertiary" style={{ minWidth: "3rem", textAlign: "right" }}>{row.calls} calls</span>
                  <span className="tnum font-semibold text-fg-primary" style={{ minWidth: "5rem", textAlign: "right" }}>{usd(row.cost_usd)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      {/* Coverage summary */}
      <Card className="flex flex-col gap-3" style={{ padding: "var(--space-5)" }}>
        <h2 className="text-sm font-semibold text-fg-primary">Coverage</h2>
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))" }}>
          <CoverageStat label="Total" value={p.total_sourcing_coverage_pct} />
          <CoverageStat label="System" value={p.system_sourcing_coverage_pct} />
          <CoverageStat label="Critical path" value={p.critical_path_coverage_pct} />
          <CoverageStat label="Automation" value={p.automation_coverage_pct} />
        </div>
      </Card>

      {/* Parts cost breakdown from manifest */}
      {manifest.isLoading ? (
        <Skeleton style={{ height: "7.5rem" }} />
      ) : manifest.error ? null : manifest.data?.entries && manifest.data.entries.length > 0 ? (
        <Card className="flex flex-col gap-3" style={{ padding: "var(--space-5)" }}>
          <h2 className="text-sm font-semibold text-fg-primary">Parts cost breakdown</h2>
          <ul className="flex flex-col gap-1">
            {manifest.data.entries
              .filter((e) => e.estimated_cost_usd != null)
              .sort((a, b) => (b.estimated_cost_usd ?? 0) - (a.estimated_cost_usd ?? 0))
              .map((entry) => (
                <li
                  key={entry.part_id}
                  className="flex items-center justify-between gap-4 text-sm"
                  style={{ padding: "var(--space-2) 0", borderBottom: "0.0625rem solid var(--border-subtle)" }}
                >
                  <span className="text-fg-secondary truncate">{entry.name}</span>
                  <span className="text-xs text-fg-tertiary" style={{ flexShrink: 0 }}>{entry.criticality}</span>
                  <span className="tnum font-semibold text-fg-primary" style={{ minWidth: "5rem", textAlign: "right" }}>
                    {usd(entry.estimated_cost_usd)}
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      ) : (
        <EmptyState
          icon={ICONS.package}
          title="No parts costed yet"
          description="The parts manifest will populate cost estimates after the identification scan completes."
        />
      )}
    </div>
  );
}

function CoverageStat({ label, value }: { label: string; value?: number | null }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.06em" }}>{label}</p>
      <p
        className="text-lg font-semibold tnum"
        style={{
          color: value != null && value >= 100 ? "var(--status-complete)" : value != null && value < 50 ? "var(--signal-amber)" : "var(--fg-primary)",
        }}
      >
        {value != null ? pct(value) : "—"}
      </p>
    </div>
  );
}
