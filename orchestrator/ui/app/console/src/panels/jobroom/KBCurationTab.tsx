// KB Curation tab (U3 §8.4). Shared knowledge base management: list with
// make/model/year filtering, add/edit/delete (custom confirmation, never
// window.confirm), and a proposal-queue section that renders a
// <DegradationPanel> when POST …/kb/approve 404s (spec §8.9 + §11.2, AT-084).
// The KB is a shared resource — entries with null make/model/year are global.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@shared/api-client";
import { keys } from "@shared/keys";
import { useCrudMutation } from "@shared/mutations";
import { useReadOnly } from "@shared/hooks";
import { Chip, EmptyState, InlineError, SkeletonRows } from "@shared/components";
import { Modal } from "@shared/modal";
import { fmtUsd } from "@shared/format";
import { DegradationPanel, DEGRADATION_PRESETS } from "@shared/degradation";
import type { KBEntry, RestorationProject } from "@shared/types";

// PART_CATEGORIES (restoration_models.py) — the backend validates these.
const PART_CATEGORIES = [
  "brake",
  "suspension",
  "engine",
  "body",
  "interior",
  "electrical",
  "exhaust",
  "fuel",
  "cooling",
  "transmission",
] as const;

const CRITICALITIES = ["critical", "standard", "optional"] as const;

interface KBFormData {
  part_id: string;
  name: string;
  category: string;
  criticality: string;
  oem_number: string;
  aftermarket_alternatives: string; // newline-separated
  interchange: string; // newline-separated
  price_min: string;
  price_max: string;
  make: string;
  model: string;
  year: string;
}

const EMPTY_FORM: KBFormData = {
  part_id: "",
  name: "",
  category: "brake",
  criticality: "standard",
  oem_number: "",
  aftermarket_alternatives: "",
  interchange: "",
  price_min: "",
  price_max: "",
  make: "",
  model: "",
  year: "",
};

function entryToForm(e: KBEntry): KBFormData {
  return {
    part_id: e.part_id,
    name: e.name,
    category: e.category,
    criticality: e.criticality ?? "standard",
    oem_number: e.oem_number ?? "",
    aftermarket_alternatives: (Array.isArray(e.aftermarket_alternatives)
      ? e.aftermarket_alternatives
      : []
    ).join("\n"),
    interchange: (Array.isArray(e.interchange) ? e.interchange : []).join("\n"),
    price_min: e.indicative_price_range_usd?.min?.toString() ?? "",
    price_max: e.indicative_price_range_usd?.max?.toString() ?? "",
    make: e.make ?? e.vehicle_make ?? "",
    model: e.model ?? e.vehicle_model ?? "",
    year: e.year ?? e.vehicle_year ?? "",
  };
}

function formToPayload(form: KBFormData): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    part_id: form.part_id.trim(),
    name: form.name.trim(),
    category: form.category,
    criticality: form.criticality,
  };
  if (form.oem_number.trim()) payload.oem_number = form.oem_number.trim();
  const alts = form.aftermarket_alternatives
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (alts.length) payload.aftermarket_alternatives = alts;
  const inter = form.interchange
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (inter.length) payload.interchange = inter;
  const min = parseFloat(form.price_min);
  const max = parseFloat(form.price_max);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    payload.indicative_price_range_usd = { min, max, mid: (min + max) / 2 };
  }
  return payload;
}

function validateForm(form: KBFormData): string | null {
  if (!form.part_id.trim()) return "Part ID is required.";
  if (!form.name.trim()) return "Name is required.";
  if (!PART_CATEGORIES.includes(form.category as (typeof PART_CATEGORIES)[number]))
    return `Category must be one of: ${PART_CATEGORIES.join(", ")}.`;
  if (form.price_min && form.price_max) {
    const min = parseFloat(form.price_min);
    const max = parseFloat(form.price_max);
    if (Number.isFinite(min) && Number.isFinite(max) && min > max)
      return "Price minimum cannot exceed maximum.";
  }
  return null;
}

function priceRange(e: KBEntry): string {
  const r = e.indicative_price_range_usd;
  if (!r) return "—";
  const min = typeof r.min === "number" ? r.min : null;
  const max = typeof r.max === "number" ? r.max : null;
  if (min == null && max == null) return "—";
  if (min != null && max != null) return `${fmtUsd(min)}–${fmtUsd(max)}`;
  return fmtUsd(min ?? max);
}

export function KBCurationTab({ project }: { project: RestorationProject }) {
  const readOnly = useReadOnly();
  const [filterMake, setFilterMake] = useState(project.vehicle_meta.make ?? "");
  const [filterModel, setFilterModel] = useState(project.vehicle_meta.model ?? "");
  const [filterYear, setFilterYear] = useState(project.vehicle_meta.year ?? "");
  const [appliedFilter, setAppliedFilter] = useState({
    make: project.vehicle_meta.make ?? "",
    model: project.vehicle_meta.model ?? "",
    year: project.vehicle_meta.year ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [form, setForm] = useState<KBFormData>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KBEntry | null>(null);

  const kb = useQuery({
    queryKey: keys.kbEntries(appliedFilter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (appliedFilter.make) params.set("make", appliedFilter.make);
      if (appliedFilter.model) params.set("model", appliedFilter.model);
      if (appliedFilter.year) params.set("year", appliedFilter.year);
      const qs = params.toString();
      return api<KBEntry[]>(`/restoration/kb/entries${qs ? `?${qs}` : ""}`);
    },
    staleTime: 30_000,
  });

  const addEntry = useCrudMutation<{ part_id: string }, KBFormData>({
    mutationFn: (data) =>
      api("/restoration/kb/entries", { body: formToPayload(data) }),
    invalidateKeys: [keys.kbEntries(appliedFilter)],
    onError: (err) => setFormError(err.message),
    onSuccess: () => {
      setModalMode(null);
      setFormError(null);
      setError(null);
    },
  });

  const updateEntry = useCrudMutation<{ entry: KBEntry }, KBFormData>({
    mutationFn: (data) =>
      api(`/restoration/kb/entries/${data.part_id}`, {
        method: "PUT",
        body: formToPayload(data),
      }),
    invalidateKeys: [keys.kbEntries(appliedFilter)],
    onError: (err) => setFormError(err.message),
    onSuccess: () => {
      setModalMode(null);
      setFormError(null);
      setError(null);
    },
  });

  const deleteEntry = useCrudMutation<{ deleted: boolean }, string>({
    mutationFn: (partId) =>
      api(`/restoration/kb/entries/${partId}`, { method: "DELETE" }),
    invalidateKeys: [keys.kbEntries(appliedFilter)],
    onError: (err) => setError(err.message),
    onSuccess: () => {
      setDeleteTarget(null);
      setError(null);
    },
  });

  const entries = kb.data ?? [];

  const isFormPending = addEntry.isPending || updateEntry.isPending;

  function openAdd() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalMode("add");
  }

  function openEdit(e: KBEntry) {
    setForm(entryToForm(e));
    setFormError(null);
    setModalMode("edit");
  }

  function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const v = validateForm(form);
    if (v) {
      setFormError(v);
      return;
    }
    setFormError(null);
    if (modalMode === "add") addEntry.mutate(form);
    else updateEntry.mutate(form);
  }

  const filterDirty =
    filterMake !== appliedFilter.make ||
    filterModel !== appliedFilter.model ||
    filterYear !== appliedFilter.year;

  return (
    <div className="flex flex-col gap-4">
      {/* Proposal queue — Phase 4/5 endpoint (§8.4 + §11.2).
          POST …/kb/approve is project-scoped and 404s in the current build.
          No GET endpoint exists to list proposals, so the queue renders the
          DegradationPanel directly — the honest "not available" surface. */}
      <section aria-label="KB proposal queue">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-faint">
          Proposal Queue
        </h2>
        <DegradationPanel
          preset={DEGRADATION_PRESETS.kb_approve()}
          testId="kb-approve-degradation"
        />
      </section>

      {/* KB entries list */}
      <section aria-label="KB entries">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-faint">
            KB Entries
          </h2>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={readOnly}
            title={readOnly ? "Unavailable while offline" : undefined}
            onClick={openAdd}
            data-testid="kb-add-btn"
          >
            Add KB entry
          </button>
        </div>

        {/* Filter bar */}
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="kb-filter-make" className="label">
              Make
            </label>
            <input
              id="kb-filter-make"
              className="input min-w-32"
              value={filterMake}
              onChange={(e) => setFilterMake(e.target.value)}
              placeholder="Any"
              aria-label="Filter by make"
            />
          </div>
          <div>
            <label htmlFor="kb-filter-model" className="label">
              Model
            </label>
            <input
              id="kb-filter-model"
              className="input min-w-32"
              value={filterModel}
              onChange={(e) => setFilterModel(e.target.value)}
              placeholder="Any"
              aria-label="Filter by model"
            />
          </div>
          <div>
            <label htmlFor="kb-filter-year" className="label">
              Year
            </label>
            <input
              id="kb-filter-year"
              className="input min-w-20"
              value={filterYear}
              onChange={(e) => setFilterYear(e.target.value)}
              placeholder="Any"
              aria-label="Filter by year"
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!filterDirty}
            onClick={() =>
              setAppliedFilter({
                make: filterMake.trim(),
                model: filterModel.trim(),
                year: filterYear.trim(),
              })
            }
          >
            Apply
          </button>
          {(appliedFilter.make || appliedFilter.model || appliedFilter.year) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setFilterMake("");
                setFilterModel("");
                setFilterYear("");
                setAppliedFilter({ make: "", model: "", year: "" });
              }}
            >
              Clear
            </button>
          )}
        </div>

        {error && (
          <div className="mb-3">
            <InlineError message={error} />
          </div>
        )}

        {kb.isPending && <SkeletonRows rows={5} />}

        {kb.isError && (
          <InlineError
            message={
              kb.error instanceof ApiError
                ? `KB entries failed to load: ${kb.error.message}`
                : "KB entries failed to load."
            }
          />
        )}

        {kb.isSuccess && entries.length === 0 && (
          <EmptyState
            title="No KB entries match this filter"
            body={
              appliedFilter.make || appliedFilter.model || appliedFilter.year
                ? "No entries exist for this vehicle. Add one manually, or clear the filter to see all entries."
                : "The knowledge base is empty. Add the first entry to start building reference data for parts identification."
            }
            ctaLabel={readOnly ? undefined : "Add KB entry"}
            onCta={readOnly ? undefined : openAdd}
          />
        )}

        {kb.isSuccess && entries.length > 0 && (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wider text-faint">
                  <th className="px-3 py-2 font-medium">Part ID</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">OEM</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Criticality</th>
                  <th className="px-3 py-2 font-medium text-right">Price Range</th>
                  <th className="px-3 py-2 font-medium">Scope</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.part_id}
                    className="border-b border-border-subtle last:border-0 hover:bg-elevated/40"
                  >
                    <td className="px-3 py-2 font-mono text-xs tnum">{e.part_id}</td>
                    <td className="px-3 py-2">{e.name}</td>
                    <td className="px-3 py-2 text-muted">{e.oem_number ?? "—"}</td>
                    <td className="px-3 py-2 capitalize">{e.category}</td>
                    <td className="px-3 py-2">
                      <Chip
                        label=""
                        value={e.criticality ?? "standard"}
                        tone={
                          e.criticality === "critical"
                            ? "signal"
                            : e.criticality === "optional"
                              ? "faint"
                              : "muted"
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-right tnum">{priceRange(e)}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {e.make || e.model || e.year
                        ? [e.year, e.make, e.model].filter(Boolean).join(" ")
                        : "Global"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={readOnly}
                          title={readOnly ? "Unavailable while offline" : "Edit entry"}
                          onClick={() => openEdit(e)}
                          aria-label={`Edit ${e.name}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm text-signal"
                          disabled={readOnly}
                          title={readOnly ? "Unavailable while offline" : "Delete entry"}
                          onClick={() => setDeleteTarget(e)}
                          aria-label={`Delete ${e.name}`}
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

      {/* Add / Edit modal */}
      <Modal
        open={modalMode !== null}
        onClose={() => {
          setModalMode(null);
          setFormError(null);
        }}
        title={modalMode === "edit" ? "Edit KB entry" : "Add KB entry"}
        widthClass="max-w-xl"
      >
        <form onSubmit={submitForm} className="flex flex-col gap-3">
          {/* Immutable fields in edit mode */}
          <div>
            <label htmlFor="kb-form-part-id" className="label">
              Part ID {modalMode === "edit" && <span className="text-faint">(immutable)</span>}
            </label>
            <input
              id="kb-form-part-id"
              className="input"
              value={form.part_id}
              onChange={(e) => setForm({ ...form, part_id: e.target.value })}
              disabled={modalMode === "edit"}
              placeholder="e.g. chevy_camaro_1967_brake_caliper_a"
              required
              aria-required="true"
            />
          </div>
          <div>
            <label htmlFor="kb-form-name" className="label">
              Name
            </label>
            <input
              id="kb-form-name"
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              aria-required="true"
              placeholder="e.g. Front Brake Caliper"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="kb-form-category" className="label">
                Category
              </label>
              <select
                id="kb-form-category"
                className="input"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {PART_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="kb-form-criticality" className="label">
                Criticality
              </label>
              <select
                id="kb-form-criticality"
                className="input"
                value={form.criticality}
                onChange={(e) => setForm({ ...form, criticality: e.target.value })}
              >
                {CRITICALITIES.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="kb-form-oem" className="label">
              OEM Number
            </label>
            <input
              id="kb-form-oem"
              className="input"
              value={form.oem_number}
              onChange={(e) => setForm({ ...form, oem_number: e.target.value })}
              placeholder="e.g. 5460007"
            />
          </div>
          <div>
            <label htmlFor="kb-form-alts" className="label">
              Aftermarket Alternatives <span className="text-faint">(one per line)</span>
            </label>
            <textarea
              id="kb-form-alts"
              className="input"
              rows={2}
              value={form.aftermarket_alternatives}
              onChange={(e) => setForm({ ...form, aftermarket_alternatives: e.target.value })}
              placeholder={"PBR-7606\nA1-Cardone-31487"}
            />
          </div>
          <div>
            <label htmlFor="kb-form-interchange" className="label">
              Interchange <span className="text-faint">(one per line)</span>
            </label>
            <textarea
              id="kb-form-interchange"
              className="input"
              rows={2}
              value={form.interchange}
              onChange={(e) => setForm({ ...form, interchange: e.target.value })}
              placeholder={"1966-1968 Camaro\n1968 Chevrolet Camaro"}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="kb-form-price-min" className="label">
                Price Min (USD)
              </label>
              <input
                id="kb-form-price-min"
                className="input"
                type="number"
                step="0.01"
                min="0"
                value={form.price_min}
                onChange={(e) => setForm({ ...form, price_min: e.target.value })}
                placeholder="51.00"
              />
            </div>
            <div>
              <label htmlFor="kb-form-price-max" className="label">
                Price Max (USD)
              </label>
              <input
                id="kb-form-price-max"
                className="input"
                type="number"
                step="0.01"
                min="0"
                value={form.price_max}
                onChange={(e) => setForm({ ...form, price_max: e.target.value })}
                placeholder="205.00"
              />
            </div>
          </div>
          {/* Vehicle scope — immutable in edit mode (§8.4) */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="kb-form-make" className="label">
                Make {modalMode === "edit" && <span className="text-faint">(immutable)</span>}
              </label>
              <input
                id="kb-form-make"
                className="input"
                value={form.make}
                onChange={(e) => setForm({ ...form, make: e.target.value })}
                disabled={modalMode === "edit"}
                placeholder="Global"
              />
            </div>
            <div>
              <label htmlFor="kb-form-model" className="label">
                Model {modalMode === "edit" && <span className="text-faint">(immutable)</span>}
              </label>
              <input
                id="kb-form-model"
                className="input"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                disabled={modalMode === "edit"}
                placeholder="Global"
              />
            </div>
            <div>
              <label htmlFor="kb-form-year" className="label">
                Year {modalMode === "edit" && <span className="text-faint">(immutable)</span>}
              </label>
              <input
                id="kb-form-year"
                className="input"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
                disabled={modalMode === "edit"}
                placeholder="Global"
              />
            </div>
          </div>
          <p className="text-xs text-muted">
            Empty make/model/year creates a global entry (applies to any vehicle).
          </p>

          {formError && <InlineError message={formError} />}

          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isFormPending}
              aria-label={isFormPending ? "Working" : modalMode === "edit" ? "Save changes" : "Add entry"}
            >
              {isFormPending ? "Working…" : modalMode === "edit" ? "Save changes" : "Add entry"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setModalMode(null);
                setFormError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation — custom flow, not window.confirm (§8.4) */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete KB entry"
      >
        {deleteTarget && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Delete <strong className="text-ink">{deleteTarget.name}</strong> ({deleteTarget.part_id})?
              Existing manifests are unaffected — they snapshot KB data at lock time.
            </p>
            {error && <InlineError message={error} />}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-danger"
                disabled={deleteEntry.isPending}
                aria-label={deleteEntry.isPending ? "Working" : "Confirm delete"}
                onClick={() => deleteEntry.mutate(deleteTarget.part_id)}
              >
                {deleteEntry.isPending ? "Working…" : "Delete"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
