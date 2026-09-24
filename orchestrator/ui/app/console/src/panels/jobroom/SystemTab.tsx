// System tab (U7 core). Health, provider cards with pause/resume/recheck,
// project-scoped + global reconcile (OBL-30), affected-jobs derivation with the
// 24h recency filter (OBL-25).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api-client";
import { keys } from "@shared/keys";
import { useAuditMutation } from "@shared/mutations";
import { useReadOnly } from "@shared/hooks";
import { Chip, InlineError, SkeletonRows } from "@shared/components";
import { fmtRelative } from "@shared/format";
import type { BridgeHealth, HealthResponse, RestorationProject } from "@shared/types";

const PROVIDER_USAGE: Record<string, string> = {
  identifying: "LLM (vision)",
  review_open: "LLM (vision)",
  hunting: "Sourcing (bridge)",
  sourcing_insufficient: "Sourcing (bridge)",
  meshing: "BFL, Meshy",
  graph_review: "LLM (text), TTS",
};

export function SystemTab({ project }: { project: RestorationProject }) {
  const readOnly = useReadOnly();
  const [error, setError] = useState<string | null>(null);
  const [reconcileResult, setReconcileResult] = useState<string | null>(null);

  const health = useQuery({
    queryKey: keys.health(),
    queryFn: () => api<HealthResponse>("/restoration/health"),
    refetchInterval: 10000,
  });

  const bridgeHealth = useQuery({
    queryKey: keys.bridgeHealth(),
    queryFn: () => api<BridgeHealth>("/bridge/health"),
    refetchInterval: 10000,
  });

  const projects = useQuery({
    queryKey: keys.projects({}),
    queryFn: () => api<RestorationProject[]>("/restoration/projects"),
  });

  const providerAction = useAuditMutation<unknown, { kind: string; body: Record<string, string> }>({
    mutationFn: ({ kind, body }) => api(`/restoration/provider/${kind}`, { body }),
    invalidateKeys: [keys.bridgeHealth()],
    onError: (err) => setError(err.message),
    onSuccess: () => setError(null),
  });

  const reconcile = useAuditMutation<Record<string, unknown>, { runId?: string }>({
    mutationFn: ({ runId }) =>
      api<Record<string, unknown>>(
        runId ? `/restoration/reconcile/${runId}` : "/restoration/reconcile",
        { body: {} },
      ),
    onError: (err) => {
      setError(err.message);
      setReconcileResult(null);
    },
    onSuccess: (res) => {
      setError(null);
      setReconcileResult(JSON.stringify(res, null, 2));
    },
  });

  const affected = (projects.data ?? []).filter((p) => {
    if (!PROVIDER_USAGE[p.status]) return false;
    const updated = new Date(p.updated_at).getTime();
    return Date.now() - updated < 24 * 3600 * 1000;
  });

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Host health</h2>
        {health.isPending && <SkeletonRows rows={2} />}
        {health.isError && <InlineError message={`Health check failed: ${health.error.message}`} />}
        {health.data && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="health-card">
            <Chip
              label="platform"
              value={health.data.os_supported ? "supported" : "not supported"}
              tone={health.data.os_supported ? "ok" : "signal"}
            />
            <Chip label="active jobs" value={String(health.data.active_projects)} />
            {health.data.version && <Chip label="version" value={health.data.version.slice(0, 8)} mono />}
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Providers</h2>
        {bridgeHealth.isPending && <SkeletonRows rows={3} />}
        {bridgeHealth.isError && (
          <InlineError message={`Provider health failed to load: ${bridgeHealth.error.message}`} />
        )}
        {bridgeHealth.data && (
          <ul className="mt-2 flex flex-col" data-testid="provider-list">
            {Object.entries(bridgeHealth.data.bridges).map(([name, info]) => (
              <li
                key={name}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle py-2 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-pill ${info.healthy ? "bg-ok" : info.configured ? "bg-signal" : "bg-faint"}`}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium">{name}</span>
                  <span className="text-xs text-muted">
                    {info.healthy ? "healthy" : info.configured ? "unhealthy" : "not configured"}
                    {info.unverified ? " · unverified" : ""}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={readOnly || providerAction.isPending}
                    title={readOnly ? "Unavailable while offline" : undefined}
                    onClick={() => providerAction.mutate({ kind: "pause", body: { provider: name } })}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={readOnly || providerAction.isPending}
                    title={readOnly ? "Unavailable while offline" : undefined}
                    onClick={() => providerAction.mutate({ kind: "resume", body: { provider: name } })}
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={readOnly || providerAction.isPending}
                    title={readOnly ? "Unavailable while offline" : "Force failover to a backup provider"}
                    onClick={() => providerAction.mutate({ kind: "failover", body: { provider: name } })}
                  >
                    Failover
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={readOnly || providerAction.isPending}
                    title={readOnly ? "Unavailable while offline" : undefined}
                    onClick={() => providerAction.mutate({ kind: "recheck", body: { provider: name } })}
                  >
                    Recheck
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {affected.length > 0 && (
          <div className="mt-3">
            <h3 className="text-sm font-semibold">Jobs touched by providers (last 24h)</h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {affected.map((p) => (
                <li key={p.project_id} className="flex justify-between gap-2">
                  <span>
                    {[p.vehicle_meta.year, p.vehicle_meta.make, p.vehicle_meta.model]
                      .filter(Boolean)
                      .join(" ") || p.project_id}
                  </span>
                  <span className="text-xs text-muted">
                    {PROVIDER_USAGE[p.status]} · {fmtRelative(p.updated_at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Event-log reconciliation</h2>
        <p className="mt-0.5 text-sm text-muted">
          SQLite is canonical. Reconcile rebuilds derived state and reports divergence between the
          database and the JSONL event log.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={readOnly || reconcile.isPending}
            title={readOnly ? "Unavailable while offline" : undefined}
            onClick={() => reconcile.mutate({ runId: project.run_id })}
            data-testid="reconcile-project"
          >
            {reconcile.isPending ? "Reconciling…" : "Reconcile this job"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={readOnly || reconcile.isPending}
            title={readOnly ? "Unavailable while offline" : undefined}
            onClick={() => reconcile.mutate({})}
          >
            Global sweep
          </button>
        </div>
        {reconcileResult && (
          <pre
            className="mt-3 max-h-64 overflow-auto rounded-md border border-border-subtle bg-elevated p-3 font-mono text-xs tnum"
            data-testid="reconcile-result"
          >
            {reconcileResult}
          </pre>
        )}
      </section>

      {error && <InlineError message={error} />}
    </div>
  );
}
