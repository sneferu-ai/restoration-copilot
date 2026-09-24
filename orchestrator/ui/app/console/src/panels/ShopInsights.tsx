// U8 — Shop Insights · #/insights (spec §8.8). Attempts GET /restoration/insights
// (404-tolerant → DegradationPanel per §8.9 + §11.2, AT-084). When the endpoint
// 404s, a DegradationPanel names the gap and the derived-from-live-data
// dashboard remains below as a clearly-labeled "Live snapshot" fallback. When
// the endpoint succeeds, the response feeds the charts. Metric definitions
// follow §8.8 exactly, with corrected denominators, null handling, and the
// "approximate" velocity label (OBL-20/44).

import { useMemo } from "react";
import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { api, ApiError } from "@shared/api-client";
import { keys } from "@shared/keys";
import { Chip, EmptyState, InlineError, SkeletonCard, StatusBadge } from "@shared/components";
import { DegradationPanel, DEGRADATION_PRESETS } from "@shared/degradation";
import { STATUS_META } from "@shared/constants";
import { fmtDate, fmtUsd, vehicleTitle } from "@shared/format";
import type { KBEntry, RestorationProject } from "@shared/types";

const STATUS_TONES: Record<string, string> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  signal: "var(--signal)",
  muted: "var(--muted)",
  faint: "var(--faint)",
};

function MetricCard({
  title,
  children,
  footnote,
}: {
  title: string;
  children: React.ReactNode;
  footnote?: string;
}) {
  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold text-muted">{title}</h2>
      <div className="mt-2">{children}</div>
      {footnote && <p className="mt-2 text-xs text-faint">{footnote}</p>}
    </section>
  );
}

export function ShopInsights() {
  const projects = useQuery({
    queryKey: keys.projects({}),
    queryFn: () => api<RestorationProject[]>("/restoration/projects"),
  });
  const kb = useQuery({
    queryKey: keys.kbEntries({}),
    queryFn: () => api<KBEntry[]>("/restoration/kb/entries"),
  });

  // Spec §8.8: GET /restoration/insights?from=&to=&make= (404-tolerant →
  // DegradationPanel). The endpoint is Phase 5 — not yet implemented. When it
  // 404s, the DegradationPanel names the gap; the derived dashboard below
  // remains as a labeled "Live snapshot" fallback. No retry on 404 (AT-084).
  const insights = useQuery({
    queryKey: [keys.all[0], "insights"] as const,
    queryFn: () => api<Record<string, unknown>>("/restoration/insights"),
    retry: (count, err) => (err instanceof ApiError && err.status === 404 ? false : count < 2),
  });
  const insightsGap =
    insights.isError && insights.error instanceof ApiError && insights.error.status === 404;
  const insightsError =
    insights.isError && !insightsGap ? insights.error : null;

  const derived = useMemo(() => {
    const all = projects.data ?? [];
    // 1. pipeline donut
    const byStatus = new Map<string, number>();
    for (const p of all) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
    const donut = Array.from(byStatus.entries()).map(([status, count]) => ({
      name: STATUS_META[status]?.label ?? status,
      value: count,
      tone: STATUS_TONES[STATUS_META[status]?.tone ?? "muted"],
    }));
    // 2. cost summary — null projects excluded with footnote
    const withBudget = all.filter((p) => p.budget_ceiling_usd != null);
    const withSpend = all.filter((p) => p.actual_spend_usd != null);
    const totalBudget = withBudget.reduce((s, p) => s + (p.budget_ceiling_usd ?? 0), 0);
    const totalSpend = withSpend.reduce((s, p) => s + (p.actual_spend_usd ?? 0), 0);
    // 4. budget adherence (OBL-9/52): completed AND both numbers present AND within budget
    const completed = all.filter(
      (p) =>
        (p.status === "in_service" || p.status === "closed") &&
        p.actual_spend_usd != null &&
        p.budget_ceiling_usd != null,
    );
    const within = completed.filter(
      (p) => (p.actual_spend_usd ?? 0) <= (p.budget_ceiling_usd ?? 0),
    );
    const adherence = completed.length
      ? Math.round((100 * within.length) / completed.length)
      : null;
    // 5. recent jobs
    const recent = [...all]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 10);
    // 6. job velocity (approximate — updated_at proxy, OBL-20/44)
    const closed = all.filter((p) => p.status === "closed");
    const velocityDays = closed.length
      ? closed.reduce((s, p) => {
          const ms = new Date(p.updated_at).getTime() - new Date(p.created_at).getTime();
          return s + Math.max(0, ms / 86400000);
        }, 0) / closed.length
      : null;
    return { donut, totalBudget, totalSpend, withBudget, withSpend, adherence, completed, recent, velocityDays, closed };
  }, [projects.data]);

  const isPending = projects.isPending || kb.isPending;
  const isEmpty =
    projects.isSuccess && (projects.data ?? []).length === 0 && kb.isSuccess;

  return (
    <div className="page-enter flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Shop Insights</h1>
        <p className="mt-0.5 text-sm text-muted">
          {insightsGap
            ? "Aggregate analytics endpoint not yet enabled — showing a live snapshot derived from project data below."
            : "Aggregate analytics across all jobs."}
        </p>
      </div>

      {/* §8.8 + §11.2 + AT-084: DegradationPanel on insights 404 — never a
          silent route-around. The derived dashboard below is a labeled
          fallback, not a replacement for the spec'd endpoint. */}
      {insightsGap && (
        <DegradationPanel
          preset={DEGRADATION_PRESETS.insights()}
          testId="degradation-insights"
        />
      )}
      {insightsError && (
        <InlineError message={`Insights endpoint error: ${insightsError.message}`} />
      )}

      {isPending && (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_var(--rail-w)]">
          <div className="flex min-w-0 flex-col gap-3">
            <SkeletonCard />
            <SkeletonCard />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </div>
      )}

      {projects.isError && (
        <InlineError message={`Insights failed to load: ${projects.error.message}`} />
      )}
      {kb.isError && (
        <InlineError message={`Knowledge base failed to load: ${kb.error.message}`} />
      )}

      {isEmpty && (
        <EmptyState
          title="No completed jobs yet"
          body="Insights appear after your first restoration. Create a job on the board to start the clock."
          ctaLabel="New job"
          ctaTo="#/jobs/new"
        />
      )}

      {insightsGap && projects.isSuccess && !isEmpty && (
        <div
          className="flex items-center gap-2 border-t border-border-subtle pt-3"
          data-testid="live-snapshot-label"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-faint" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="6" cy="6" r="1.5" fill="currentColor" />
          </svg>
          <span className="text-xs font-medium uppercase tracking-wide text-faint">
            Live snapshot — derived from project data
          </span>
        </div>
      )}

      {projects.isSuccess && !isEmpty && (
        /* Dominant field + scoreboard rail (brand: editorial asymmetry —
           the same geometry as JobRoom's working surface + fact rail). */
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_var(--rail-w)]">
          <div className="flex min-w-0 flex-col gap-3">
          <MetricCard title="Project pipeline">
            {derived.donut.length ? (
              <div className="h-44" data-testid="pipeline-donut">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart aria-label="Project count by status">
                    <Pie
                      data={derived.donut}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="55%"
                      outerRadius="85%"
                      strokeWidth={0}
                    >
                      {derived.donut.map((d) => (
                        <Cell key={d.name} fill={d.tone}>
                          <title>{`${d.name}: ${d.value}`}</title>
                        </Cell>
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "var(--elevated)",
                        border: "var(--border-w) solid var(--border-default)",
                        borderRadius: "var(--radius-md)",
                        color: "var(--ink)",
                        fontSize: "var(--text-sm)",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-muted">No projects.</p>
            )}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {derived.donut.map((d) => (
                <Chip key={d.name} label={d.name} value={String(d.value)} />
              ))}
            </div>
          </MetricCard>

          <MetricCard title="Recent jobs">
            {derived.recent.length === 0 ? (
              <p className="text-sm text-muted">No jobs yet.</p>
            ) : (
              <ul className="flex flex-col" data-testid="recent-jobs">
                {derived.recent.map((p) => (
                  <li
                    key={p.project_id}
                    className="flex items-center justify-between gap-2 border-b border-border-subtle py-1.5 last:border-0"
                  >
                    <Link
                      to={`/jobs/${p.project_id}`}
                      className="min-w-0 truncate text-sm hover:underline"
                    >
                      {vehicleTitle(p.vehicle_meta)}
                    </Link>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tnum text-xs text-faint">{fmtDate(p.created_at)}</span>
                      <StatusBadge status={p.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </MetricCard>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
          <MetricCard
            title="Cost summary"
            footnote={`${(projects.data ?? []).length - derived.withBudget.length} job(s) without a ceiling and ${(projects.data ?? []).length - derived.withSpend.length} without recorded spend are excluded.`}
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted">Total budget</span>
                <span className="tnum font-semibold">{fmtUsd(derived.totalBudget)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted">Actual spend</span>
                <span className="tnum font-semibold">{fmtUsd(derived.totalSpend)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted">Variance</span>
                <span
                  className={`tnum font-semibold ${derived.totalSpend > derived.totalBudget ? "text-signal" : "text-ok"}`}
                >
                  {fmtUsd(derived.totalBudget - derived.totalSpend)}
                </span>
              </div>
            </div>
          </MetricCard>

          <MetricCard
            title="Budget adherence"
            footnote="Completed within budget: in-service or closed jobs where actual spend ≤ ceiling. Jobs without both numbers are excluded."
          >
            {derived.adherence == null ? (
              <p className="text-sm text-muted">No completed jobs yet.</p>
            ) : (
              <>
                <p className="tnum text-3xl font-semibold" data-testid="budget-adherence">
                  {derived.adherence}%
                </p>
                <p className="text-sm text-muted">
                  {derived.completed.length} completed job{derived.completed.length === 1 ? "" : "s"} measured
                </p>
              </>
            )}
          </MetricCard>

          <MetricCard
            title="Job velocity (approximate)"
            footnote="Based on updated_at as a proxy for completion. Projects with post-close edits may skew the average."
          >
            {derived.velocityDays == null ? (
              <p className="text-sm text-muted">No closed jobs yet.</p>
            ) : (
              <>
                <p className="tnum text-3xl font-semibold" data-testid="job-velocity">
                  {derived.velocityDays.toFixed(1)}d
                </p>
                <p className="text-sm text-muted">
                  average across {derived.closed.length} closed job{derived.closed.length === 1 ? "" : "s"}
                </p>
              </>
            )}
          </MetricCard>

          <MetricCard title="KB growth">
            <p className="tnum text-3xl font-semibold" data-testid="kb-count">
              {kb.data ? kb.data.length : "—"}
            </p>
            <p className="text-sm text-muted">reference entries on file</p>
          </MetricCard>
          </div>
        </div>
      )}
    </div>
  );
}
