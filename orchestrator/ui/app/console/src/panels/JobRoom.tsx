// JobRoom — /jobs/:projectId/:tab. Entity query with NO keepPreviousData
// (OBL-60: skeleton on project switch). Header: title, StatusBadge,
// needs_attention (verbatim, OBL-3), API-cost warning pill, NextActionBadge,
// lifecycle actions per the §9 matrix. Dominant field + fact rail (brand:
// editorial asymmetry).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useParams } from "react-router-dom";
import { api, ApiError } from "@shared/api-client";
import { keys } from "@shared/keys";
import { allowedActions, API_COST_WARN_RATIO, statusMeta } from "@shared/constants";
import { useAuditMutation } from "@shared/mutations";
import { useReadOnly } from "@shared/hooks";
import { Chip, InlineError, SkeletonRows, StatusBadge } from "@shared/components";
import { Modal } from "@shared/modal";
import { NextActionBadge } from "@shared/next-action-badge";
import { fmtDate, fmtUsd, vehicleTitle } from "@shared/format";
import type { RestorationProject } from "@shared/types";
import { IntakeBay } from "./IntakeBay";
import { ManifestTab } from "./jobroom/ManifestTab";
import { KBCurationTab } from "./jobroom/KBCurationTab";
import { BudgetTab } from "./jobroom/BudgetTab";
import { AssemblyTab } from "./jobroom/AssemblyTab";
import { SystemTab } from "./jobroom/SystemTab";

const TABS = [
  { id: "intake", label: "Intake" },
  { id: "manifest", label: "Manifest" },
  { id: "kb", label: "KB" },
  { id: "budget", label: "Budget" },
  { id: "assembly", label: "Assembly" },
  { id: "system", label: "System" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function useProject(id: string) {
  return useQuery({
    queryKey: keys.project(id),
    queryFn: () => api<RestorationProject>(`/restoration/projects/${id}`),
    // no placeholderData — skeleton on project switch (OBL-60)
  });
}

// Count-aware NextActionBadge details (§6.0 layer 1): open review count from
// the manifest, when one exists. 404 (pre-identification) → generic messages.
function useOpenReviewCount(id: string): number | undefined {
  const q = useQuery({
    queryKey: keys.manifest(id),
    queryFn: () => api<{ entries?: { requires_review?: boolean }[] }>(`/restoration/projects/${id}/manifest`),
    retry: (count, err) => (err instanceof ApiError && err.status === 404 ? false : count < 2),
  });
  if (!q.data?.entries) return undefined;
  return q.data.entries.filter((e) => e.requires_review).length;
}

interface ReasonModalState {
  action: "abandon" | "reopen" | "park" | null;
}

export function JobRoom() {
  const { projectId = "", tab } = useParams();

  const activeTab: TabId = TABS.some((t) => t.id === tab) ? (tab as TabId) : "intake";
  const project = useProject(projectId);
  const openReviews = useOpenReviewCount(projectId);
  const readOnly = useReadOnly();
  const [reasonModal, setReasonModal] = useState<ReasonModalState>({ action: null });
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checklist, setChecklist] = useState<string[]>([]);
  const [missingItems, setMissingItems] = useState<string[]>([]);

  const lifecycle = useAuditMutation<unknown, { kind: string; body?: Record<string, unknown> }>({
    mutationFn: ({ kind, body }) =>
      api(`/restoration/projects/${projectId}/${kind}`, { body: body ?? {} }),
    invalidateKeys: [keys.project(projectId), keys.projects({})],
    onError: (err) => {
      if (err.missingItems?.length || err.code === "incomplete_checklist") {
        setMissingItems(err.missingItems ?? []);
        setChecklistOpen(true);
        setActionError(null);
        return;
      }
      setActionError(err.message);
    },
    onSuccess: () => {
      setActionError(null);
      setReasonModal({ action: null });
      setReason("");
      setChecklistOpen(false);
    },
  });

  if (project.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <SkeletonRows rows={2} height="h-10" />
        <SkeletonRows rows={5} />
      </div>
    );
  }
  if (project.isError) {
    return (
      <div className="flex flex-col gap-3">
        <InlineError
          message={
            project.error instanceof ApiError
              ? `Job failed to load: ${project.error.message}`
              : "Job failed to load."
          }
        />
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => project.refetch()}>
            Retry
          </button>
          <Link to="/jobs" className="btn btn-ghost">
            Back to board
          </Link>
        </div>
      </div>
    );
  }

  const p = project.data;
  const reasonActionLabel =
    reasonModal.action === "abandon"
      ? "Abandon job"
      : reasonModal.action === "reopen"
        ? "Reopen job"
        : "Park job";
  const actions = allowedActions(p.status, p.parked);
  const apiCostRatio = p.api_cost_ceiling_usd > 0 ? p.api_cost_to_date_usd / p.api_cost_ceiling_usd : 0;

  function fireLifecycle(kind: string, body?: Record<string, unknown>) {
    setActionError(null);
    lifecycle.mutate({ kind, body });
  }

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link to="/jobs" className="text-sm text-muted hover:text-ink" aria-label="Back to job board">
                ←
              </Link>
              <h1 className="truncate text-2xl font-semibold">{vehicleTitle(p.vehicle_meta)}</h1>
              <StatusBadge status={p.status} />
              {p.parked && <Chip label="parked" value={p.parked_reason ?? "yes"} tone="faint" />}
              {apiCostRatio >= API_COST_WARN_RATIO && (
                <Chip
                  label="api cost"
                  value={`${Math.round(apiCostRatio * 100)}% of ceiling`}
                  tone="signal"
                  title="API cost warning — open the Budget tab for the override"
                />
              )}
            </div>
            {p.needs_attention != null && (
              <p className="mt-2 rounded-sm border-l-2 border-signal bg-signal/10 px-2 py-1 text-sm">
                {p.needs_attention}
              </p>
            )}
            <div className="mt-2">
              <NextActionBadge project={p} details={{ openReviews }} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions.has("go_in_service") && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={readOnly || lifecycle.isPending}
                title={readOnly ? "Unavailable while offline" : undefined}
                onClick={() => {
                  setChecklist([]);
                  setMissingItems([]);
                  setChecklistOpen(true);
                }}
              >
                Go in-service
              </button>
            )}
            {p.parked ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={readOnly || lifecycle.isPending}
                onClick={() => fireLifecycle("unpark")}
              >
                Unpark
              </button>
            ) : (
              actions.has("park") && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={readOnly || lifecycle.isPending}
                  onClick={() => setReasonModal({ action: "park" })}
                >
                  Park
                </button>
              )
            )}
            {actions.has("reopen") && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={readOnly || lifecycle.isPending}
                onClick={() => setReasonModal({ action: "reopen" })}
              >
                Reopen
              </button>
            )}
            {actions.has("abandon") && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={readOnly || lifecycle.isPending}
                onClick={() => setReasonModal({ action: "abandon" })}
              >
                Abandon
              </button>
            )}
          </div>
        </div>
        {actionError && (
          <div className="mt-3">
            <InlineError message={actionError} />
          </div>
        )}
      </div>

      {/* Tabs — full WAI tab semantics: roving tabindex, arrow/Home/End move
          focus (manual activation — Enter follows the link), aria-controls →
          panel, panel labelled by the active tab (§1 pattern 4 keyboard
          contract). Without the key handler the roving tabindex would strand
          keyboard users on the active tab. */}
      <div
        className="flex gap-1 border-b border-border-subtle"
        role="tablist"
        aria-label="Job sections"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
          e.preventDefault();
          const ids = TABS.map((t) => t.id);
          const cur = Math.max(0, ids.indexOf(activeTab));
          const next =
            e.key === "ArrowRight"
              ? (cur + 1) % ids.length
              : e.key === "ArrowLeft"
                ? (cur - 1 + ids.length) % ids.length
                : e.key === "Home"
                  ? 0
                  : ids.length - 1;
          document.getElementById(`job-tab-${ids[next]}`)?.focus();
        }}
      >
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/jobs/${projectId}/${t.id}`}
            role="tab"
            id={`job-tab-${t.id}`}
            aria-selected={activeTab === t.id}
            aria-controls="job-panel"
            tabIndex={activeTab === t.id ? 0 : -1}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
              activeTab === t.id
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </NavLink>
        ))}
      </div>

      {/* Dominant field + fact rail */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_var(--rail-w)]">
        <div
          className="page-enter-late min-w-0"
          role="tabpanel"
          id="job-panel"
          aria-labelledby={`job-tab-${activeTab}`}
        >
          {activeTab === "intake" && <IntakeBay mode="project" project={p} />}
          {activeTab === "manifest" && <ManifestTab project={p} />}
          {activeTab === "kb" && <KBCurationTab project={p} />}
          {activeTab === "budget" && <BudgetTab project={p} />}
          {activeTab === "assembly" && <AssemblyTab project={p} />}
          {activeTab === "system" && <SystemTab project={p} />}
        </div>
        <aside className="page-enter-late flex flex-col gap-3" aria-label="Job facts">
          <div className="card p-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">Facts</h2>
            <dl className="mt-2 flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Status</dt>
                <dd>{statusMeta(p.status).label}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Project</dt>
                <dd className="font-mono text-xs tnum">{p.project_id}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Created</dt>
                <dd className="tnum">{fmtDate(p.created_at)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Budget</dt>
                <dd className="tnum">{fmtUsd(p.budget_ceiling_usd)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Spend</dt>
                <dd className="tnum">{fmtUsd(p.actual_spend_usd)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">API cost</dt>
                <dd className="tnum">
                  {fmtUsd(p.api_cost_to_date_usd)} / {fmtUsd(p.api_cost_ceiling_usd)}
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>

      {/* Reason modal: abandon / reopen / park */}
      <Modal
        open={reasonModal.action !== null}
        onClose={() => setReasonModal({ action: null })}
        title={
          reasonModal.action === "abandon"
            ? "Abandon this job"
            : reasonModal.action === "reopen"
              ? "Reopen this job"
              : "Park this job"
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonModal.action) fireLifecycle(reasonModal.action, { reason });
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted">
            {reasonModal.action === "abandon"
              ? "Abandoning is a recorded, auditable action. Pending tasks are cancelled."
              : reasonModal.action === "reopen"
                ? "Reopening returns the job to manifest-locked. A reason is required for the audit log."
                : "Parking freezes the job until it is unparked."}
          </p>
          <div>
            <label htmlFor="reason" className="label">
              Reason
            </label>
            <input
              id="reason"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                reasonModal.action === "abandon" ? "Customer walked" : "Customer added scope"
              }
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className={`btn ${reasonModal.action === "abandon" ? "btn-danger" : "btn-primary"}`}
              disabled={!reason.trim() || lifecycle.isPending}
              title={!reason.trim() ? "A reason is required" : undefined}
              aria-label={lifecycle.isPending ? "Working" : reasonActionLabel}
            >
              {lifecycle.isPending ? "Working…" : reasonActionLabel}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setReasonModal({ action: null })}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Go-in-service checklist modal */}
      <Modal open={checklistOpen} onClose={() => setChecklistOpen(false)} title="Go in-service checklist">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            fireLifecycle("in-service", { checklist });
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted">
            Every item must be confirmed before the vehicle goes back on the road.
          </p>
          {["all critical sub-assemblies published", "operator has verified the vehicle is road-ready"].map(
            (item) => (
              <label key={item} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent)]"
                  checked={checklist.includes(item)}
                  onChange={(e) =>
                    setChecklist((prev) =>
                      e.target.checked ? [...prev, item] : prev.filter((x) => x !== item),
                    )
                  }
                />
                {item}
              </label>
            ),
          )}
          {missingItems.map((item) => (
            <label key={item} className="flex items-center gap-2 text-sm text-signal">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--signal)]"
                checked={checklist.includes(item)}
                onChange={(e) =>
                  setChecklist((prev) =>
                    e.target.checked ? [...prev, item] : prev.filter((x) => x !== item),
                  )
                }
              />
              {item} <span className="text-xs">(required by server)</span>
            </label>
          ))}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={lifecycle.isPending}
              aria-label={lifecycle.isPending ? "Working" : "Confirm in-service"}
            >
              {lifecycle.isPending ? "Working…" : "Confirm in-service"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setChecklistOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
