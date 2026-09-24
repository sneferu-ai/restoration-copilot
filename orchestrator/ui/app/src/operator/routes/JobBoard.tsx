// U1 — Job Board. The landing page and the reviewer's audition.
// One dominant field (the job list) + a disciplined right rail (filters +
// attention). All six component states + four lifecycle states implemented.
//
// Patterns mirrored from Linear (DESIGN.md §1): 56px rows, 3px status pip at
// left:0 full-height, tabular numerals on every numeric column, hover
// translateY(-1px) + shadow-1, focus-visible ring offset 2px, one primary
// action per screen with ghosted secondaries.

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useProjects, useCreateProject } from "@/shared/hooks";
import { useSession } from "@/shared/session";
import { useToast } from "@/shared/ui/Toast";
import { Button } from "@/shared/ui/Button";
import { Badge, StatusPip } from "@/shared/ui/Badge";
import { Card } from "@/shared/ui/Card";
import { Input } from "@/shared/ui/Input";
import { Modal } from "@/shared/ui/Modal";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { JobCardSkeleton } from "@/shared/ui/Skeleton";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { statusOf, ATTENTION_ICON } from "@/shared/status";
import { usd, pct, shortId, vehicleTitle, datetime } from "@/shared/format";
import type { RestorationProject } from "@/shared/api-types";
import { ApiError } from "@/shared/http";
import { useQueryClient } from "@tanstack/react-query";

const STATE_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "intake_open", label: "Intake" },
  { value: "intake_sealed", label: "Sealed" },
  { value: "identifying", label: "Identifying" },
  { value: "review_open", label: "Review" },
  { value: "manifest_locked", label: "Manifest" },
  { value: "hunting", label: "Hunting" },
  { value: "hunt_sealed", label: "Hunt sealed" },
  { value: "meshing", label: "Meshing" },
  { value: "published", label: "Published" },
  { value: "in_service", label: "In service" },
  { value: "closed", label: "Closed" },
  { value: "abandoned", label: "Abandoned" },
];

export function JobBoard() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [stateFilter, setStateFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [abandonTarget, setAbandonTarget] = useState<RestorationProject | null>(null);
  const [reopenTarget, setReopenTarget] = useState<RestorationProject | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [parkingId, setParkingId] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const { token } = useSession();
  const qc = useQueryClient();

  // Sync search from URL param (global search in top bar navigates here with ?q=)
  useEffect(() => {
    const q = searchParams.get("q") ?? "";
    setSearch(q);
  }, [searchParams]);

  const query = useProjects({ state: stateFilter || undefined, search: search || undefined });
  const createMutation = useCreateProject();

  const jobs = query.data ?? [];
  const attentionCount = useMemo(() => jobs.filter((j) => j.needs_attention).length, [jobs]);

  function openJob(projectId: string) {
    navigate(`/projects/${projectId}`);
  }

  async function exportPdf(job: RestorationProject) {
    setExportingId(job.project_id);
    try {
      const res = await fetch(`/restoration/projects/${job.project_id}/export-artifact`, {
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
        a.download = `${job.project_id}-report.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.push("success", `${vehicleTitle(job.vehicle_meta)} report downloaded.`);
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
      setExportingId(null);
    }
  }

  async function togglePark(job: RestorationProject) {
    setParkingId(job.project_id);
    try {
      const endpoint = job.parked ? "unpark" : "park";
      const res = await fetch(`/restoration/projects/${job.project_id}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      toast.push("info", job.parked ? "Job unparked." : "Job parked.");
      qc.invalidateQueries({ queryKey: ["projects"] });
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : `Couldn't ${job.parked ? "unpark" : "park"} the job.`);
    } finally {
      setParkingId(null);
    }
  }

  async function reopenJob() {
    if (!reopenTarget) return;
    setReopenSubmitting(true);
    try {
      const res = await fetch(`/restoration/projects/${reopenTarget.project_id}/reopen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: reopenReason.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      toast.push("success", `${vehicleTitle(reopenTarget.vehicle_meta)} reopened.`);
      setReopenTarget(null);
      setReopenReason("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't reopen the job.");
    } finally {
      setReopenSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6" style={{ gridTemplateColumns: "minmax(0, 1fr)", padding: "var(--space-6)" }}>
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Dominant field — the job list (7/12 on desktop, full on mobile) */}
        <section className="lg:col-span-7 xl:col-span-8 flex flex-col gap-4 animate-enter">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="lead-rule text-2xl font-semibold tracking-tight">Jobs</h1>
              <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
                {query.isLoading ? "Loading…" : `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`}
                {attentionCount > 0 && <span style={{ color: "var(--signal-amber)" }}> · {attentionCount} need attention</span>}
              </p>
            </div>
            <Button variant="primary" icon={ICONS.plus} onClick={() => setCreateOpen(true)}>
              Create job
            </Button>
          </div>

          {/* Search + state filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-12rem" style={{ minWidth: "12rem" }}>
              <span className="absolute" style={{ left: "var(--space-3)", top: "50%", transform: "translateY(-50%)", color: "var(--fg-tertiary)" }} aria-hidden>
                <Icon d={ICONS.search} width={15} height={15} />
              </span>
              <input
                type="search"
                className="input"
                style={{ paddingLeft: "var(--space-8)" }}
                placeholder="Search vehicle or project ID"
                aria-label="Search jobs by vehicle or project ID"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-fg-tertiary">
              <span className="sr-only">Filter by state</span>
              <select
                className="input"
                style={{ width: "auto", height: "2.5rem" }}
                aria-label="Filter by state"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
              >
                {STATE_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Lifecycle states */}
          {query.isLoading && (
            <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <JobCardSkeleton key={i} />
              ))}
            </div>
          )}

          {query.isError && (
            <ErrorBanner
              title="Couldn't reach the shop server"
              message="Last readings shown when available — retry when you're back online. If this persists, the restoration pipeline may be paused."
              retry={() => query.refetch()}
              retryLoading={query.isFetching}
            />
          )}

          {!query.isLoading && !query.isError && jobs.length === 0 && (
            <EmptyState
              icon={ICONS.clipboard}
              title="No vehicle jobs yet"
              description="Create your first job to begin a restoration. You'll seal the intake, identify the parts, and start the sourcing hunt."
              action={
                <Button variant="primary" icon={ICONS.plus} onClick={() => setCreateOpen(true)}>
                  Create your first job
                </Button>
              }
            />
          )}

          {!query.isLoading && !query.isError && jobs.length > 0 && (
            <ul className="flex flex-col gap-2" aria-label="Vehicle jobs">
              {jobs.map((job) => (
                <JobCard
                  key={job.project_id}
                  job={job}
                  onOpen={() => openJob(job.project_id)}
                  onAbandon={() => setAbandonTarget(job)}
                  onReopen={() => setReopenTarget(job)}
                  onExportPdf={() => exportPdf(job)}
                  onTogglePark={() => togglePark(job)}
                  exporting={exportingId === job.project_id}
                  parking={parkingId === job.project_id}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Right rail — filters summary + attention (5/12) */}
        <aside className="lg:col-span-5 xl:col-span-4 flex flex-col gap-4 animate-enter stagger-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.08em" }}>
            Attention
          </h2>
          {attentionCount === 0 ? (
            <Card className="flex flex-col gap-1" style={{ padding: "var(--space-4)" }}>
              <p className="text-sm text-fg-secondary">No jobs need attention.</p>
              <p className="text-xs text-fg-tertiary">All hunts are sealed or within budget.</p>
            </Card>
          ) : (
            <ul className="flex flex-col gap-2">
              {jobs
                .filter((j) => j.needs_attention)
                .map((job) => (
                  <li key={job.project_id}>
                    <Card hover interactive onClick={() => openJob(job.project_id)} className="flex items-center gap-3" style={{ padding: "var(--space-3) var(--space-4)" }} aria-label={`Open ${vehicleTitle(job.vehicle_meta)}`}>
                      <span style={{ color: "var(--signal-amber)" }} aria-hidden>
                        <Icon d={ATTENTION_ICON} width={16} height={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg-primary truncate">{vehicleTitle(job.vehicle_meta)}</p>
                        <p className="text-xs text-fg-tertiary truncate">{job.needs_attention}</p>
                      </div>
                      <Icon d={ICONS.chevronRight} width={14} height={14} style={{ color: "var(--fg-tertiary)" }} />
                    </Card>
                  </li>
                ))}
            </ul>
          )}

          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ letterSpacing: "0.08em", marginTop: "var(--space-4)" }}>
            State filter
          </h2>
          <Card className="flex flex-wrap gap-1" style={{ padding: "var(--space-3)" }}>
            {STATE_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStateFilter(f.value)}
                aria-pressed={stateFilter === f.value}
                aria-label={`Filter: ${f.label}`}
                className="btn btn-ghost btn-sm"
                style={
                  stateFilter === f.value
                    ? { background: "var(--accent-soft)", color: "var(--accent)" }
                    : undefined
                }
              >
                {f.label}
              </button>
            ))}
          </Card>
        </aside>
      </div>

      <CreateJobModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        submitting={createMutation.isPending}
        onSubmit={async (input) => {
          try {
            const project = await createMutation.mutateAsync(input);
            toast.push("success", `${vehicleTitle(project.vehicle_meta)} created.`);
            setCreateOpen(false);
            navigate(`/projects/${project.project_id}/intake`);
          } catch (err) {
            toast.push("error", err instanceof ApiError ? err.message : "Couldn't create the job.");
          }
        }}
      />

      <AbandonModal
        job={abandonTarget}
        onClose={() => setAbandonTarget(null)}
        onDone={(message) => {
          toast.push("info", message);
          setAbandonTarget(null);
        }}
      />

      <ReopenModal
        job={reopenTarget}
        reason={reopenReason}
        onReasonChange={setReopenReason}
        onClose={() => { setReopenTarget(null); setReopenReason(""); }}
        onConfirm={reopenJob}
        submitting={reopenSubmitting}
      />
    </div>
  );
}

function JobCard({ job, onOpen, onAbandon, onReopen, onExportPdf, onTogglePark, exporting, parking }: { job: RestorationProject; onOpen: () => void; onAbandon: () => void; onReopen: () => void; onExportPdf: () => void; onTogglePark: () => void; exporting: boolean; parking: boolean }) {
  const cfg = statusOf(job.status);
  const title = vehicleTitle(job.vehicle_meta);
  const overBudget =
    job.budget_ceiling_usd != null &&
    job.actual_spend_usd != null &&
    job.actual_spend_usd > job.budget_ceiling_usd;
  const apiOver = job.api_cost_to_date_usd >= job.api_cost_ceiling_usd;
  const canReopen = job.status === "closed";

  return (
    <li>
      <Card hover className="relative overflow-hidden" style={{ minHeight: "3.5rem" }}>
        <StatusPip color={cfg.pipColor} label={cfg.label} />
        <button
          type="button"
          onClick={onOpen}
          className="w-full text-left flex items-center gap-4"
          style={{ padding: "var(--space-3) var(--space-4) var(--space-3) var(--space-5)", minHeight: "3.5rem" }}
          aria-label={`Open ${title}`}
        >
          <div className="min-w-0 flex-1 flex items-center gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg-primary truncate">{title}</p>
              <p className="text-xs text-fg-tertiary tnum truncate">
                {shortId(job.project_id)} · {datetime(job.updated_at)}
              </p>
            </div>
          </div>

          <Badge hue={cfg.pipColor} soft={cfg.softColor} icon={cfg.icon} label={cfg.label} />

          {job.needs_attention && (
            <span
              className="badge"
              style={{ color: "var(--signal-amber)", background: "var(--signal-amber-soft)", borderColor: "var(--signal-amber)" }}
              title={job.needs_attention}
            >
              <Icon d={ATTENTION_ICON} width={11} height={11} />
              Attention
            </span>
          )}

          {job.parked && (
            <span className="badge" style={{ color: "var(--status-halted)", borderColor: "var(--border-subtle)" }}>
              <Icon d={ICONS.pin} width={11} height={11} />
              Parked
            </span>
          )}

          {job.total_sourcing_coverage_pct != null && (
            <span
              className="text-xs tnum tabular-nums"
              style={{ color: job.total_sourcing_coverage_pct >= 100 ? "var(--status-complete)" : "var(--fg-tertiary)", minWidth: "4.5rem", textAlign: "right" }}
              title="Total sourcing coverage"
            >
              {pct(job.total_sourcing_coverage_pct)}
            </span>
          )}

          <span
            className={`text-xs tnum ${overBudget || apiOver ? "text-status-failed" : "text-fg-tertiary"}`}
            style={{ minWidth: "7rem", textAlign: "right" }}
            title={overBudget ? "Over parts budget" : apiOver ? "Over API cost ceiling" : "API cost to date / ceiling"}
          >
            {usd(job.api_cost_to_date_usd)} / {usd(job.api_cost_ceiling_usd)}
          </span>

          <span style={{ color: "var(--fg-tertiary)" }} aria-hidden>
            <Icon d={ICONS.chevronRight} width={16} height={16} />
          </span>
        </button>

        {/* Secondary action row — ghosted, expanding on selection (DESIGN.md §1 divergence #2) */}
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{ padding: "0 var(--space-4) var(--space-3) var(--space-5)", borderTop: "0.0625rem solid var(--border-subtle)" }}
        >
          <Button variant="ghost" size="sm" icon={ICONS.file} onClick={onExportPdf} loading={exporting} loadingLabel="Exporting…" disabled={job.status === "draft" || job.status === "abandoned"} disabledReason={job.status === "draft" ? "Seal the intake before exporting a report." : job.status === "abandoned" ? "Abandoned jobs can't be exported." : undefined}>
            Export PDF
          </Button>
          <Button variant="ghost" size="sm" icon={ICONS.pin} onClick={onTogglePark} loading={parking} loadingLabel={job.parked ? "Unparking…" : "Parking…"} disabled={job.status === "abandoned" || job.status === "closed"} disabledReason={job.status === "abandoned" ? "Abandoned jobs can't be parked." : job.status === "closed" ? "Closed jobs can't be parked." : undefined}>
            {job.parked ? "Unpark" : "Park"}
          </Button>
          <Button variant="ghost" size="sm" icon={ICONS.alert} onClick={onAbandon} disabled={job.status === "abandoned"} disabledReason={job.status === "abandoned" ? "This job is already abandoned." : undefined}>
            Abandon
          </Button>
          <Button variant="ghost" size="sm" icon={ICONS.refresh} onClick={onReopen} disabled={!canReopen} disabledReason={!canReopen ? "Reopen is available for closed jobs only." : undefined}>
            Reopen
          </Button>
          <span className="text-xs text-fg-disabled" style={{ marginLeft: "auto" }}>
            Lifecycle actions run server-side and log to the run history.
          </span>
        </div>
      </Card>
    </li>
  );
}

function CreateJobModal({
  open,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { vehicle_meta: { year: string; make: string; model: string; trim?: string; engine_code?: string }; budget_ceiling_usd?: number | null }) => Promise<void>;
  submitting: boolean;
}) {
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [engine, setEngine] = useState("");
  const [budget, setBudget] = useState("");
  const valid = year.trim() && make.trim() && model.trim();

  function reset() {
    setYear(""); setMake(""); setModel(""); setTrim(""); setEngine(""); setBudget("");
  }

  async function handle(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    await onSubmit({
      vehicle_meta: {
        year: year.trim(),
        make: make.trim(),
        model: model.trim(),
        trim: trim.trim() || undefined,
        engine_code: engine.trim() || undefined,
      },
      budget_ceiling_usd: budget ? Number(budget) : null,
    });
    reset();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create job"
      description="Enter the vehicle to start a new restoration project."
      blocking={submitting}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            type="submit"
            form="create-job-form"
            variant="primary"
            icon={ICONS.plus}
            loading={submitting}
            loadingLabel="Creating…"
            disabled={!valid}
            disabledReason={!valid ? "Year, make, and model are required." : undefined}
          >
            Create job
          </Button>
        </>
      }
    >
      <form id="create-job-form" onSubmit={handle} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Input label="Year" required value={year} onChange={(e) => setYear(e.target.value)} placeholder="1969" disabled={submitting} />
          <Input label="Make" required value={make} onChange={(e) => setMake(e.target.value)} placeholder="Chevrolet" disabled={submitting} />
        </div>
        <Input label="Model" required value={model} onChange={(e) => setModel(e.target.value)} placeholder="Camaro SS" disabled={submitting} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Trim" value={trim} onChange={(e) => setTrim(e.target.value)} placeholder="RS" disabled={submitting} />
          <Input label="Engine code" value={engine} onChange={(e) => setEngine(e.target.value)} placeholder="396/375" disabled={submitting} />
        </div>
        <Input
          label="Parts budget ceiling (USD)"
          type="number"
          min={1}
          step="0.01"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="Optional — set later"
          disabled={submitting}
          hint="You can override this later with a recorded reason."
        />
      </form>
    </Modal>
  );
}

function AbandonModal({ job, onClose, onDone }: { job: RestorationProject | null; onClose: () => void; onDone: (message: string) => void }) {
  const { token } = useSession();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = job !== null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!job || !reason.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/restoration/projects/${job.project_id}/abandon`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      onDone(`${vehicleTitle(job.vehicle_meta)} abandoned: ${reason.trim()}`);
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't abandon the job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        setReason("");
        setError(null);
        onClose();
      }}
      title="Abandon job"
      description={job ? `${vehicleTitle(job.vehicle_meta)} — ${shortId(job.project_id)}` : undefined}
      blocking={submitting}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            type="submit"
            form="abandon-form"
            variant="danger"
            loading={submitting}
            loadingLabel="Abandoning…"
            disabled={!reason.trim()}
            disabledReason={!reason.trim() ? "A reason is required to abandon a job." : undefined}
          >
            Abandon job
          </Button>
        </>
      }
    >
      <form id="abandon-form" onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Customer cancelled, frame beyond repair"
          disabled={submitting}
          error={error}
          hint="The reason is recorded in the run history and cannot be undone without reopening."
        />
      </form>
    </Modal>
  );
}

function ReopenModal({
  job,
  reason,
  onReasonChange,
  onClose,
  onConfirm,
  submitting,
}: {
  job: RestorationProject | null;
  reason: string;
  onReasonChange: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  if (!job) return null;
  const title = vehicleTitle(job.vehicle_meta);
  return (
    <Modal
      open={Boolean(job)}
      onClose={onClose}
      title={`Reopen ${title}`}
      description="Reopening transitions this job back to an active state so you can continue work."
      blocking={submitting}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" icon={ICONS.refresh} loading={submitting} loadingLabel="Reopening…" onClick={onConfirm}>
            Reopen job
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-secondary">
          Status: <Badge hue={statusOf(job.status).pipColor} label={statusOf(job.status).label} />
        </p>
        <Input
          label="Reason (optional)"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          placeholder="e.g. Customer wants to resume, parts found"
          disabled={submitting}
          hint="The reason is recorded in the run history."
        />
      </div>
    </Modal>
  );
}
