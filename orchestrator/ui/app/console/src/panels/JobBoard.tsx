// U1 — Job Board · #/jobs (spec §6.1). List query with keepPreviousData scoped
// per-query (OBL-60), 5s poll, filter bar, attention digest, JobCards with
// NextActionBadge + metric chips. Skeleton/empty/error/success all designed.
// JobCard "Export PDF" attempts POST …/export-artifact; 404 renders an inline
// <DegradationPanel> (spec §8.2 + §11.2, AT-084) — never a silent route-around.

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError } from "@shared/api-client";
import { keys } from "@shared/keys";
import {
  CopilotAlert,
  Chip,
  EmptyState,
  InlineError,
  SkeletonCard,
  StatusBadge,
} from "@shared/components";
import { NextActionBadge } from "@shared/next-action-badge";
import { useCopilotAlerts, useReadOnly } from "@shared/hooks";
import { useAuditMutation } from "@shared/mutations";
import { DegradationPanel, DEGRADATION_PRESETS, isPhaseGap } from "@shared/degradation";
import { STATUS_META, STATUS_ORDER } from "@shared/constants";
import { fmtPct, fmtRelative, fmtUsd, vehicleTitle } from "@shared/format";
import type { RestorationProject } from "@shared/types";

function useProjects(filter: { state?: string; search?: string }) {
  return useQuery({
    queryKey: keys.projects(filter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.state) params.set("state", filter.state);
      if (filter.search) params.set("search", filter.search);
      const qs = params.toString();
      return api<RestorationProject[]>(`/restoration/projects${qs ? `?${qs}` : ""}`);
    },
    placeholderData: keepPreviousData, // scoped here, not global (OBL-60)
    refetchInterval: 5000,
  });
}

function JobCard({ project }: { project: RestorationProject }) {
  const readOnly = useReadOnly();
  const title = vehicleTitle(project.vehicle_meta);
  const [exportGap, setExportGap] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportArtifact = useAuditMutation<unknown, void>({
    mutationFn: () =>
      api(`/restoration/projects/${project.project_id}/export-artifact`, { body: {} }),
    onError: (err) => {
      if (isPhaseGap(err)) setExportGap(true);
      else setExportError(err.message);
    },
    onSuccess: () => { setExportError(null); setExportGap(false); },
  });
  return (
    <article
      className="card group relative flex flex-col gap-2 p-4 transition-colors duration-150 hover:border-border-default focus-within:border-border-focus"
      data-testid="job-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/jobs/${project.project_id}`}
            className="block truncate text-lg font-semibold leading-snug hover:underline"
          >
            {title}
          </Link>
          <p className="mt-0.5 font-mono text-xs text-faint tnum">{project.project_id}</p>
        </div>
        <StatusBadge status={project.status} />
      </div>

      {project.parked && (
        <p className="rounded-sm bg-elevated px-2 py-1 text-xs text-muted">
          Parked — {project.parked_reason ?? "no reason recorded"}
        </p>
      )}
      {project.needs_attention != null && (
        <p className="rounded-sm border-l-2 border-signal bg-signal/10 px-2 py-1 text-xs text-ink">
          {project.needs_attention}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Chip
          label="spend"
          value={`${fmtUsd(project.actual_spend_usd)} / ${fmtUsd(project.budget_ceiling_usd)}`}
          tone={
            project.actual_spend_usd != null &&
            project.budget_ceiling_usd != null &&
            project.actual_spend_usd > project.budget_ceiling_usd
              ? "signal"
              : "muted"
          }
          title="Actual spend vs budget ceiling"
        />
        <Chip
          label="coverage"
          value={fmtPct(project.total_sourcing_coverage_pct)}
          tone="muted"
          title="Total sourcing coverage"
        />
        <Chip
          label="api"
          value={`${fmtUsd(project.api_cost_to_date_usd)} / ${fmtUsd(project.api_cost_ceiling_usd)}`}
          tone={
            project.api_cost_ceiling_usd > 0 &&
            project.api_cost_to_date_usd / project.api_cost_ceiling_usd >= 0.8
              ? "signal"
              : "muted"
          }
          title="API cost to date vs ceiling"
        />
        <Chip label="updated" value={fmtRelative(project.updated_at)} tone="faint" />
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-1">
        <div className="flex items-center justify-between gap-2">
          <NextActionBadge project={project} />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={readOnly || exportArtifact.isPending || project.status === "abandoned"}
            title={
              project.status === "abandoned"
                ? "Abandoned jobs cannot be exported"
                : readOnly
                  ? "Unavailable while offline"
                  : undefined
            }
            onClick={() => exportArtifact.mutate()}
            data-testid={`job-card-export-${project.project_id}`}
            aria-label={exportArtifact.isPending ? "Exporting PDF" : "Export job artifact as PDF"}
          >
            {exportArtifact.isPending ? "Exporting…" : "Export PDF"}
          </button>
        </div>
        {exportError && <InlineError message={exportError} />}
        {exportGap && (
          <DegradationPanel
            preset={DEGRADATION_PRESETS.export_artifact()}
            testId={`job-card-degradation-${project.project_id}`}
          />
        )}
      </div>
    </article>
  );
}

export function JobBoard() {
  const [stateFilter, setStateFilter] = useState("");
  const [search, setSearch] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const filter = useMemo(
    () => ({ state: stateFilter || undefined, search: search || undefined }),
    [stateFilter, search],
  );
  const query = useProjects(filter);
  const alerts = useCopilotAlerts(query.data);

  const projects = useMemo(() => {
    const all = query.data ?? [];
    return attentionOnly ? all.filter((p) => p.needs_attention != null) : all;
  }, [query.data, attentionOnly]);

  return (
    <div className="page-enter flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Job Board</h1>
          <p className="mt-0.5 text-sm text-muted">
            {query.data ? `${query.data.length} job${query.data.length === 1 ? "" : "s"} on the floor` : "Loading the floor…"}
          </p>
        </div>
        <Link to="/jobs/new" className="btn btn-primary" data-testid="new-job">
          New job
        </Link>
      </div>

      {alerts.map((a, i) => (
        <CopilotAlert key={i} severity={a.severity} title={a.title} body={a.body} />
      ))}

      <div className="card flex flex-wrap items-center gap-3 p-3" role="search">
        <div className="min-w-40 flex-1">
          <label htmlFor="job-search" className="sr-only">
            Search jobs
          </label>
          <input
            id="job-search"
            className="input"
            placeholder="Search year, make, model…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="state-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="state-filter"
            className="input w-auto"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s]?.label ?? s}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          aria-pressed={attentionOnly}
          className={`btn ${attentionOnly ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setAttentionOnly((v) => !v)}
          data-testid="attention-toggle"
        >
          Needs attention
        </button>
      </div>

      {query.isPending && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {query.isError && (
        <div className="flex flex-col gap-2">
          <InlineError
            message={
              query.error instanceof ApiError
                ? `Job board failed to load: ${query.error.message}`
                : "Job board failed to load."
            }
          />
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => query.refetch()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {query.isSuccess && projects.length === 0 && (
        <EmptyState
          title={attentionOnly || stateFilter || search ? "Nothing matches" : "No jobs on the board"}
          body={
            attentionOnly || stateFilter || search
              ? "No jobs match the current filters. Clear them to see the whole floor."
              : "Create the first job — intake takes six photos and a parts list."
          }
          ctaLabel={attentionOnly || stateFilter || search ? undefined : "New job"}
          ctaTo={attentionOnly || stateFilter || search ? undefined : "#/jobs/new"}
        />
      )}

      {query.isSuccess && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <JobCard key={p.project_id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
