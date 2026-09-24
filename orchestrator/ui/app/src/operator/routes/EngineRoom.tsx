// U7 — Engine Room. System health: bridge providers, restoration pipeline
// status, capabilities. The operator's "is everything working" view.

import { useBridgeHealth, useRestorationHealth } from "@/shared/hooks";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { datetime } from "@/shared/format";

export function EngineRoom() {
  const bridge = useBridgeHealth();
  const restoration = useRestorationHealth();

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      <header className="animate-enter">
        <h1 className="lead-rule text-2xl font-semibold tracking-tight">Engine room</h1>
        <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
          System health, bridge providers, and pipeline status.
        </p>
      </header>

      {/* Pipeline status */}
      <section className="flex flex-col gap-3 animate-enter stagger-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.08em" }}>
          Restoration pipeline
        </h2>
        {restoration.isLoading && <Skeleton style={{ height: "5rem" }} />}
        {restoration.isError && (
          <ErrorBanner message="Couldn't reach the restoration health endpoint." retry={() => restoration.refetch()} retryLoading={restoration.isFetching} />
        )}
        {restoration.data && (
          <Card className="flex flex-col gap-3" style={{ padding: "var(--space-4)" }}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-fg-primary">Status</span>
              <Badge
                hue={restoration.data.status === "ok" ? "var(--status-complete)" : restoration.data.status === "degraded" ? "var(--signal-amber)" : "var(--status-failed)"}
                soft={restoration.data.status === "ok" ? "var(--status-complete-soft)" : restoration.data.status === "degraded" ? "var(--signal-amber-soft)" : "var(--status-failed-soft)"}
                label={restoration.data.status}
              />
            </div>
            {restoration.data.pipeline_running !== undefined && (
              <div className="flex items-center gap-2 text-sm">
                <span className="pip" style={{ background: restoration.data.pipeline_running ? "var(--status-running)" : "var(--status-halted)", width: "0.5rem", height: "0.5rem", borderRadius: "50%" }} aria-hidden />
                <span className="text-fg-secondary">{restoration.data.pipeline_running ? "Pipeline running" : "Pipeline idle"}</span>
                {restoration.data.active_project_id && (
                  <span className="text-xs text-fg-tertiary tnum">· {restoration.data.active_project_id.slice(0, 8)}</span>
                )}
              </div>
            )}
            {restoration.data.providers_paused && restoration.data.providers_paused.length > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <Icon d={ICONS.pause} width={14} height={14} style={{ color: "var(--signal-amber)" }} />
                <span className="text-fg-secondary">Paused: {restoration.data.providers_paused.join(", ")}</span>
              </div>
            )}
            {restoration.data.capabilities && (
              <div className="flex flex-wrap gap-1" style={{ marginTop: "var(--space-1)" }}>
                {Object.entries(restoration.data.capabilities).map(([cap, state]) => (
                  <span
                    key={cap}
                    className="badge"
                    style={{
                      color: state === "available" ? "var(--status-complete)" : state === "gated" ? "var(--signal-amber)" : "var(--fg-tertiary)",
                      borderColor: "var(--border-subtle)",
                    }}
                  >
                    {cap}: {state}
                  </span>
                ))}
              </div>
            )}
          </Card>
        )}
      </section>

      {/* Bridge providers */}
      <section className="flex flex-col gap-3 animate-enter stagger-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.08em" }}>
          Bridge providers
        </h2>
        {bridge.isLoading && (
          <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} style={{ height: "3.5rem" }} />)}
          </div>
        )}
        {bridge.isError && (
          <ErrorBanner message="Couldn't reach the bridge health endpoint." retry={() => bridge.refetch()} retryLoading={bridge.isFetching} />
        )}
        {bridge.data && (
          <>
            {bridge.data.providers && bridge.data.providers.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {bridge.data.providers.map((p) => (
                  <li key={p.provider}>
                    <Card className="flex items-center gap-3" style={{ padding: "var(--space-3) var(--space-4)" }}>
                      <span
                        className="pip"
                        style={{
                          background: p.healthy ? "var(--status-complete)" : "var(--status-failed)",
                          width: "0.5rem",
                          height: "0.5rem",
                          borderRadius: "50%",
                        }}
                        aria-hidden
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-fg-primary">{p.provider}</span>
                        {p.model && <span className="text-xs text-fg-tertiary" style={{ marginLeft: "var(--space-2)" }}>{p.model}</span>}
                      </div>
                      <Badge
                        hue={p.healthy ? "var(--status-complete)" : "var(--status-failed)"}
                        soft={p.healthy ? "var(--status-complete-soft)" : "var(--status-failed-soft)"}
                        label={p.status}
                      />
                      {p.last_check && <span className="text-xs text-fg-tertiary tnum">{datetime(p.last_check)}</span>}
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={ICONS.cog} title="No bridge providers configured" description="Bridge providers are configured in the orchestrator's Model Settings." />
            )}

            {bridge.data.capabilities && (
              <Card className="flex flex-wrap gap-1" style={{ padding: "var(--space-3)" }}>
                {Object.entries(bridge.data.capabilities).map(([cap, state]) => (
                  <span key={cap} className="badge" style={{ color: state === "available" ? "var(--status-complete)" : state === "gated" ? "var(--signal-amber)" : "var(--fg-tertiary)", borderColor: "var(--border-subtle)" }}>
                    {cap}: {state}
                  </span>
                ))}
              </Card>
            )}
          </>
        )}
      </section>
    </div>
  );
}
