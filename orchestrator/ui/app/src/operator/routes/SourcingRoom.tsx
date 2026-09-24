// U5 — Sourcing Room. Candidates per part, coverage, best prices.
// The hunt panel — where the operator reviews and approves sourcing candidates.

import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useProject, useSourcing, useManifest } from "@/shared/hooks";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { statusOf } from "@/shared/status";
import { usd, pct, shortId, vehicleTitle } from "@/shared/format";
import type { SourcingCandidate } from "@/shared/api-types";

const AVAILABILITY_COLORS: Record<string, string> = {
  in_stock: "var(--status-complete)",
  limited: "var(--signal-amber)",
  backordered: "var(--signal-blue)",
  unavailable: "var(--status-failed)",
};

interface PartGroup {
  part_id: string;
  name: string;
  best_price_usd?: number | null;
  candidates: SourcingCandidate[];
}

export function SourcingRoom() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const sourcing = useSourcing(projectId);
  const manifest = useManifest(projectId);

  // All hooks must run unconditionally — derive data before early returns.
  const candidates = sourcing.data?.candidates ?? [];
  const manifestNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of manifest.data?.entries ?? []) {
      map.set(entry.part_id, entry.name);
    }
    return map;
  }, [manifest.data]);

  const byPart: PartGroup[] = useMemo(() => {
    const groups = new Map<string, PartGroup>();
    for (const c of candidates) {
      const existing = groups.get(c.part_id);
      if (existing) {
        existing.candidates.push(c);
        if (c.price_usd != null && (existing.best_price_usd == null || c.price_usd < existing.best_price_usd)) {
          existing.best_price_usd = c.price_usd;
        }
      } else {
        groups.set(c.part_id, {
          part_id: c.part_id,
          name: manifestNames.get(c.part_id) ?? c.part_id,
          best_price_usd: c.price_usd ?? null,
          candidates: [c],
        });
      }
    }
    return Array.from(groups.values());
  }, [candidates, manifestNames]);

  if (project.isLoading) {
    return (
      <div className="flex flex-col gap-4" style={{ padding: "var(--space-6)" }} aria-live="polite" aria-busy="true">
        <Skeleton style={{ height: "3rem", width: "16rem" }} />
        <Skeleton style={{ height: "8rem" }} />
      </div>
    );
  }

  if (project.isError || !project.data) {
    return (
      <div style={{ padding: "var(--space-6)" }}>
        <ErrorBanner title="Couldn't load sourcing" message="The project may not exist or the server is unreachable." retry={() => project.refetch()} retryLoading={project.isFetching} />
      </div>
    );
  }

  const title = vehicleTitle(project.data.vehicle_meta);
  const cfg = statusOf(project.data.status);
  const data = sourcing.data;
  const coverage = data?.total_coverage ?? project.data.total_sourcing_coverage_pct;

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-fg-tertiary">
        <Link to="/" className="hover:text-fg-secondary">Jobs</Link>
        <Icon d={ICONS.chevronRight} width={12} height={12} />
        <Link to={`/projects/${projectId}`} className="hover:text-fg-secondary">{title}</Link>
        <Icon d={ICONS.chevronRight} width={12} height={12} />
        <span className="text-fg-secondary">Sourcing</span>
      </nav>

      <header className="flex items-start gap-4 flex-wrap animate-enter">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Sourcing</h1>
          <p className="text-sm text-fg-tertiary">{title} · {candidates.length} candidates across {byPart.length} parts</p>
        </div>
        <Badge hue={cfg.pipColor} soft={cfg.softColor} icon={cfg.icon} label={cfg.label} />
      </header>

      {/* Coverage bar */}
      {coverage != null && (
        <Card className="flex flex-col gap-2" style={{ padding: "var(--space-4)" }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary">Total coverage</span>
            <span className="text-sm font-semibold tnum" style={{ color: coverage >= 100 ? "var(--status-complete)" : "var(--fg-primary)" }}>{pct(coverage)}</span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: "0.5rem", background: "var(--bg-elevated)" }} role="progressbar" aria-valuenow={coverage} aria-valuemin={0} aria-valuemax={100} aria-label="Total sourcing coverage">
            <div style={{ height: "100%", width: "100%", transform: `scaleX(${Math.min(coverage, 100) / 100})`, transformOrigin: "left center", background: "var(--accent)", transition: "transform var(--dur-fast) var(--ease-default)" }} />
          </div>
        </Card>
      )}

      {sourcing.isLoading && (
        <div className="flex flex-col gap-3" aria-live="polite" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} style={{ height: "6rem" }} />)}
        </div>
      )}

      {sourcing.isError && (
        <ErrorBanner message="Couldn't load sourcing candidates." retry={() => sourcing.refetch()} retryLoading={sourcing.isFetching} />
      )}

      {!sourcing.isLoading && !sourcing.isError && byPart.length === 0 && (
        <EmptyState
          icon={ICONS.search}
          title="No sourcing candidates yet"
          description="The sourcing hunt hasn't started or hasn't found any candidates. It runs after the parts manifest is identified."
          action={<Link to={`/projects/${projectId}/manifest`} className="btn btn-primary btn-sm"><Icon d={ICONS.package} width={15} height={15} />View manifest</Link>}
        />
      )}

      {!sourcing.isLoading && !sourcing.isError && byPart.length > 0 && (
        <div className="flex flex-col gap-4">
          {byPart.map((part) => {
            return (
              <section key={part.part_id} className="flex flex-col gap-3 animate-enter">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-fg-primary">
                    {part.name}
                    <span className="text-xs text-fg-tertiary tnum" style={{ marginLeft: "var(--space-2)" }}>{shortId(part.part_id)}</span>
                  </h2>
                  {part.best_price_usd != null && (
                    <span className="text-xs text-fg-tertiary tnum">Best: {usd(part.best_price_usd)}</span>
                  )}
                </div>
                {part.candidates.length === 0 ? (
                  <Card className="flex items-center gap-2" style={{ padding: "var(--space-3) var(--space-4)" }}>
                    <Icon d={ICONS.search} width={15} height={15} style={{ color: "var(--fg-tertiary)" }} />
                    <span className="text-sm text-fg-tertiary">No candidates found yet. The hunt is still running.</span>
                  </Card>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {part.candidates.map((c) => (
                      <CandidateRow key={c.candidate_id} candidate={c} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-end gap-2" style={{ paddingTop: "var(--space-4)" }}>
        <Button variant="ghost" icon={ICONS.download} disabled disabledReason="Sourcing report export is not available in this build.">
          Export sourcing report
        </Button>
      </div>
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: SourcingCandidate }) {
  const availColor = AVAILABILITY_COLORS[candidate.availability] ?? "var(--fg-tertiary)";
  const isBest = candidate.negotiation_status === "accepted";

  return (
    <li>
      <Card hover className="flex items-center gap-4" style={{ padding: "var(--space-3) var(--space-4)" }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-primary truncate">{candidate.supplier}</span>
            {isBest && (
              <Badge hue="var(--status-complete)" soft="var(--status-complete-soft)" icon={ICONS.check} label="Accepted" />
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-fg-tertiary">
            <span className="flex items-center gap-1">
              <span className="pip" style={{ background: availColor, width: "0.375rem", height: "0.375rem", borderRadius: "50%" }} aria-hidden />
              {candidate.availability.replace(/_/g, " ")}
            </span>
            <span>{candidate.condition}</span>
            {candidate.url && (
              <a href={candidate.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                View listing
              </a>
            )}
          </div>
          {candidate.notes && <p className="text-xs text-fg-tertiary" style={{ marginTop: "0.25rem" }}>{candidate.notes}</p>}
        </div>
        <span className="text-sm font-semibold tnum text-fg-primary" style={{ minWidth: "5rem", textAlign: "right" }}>
          {usd(candidate.price_usd)}
        </span>
        <Badge hue="var(--fg-tertiary)" label={candidate.negotiation_status.replace(/_/g, " ")} />
      </Card>
    </li>
  );
}
