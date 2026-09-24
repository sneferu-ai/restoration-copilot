// Budget tab (U4 core). Budget ruling form + override (gated per §9 footnote),
// API-cost card with override (auto-opens on #override, OBL-8), sourcing
// summary (coverage, candidates, flags), hunt controls, manual candidate,
// record purchase. All transitions server-authoritative (useAuditMutation).

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { api, ApiError } from "@shared/api-client";
import { keys } from "@shared/keys";
import { useAuditMutation, useCrudMutation } from "@shared/mutations";
import { useReadOnly } from "@shared/hooks";
import { Chip, EmptyState, InlineError, ProgressBar, SkeletonRows, SafeLink } from "@shared/components";
import { Modal } from "@shared/modal";
import { fmtUsd, fmtDateTime } from "@shared/format";
import { loadPurchases, savePurchase } from "@shared/console-db";
import type {
  ApiCostSummary,
  LedgerEntry,
  Manifest,
  RestorationProject,
  SourceRegistryEntry,
  SourcingSummary,
} from "@shared/types";

const RULING_LABEL: Record<string, { label: string; tone: "ok" | "accent" | "signal" }> = {
  affordable: { label: "Affordable", tone: "ok" },
  tight: { label: "Tight", tone: "accent" },
  shortfall_critical: { label: "Shortfall — critical", tone: "signal" },
  insufficient_data: { label: "Insufficient data", tone: "signal" },
};

interface RulingResponse {
  ruling: string;
  detail?: {
    total_estimated_cost_usd?: number;
    allocation?: Record<string, number>;
  };
  unknown_cost_count?: number;
}

export function BudgetTab({ project }: { project: RestorationProject }) {
  const readOnly = useReadOnly();
  const location = useLocation();
  const [ceiling, setCeiling] = useState(
    project.budget_ceiling_usd != null ? String(project.budget_ceiling_usd) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [lastRuling, setLastRuling] = useState<RulingResponse | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [apiOverrideOpen, setApiOverrideOpen] = useState(false);
  const [apiOverrideReason, setApiOverrideReason] = useState("");
  const [sealPartialOpen, setSealPartialOpen] = useState(false);
  const [sealReason, setSealReason] = useState("");
  const [candidateForm, setCandidateForm] = useState({
    part_id: "",
    vendor: "",
    price_usd: "",
    condition: "used",
    availability: "in_stock",
    url_or_contact: "",
  });
  const [purchaseForm, setPurchaseForm] = useState({
    part_id: "",
    vendor: "",
    price_usd: "",
    condition: "used",
    notes: "",
  });
  // Source registry (FR-012, §6.4 — global CRUD, optimistic per OBL-49).
  const [sourceForm, setSourceForm] = useState({
    vendor_name: "",
    url: "",
    specialty: "",
    search_template: "",
    contact_info: "",
    is_trade_partner: false,
    rate_limit_seconds: "2",
  });
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const qc = useQueryClient();

  // OBL-8: #override fragment auto-opens the API-cost override form.
  useEffect(() => {
    if (location.hash === "#override") setApiOverrideOpen(true);
  }, [location.hash]);

  const sourcing = useQuery({
    queryKey: keys.sourcing(project.project_id),
    queryFn: () => api<SourcingSummary>(`/restoration/projects/${project.project_id}/sourcing`),
    refetchInterval: project.status === "hunting" ? 3000 : false,
  });

  const apiCosts = useQuery({
    queryKey: keys.apiCosts(project.project_id),
    queryFn: () => api<ApiCostSummary>(`/restoration/projects/${project.project_id}/api-costs`),
  });

  // §6.0 Layer 3: load manifest to power the OEM mismatch warning on candidates
  // (U4 candidate selection — soul-brief core feature). Computed from already-
  // loaded data, no new endpoints (OBL-66).
  const manifest = useQuery({
    queryKey: keys.manifest(project.project_id),
    queryFn: () => api<Manifest>(`/restoration/projects/${project.project_id}/manifest`),
    retry: (count, err) =>
      err instanceof ApiError && err.status === 404 ? false : count < 2,
  });

  const oemByPartId = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of manifest.data?.entries ?? []) {
      if (e.oem_number) m.set(e.part_id, e.oem_number.toUpperCase());
    }
    return m;
  }, [manifest.data]);

  // Source registry — global (keys.sources() has no project id, so the query
  // is deduped across projects). OBL-49: optimistic CRUD with rollback.
  const sources = useQuery({
    queryKey: keys.sources(),
    queryFn: () => api<SourceRegistryEntry[]>(`/restoration/sources`),
  });

  // U4 session ledger — IndexedDB mirror (§16 item 8). Best-effort; never
  // throws. Refreshed by invalidating keys.ledger() after a purchase mirrors.
  const ledger = useQuery({
    queryKey: keys.ledger(project.project_id),
    queryFn: () => loadPurchases(project.project_id),
  });

  const rulingMutation = useAuditMutation<RulingResponse, number>({
    mutationFn: (value) =>
      api<RulingResponse>(`/restoration/projects/${project.project_id}/budget`, {
        body: { budget_ceiling_usd: value },
      }),
    invalidateKeys: [keys.project(project.project_id)],
    onError: (err) => setError(err.message),
    onSuccess: (res) => {
      setError(null);
      setLastRuling(res);
      if (res.ruling === "shortfall_critical" || res.ruling === "insufficient_data") {
        setOverrideOpen(true);
      }
    },
  });

  const budgetOverride = useAuditMutation<unknown, string>({
    mutationFn: (reason) =>
      api(`/restoration/projects/${project.project_id}/budget/override`, { body: { reason } }),
    invalidateKeys: [keys.project(project.project_id)],
    onError: (err) => setError(err.message),
    onSuccess: () => {
      setError(null);
      setOverrideOpen(false);
      setOverrideReason("");
    },
  });

  const apiOverride = useAuditMutation<unknown, string>({
    mutationFn: (reason) =>
      api(`/restoration/projects/${project.project_id}/api-cost/override`, { body: { reason } }),
    invalidateKeys: [keys.apiCosts(project.project_id), keys.project(project.project_id)],
    onError: (err) => setError(err.message),
    onSuccess: () => {
      setError(null);
      setApiOverrideOpen(false);
      setApiOverrideReason("");
    },
  });

  const hunt = useAuditMutation<unknown, { kind: string; body?: Record<string, unknown> }>({
    mutationFn: ({ kind, body }) =>
      api(`/restoration/projects/${project.project_id}/${kind}`, { body: body ?? {} }),
    invalidateKeys: [keys.sourcing(project.project_id), keys.project(project.project_id)],
    onError: (err) => {
      // 409 "API cost ceiling reached" → cross-panel override surface (OBL-8)
      if (err.status === 409 && /api cost/i.test(err.message)) {
        window.dispatchEvent(
          new CustomEvent("rc:navigate-to-wallet-override", {
            detail: { projectId: project.project_id },
          }),
        );
      }
      setError(err.message);
    },
    onSuccess: () => {
      setError(null);
      setSealPartialOpen(false);
      setSealReason("");
    },
  });

  const addCandidate = useAuditMutation<unknown, Record<string, unknown>>({
    mutationFn: (body) =>
      api(`/restoration/projects/${project.project_id}/sourcing/manual`, { body }),
    invalidateKeys: [keys.sourcing(project.project_id), keys.project(project.project_id)],
    onError: (err) => setError(err.message),
    onSuccess: () => {
      setError(null);
      setCandidateForm({
        part_id: "",
        vendor: "",
        price_usd: "",
        condition: "used",
        availability: "in_stock",
        url_or_contact: "",
      });
    },
  });

  const purchase = useAuditMutation<unknown, Record<string, unknown>>({
    mutationFn: (body) => api(`/restoration/projects/${project.project_id}/purchase`, { body }),
    invalidateKeys: [keys.project(project.project_id)],
    onError: (err) => setError(err.message),
    onSuccess: (_res, body) => {
      setError(null);
      setPurchaseForm({ part_id: "", vendor: "", price_usd: "", condition: "used", notes: "" });
      // U4 ledger (AC-UI-011, OBL-19): mirror into IndexedDB so the session
      // record survives F5. The server's actual_spend_usd stays authoritative.
      const price = Number(body.price_usd);
      if (Number.isFinite(price) && price > 0) {
        const entry: LedgerEntry = {
          id: `${project.project_id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          project_id: project.project_id,
          part_id: String(body.part_id ?? ""),
          vendor: String(body.vendor ?? ""),
          price_usd: price,
          condition: String(body.condition ?? "used"),
          notes: body.notes ? String(body.notes) : null,
          recorded_at: Date.now(),
        };
        void savePurchase(entry).then(() =>
          qc.invalidateQueries({ queryKey: keys.ledger(project.project_id) }),
        );
      }
    },
  });

  // -- Source registry CRUD (FR-012, OBL-49 optimistic with rollback) --------
  const addSource = useCrudMutation<{ source_id: string }, SourceRegistryEntry, { previous?: SourceRegistryEntry[] }>({
    mutationFn: (entry) => api(`/restoration/sources`, { body: entry }),
    invalidateKeys: [keys.sources()],
    onMutate: async (entry) => {
      const qk = keys.sources();
      await qc.cancelQueries({ queryKey: qk });
      const previous = qc.getQueryData<SourceRegistryEntry[]>(qk);
      if (previous) qc.setQueryData<SourceRegistryEntry[]>(qk, [...previous, entry]);
      return { previous };
    },
    onError: (_err, _entry, context) => {
      if (context?.previous) qc.setQueryData(keys.sources(), context.previous);
      setSourceError("Source could not be saved. Reverted.");
    },
    onSuccess: () => resetSourceForm(),
  });

  const updateSource = useCrudMutation<{ entry: SourceRegistryEntry }, SourceRegistryEntry, { previous?: SourceRegistryEntry[] }>({
    mutationFn: (entry) => api(`/restoration/sources/${entry.source_id}`, { body: entry, method: "PUT" }),
    invalidateKeys: [keys.sources()],
    onMutate: async (entry) => {
      const qk = keys.sources();
      await qc.cancelQueries({ queryKey: qk });
      const previous = qc.getQueryData<SourceRegistryEntry[]>(qk);
      if (previous) qc.setQueryData<SourceRegistryEntry[]>(qk, previous.map((s) => (s.source_id === entry.source_id ? entry : s)));
      return { previous };
    },
    onError: (_err, _entry, context) => {
      if (context?.previous) qc.setQueryData(keys.sources(), context.previous);
      setSourceError("Source could not be updated. Reverted.");
    },
    onSuccess: () => resetSourceForm(),
  });

  const deleteSource = useCrudMutation<{ deleted: boolean; source_id: string }, string, { previous?: SourceRegistryEntry[] }>({
    mutationFn: (sourceId) => api(`/restoration/sources/${sourceId}`, { method: "DELETE" }),
    invalidateKeys: [keys.sources()],
    onMutate: async (sourceId) => {
      const qk = keys.sources();
      await qc.cancelQueries({ queryKey: qk });
      const previous = qc.getQueryData<SourceRegistryEntry[]>(qk);
      if (previous) qc.setQueryData<SourceRegistryEntry[]>(qk, previous.filter((s) => s.source_id !== sourceId));
      return { previous };
    },
    onError: (_err, _sourceId, context) => {
      if (context?.previous) qc.setQueryData(keys.sources(), context.previous);
      setSourceError("Source could not be deleted. Reverted.");
    },
  });

  function resetSourceForm() {
    setSourceForm({
      vendor_name: "",
      url: "",
      specialty: "",
      search_template: "",
      contact_info: "",
      is_trade_partner: false,
      rate_limit_seconds: "2",
    });
    setEditingSourceId(null);
    setSourceError(null);
  }

  function submitSource(e: React.FormEvent) {
    e.preventDefault();
    setSourceError(null);
    const vendor = sourceForm.vendor_name.trim();
    if (!vendor) {
      setSourceError("Vendor name is required.");
      return;
    }
    const rate = Number(sourceForm.rate_limit_seconds);
    const payload: SourceRegistryEntry = {
      source_id: editingSourceId ?? `src-${vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 18)}-${Math.random().toString(36).slice(2, 6)}`,
      vendor_name: vendor,
      url: sourceForm.url.trim(),
      search_template: sourceForm.search_template.trim() || null,
      specialty: sourceForm.specialty.trim() || null,
      is_trade_partner: sourceForm.is_trade_partner,
      contact_info: sourceForm.contact_info.trim() || null,
      rate_limit_seconds: Number.isFinite(rate) && rate >= 0 ? Math.round(rate) : 2,
    };
    if (editingSourceId) updateSource.mutate(payload);
    else addSource.mutate(payload);
  }

  function editSource(s: SourceRegistryEntry) {
    setEditingSourceId(s.source_id);
    setSourceForm({
      vendor_name: s.vendor_name,
      url: s.url ?? "",
      specialty: s.specialty ?? "",
      search_template: s.search_template ?? "",
      contact_info: s.contact_info ?? "",
      is_trade_partner: s.is_trade_partner,
      rate_limit_seconds: String(s.rate_limit_seconds ?? 2),
    });
    setSourceError(null);
  }

  function removeSource(s: SourceRegistryEntry) {
    setSourceError(null);
    deleteSource.mutate(s.source_id);
  }

  const summary = sourcing.data;
  const candidates = summary?.candidates ?? [];
  const flags = summary?.flags ?? [];
  const partIds = Array.from(new Set(candidates.map((c) => c.part_id)));

  return (
    <div className="flex flex-col gap-4">
      {/* Budget ruling */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Budget</h2>
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Number(ceiling);
            if (!Number.isFinite(value) || value <= 0) {
              setError("Budget ceiling must be a positive number (USD).");
              return;
            }
            rulingMutation.mutate(value);
          }}
        >
          <div>
            <label htmlFor="ceiling" className="label">
              Ceiling (USD)
            </label>
            <input
              id="ceiling"
              className="input w-44 tnum"
              inputMode="decimal"
              placeholder="8500"
              value={ceiling}
              onChange={(e) => setCeiling(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={readOnly || rulingMutation.isPending}
            title={readOnly ? "Unavailable while offline" : undefined}
            data-testid="set-budget"
          >
            {rulingMutation.isPending ? "Ruling…" : "Set budget"}
          </button>
          {project.budget_ceiling_usd != null && (
            <Chip label="current ceiling" value={fmtUsd(project.budget_ceiling_usd)} />
          )}
        </form>
        {(lastRuling || project.budget_ceiling_usd != null) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="budget-ruling">
            {lastRuling && (
              <>
                <Chip
                  label="ruling"
                  value={RULING_LABEL[lastRuling.ruling]?.label ?? lastRuling.ruling}
                  tone={RULING_LABEL[lastRuling.ruling]?.tone ?? "muted"}
                />
                {lastRuling.detail?.total_estimated_cost_usd != null && (
                  <Chip
                    label="est. total"
                    value={fmtUsd(lastRuling.detail.total_estimated_cost_usd)}
                  />
                )}
                {lastRuling.detail?.allocation &&
                  Object.entries(lastRuling.detail.allocation).map(([tier, perPart]) => (
                    <Chip
                      key={tier}
                      label={`${tier}/part`}
                      value={fmtUsd(perPart)}
                      title="Per-part allocation from the 60/30/10 tier rule"
                    />
                  ))}
              </>
            )}
            {project.budget_override_reason && (
              <Chip
                label="overridden"
                value={project.budget_override_reason}
                tone="accent"
                title="Budget ruling overridden by operator"
              />
            )}
          </div>
        )}
      </section>

      {/* API cost */}
      <section className="card p-4" id="api-cost">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">API cost</h2>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setApiOverrideOpen(true)}
            disabled={readOnly}
            title={readOnly ? "Unavailable while offline" : "Override the API cost ceiling (audited)"}
            data-testid="api-cost-override-open"
          >
            Override ceiling
          </button>
        </div>
        {apiCosts.isPending && <SkeletonRows rows={2} />}
        {apiCosts.isError && <InlineError message={`API cost failed to load: ${apiCosts.error.message}`} />}
        {apiCosts.data && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <span className="tnum text-xl font-semibold">
                {fmtUsd(apiCosts.data.total ?? project.api_cost_to_date_usd)}
              </span>
              <span className="text-sm text-muted tnum">
                of {fmtUsd(apiCosts.data.ceiling ?? project.api_cost_ceiling_usd)} ceiling
                {apiCosts.data.pct_of_ceiling != null && ` · ${apiCosts.data.pct_of_ceiling}%`}
              </span>
            </div>
            <ProgressBar
              value={apiCosts.data.total ?? 0}
              max={apiCosts.data.ceiling ?? 1}
              tone={(apiCosts.data.pct_of_ceiling ?? 0) >= 80 ? "signal" : "accent"}
              label="API cost vs ceiling"
            />
            {apiCosts.data.per_provider && Object.keys(apiCosts.data.per_provider).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(apiCosts.data.per_provider).map(([provider, total]) => (
                  <Chip key={provider} label={provider} value={fmtUsd(total)} mono />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Sourcing */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Sourcing</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={readOnly || hunt.isPending || project.status === "hunting"}
              title={
                project.status === "hunting"
                  ? "Hunt already running"
                  : readOnly
                    ? "Unavailable while offline"
                    : undefined
              }
              onClick={() => hunt.mutate({ kind: "source" })}
              data-testid="start-hunt"
            >
              Start hunt
            </button>
            {project.status === "hunting" && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={readOnly || hunt.isPending}
                  onClick={() => hunt.mutate({ kind: "sourcing/pause" })}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={readOnly || hunt.isPending}
                  onClick={() => hunt.mutate({ kind: "sourcing/resume" })}
                >
                  Resume
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={readOnly || hunt.isPending}
                  onClick={() => hunt.mutate({ kind: "sourcing/seal" })}
                  data-testid="seal-hunt"
                >
                  Seal sourcing
                </button>
              </>
            )}
            {project.status === "sourcing_insufficient" && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={readOnly || hunt.isPending}
                onClick={() => setSealPartialOpen(true)}
                title="Seal below the coverage floor — requires a reason (audited)"
              >
                Seal partial…
              </button>
            )}
          </div>
        </div>
        {sourcing.isPending && <SkeletonRows rows={3} />}
        {sourcing.isError && (
          <InlineError message={`Sourcing summary failed to load: ${sourcing.error.message}`} />
        )}
        {summary && (
          <div className="mt-2 flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              <Chip
                label="total coverage"
                value={summary.total_coverage != null ? `${summary.total_coverage}%` : "—"}
                tone={(summary.total_coverage ?? 0) >= 50 ? "ok" : "accent"}
              />
              <Chip
                label="system"
                value={summary.system_coverage != null ? `${summary.system_coverage}%` : "—"}
              />
              <Chip
                label="critical path"
                value={summary.critical_coverage != null ? `${summary.critical_coverage}%` : "—"}
                tone={(summary.critical_coverage ?? 0) >= 50 ? "ok" : "signal"}
              />
              <Chip label="parts" value={String(summary.total_parts ?? 0)} />
            </div>
            {candidates.length === 0 && flags.length === 0 && (
              <EmptyState
                title="No candidates yet"
                body="Start the hunt or add a candidate manually — every lead lands here with provenance."
              />
            )}
            {candidates.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm" data-testid="candidate-table">
                  <thead>
                    <tr className="border-b border-border-default text-left text-xs text-faint">
                      <th className="py-1.5 pr-3 font-medium">Part</th>
                      <th className="py-1.5 pr-3 font-medium">Vendor</th>
                      <th className="py-1.5 pr-3 font-medium">OEM</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Price</th>
                      <th className="py-1.5 pr-3 font-medium">Cond.</th>
                      <th className="py-1.5 pr-3 font-medium">Avail.</th>
                      <th className="py-1.5 pr-3 font-medium">Source</th>
                      <th className="py-1.5 font-medium">Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => {
                      const manifestOem = oemByPartId.get(c.part_id);
                      const oemMismatch =
                        manifestOem != null &&
                        c.oem_number != null &&
                        c.oem_number.trim() !== "" &&
                        c.oem_number.trim().toUpperCase() !== manifestOem;
                      return (
                        <tr key={c.candidate_id} className="border-b border-border-subtle last:border-0">
                          <td className="py-1.5 pr-3 font-mono text-xs tnum">{c.part_id}</td>
                          <td className="py-1.5 pr-3">{c.vendor}</td>
                          <td className="py-1.5 pr-3 font-mono text-xs tnum">
                            {c.oem_number ?? "—"}
                            {oemMismatch && (
                              <span
                                className="ml-1 text-signal"
                                title={`OEM mismatch — manifest says ${manifestOem}. Verify before buying.`}
                                aria-label={`OEM mismatch — manifest says ${manifestOem}`}
                                data-testid={`oem-mismatch-${c.candidate_id}`}
                              >
                                ▲
                              </span>
                            )}
                          </td>
                        <td className="py-1.5 pr-3 text-right tnum">{fmtUsd(c.price_usd)}</td>
                        <td className="py-1.5 pr-3 text-muted">{c.condition}</td>
                        <td className="py-1.5 pr-3 text-muted">{c.availability.replace(/_/g, " ")}</td>
                        <td className="py-1.5 pr-3 text-xs text-faint">{c.provenance}</td>
                        <td className="py-1.5">
                          {c.url_or_contact ? (
                            <SafeLink href={c.url_or_contact} target="_blank" rel="noreferrer">
                              link
                            </SafeLink>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {flags.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-signal">Unsourceable flags</h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {flags.map((f) => (
                    <li key={f.part_id} className="flex gap-2">
                      <span className="font-mono text-xs tnum">{f.part_id}</span>
                      <span className="text-muted">
                        {f.reason_code.replace(/_/g, " ")}
                        {f.alternative_suggestion ? ` — ${f.alternative_suggestion}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Manual candidate + purchase */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-lg font-semibold">Add candidate manually</h2>
          <form
            className="mt-2 grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!candidateForm.part_id.trim() || !candidateForm.vendor.trim()) {
                setError("Part and vendor are required.");
                return;
              }
              addCandidate.mutate({
                part_id: candidateForm.part_id.trim(),
                vendor: candidateForm.vendor.trim(),
                price_usd: candidateForm.price_usd ? Number(candidateForm.price_usd) : null,
                condition: candidateForm.condition,
                availability: candidateForm.availability,
                url_or_contact: candidateForm.url_or_contact.trim(),
                tradeable: false,
              });
            }}
          >
            <div>
              <label htmlFor="mc-part" className="label">Part ID</label>
              <input
                id="mc-part"
                className="input font-mono"
                value={candidateForm.part_id}
                onChange={(e) => setCandidateForm((f) => ({ ...f, part_id: e.target.value }))}
                list="mc-part-ids"
              />
              <datalist id="mc-part-ids">
                {partIds.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor="mc-vendor" className="label">Vendor</label>
              <input
                id="mc-vendor"
                className="input"
                value={candidateForm.vendor}
                onChange={(e) => setCandidateForm((f) => ({ ...f, vendor: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="mc-price" className="label">Price (USD)</label>
              <input
                id="mc-price"
                className="input tnum"
                inputMode="decimal"
                value={candidateForm.price_usd}
                onChange={(e) => setCandidateForm((f) => ({ ...f, price_usd: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="mc-cond" className="label">Condition</label>
              <select
                id="mc-cond"
                className="input"
                value={candidateForm.condition}
                onChange={(e) => setCandidateForm((f) => ({ ...f, condition: e.target.value }))}
              >
                <option value="new">new</option>
                <option value="used">used</option>
                <option value="rebuilt">rebuilt</option>
                <option value="nos">nos</option>
              </select>
            </div>
            <div>
              <label htmlFor="mc-avail" className="label">Availability</label>
              <select
                id="mc-avail"
                className="input"
                value={candidateForm.availability}
                onChange={(e) => setCandidateForm((f) => ({ ...f, availability: e.target.value }))}
              >
                <option value="in_stock">in stock</option>
                <option value="backorder">backorder</option>
                <option value="special_order">special order</option>
              </select>
            </div>
            <div>
              <label htmlFor="mc-url" className="label">URL or contact</label>
              <input
                id="mc-url"
                className="input"
                value={candidateForm.url_or_contact}
                onChange={(e) => setCandidateForm((f) => ({ ...f, url_or_contact: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={readOnly || addCandidate.isPending}
                aria-label={addCandidate.isPending ? "Adding candidate" : "Add candidate"}
              >
                {addCandidate.isPending ? "Adding…" : "Add candidate"}
              </button>
            </div>
          </form>
        </section>

        <section className="card p-4">
          <h2 className="text-lg font-semibold">Record purchase</h2>
          <p className="mt-0.5 text-xs text-muted">
            Server spend total stays authoritative; records land in the audit log.
          </p>
          <form
            className="mt-2 grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!purchaseForm.part_id.trim() || !purchaseForm.vendor.trim()) {
                setError("Part and vendor are required.");
                return;
              }
              const price = Number(purchaseForm.price_usd);
              if (!Number.isFinite(price) || price <= 0) {
                setError("Purchase price must be a positive number (USD).");
                return;
              }
              purchase.mutate({
                part_id: purchaseForm.part_id.trim(),
                vendor: purchaseForm.vendor.trim(),
                price_usd: price,
                condition: purchaseForm.condition,
                ordered_at: new Date().toISOString(),
                notes: purchaseForm.notes || null,
              });
            }}
          >
            <div>
              <label htmlFor="po-part" className="label">Part ID</label>
              <input
                id="po-part"
                className="input font-mono"
                value={purchaseForm.part_id}
                onChange={(e) => setPurchaseForm((f) => ({ ...f, part_id: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="po-vendor" className="label">Vendor</label>
              <input
                id="po-vendor"
                className="input"
                value={purchaseForm.vendor}
                onChange={(e) => setPurchaseForm((f) => ({ ...f, vendor: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="po-price" className="label">Price (USD)</label>
              <input
                id="po-price"
                className="input tnum"
                inputMode="decimal"
                value={purchaseForm.price_usd}
                onChange={(e) => setPurchaseForm((f) => ({ ...f, price_usd: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="po-cond" className="label">Condition</label>
              <select
                id="po-cond"
                className="input"
                value={purchaseForm.condition}
                onChange={(e) => setPurchaseForm((f) => ({ ...f, condition: e.target.value }))}
              >
                <option value="new">new</option>
                <option value="used">used</option>
                <option value="rebuilt">rebuilt</option>
                <option value="nos">nos</option>
              </select>
            </div>
            <div className="col-span-2">
              <label htmlFor="po-notes" className="label">Notes <span className="text-faint">(optional)</span></label>
              <input
                id="po-notes"
                className="input"
                value={purchaseForm.notes}
                onChange={(e) => setPurchaseForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={readOnly || purchase.isPending}
                aria-label={purchase.isPending ? "Recording purchase" : "Record purchase"}
              >
                {purchase.isPending ? "Recording…" : "Record purchase"}
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* U4 session ledger — IndexedDB mirror + honest banner + Server vs Local
          totals (AC-UI-011, OBL-19, §16 item 8). The server's actual_spend_usd
          is authoritative; local records are session-only until REP-4. */}
      <section className="card p-4" aria-labelledby="ledger-heading">
        <h2 id="ledger-heading" className="text-lg font-semibold">Purchase ledger</h2>
        <div
          className="mt-2 rounded-md border border-border-subtle bg-elevated px-3 py-2 text-sm text-muted"
          role="note"
          data-testid="ledger-banner"
        >
          Local records are session-only — they survive a refresh but are not the
          source of truth. The server total below is authoritative.
        </div>
        <div
          className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm"
          data-testid="ledger-totals"
        >
          <span className="tnum">
            <span className="text-faint">Server total: </span>
            <span className="font-semibold">{fmtUsd(project.actual_spend_usd)}</span>
          </span>
          <span className="tnum">
            <span className="text-faint">Local records: </span>
            <span className="font-semibold">
              {fmtUsd((ledger.data ?? []).reduce((sum, e) => sum + e.price_usd, 0))}
            </span>
          </span>
        </div>
        {ledger.isPending && <SkeletonRows rows={2} />}
        {ledger.isSuccess && ledger.data.length === 0 && (
          <p className="mt-3 text-sm text-muted" data-testid="ledger-empty">
            No purchases recorded this session. Record a purchase above to start the ledger.
          </p>
        )}
        {ledger.isSuccess && ledger.data.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-faint">
                  <th className="py-1.5 pr-3">Part</th>
                  <th className="py-1.5 pr-3">Vendor</th>
                  <th className="py-1.5 pr-3 text-right">Price</th>
                  <th className="py-1.5 pr-3">Condition</th>
                  <th className="py-1.5 pr-3">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.map((e) => (
                  <tr key={e.id} className="border-t border-border-subtle">
                    <td className="py-1.5 pr-3 font-mono text-xs tnum">{e.part_id || "—"}</td>
                    <td className="py-1.5 pr-3">{e.vendor || "—"}</td>
                    <td className="py-1.5 pr-3 text-right tnum">{fmtUsd(e.price_usd)}</td>
                    <td className="py-1.5 pr-3 text-muted">{e.condition}</td>
                    <td className="py-1.5 pr-3 text-xs text-faint tnum">{fmtDateTime(new Date(e.recorded_at).toISOString())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Source registry (FR-012, §6.4) — global CRUD, optimistic (OBL-49). */}
      <section className="card p-4" aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="text-lg font-semibold">Source registry</h2>
        <p className="mt-0.5 text-sm text-muted">
          Vendor sources the sourcing hunt consults. Global across all jobs.
        </p>
        <form className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submitSource}>
          <div>
            <label htmlFor="src-vendor" className="label">Vendor name <span className="text-signal">*</span></label>
            <input
              id="src-vendor"
              className="input"
              value={sourceForm.vendor_name}
              onChange={(e) => setSourceForm((f) => ({ ...f, vendor_name: e.target.value }))}
              placeholder="Classic Industries"
              required
            />
          </div>
          <div>
            <label htmlFor="src-url" className="label">URL</label>
            <input
              id="src-url"
              className="input"
              value={sourceForm.url}
              onChange={(e) => setSourceForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://example.com/search?q={oem}"
              inputMode="url"
            />
          </div>
          <div>
            <label htmlFor="src-specialty" className="label">Specialty</label>
            <input
              id="src-specialty"
              className="input"
              value={sourceForm.specialty}
              onChange={(e) => setSourceForm((f) => ({ ...f, specialty: e.target.value }))}
              placeholder="First-gen Camaro sheet metal"
            />
          </div>
          <div>
            <label htmlFor="src-template" className="label">Search template</label>
            <input
              id="src-template"
              className="input font-mono"
              value={sourceForm.search_template}
              onChange={(e) => setSourceForm((f) => ({ ...f, search_template: e.target.value }))}
              placeholder="{oem_number} {make} {year}"
            />
          </div>
          <div>
            <label htmlFor="src-contact" className="label">Contact info</label>
            <input
              id="src-contact"
              className="input"
              value={sourceForm.contact_info}
              onChange={(e) => setSourceForm((f) => ({ ...f, contact_info: e.target.value }))}
              placeholder="orders@example.com"
            />
          </div>
          <div>
            <label htmlFor="src-rate" className="label">Rate limit (seconds)</label>
            <input
              id="src-rate"
              className="input tnum"
              inputMode="numeric"
              value={sourceForm.rate_limit_seconds}
              onChange={(e) => setSourceForm((f) => ({ ...f, rate_limit_seconds: e.target.value }))}
              placeholder="2"
            />
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <input
              id="src-trade"
              type="checkbox"
              className="h-4 w-4"
              checked={sourceForm.is_trade_partner}
              onChange={(e) => setSourceForm((f) => ({ ...f, is_trade_partner: e.target.checked }))}
            />
            <label htmlFor="src-trade" className="text-sm">Trade partner</label>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={readOnly || addSource.isPending || updateSource.isPending}
              aria-label={editingSourceId ? "Update source" : "Add source"}
            >
              {(addSource.isPending || updateSource.isPending)
                ? "Saving…"
                : editingSourceId ? "Update source" : "Add source"}
            </button>
            {editingSourceId && (
              <button type="button" className="btn btn-ghost" onClick={resetSourceForm}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
        {sourceError && <div className="mt-2"><InlineError message={sourceError} /></div>}
        {sources.isPending && <SkeletonRows rows={3} />}
        {sources.isError && (
          <InlineError message={`Source registry failed to load: ${sources.error.message}`} />
        )}
        {sources.isSuccess && sources.data.length === 0 && (
          <EmptyState
            title="No sources registered"
            body="Add a vendor above so the sourcing hunt has somewhere to look."
          />
        )}
        {sources.isSuccess && sources.data.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm" data-testid="source-registry-table">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-faint">
                  <th className="py-1.5 pr-3">Vendor</th>
                  <th className="py-1.5 pr-3">Specialty</th>
                  <th className="py-1.5 pr-3">URL</th>
                  <th className="py-1.5 pr-3">Rate</th>
                  <th className="py-1.5 pr-3">Partner</th>
                  <th className="py-1.5 pr-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sources.data.map((s) => (
                  <tr key={s.source_id} className="border-t border-border-subtle">
                    <td className="py-1.5 pr-3 font-medium">{s.vendor_name}</td>
                    <td className="py-1.5 pr-3 text-muted">{s.specialty || "—"}</td>
                    <td className="py-1.5 pr-3">
                      {s.url ? <SafeLink href={s.url} target="_blank" rel="noreferrer">link</SafeLink> : "—"}
                    </td>
                    <td className="py-1.5 pr-3 tnum text-muted">{s.rate_limit_seconds}s</td>
                    <td className="py-1.5 pr-3">{s.is_trade_partner ? <Chip label="trade" value="yes" /> : "—"}</td>
                    <td className="py-1.5 pr-3">
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={readOnly || addSource.isPending || updateSource.isPending || deleteSource.isPending}
                          onClick={() => editSource(s)}
                          aria-label={`Edit ${s.vendor_name}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={readOnly || deleteSource.isPending}
                          onClick={() => removeSource(s)}
                          aria-label={`Delete ${s.vendor_name}`}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {error && <InlineError message={error} />}

      {/* Budget override modal */}
      <Modal open={overrideOpen} onClose={() => setOverrideOpen(false)} title="Override budget ruling">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            budgetOverride.mutate(overrideReason.trim());
          }}
        >
          <p className="text-sm text-muted">
            The ruling is <strong>{lastRuling ? (RULING_LABEL[lastRuling.ruling]?.label ?? lastRuling.ruling) : "not favorable"}</strong>.
            Overriding proceeds anyway and writes an audit record. A reason is required.
          </p>
          <div>
            <label htmlFor="override-reason" className="label">Reason</label>
            <input
              id="override-reason"
              className="input"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Panel price increase since estimate"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!overrideReason.trim() || budgetOverride.isPending}
              title={!overrideReason.trim() ? "A reason is required" : undefined}
            >
              {budgetOverride.isPending ? "Overriding…" : "Override ruling"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setOverrideOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* API cost override modal */}
      <Modal open={apiOverrideOpen} onClose={() => setApiOverrideOpen(false)} title="Override API cost ceiling">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apiOverride.mutate(apiOverrideReason.trim());
          }}
        >
          <p className="text-sm text-muted">
            Overriding lifts the block on paid API calls for this job and writes an audit record.
            A reason is required.
          </p>
          <div>
            <label htmlFor="api-override-reason" className="label">Reason</label>
            <input
              id="api-override-reason"
              className="input"
              value={apiOverrideReason}
              onChange={(e) => setApiOverrideReason(e.target.value)}
              placeholder="Mesh generation is worth the spend on this job"
              data-testid="api-cost-override-reason"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!apiOverrideReason.trim() || apiOverride.isPending}
              title={!apiOverrideReason.trim() ? "A reason is required" : undefined}
            >
              {apiOverride.isPending ? "Overriding…" : "Override ceiling"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setApiOverrideOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Seal partial modal */}
      <Modal open={sealPartialOpen} onClose={() => setSealPartialOpen(false)} title="Seal sourcing below the floor">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            hunt.mutate({ kind: "sourcing/seal", body: { accept_partial: true, reason: sealReason.trim() } });
          }}
        >
          <p className="text-sm text-muted">
            Coverage is below the 50% floor. Sealing anyway is an explicit partial acceptance and
            writes an audit event. A reason is required.
          </p>
          <div>
            <label htmlFor="seal-reason" className="label">Reason</label>
            <input
              id="seal-reason"
              className="input"
              value={sealReason}
              onChange={(e) => setSealReason(e.target.value)}
              placeholder="Remaining parts are fab-only; sourcing locally"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!sealReason.trim() || hunt.isPending}
              title={!sealReason.trim() ? "A reason is required" : undefined}
              data-testid="seal-partial-confirm"
            >
              {hunt.isPending ? "Sealing…" : "Accept partial & seal"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setSealPartialOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
