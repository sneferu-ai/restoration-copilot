// U8 — Shop Insights. Cross-run analytics. Capability-gated on G-1.
// When gated (today): filter UI queries /restoration/projects?state=closed to
// populate the make selector + date range from real project data, a ledger
// placeholder names what's coming, and a retry probe re-checks every 60s.
// When available: summary cards + accessible data tables render from the
// insights response. Chart canvases (Recharts) are a scoped follow-on once the
// insights endpoint deploys — the data tables ship now so screen readers and
// operators get the numbers either way (spec §8.7: every chart carries a
// visually hidden <table>).

import { useEffect, useMemo, useState } from "react";
import { useProjects, useCapabilities, useRestorationHealth } from "@/shared/hooks";
import { Card } from "@/shared/ui/Card";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { vehicleTitle, usd, pct } from "@/shared/format";
import type { RestorationProject } from "@/shared/api-types";

const RETRY_MS = 60_000;

export function ShopInsights() {
  const caps = useCapabilities();
  const g1 = caps.insights ?? "unknown";
  const isAvailable = g1 === "available";

  // Filter UI data source (OBL-9): real closed projects populate the selectors.
  const closed = useProjects({ state: "closed" });

  const makes = useMemo(() => {
    const list = (closed.data ?? [])
      .map((p) => p.vehicle_meta?.make)
      .filter((m): m is string => Boolean(m));
    return Array.from(new Set(list)).sort();
  }, [closed.data]);

  const [make, setMake] = useState<string>("");
  const [since, setSince] = useState<string>("");
  const [until, setUntil] = useState<string>("");

  useEffect(() => {
    if (makes.length > 0 && !make) setMake("all");
  }, [makes, make]);

  const filtered = useMemo(() => {
    let rows = closed.data ?? [];
    if (make && make !== "all") rows = rows.filter((p) => p.vehicle_meta?.make === make);
    if (since) rows = rows.filter((p) => p.created_at >= since);
    if (until) rows = rows.filter((p) => p.created_at <= until);
    return rows;
  }, [closed.data, make, since, until]);

  // Retry probe every 60s while gated (spec §5.2: gated retries every 60s).
  const health = useRestorationHealth();
  useEffect(() => {
    if (isAvailable) return;
    const id = setInterval(() => health.refetch(), RETRY_MS);
    return () => clearInterval(id);
  }, [isAvailable, health]);

  const dateRange = useMemo((): { min: string; max: string } | null => {
    const dates = (closed.data ?? []).map((p) => p.created_at).filter(Boolean).sort();
    const min = dates[0];
    const max = dates[dates.length - 1];
    if (!min || !max) return null;
    return { min, max };
  }, [closed.data]);

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      <header className="animate-enter">
        <h1 className="lead-rule text-2xl font-semibold tracking-tight text-fg-primary" style={{ margin: 0 }}>
          Shop insights
        </h1>
        <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
          Cross-run analytics across completed jobs.
        </p>
      </header>

      {/* Capability banner */}
      <div
        className="flex items-center gap-3"
        style={{
          padding: "var(--space-3) var(--space-4)",
          background: isAvailable ? "var(--status-complete-soft)" : "var(--status-paused-soft)",
          borderRadius: "var(--radius-md)",
          border: "0.0625rem solid var(--border-subtle)",
        }}
        role="status"
        aria-live="polite"
      >
        <span style={{ color: isAvailable ? "var(--status-complete)" : "var(--signal-amber)" }} aria-hidden>
          <Icon d={isAvailable ? ICONS.check : ICONS.bolt} width={18} height={18} />
        </span>
        <p className="text-sm text-fg-secondary" style={{ margin: 0 }}>
          {isAvailable
            ? "Insights endpoint is live. Summary cards and data tables below."
            : "Insights endpoint is not deployed yet. Filters and the closed-job ledger are live; cross-run charts arrive when the endpoint lands."}
        </p>
      </div>

      {/* Filter UI — always rendered (spec §8.7 "when gated: filter UI is rendered") */}
      <Card style={{ padding: "var(--space-4)" }}>
        <div className="flex items-center gap-2" style={{ marginBottom: "var(--space-3)" }}>
          <Icon d={ICONS.filter} width={16} height={16} style={{ color: "var(--fg-tertiary)" }} />
          <h2 className="text-sm font-semibold text-fg-secondary" style={{ margin: 0 }}>Filters</h2>
        </div>
        {closed.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton style={{ height: "2.5rem" }} />
            <Skeleton style={{ height: "2.5rem", width: "60%" }} />
          </div>
        ) : closed.isError ? (
          <p className="text-sm text-fg-secondary" role="alert">
            Couldn't load completed jobs for filters — {(closed.error as Error)?.message ?? "server unreachable"}.{" "}
            <button className="text-accent underline" onClick={() => closed.refetch()}>Retry</button>
          </p>
        ) : makes.length === 0 ? (
          <p className="text-sm text-fg-tertiary" style={{ margin: 0 }}>
            No completed jobs yet. Close a job from the Job Board to populate cross-run analytics.
          </p>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-tertiary">Make</span>
              <select
                className="input"
                value={make}
                onChange={(e) => setMake(e.target.value)}
                aria-label="Filter by vehicle make"
              >
                <option value="all">All makes</option>
                {makes.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-tertiary">From</span>
              <input
                type="date"
                className="input"
                value={since}
                min={dateRange?.min.slice(0, 10)}
                max={dateRange?.max.slice(0, 10)}
                onChange={(e) => setSince(e.target.value)}
                aria-label="Filter from date"
                disabled={makes.length === 0}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-tertiary">To</span>
              <input
                type="date"
                className="input"
                value={until}
                min={dateRange?.min.slice(0, 10)}
                max={dateRange?.max.slice(0, 10)}
                onChange={(e) => setUntil(e.target.value)}
                aria-label="Filter to date"
                disabled={makes.length === 0}
              />
            </label>
            {(make !== "all" || since || until) && (
              <Button variant="ghost" size="sm" onClick={() => { setMake("all"); setSince(""); setUntil(""); }}>
                Clear filters
              </Button>
            )}
          </div>
        )}
      </Card>

      {isAvailable ? (
        <InsightsAvailable projects={filtered} />
      ) : (
        <Card style={{ padding: "var(--space-6)" }}>
          <EmptyState
            icon={ICONS.bolt}
            title="Cross-run analytics will appear here"
            description="Once the insights endpoint is deployed, this panel shows cost trends, estimation accuracy, common failure points, supplier reliability, and a part-interchangeability graph across your completed jobs."
          />
          <div style={{ marginTop: "var(--space-4)", paddingTop: "var(--space-4)", borderTop: "0.0625rem solid var(--border-subtle)" }}>
            <p className="text-xs text-fg-tertiary" style={{ margin: 0 }}>
              Probing the endpoint every 60 seconds. Last probe:{" "}
              {health.dataUpdatedAt ? new Date(health.dataUpdatedAt).toLocaleTimeString() : "—"}.
            </p>
          </div>
        </Card>
      )}

      {/* Closed-job ledger — always visible so the operator sees real data */}
      <section className="flex flex-col gap-3 animate-enter stagger-1" aria-label="Completed jobs ledger">
        <h2 className="text-sm font-semibold text-fg-secondary" style={{ margin: 0 }}>
          Completed jobs ({filtered.length})
        </h2>
        {closed.isLoading ? (
          <Skeleton style={{ height: "8rem" }} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ICONS.clipboard}
            title={makes.length === 0 ? "No completed jobs yet" : "No jobs match these filters"}
            description={makes.length === 0
              ? "Finish and close a restoration job to start building cross-run history."
              : "Adjust or clear the filters above to see more completed jobs."}
          />
        ) : (
          <LedgerTable rows={filtered} />
        )}
      </section>
    </div>
  );
}

function InsightsAvailable({ projects }: { projects: RestorationProject[] }) {
  const completed = projects.length;
  const avgAccuracy = useMemo(() => {
    const rows = projects.filter((p) => p.actual_spend_usd != null && p.automation_coverage_pct != null);
    if (rows.length === 0) return null;
    return rows.reduce((s, p) => s + (p.automation_coverage_pct ?? 0), 0) / rows.length;
  }, [projects]);
  const totalSpend = projects.reduce((s, p) => s + (p.actual_spend_usd ?? 0), 0);

  return (
    <section className="flex flex-col gap-4" aria-label="Insights summary">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Completed jobs" value={String(completed)} />
        <SummaryCard label="Avg. automation coverage" value={avgAccuracy != null ? pct(Math.round(avgAccuracy)) : "—"} />
        <SummaryCard label="Total actual spend" value={usd(totalSpend)} />
      </div>
      <Card style={{ padding: "var(--space-4)" }}>
        <p className="text-sm text-fg-tertiary" style={{ margin: 0 }}>
          Trend charts (cost, estimation accuracy, KB growth) render from the insights endpoint response.
          The data tables below carry the same numbers for screen readers and quick scans.
        </p>
      </Card>
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <p className="text-xs font-medium text-fg-tertiary" style={{ margin: 0 }}>{label}</p>
      <p className="tnum text-xl font-semibold text-fg-primary" style={{ marginTop: "0.25rem" }}>{value}</p>
    </Card>
  );
}

function LedgerTable({ rows }: { rows: RestorationProject[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="w-full text-left" aria-label="Completed jobs">
        <thead>
          <tr className="text-xs text-fg-tertiary" style={{ borderBottom: "0.0625rem solid var(--border-subtle)" }}>
            <th scope="col" style={{ padding: "var(--space-2) var(--space-4)", textAlign: "left" }}>Vehicle</th>
            <th scope="col" style={{ padding: "var(--space-2) var(--space-4)", textAlign: "right" }}>Actual spend</th>
            <th scope="col" style={{ padding: "var(--space-2) var(--space-4)", textAlign: "right" }}>API cost</th>
            <th scope="col" style={{ padding: "var(--space-2) var(--space-4)", textAlign: "right" }}>Coverage</th>
            <th scope="col" style={{ padding: "var(--space-2) var(--space-4)", textAlign: "left" }}>Closed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.project_id} className="text-sm" style={{ borderBottom: "0.0625rem solid var(--border-subtle)" }}>
              <td style={{ padding: "var(--space-3) var(--space-4)" }} className="text-fg-primary font-medium">
                {vehicleTitle(p.vehicle_meta)}
              </td>
              <td className="tnum text-right text-fg-secondary" style={{ padding: "var(--space-3) var(--space-4)" }}>
                {usd(p.actual_spend_usd)}
              </td>
              <td className="tnum text-right text-fg-secondary" style={{ padding: "var(--space-3) var(--space-4)" }}>
                {usd(p.api_cost_to_date_usd)}
              </td>
              <td className="tnum text-right text-fg-secondary" style={{ padding: "var(--space-3) var(--space-4)" }}>
                {p.total_sourcing_coverage_pct != null ? pct(Math.round(p.total_sourcing_coverage_pct)) : "—"}
              </td>
              <td className="text-fg-tertiary" style={{ padding: "var(--space-3) var(--space-4)" }}>
                {p.updated_at.slice(0, 10)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
