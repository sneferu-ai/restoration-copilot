// Manifest tab (U3 core). Entries table (virtualization lands with the 500-row
// AC next round), review resolution inline (AC-UI-007), lock gating (§9:
// review_open + no unresolved reviews). Manifest 404 → honest empty state.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@shared/api-client";
import { keys } from "@shared/keys";
import { useAuditMutation } from "@shared/mutations";
import { useReadOnly } from "@shared/hooks";
import { Chip, EmptyState, InlineError, SkeletonRows, StaleKbWarning } from "@shared/components";
import { fmtUsd } from "@shared/format";
import type { KBEntry, Manifest, ManifestEntry, RestorationProject } from "@shared/types";

interface ManifestDoc extends Manifest {
  version?: number;
  automation_coverage_pct?: number;
}

function ReviewRow({
  project,
  entry,
  kbEntry,
}: {
  project: RestorationProject;
  entry: ManifestEntry;
  kbEntry: KBEntry | null;
}) {
  const readOnly = useReadOnly();
  const [name, setName] = useState(entry.name);
  const [condition, setCondition] = useState("present");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const resolve = useAuditMutation<unknown, void>({
    mutationFn: () =>
      api(`/restoration/projects/${project.project_id}/manifest/resolve`, {
        body: { part_id: entry.part_id, name, condition, notes: notes || undefined },
      }),
    invalidateKeys: [keys.manifest(project.project_id), keys.project(project.project_id)],
    onError: (err) => setError(err.message),
    onSuccess: () => setDone(true),
  });

  if (done) {
    return (
      <tr className="border-b border-border-subtle" data-testid={`review-resolved-${entry.part_id}`}>
        <td colSpan={7} className="py-2 text-sm text-ok">
          Resolved — {entry.name}
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border-subtle bg-accent/5" data-testid={`review-row-${entry.part_id}`}>
      <td className="py-1.5 pr-3 font-mono text-xs tnum">{entry.part_id}</td>
      <td className="py-1.5 pr-3" colSpan={3}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={`Corrected name for ${entry.name}`}
            className="input min-w-48 flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            aria-label="Condition"
            className="input w-auto"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          >
            <option value="present">present</option>
            <option value="missing">missing</option>
            <option value="damaged">damaged</option>
          </select>
          <input
            aria-label="Notes (optional)"
            className="input min-w-32 flex-1"
            placeholder="notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={readOnly || resolve.isPending || !name.trim()}
            title={readOnly ? "Unavailable while offline" : !name.trim() ? "A name is required" : undefined}
            onClick={() => resolve.mutate()}
          >
            {resolve.isPending ? "Resolving…" : "Resolve"}
          </button>
        </div>
        {kbEntry && (
          <StaleKbWarning
            kbEntry={kbEntry}
            identifiedOem={entry.oem_number}
            biasingContext={null}
          />
        )}
        {error && (
          <div className="mt-2">
            <InlineError message={error} />
          </div>
        )}
      </td>
      <td className="py-1.5 pr-3 text-sm tnum">{entry.quantity}</td>
      <td className="py-1.5 pr-3 text-sm">
        <span className="text-accent">review</span>
      </td>
      <td className="py-1.5 text-right text-sm tnum">{Math.round(entry.confidence * 100)}%</td>
    </tr>
  );
}

export function ManifestTab({ project }: { project: RestorationProject }) {
  const readOnly = useReadOnly();
  const [lockError, setLockError] = useState<string | null>(null);
  const manifest = useQuery({
    queryKey: keys.manifest(project.project_id),
    queryFn: () => api<ManifestDoc>(`/restoration/projects/${project.project_id}/manifest`),
    retry: (count, err) =>
      err instanceof ApiError && err.status === 404 ? false : count < 2,
  });

  // §6.0 Layer 3 / §6.3 KB sub-panel: load KB entries for the vehicle to power
  // the StaleKbWarning in review rows (soul-brief core feature — the $400 wrong
  // OEM number). Computed from already-loaded data, no new endpoints (OBL-66).
  const kb = useQuery({
    queryKey: keys.kbEntries({
      make: project.vehicle_meta.make ?? undefined,
      model: project.vehicle_meta.model ?? undefined,
      year: project.vehicle_meta.year ?? undefined,
    }),
    queryFn: () => {
      const params = new URLSearchParams();
      if (project.vehicle_meta.make) params.set("make", project.vehicle_meta.make);
      if (project.vehicle_meta.model) params.set("model", project.vehicle_meta.model);
      if (project.vehicle_meta.year) params.set("year", project.vehicle_meta.year);
      const qs = params.toString();
      return api<KBEntry[]>(`/restoration/kb/entries${qs ? `?${qs}` : ""}`);
    },
    staleTime: 60_000,
  });

  // Match manifest entries to KB entries by OEM number (primary) or name (fallback).
  const kbByOem = useMemo(() => {
    const m = new Map<string, KBEntry>();
    for (const k of kb.data ?? []) {
      if (k.oem_number) m.set(k.oem_number.toUpperCase(), k);
    }
    return m;
  }, [kb.data]);

  const kbByName = useMemo(() => {
    const m = new Map<string, KBEntry>();
    for (const k of kb.data ?? []) {
      if (k.name) m.set(k.name.toLowerCase(), k);
    }
    return m;
  }, [kb.data]);

  function findKbEntry(entry: ManifestEntry): KBEntry | null {
    if (entry.oem_number) {
      const byOem = kbByOem.get(entry.oem_number.toUpperCase());
      if (byOem) return byOem;
    }
    return kbByName.get(entry.name.toLowerCase()) ?? null;
  }

  const lock = useAuditMutation<unknown, void>({
    mutationFn: () =>
      api(`/restoration/projects/${project.project_id}/manifest/lock`, { body: {} }),
    invalidateKeys: [keys.manifest(project.project_id), keys.project(project.project_id)],
    onError: (err) => setLockError(err.message),
    onSuccess: () => setLockError(null),
  });

  if (manifest.isPending) return <SkeletonRows rows={6} />;

  if (manifest.isError) {
    if (manifest.error instanceof ApiError && manifest.error.status === 404) {
      return (
        <EmptyState
          title="Manifest is empty"
          body="Seal intake and run identification — identified parts land here as a reviewable manifest."
          ctaLabel="Open intake"
          ctaTo={`#/jobs/${project.project_id}/intake`}
        />
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <InlineError message={`Manifest failed to load: ${manifest.error.message}`} />
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => manifest.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const doc = manifest.data;
  const entries = doc.entries ?? [];
  const openReviews = entries.filter((e) => e.requires_review);
  const canLock =
    project.status === "review_open" && openReviews.length === 0 && !doc.locked && !readOnly;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Chip label="entries" value={String(entries.length)} />
          <Chip
            label="auto coverage"
            value={doc.automation_coverage_pct != null ? `${doc.automation_coverage_pct}%` : "—"}
            title="Share of entries that needed no review"
          />
          <Chip
            label="reviews open"
            value={String(openReviews.length)}
            tone={openReviews.length ? "accent" : "ok"}
          />
          {doc.locked && <Chip label="manifest" value="locked" tone="ok" />}
        </div>
        {!doc.locked && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canLock || lock.isPending}
            title={
              project.status !== "review_open"
                ? `Lock requires status review_open (current: ${project.status})`
                : openReviews.length > 0
                  ? `${openReviews.length} review${openReviews.length === 1 ? "" : "s"} still open`
                  : readOnly
                    ? "Unavailable while offline"
                    : undefined
            }
            onClick={() => lock.mutate()}
            data-testid="lock-manifest"
          >
            {lock.isPending ? "Locking…" : "Lock manifest"}
          </button>
        )}
      </div>
      {lockError && <InlineError message={lockError} />}

      {entries.length === 0 ? (
        <EmptyState
          title="No entries"
          body="Identification produced no entries. Re-run identification from the Intake tab or check the review queue."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="manifest-table">
            <thead>
              <tr className="border-b border-border-default text-left text-xs text-faint">
                <th className="py-2 pr-3 pl-3 font-medium">Part</th>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">OEM</th>
                <th className="py-2 pr-3 font-medium">Est. cost</th>
                <th className="py-2 pr-3 font-medium">Qty</th>
                <th className="py-2 pr-3 font-medium">Sourcing</th>
                <th className="py-2 pr-3 text-right font-medium">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) =>
                e.requires_review ? (
                  <ReviewRow key={e.part_id} project={project} entry={e} kbEntry={findKbEntry(e)} />
                ) : (
                  <tr key={e.part_id} className="border-b border-border-subtle last:border-0">
                    <td className="py-1.5 pr-3 pl-3 font-mono text-xs tnum">{e.part_id}</td>
                    <td className="py-1.5 pr-3">{e.name}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs tnum">{e.oem_number ?? "—"}</td>
                    <td className="py-1.5 pr-3 tnum">{fmtUsd(e.estimated_cost_usd)}</td>
                    <td className="py-1.5 pr-3 tnum">{e.quantity}</td>
                    <td className="py-1.5 pr-3 text-muted">{e.sourcing_status.replace(/_/g, " ")}</td>
                    <td className="py-1.5 pr-3 text-right tnum">{Math.round(e.confidence * 100)}%</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
