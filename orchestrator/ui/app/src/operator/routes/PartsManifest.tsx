// U3 — Parts Bench. The authoritative list of identified parts.
// Table with criticality, OEM numbers, sourcing status, confidence, and
// review flags. Rows that require_review get an amber marker and land in the
// review-queue drawer (spec §8.4). A Copilot Panel (OBL-55) opens per-row with
// "why identified", alternatives, and sourcing-difficulty. Lock manifest is
// gated on an empty review queue (spec §8.4).

import { Link, useParams } from "react-router-dom";
import { useMemo, useState } from "react";
import {
  useProject,
  useManifest,
  useResolveManifestEntry,
  useLockManifest,
} from "@/shared/hooks";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Modal } from "@/shared/ui/Modal";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { RowSkeleton } from "@/shared/ui/Skeleton";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { useToast } from "@/shared/ui/Toast";
import { statusOf, statusAtOrPast } from "@/shared/status";
import { usd, shortId, vehicleTitle } from "@/shared/format";
import type { ManifestEntry } from "@/shared/api-types";

const CRITICALITY_COLORS: Record<string, string> = {
  critical: "var(--status-failed)",
  high: "var(--signal-amber)",
  medium: "var(--signal-blue)",
  low: "var(--fg-tertiary)",
};

const SOURCING_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  not_started: { label: "Not started", color: "var(--status-halted)" },
  searching: { label: "Searching", color: "var(--status-running)" },
  candidates_found: { label: "Candidates found", color: "var(--signal-blue)" },
  ordered: { label: "Ordered", color: "var(--signal-amber)" },
  received: { label: "Received", color: "var(--status-complete)" },
};

const CONFIDENCE_FLOOR = 0.7;

export function PartsManifest() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const manifest = useManifest(projectId);
  const lockManifest = useLockManifest(projectId);
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ManifestEntry | null>(null);
  const [reviewEntry, setReviewEntry] = useState<ManifestEntry | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);

  const isLocked = project.data ? statusAtOrPast(project.data.status, "manifest_locked") : false;

  const reviewQueue = useMemo(
    () => (manifest.data?.entries ?? []).filter((e) => e.requires_review),
    [manifest.data],
  );

  if (project.isLoading) {
    return (
      <div className="flex flex-col gap-4" style={{ padding: "var(--space-6)" }} aria-live="polite" aria-busy="true">
        <RowSkeleton columns={4} />
        <RowSkeleton columns={4} />
      </div>
    );
  }

  if (project.isError || !project.data) {
    return (
      <div style={{ padding: "var(--space-6)" }}>
        <ErrorBanner title="Couldn't load the manifest" message="The project may not exist or the server is unreachable." retry={() => project.refetch()} retryLoading={project.isFetching} />
      </div>
    );
  }

  const title = vehicleTitle(project.data.vehicle_meta);
  const entries = manifest.data?.entries ?? [];
  const filtered = search
    ? entries.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()) || (e.oem_number ?? "").toLowerCase().includes(search.toLowerCase()))
    : entries;

  const cfg = statusOf(project.data.status);

  async function doLock() {
    try {
      await lockManifest.mutateAsync();
      toast.push("success", "Manifest locked. Budget rules and sourcing can begin.");
      setConfirmLock(false);
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't lock the manifest.");
    }
  }

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-fg-tertiary">
        <Link to="/" className="hover:text-fg-secondary">Jobs</Link>
        <Icon d={ICONS.chevronRight} width={12} height={12} />
        <Link to={`/projects/${projectId}`} className="hover:text-fg-secondary">{title}</Link>
        <Icon d={ICONS.chevronRight} width={12} height={12} />
        <span className="text-fg-secondary">Parts manifest</span>
      </nav>

      <header className="flex items-start gap-4 flex-wrap animate-enter">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Parts manifest</h1>
          <p className="text-sm text-fg-tertiary">{title} · {entries.length} {entries.length === 1 ? "part" : "parts"}</p>
        </div>
        <Badge hue={cfg.pipColor} soft={cfg.softColor} icon={cfg.icon} label={cfg.label} />
      </header>

      {/* Review-queue banner + lock gate */}
      {!isLocked && (
        <Card style={{ padding: "var(--space-4)", borderColor: reviewQueue.length > 0 ? "var(--signal-amber)" : "var(--border-subtle)" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <span style={{ color: reviewQueue.length > 0 ? "var(--signal-amber)" : "var(--status-complete)" }} aria-hidden>
                <Icon d={reviewQueue.length > 0 ? ICONS.alert : ICONS.check} width={18} height={18} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg-primary">
                  {reviewQueue.length > 0
                    ? `${reviewQueue.length} part${reviewQueue.length > 1 ? "s" : ""} need review`
                    : "Review queue is clear"}
                </p>
                <p className="text-xs text-fg-tertiary">
                  {reviewQueue.length > 0
                    ? "Resolve every review flag before locking the manifest."
                    : "You can lock the manifest to start budget and sourcing."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {reviewQueue.length > 0 && (
                <Button variant="secondary" size="sm" icon={ICONS.clipboard} onClick={() => { const first = reviewQueue[0]; if (first) setReviewEntry(first); }}>
                  Review queue
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                icon={ICONS.check}
                disabled={reviewQueue.length > 0 || lockManifest.isPending}
                disabledReason={reviewQueue.length > 0 ? `${reviewQueue.length} review flag${reviewQueue.length > 1 ? "s" : ""} must be resolved first` : undefined}
                loading={lockManifest.isPending}
                onClick={() => setConfirmLock(true)}
              >
                Lock manifest
              </Button>
            </div>
          </div>
        </Card>
      )}

      {isLocked && (
        <Card style={{ padding: "var(--space-3) var(--space-4)", background: "var(--status-complete-soft)" }}>
          <p className="text-sm text-fg-secondary" style={{ margin: 0 }}>
            <Icon d={ICONS.check} width={14} height={14} style={{ verticalAlign: "-0.125rem", color: "var(--status-complete)" }} /> Manifest is locked. Edit budget or sourcing to change parts.
          </p>
        </Card>
      )}

      {/* Search + export */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1" style={{ minWidth: "12rem" }}>
          <span className="absolute" style={{ left: "var(--space-3)", top: "50%", transform: "translateY(-50%)", color: "var(--fg-tertiary)" }} aria-hidden>
            <Icon d={ICONS.search} width={15} height={15} />
          </span>
          <input
            type="search"
            className="input"
            style={{ paddingLeft: "var(--space-8)" }}
            placeholder="Search part name or OEM number"
            aria-label="Search manifest"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="ghost" icon={ICONS.download} disabled disabledReason="CSV export is not available in this build.">
          Export CSV
        </Button>
      </div>

      {/* Table */}
      {manifest.isLoading && (
        <div aria-live="polite" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} columns={5} />)}
        </div>
      )}

      {manifest.isError && (
        <ErrorBanner message="Couldn't load the parts manifest." retry={() => manifest.refetch()} retryLoading={manifest.isFetching} />
      )}

      {!manifest.isLoading && !manifest.isError && entries.length === 0 && (
        <EmptyState
          icon={ICONS.package}
          title="No parts identified yet"
          description="The identification scan hasn't run or hasn't found any parts. Seal the intake to start the scan."
          action={<Link to={`/projects/${projectId}/intake`} className="btn btn-primary btn-sm"><Icon d={ICONS.clipboard} width={15} height={15} />Go to intake</Link>}
        />
      )}

      {!manifest.isLoading && !manifest.isError && filtered.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "0.0625rem solid var(--border-subtle)" }}>
                  <Th>Part</Th>
                  <Th>Criticality</Th>
                  <Th>Sourcing</Th>
                  <Th align="right">Est. cost</Th>
                  <Th align="right">Confidence</Th>
                  <Th align="right"><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => (
                  <ManifestRow
                    key={entry.part_id}
                    entry={entry}
                    projectId={projectId!}
                    onSelect={() => setSelected(entry)}
                    onReview={() => setReviewEntry(entry)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {filtered.length === 0 && entries.length > 0 && (
        <EmptyState icon={ICONS.search} title="No parts match" description={`No parts match "${search}".`} />
      )}

      {selected && (
        <CopilotPanel entry={selected} projectId={projectId!} onClose={() => setSelected(null)} onReview={() => { setReviewEntry(selected); setSelected(null); }} />
      )}

      {reviewEntry && (
        <ReviewDrawer
          entry={reviewEntry}
          projectId={projectId!}
          onClose={() => setReviewEntry(null)}
          onResolveNext={(next) => setReviewEntry(next)}
        />
      )}

      {confirmLock && (
        <Modal
          open
          onClose={() => setConfirmLock(false)}
          title="Lock the parts manifest?"
          description="Locking freezes the parts list. Budget rules and sourcing can begin. You can still edit parts by reopening the manifest from the job room."
          blocking={lockManifest.isPending}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmLock(false)} disabled={lockManifest.isPending}>Cancel</Button>
              <Button variant="primary" loading={lockManifest.isPending} onClick={doLock}>Lock manifest</Button>
            </>
          }
        >
          <p className="text-sm text-fg-secondary">{entries.length} parts will be frozen at their current values.</p>
        </Modal>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary"
      style={{ textAlign: align ?? "left", padding: "var(--space-3) var(--space-4)", letterSpacing: "0.06em" }}
    >
      {children}
    </th>
  );
}

function ManifestRow({ entry, projectId, onSelect, onReview }: {
  entry: ManifestEntry;
  projectId: string;
  onSelect: () => void;
  onReview: () => void;
}) {
  const critColor = CRITICALITY_COLORS[entry.criticality] ?? "var(--fg-tertiary)";
  const sourcing = SOURCING_STATUS_LABELS[entry.sourcing_status] ?? { label: entry.sourcing_status, color: "var(--fg-tertiary)" };
  const confPct = Math.round(entry.confidence * 100);
  const lowConfidence = entry.confidence < CONFIDENCE_FLOOR;

  return (
    <tr
      style={{ borderBottom: "0.0625rem solid var(--border-subtle)", boxShadow: entry.requires_review ? "inset 0.25rem 0 0 var(--signal-amber)" : undefined }}
      className="hover:bg-surface-hover transition-colors"
    >
      <td style={{ padding: "var(--space-3) var(--space-4)" }}>
        <div className="flex items-center gap-2">
          {entry.requires_review && (
            <span style={{ color: "var(--signal-amber)" }} title="Requires review" aria-hidden>
              <Icon d={ICONS.alert} width={14} height={14} />
            </span>
          )}
          <div className="min-w-0">
            <Link to={`/projects/${projectId}/sourcing`} className="text-sm font-medium text-fg-primary hover:text-accent truncate block">
              {entry.name}
            </Link>
            <span className="text-xs text-fg-tertiary tnum">{shortId(entry.part_id)}</span>
            {entry.oem_number && <span className="text-xs text-fg-tertiary tnum" style={{ marginLeft: "var(--space-2)" }}>OEM {entry.oem_number}</span>}
          </div>
        </div>
      </td>
      <td style={{ padding: "var(--space-3) var(--space-4)" }}>
        <Badge hue={critColor} label={entry.criticality} />
        {entry.quantity > 1 && <span className="text-xs text-fg-tertiary tnum" style={{ marginLeft: "var(--space-2)" }}>×{entry.quantity}</span>}
      </td>
      <td style={{ padding: "var(--space-3) var(--space-4)" }}>
        <span className="flex items-center gap-2">
          <span className="pip" style={{ background: sourcing.color, width: "0.375rem", height: "0.375rem", borderRadius: "50%" }} aria-hidden />
          <span className="text-sm text-fg-secondary">{sourcing.label}</span>
        </span>
      </td>
      <td className="tnum text-right text-sm text-fg-secondary" style={{ padding: "var(--space-3) var(--space-4)" }}>
        {usd(entry.estimated_cost_usd)}
      </td>
      <td style={{ padding: "var(--space-3) var(--space-4)" }}>
        <div className="flex items-center gap-2 justify-end">
          <div
            role="progressbar"
            aria-valuenow={confPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Identification confidence ${confPct}%`}
            style={{ width: "3rem", height: "0.25rem", background: "var(--bg-input)", borderRadius: "var(--radius-full)", overflow: "hidden" }}
          >
            <div
              style={{
                width: `${confPct}%`,
                height: "100%",
                background: lowConfidence ? "var(--signal-amber)" : "var(--status-complete)",
                borderRadius: "var(--radius-full)",
              }}
            />
          </div>
          <span className={`tnum text-sm ${lowConfidence ? "text-fg-primary" : "text-fg-secondary"}`} style={{ minWidth: "2.5rem", textAlign: "right" }}>
            {confPct}%
          </span>
        </div>
      </td>
      <td style={{ padding: "var(--space-2) var(--space-3)", textAlign: "right", whiteSpace: "nowrap" }}>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onSelect} aria-label={`Copilot panel for ${entry.name}`} title="Copilot panel">
          <Icon d={ICONS.bolt} width={15} height={15} />
        </button>
        {entry.requires_review && (
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onReview} aria-label={`Review ${entry.name}`} title="Resolve review flag">
            <Icon d={ICONS.alert} width={15} height={15} />
          </button>
        )}
      </td>
    </tr>
  );
}

// Copilot Panel (OBL-55) — per-part actions: why identified, alternatives,
// sourcing difficulty. Renders from local manifest data; sourcing difficulty
// links into the Sourcing Room where the real hunt lives.
function CopilotPanel({ entry, projectId, onClose, onReview }: {
  entry: ManifestEntry;
  projectId: string;
  onClose: () => void;
  onReview: () => void;
}) {
  const lowConfidence = entry.confidence < CONFIDENCE_FLOOR;
  return (
    <Modal
      open
      onClose={onClose}
      title="Copilot panel"
      description={
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-fg-primary font-medium">{entry.name}</span>
          {entry.oem_number && <span className="text-xs text-fg-tertiary tnum">OEM {entry.oem_number}</span>}
        </span>
      }
      style={{ maxWidth: "32rem" }}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-4">
        {/* Why was this identified? */}
        <section>
          <h3 className="text-sm font-semibold text-fg-secondary" style={{ margin: 0 }}>Why was this identified?</h3>
          <dl className="grid grid-cols-2 gap-2" style={{ marginTop: "var(--space-2)" }}>
            <Stat label="Confidence" value={`${Math.round(entry.confidence * 100)}%`} tone={lowConfidence ? "warn" : "ok"} />
            <Stat label="Criticality" value={entry.criticality} />
            <Stat label="Quantity" value={String(entry.quantity)} />
            <Stat label="Est. cost" value={usd(entry.estimated_cost_usd)} />
          </dl>
          {lowConfidence && (
            <p className="text-xs text-fg-tertiary" style={{ marginTop: "var(--space-2)" }}>
              Confidence is below 70%. The scan flagged this for review — verify the identification before sourcing.
            </p>
          )}
        </section>

        {/* Suggest alternatives */}
        <section>
          <h3 className="text-sm font-semibold text-fg-secondary" style={{ margin: 0 }}>Suggest alternatives</h3>
          {entry.aftermarket_alternatives.length > 0 ? (
            <ul className="flex flex-col gap-1" style={{ marginTop: "var(--space-2)" }}>
              {entry.aftermarket_alternatives.map((alt, i) => (
                <li key={i} className="text-sm text-fg-secondary flex items-center gap-2">
                  <Icon d={ICONS.layers} width={14} height={14} style={{ color: "var(--fg-tertiary)" }} />
                  {alt}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-tertiary" style={{ marginTop: "var(--space-2)" }}>
              No aftermarket alternatives recorded. The sourcing room will surface candidates during the hunt.
            </p>
          )}
        </section>

        {/* Check sourcing difficulty */}
        <section>
          <h3 className="text-sm font-semibold text-fg-secondary" style={{ margin: 0 }}>Check sourcing difficulty</h3>
          <p className="text-xs text-fg-tertiary" style={{ marginTop: "var(--space-2)" }}>
            Current sourcing status: <span className="text-fg-secondary">{SOURCING_STATUS_LABELS[entry.sourcing_status]?.label ?? entry.sourcing_status}</span>.
            Open the sourcing room to run or review the hunt for this part.
          </p>
          <div className="flex gap-2" style={{ marginTop: "var(--space-3)" }}>
            <Link to={`/projects/${projectId}/sourcing`}>
              <Button variant="secondary" size="sm" iconRight={ICONS.chevronRight}>Open sourcing room</Button>
            </Link>
            {entry.requires_review && (
              <Button variant="ghost" size="sm" icon={ICONS.alert} onClick={onReview}>Resolve review flag</Button>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" }) {
  return (
    <div>
      <dt className="text-xs text-fg-tertiary">{label}</dt>
      <dd className={`tnum text-sm font-medium ${tone === "warn" ? "text-fg-primary" : "text-fg-primary"}`} style={{ color: tone === "warn" ? "var(--signal-amber)" : undefined }}>
        {value}
      </dd>
    </div>
  );
}

// Review drawer — correct a flagged part then POST manifest/resolve.
function ReviewDrawer({ entry, projectId, onClose, onResolveNext }: {
  entry: ManifestEntry;
  projectId: string;
  onClose: () => void;
  onResolveNext: (next: ManifestEntry | null) => void;
}) {
  const resolve = useResolveManifestEntry(projectId);
  const manifest = useManifest(projectId);
  const toast = useToast();
  const [name, setName] = useState(entry.name);
  const [oem, setOem] = useState(entry.oem_number ?? "");
  const [qty, setQty] = useState(String(entry.quantity));
  const [cost, setCost] = useState(entry.estimated_cost_usd != null ? String(entry.estimated_cost_usd) : "");
  const [touched, setTouched] = useState(false);

  const qtyNum = Number(qty);
  const costNum = cost.trim() === "" ? null : Number(cost);
  const qtyError = touched && (!Number.isFinite(qtyNum) || qtyNum < 1) ? "Quantity must be a whole number ≥ 1" : undefined;
  const costError = touched && costNum != null && (!Number.isFinite(costNum) || costNum < 0) ? "Cost must be a non-negative number" : undefined;
  const canSubmit = Boolean(name.trim()) && Number.isFinite(qtyNum) && qtyNum >= 1 && (costNum == null || (Number.isFinite(costNum) && costNum >= 0));

  const remaining = (manifest.data?.entries ?? []).filter((e) => e.requires_review && e.part_id !== entry.part_id);

  async function doResolve() {
    setTouched(true);
    if (!canSubmit) return;
    try {
      await resolve.mutateAsync({
        partId: entry.part_id,
        fields: {
          name: name.trim(),
          oem_number: oem.trim() || null,
          quantity: Math.round(qtyNum),
          estimated_cost_usd: costNum,
        },
      });
      toast.push("success", `${entry.name} resolved.`);
      const next = remaining[0];
      if (next) {
        onResolveNext(next);
      } else {
        onClose();
      }
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't resolve the review flag.");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Resolve review flag"
      description={
        <span>Correct the identification for <span className="text-fg-primary font-medium">{entry.name}</span> ({shortId(entry.part_id)}).</span>
      }
      blocking={resolve.isPending}
      style={{ maxWidth: "32rem" }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={resolve.isPending}>Cancel</Button>
          <Button variant="primary" loading={resolve.isPending} disabled={!canSubmit} disabledReason={!canSubmit ? "Fix the fields above" : undefined} onClick={doResolve}>
            {remaining.length > 0 ? `Resolve & next (${remaining.length} left)` : "Resolve flag"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input label="Part name" value={name} onChange={(e) => setName(e.target.value)} required error={touched && !name.trim() ? "Name is required" : undefined} />
        <Input label="OEM number" value={oem} onChange={(e) => setOem(e.target.value)} placeholder="Optional" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Quantity" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} error={qtyError} />
          <Input label="Estimated cost (USD)" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Optional" error={costError} />
        </div>
        <div className="flex items-center gap-2" style={{ padding: "var(--space-3)", background: "var(--bg-elevated)", borderRadius: "var(--radius-md)" }}>
          <Icon d={ICONS.alert} width={14} height={14} style={{ color: "var(--signal-amber)" }} />
          <span className="text-xs text-fg-tertiary">
            Confidence was {Math.round(entry.confidence * 100)}%. Your correction overrides the scan and clears the review flag.
          </span>
        </div>
      </div>
    </Modal>
  );
}
