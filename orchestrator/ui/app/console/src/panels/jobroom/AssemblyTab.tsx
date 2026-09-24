// Assembly tab (U5 core). Assemblies are derived from the LIVE manifest per
// the §3.3 algorithm (group by category → "X Assembly") until the 3D pipeline
// lands. Guide-token lifecycle is LIVE: mint, extend (Modal, spec §4.8
// inventory), supersede (Modal, AT-041 — mints a new link, marks the old one
// superseded), revoke (confirmation Modal — custom flow, not window.confirm).
// Duplicate mint within a session warns (AC-UI-014). Phase 4/5 actions
// (Generate 3D, Publish guide, Export) attempt the call and render a
// <DegradationPanel> on 404 (spec §8.6 + §8.9 + §11.2, AT-084) — never a
// disabled-with-tooltip silent route-around.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@shared/api-client";
import { keys } from "@shared/keys";
import { useAuditMutation } from "@shared/mutations";
import { useReadOnly } from "@shared/hooks";
import { Chip, EmptyState, InlineError, SkeletonRows } from "@shared/components";
import { Modal } from "@shared/modal";
import { fmtDateTime } from "@shared/format";
import { toast } from "@shared/toast";
import { DegradationPanel, DEGRADATION_PRESETS, isPhaseGap } from "@shared/degradation";
import type { GuideToken, Manifest, MechanicFlag, RestorationProject } from "@shared/types";

interface ManifestDoc extends Manifest {
  version?: number;
}

interface DerivedAssembly {
  id: string;
  name: string;
  category: string;
  parts: number;
  criticalParts: number;
}

// §3.3 derivation: group manifest entries by category. ManifestEntry carries
// no category field, so we mirror the backend's deterministic _CATEGORY_HINTS
// table (restoration_pipeline.py) verbatim — same input, same buckets — until
// the 3D pipeline serves assemblies directly.
const CATEGORY_HINTS: Record<string, string> = {
  brake: "brake", caliper: "brake", rotor: "brake", drum: "brake",
  shock: "suspension", strut: "suspension", spring: "suspension", "control arm": "suspension",
  piston: "engine", gasket: "engine", carburetor: "engine", valve: "engine",
  fender: "body", bumper: "body", hood: "body", door: "body", panel: "body",
  seat: "interior", carpet: "interior", dash: "interior",
  alternator: "electrical", wiring: "electrical", battery: "electrical", starter: "electrical",
  muffler: "exhaust", manifold: "exhaust", exhaust: "exhaust",
  fuel: "fuel", tank: "fuel", "fuel pump": "fuel",
  radiator: "cooling", "water pump": "cooling", thermostat: "cooling", hose: "cooling",
  transmission: "transmission", clutch: "transmission", gearbox: "transmission",
};

function categorize(name: string): string {
  const lowered = name.toLowerCase();
  for (const [hint, category] of Object.entries(CATEGORY_HINTS)) {
    if (lowered.includes(hint)) return category;
  }
  return lowered ? "engine" : "unknown";
}

function deriveAssemblies(doc: ManifestDoc | undefined): DerivedAssembly[] {
  if (!doc) return [];
  const groups = new Map<string, { parts: number; critical: number }>();
  for (const e of doc.entries ?? []) {
    const category = categorize(e.name);
    const g = groups.get(category) ?? { parts: 0, critical: 0 };
    g.parts += 1;
    if (e.criticality === "critical") g.critical += 1;
    groups.set(category, g);
  }
  return Array.from(groups.entries()).map(([category, g]) => ({
    id: `asm_${category.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    name: `${category.charAt(0).toUpperCase()}${category.slice(1)} Assembly`,
    category,
    parts: g.parts,
    criticalParts: g.critical,
  }));
}

type StepPositionLabel = "exploded" | "positioning" | "install" | "torque" | "finishing";

interface LocalGraphStep {
  description: string;
  tool_callout: string;
  safety_warning: string;
  associated_part_ids: string;
  step_position_label: StepPositionLabel;
}

export function AssemblyTab({ project }: { project: RestorationProject }) {
  const readOnly = useReadOnly();
  const [error, setError] = useState<string | null>(null);
  const [mintAssembly, setMintAssembly] = useState("");
  const [minted, setMinted] = useState<GuideToken | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  const manifest = useQuery({
    queryKey: keys.manifest(project.project_id),
    queryFn: () => api<ManifestDoc>(`/restoration/projects/${project.project_id}/manifest`),
    retry: (count, err) => (err instanceof ApiError && err.status === 404 ? false : count < 2),
  });

  const flags = useQuery({
    queryKey: keys.flags(project.project_id),
    queryFn: () => api<MechanicFlag[]>(`/restoration/projects/${project.project_id}/flags`),
  });

  const assemblies = useMemo(() => deriveAssemblies(manifest.data), [manifest.data]);

  const mint = useAuditMutation<GuideToken, { assembly_id: string }>({
    mutationFn: (body) =>
      api<GuideToken>(`/restoration/projects/${project.project_id}/tokens`, {
        body: { ...body, bundle_version: 1 },
      }),
    onError: (err) => setError(err.message),
    onSuccess: (token, vars) => {
      setError(null);
      setMinted(token);
      setTokenRevoked(false);
      // AC-UI-014: second mint for the same assembly in one session warns.
      try {
        const key = `restoration.mints.${project.project_id}`;
        const seen = JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[];
        if (seen.includes(vars.assembly_id)) {
          setDuplicateWarning(
            "A link for this assembly was already minted in this session — the new link supersedes nothing automatically; revoke the old one if it should die.",
          );
        } else {
          setDuplicateWarning(null);
        }
        sessionStorage.setItem(key, JSON.stringify([...seen, vars.assembly_id]));
      } catch {
        /* ignore */
      }
    },
  });

  const [extendOpen, setExtendOpen] = useState(false);
  const [extendDays, setExtendDays] = useState("30");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [tokenRevoked, setTokenRevoked] = useState(false);

  const resolveFlag = useAuditMutation<unknown, { flag_id: string; notes: string }>({
    mutationFn: ({ flag_id, notes }) =>
      api(`/restoration/projects/${project.project_id}/flags/${flag_id}/resolve`, {
        body: { resolution_notes: notes },
      }),
    invalidateKeys: [keys.flags(project.project_id)],
    onError: (err) => setError(err.message),
  });

  // Token lifecycle: revoke + extend (LIVE endpoints, spec §4.8 Modal inventory
  // lists "token extend"). Both server-authoritative via useAuditMutation.
  const revokeToken = useAuditMutation<{ revoked: string }, void>({
    mutationFn: () =>
      api(
        `/restoration/projects/${project.project_id}/tokens/${minted?.token_id}`,
        { method: "DELETE" },
      ),
    onError: (err) => setError(err.message),
    onSuccess: () => {
      setError(null);
      setTokenRevoked(true);
      setMinted(null);
      setRevokeOpen(false);
    },
  });

  const extendToken = useAuditMutation<{ token: GuideToken }, void>({
    mutationFn: () =>
      api(
        `/restoration/projects/${project.project_id}/tokens/${minted?.token_id}/extend`,
        { body: { extends_days: Number(extendDays) || 30 } },
      ),
    onError: (err) => setError(err.message),
    onSuccess: (data) => {
      setError(null);
      setMinted(data.token);
      setExtendOpen(false);
    },
  });

  // Supersede (AT-041, §8.6): POST …/tokens/{id}/supersede mints a new token
  // and marks the old one superseded. The old link stays readable but shows the
  // superseded banner; the new link is the authoritative one.
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const [supersededToken, setSupersededToken] = useState<GuideToken | null>(null);

  const supersedeToken = useAuditMutation<{ token: GuideToken }, void>({
    mutationFn: () =>
      api(
        `/restoration/projects/${project.project_id}/tokens/${minted?.token_id}/supersede`,
        { body: {} },
      ),
    onError: (err) => setError(err.message),
    onSuccess: (data) => {
      setError(null);
      setSupersededToken(data.token);
      setSupersedeOpen(false);
    },
  });

  const manifestMissing =
    manifest.isError && manifest.error instanceof ApiError && manifest.error.status === 404;

  // Phase 4/5 endpoints (spec §8.6): attempt the call, render DegradationPanel
  // on 404 (AT-084). If the endpoint ships later, the button works; if it 404s,
  // the operator sees the honest panel with fallback actions — never a silent
  // route-around (§11.2).
  const [gen3dGap, setGen3dGap] = useState(false);
  const [exportGap, setExportGap] = useState(false);
  const [publishGap, setPublishGap] = useState(false);

  const generate3d = useAuditMutation<unknown, void>({
    mutationFn: () =>
      api(`/restoration/projects/${project.project_id}/generate_3d`, { body: {} }),
    onError: (err) => {
      if (isPhaseGap(err)) setGen3dGap(true);
      else setError(err.message);
    },
    onSuccess: () => { setError(null); setGen3dGap(false); },
  });

  const publishGuide = useAuditMutation<unknown, void>({
    mutationFn: () =>
      api(`/restoration/projects/${project.project_id}/publish`, { body: {} }),
    onError: (err) => {
      if (isPhaseGap(err)) setPublishGap(true);
      else setError(err.message);
    },
    onSuccess: () => { setError(null); setPublishGap(false); },
  });

  const exportArtifact = useAuditMutation<unknown, void>({
    mutationFn: () =>
      api(`/restoration/projects/${project.project_id}/export-artifact`, { body: {} }),
    onError: (err) => {
      if (isPhaseGap(err)) setExportGap(true);
      else setError(err.message);
    },
    onSuccess: () => { setError(null); setExportGap(false); },
  });

  // QA viewer (spec §8.6): dimension_source + per-axis deviation + dimension
  // input form. GET …/assemblies is 404-tolerant (not yet built), so
  // dimension_source defaults to "none" and qa_status to "unverified_dimensions"
  // for all manifest parts. The operator can enter dimensions → POST
  // …/parts/{id}/dimensions (404 → DegradationPanel, §11.2).
  const [dimensionsGap, setDimensionsGap] = useState(false);
  const [dimPartId, setDimPartId] = useState<string | null>(null);
  const [dimForm, setDimForm] = useState({ length_mm: "", width_mm: "", height_mm: "" });
  const [dimVerifiedPartId, setDimVerifiedPartId] = useState<string | null>(null);

  const submitDimensions = useAuditMutation<
    unknown,
    { partId: string; body: { length_mm: number; width_mm: number; height_mm: number } }
  >({
    mutationFn: ({ partId, body }) =>
      api(`/restoration/projects/${project.project_id}/parts/${partId}/dimensions`, { body }),
    onError: (err) => {
      if (isPhaseGap(err)) setDimensionsGap(true);
      else setError(err.message);
    },
    onSuccess: (_data, vars) => {
      setError(null);
      setDimensionsGap(false);
      setDimPartId(null);
      setDimForm({ length_mm: "", width_mm: "", height_mm: "" });
      setDimVerifiedPartId(vars.partId);
    },
  });

  // Assembly graph editor (spec §8.6): table of AssemblyGraphStep rows.
  // "Save graph" → POST …/assembly/graph (404 → DegradationPanel, §11.2).
  const [graphGap, setGraphGap] = useState(false);
  const [graphSteps, setGraphSteps] = useState<LocalGraphStep[]>([
    { description: "", tool_callout: "", safety_warning: "", associated_part_ids: "", step_position_label: "install" },
  ]);

  const saveGraph = useAuditMutation<unknown, void>({
    mutationFn: () =>
      api(`/restoration/projects/${project.project_id}/assembly/graph`, {
        body: {
          assembly_id: assemblies[0]?.id ?? "asm_derived",
          steps: graphSteps
            .filter((s) => s.description.trim())
            .map((s, i) => ({
              step_index: i,
              description: s.description.trim(),
              step_position_label: s.step_position_label,
              tool_callout: s.tool_callout.trim() || null,
              part_callout: null,
              safety_warning: s.safety_warning.trim() || null,
              associated_part_ids: s.associated_part_ids
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean),
              audio_path: null,
              glb_file: null,
              diagram_path: null,
              text_fallback: s.description.trim(),
            })),
        },
      }),
    onError: (err) => {
      if (isPhaseGap(err)) setGraphGap(true);
      else setError(err.message);
    },
    onSuccess: () => { setError(null); setGraphGap(false); },
  });

  const exportGraphJson = () => {
    const graph = {
      assembly_id: assemblies[0]?.id ?? "asm_derived",
      steps: graphSteps
        .filter((s) => s.description.trim())
        .map((s, i) => ({
          step_index: i,
          description: s.description.trim(),
          step_position_label: s.step_position_label,
          tool_callout: s.tool_callout.trim() || null,
          safety_warning: s.safety_warning.trim() || null,
          associated_part_ids: s.associated_part_ids
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
        })),
    };
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `assembly_graph_${project.project_id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const manifestEntries = manifest.data?.entries ?? [];
  const validGraphSteps = graphSteps.filter((s) => s.description.trim());

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Assemblies</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={readOnly || generate3d.isPending || assemblies.length === 0}
              title={
                assemblies.length === 0
                  ? "Derive assemblies first (manifest required)"
                  : readOnly
                    ? "Unavailable while offline"
                    : undefined
              }
              onClick={() => generate3d.mutate()}
              data-testid="generate-3d"
              aria-label={generate3d.isPending ? "Generating 3D meshes" : "Generate 3D meshes from manifest parts"}
            >
              {generate3d.isPending ? "Generating…" : "Generate 3D"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={readOnly || publishGuide.isPending || assemblies.length === 0}
              title={
                assemblies.length === 0
                  ? "Derive assemblies first (manifest required)"
                  : readOnly
                    ? "Unavailable while offline"
                    : undefined
              }
              onClick={() => publishGuide.mutate()}
              data-testid="publish-guide"
              aria-label={publishGuide.isPending ? "Publishing guide bundle" : "Publish guide bundle for the bay guide"}
            >
              {publishGuide.isPending ? "Publishing…" : "Publish guide"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={readOnly || exportArtifact.isPending}
              title={readOnly ? "Unavailable while offline" : undefined}
              onClick={() => exportArtifact.mutate()}
              data-testid="export-artifact"
              aria-label={exportArtifact.isPending ? "Exporting PDF artifact" : "Export job artifact as PDF"}
            >
              {exportArtifact.isPending ? "Exporting…" : "Export"}
            </button>
          </div>
        </div>
        {manifest.isPending && <SkeletonRows rows={3} />}
        {manifestMissing && (
          <EmptyState
            title="No assemblies yet"
            body="Assemblies derive from the manifest. Lock the manifest first — the 3D pipeline builds on it."
            ctaLabel="Open manifest"
            ctaTo={`#/jobs/${project.project_id}/manifest`}
          />
        )}
        {manifest.isError && !manifestMissing && (
          <InlineError message={`Assemblies failed to derive: ${manifest.error.message}`} />
        )}
        {assemblies.length > 0 && (
          <ul className="mt-2 flex flex-col" data-testid="assembly-list">
            {assemblies.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 border-b border-border-subtle py-2 last:border-0"
              >
                <div>
                  <p className="text-sm font-medium">{a.name}</p>
                  <p className="font-mono text-xs text-faint tnum">{a.id}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Chip label="parts" value={String(a.parts)} />
                  {a.criticalParts > 0 && (
                    <Chip label="critical" value={String(a.criticalParts)} tone="accent" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {gen3dGap && (
          <div className="mt-3" data-testid="gen3d-degradation-wrap">
            <DegradationPanel
              preset={DEGRADATION_PRESETS.generate_3d(project.project_id)}
              testId="degradation-generate-3d"
            />
          </div>
        )}
      </section>

      {/* QA viewer (spec §8.6 layout: assemblies → QA viewer → graph editor).
          GET …/assemblies is 404-tolerant; dimension_source defaults to "none"
          for all manifest parts. When the operator enters dimensions, POST
          …/parts/{id}/dimensions is attempted — 404 → DegradationPanel. */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">QA — Dimensions</h2>
        <p className="mt-0.5 text-sm text-muted">
          Per-part dimension verification. Dimension source shows where the reference
          dimensions come from. Enter operator-measured dimensions to update QA status.
        </p>
        {manifest.isPending && <SkeletonRows rows={3} />}
        {manifestMissing && (
          <p className="mt-2 text-sm text-muted">
            Lock the manifest first — parts appear here once identified.
          </p>
        )}
        {manifest.data && manifestEntries.length > 0 && (
          <ul className="mt-2 flex flex-col" data-testid="qa-dimension-list">
            {manifestEntries.map((e) => (
              <li
                key={e.part_id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle py-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{e.name}</p>
                  <p className="font-mono text-xs text-faint tnum">{e.part_id}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Chip label="dim source" value="none" tone="muted" />
                  <Chip
                    label="qa"
                    value={dimVerifiedPartId === e.part_id ? "verified" : "unverified"}
                    tone={dimVerifiedPartId === e.part_id ? "ok" : "accent"}
                  />
                  {dimPartId === e.part_id ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setDimPartId(null); setError(null); }}
                      aria-label={`Cancel dimension entry for ${e.part_id}`}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={readOnly || dimensionsGap}
                      title={readOnly ? "Unavailable while offline" : undefined}
                      onClick={() => {
                        setDimPartId(e.part_id);
                        setDimVerifiedPartId(null);
                        setDimensionsGap(false);
                        setError(null);
                      }}
                      data-testid={`qa-enter-dims-${e.part_id}`}
                    >
                      Enter dimensions
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {manifest.data && manifestEntries.length === 0 && (
          <p className="mt-2 text-sm text-muted">No parts in the manifest yet.</p>
        )}
        {dimPartId && !dimensionsGap && (
          <form
            className="mt-3 rounded-md border border-border-default bg-elevated p-3"
            data-testid="dimension-form"
            onSubmit={(e) => {
              e.preventDefault();
              const length = Number(dimForm.length_mm);
              const width = Number(dimForm.width_mm);
              const height = Number(dimForm.height_mm);
              if (
                !Number.isFinite(length) || length <= 0 ||
                !Number.isFinite(width) || width <= 0 ||
                !Number.isFinite(height) || height <= 0
              ) {
                setError("All three dimensions must be positive numbers in millimeters.");
                return;
              }
              setError(null);
              submitDimensions.mutate({
                partId: dimPartId,
                body: { length_mm: length, width_mm: width, height_mm: height },
              });
            }}
          >
            <p className="text-sm font-medium">Dimensions for {dimPartId}</p>
            <p className="mt-0.5 text-xs text-muted">All measurements in millimeters.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <div>
                <label htmlFor="dim-length" className="label">Length (mm)</label>
                <input
                  id="dim-length"
                  className="input w-24 tnum"
                  inputMode="numeric"
                  required
                  value={dimForm.length_mm}
                  onChange={(e) => setDimForm((f) => ({ ...f, length_mm: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="dim-width" className="label">Width (mm)</label>
                <input
                  id="dim-width"
                  className="input w-24 tnum"
                  inputMode="numeric"
                  required
                  value={dimForm.width_mm}
                  onChange={(e) => setDimForm((f) => ({ ...f, width_mm: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="dim-height" className="label">Height (mm)</label>
                <input
                  id="dim-height"
                  className="input w-24 tnum"
                  inputMode="numeric"
                  required
                  value={dimForm.height_mm}
                  onChange={(e) => setDimForm((f) => ({ ...f, height_mm: e.target.value }))}
                />
              </div>
            </div>
            {error && dimPartId && <InlineError message={error} />}
            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={readOnly || submitDimensions.isPending}
                aria-label={submitDimensions.isPending ? "Submitting dimensions" : "Submit dimensions"}
              >
                {submitDimensions.isPending ? "Submitting…" : "Submit dimensions"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setDimPartId(null); setError(null); }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {dimensionsGap && (
          <div className="mt-3" data-testid="dimensions-degradation-wrap">
            <DegradationPanel
              preset={DEGRADATION_PRESETS.dimensions()}
              testId="degradation-dimensions"
            />
          </div>
        )}
        {dimVerifiedPartId && !dimPartId && !dimensionsGap && (
          <p
            className="mt-2 rounded-sm border-l-2 border-ok bg-ok/10 px-2 py-1 text-sm"
            role="status"
            data-testid="dim-success-notice"
          >
            Dimensions recorded for part {dimVerifiedPartId}.
          </p>
        )}
      </section>

      {/* Assembly graph editor (spec §8.6 layout: …→ assembly graph editor →
          publish flow). Table of AssemblyGraphStep rows. "Save graph" → POST
          …/assembly/graph (404 → DegradationPanel with Export graph JSON). */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Assembly graph</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                setGraphSteps((steps) => [
                  ...steps,
                  { description: "", tool_callout: "", safety_warning: "", associated_part_ids: "", step_position_label: "install" },
                ])
              }
              disabled={readOnly}
              data-testid="graph-add-step"
            >
              Add step
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={readOnly || saveGraph.isPending || validGraphSteps.length === 0}
              title={
                validGraphSteps.length === 0
                  ? "Add at least one step with a description"
                  : readOnly
                    ? "Unavailable while offline"
                    : undefined
              }
              onClick={() => saveGraph.mutate()}
              data-testid="graph-save"
              aria-label={saveGraph.isPending ? "Saving assembly graph" : "Save assembly graph to backend"}
            >
              {saveGraph.isPending ? "Saving…" : "Save graph"}
            </button>
          </div>
        </div>
        <p className="mt-0.5 text-sm text-muted">
          Define the step-by-step assembly sequence. Each step describes what to do, which tools to
          use, and which parts it involves.
        </p>
        {graphSteps.length === 0 && (
          <p className="mt-2 text-sm text-muted">
            No steps yet. Click "Add step" to start building the assembly graph.
          </p>
        )}
        {graphSteps.length > 0 && (
          <div className="mt-2 overflow-x-auto" data-testid="graph-editor">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs text-faint">
                  <th className="py-1.5 pr-3 w-8">#</th>
                  <th className="py-1.5 pr-3">Description</th>
                  <th className="py-1.5 pr-3">Position</th>
                  <th className="py-1.5 pr-3">Tool callout</th>
                  <th className="py-1.5 pr-3">Safety warning</th>
                  <th className="py-1.5 pr-3">Part IDs</th>
                  <th className="py-1.5 pr-2 w-8" aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {graphSteps.map((step, idx) => (
                  <tr key={idx} className="border-b border-border-subtle">
                    <td className="py-1.5 pr-3 tnum text-faint">{idx + 1}</td>
                    <td className="py-1.5 pr-3">
                      <input
                        className="input w-full"
                        placeholder="What to do in this step"
                        value={step.description}
                        onChange={(e) =>
                          setGraphSteps((steps) =>
                            steps.map((s, i) => (i === idx ? { ...s, description: e.target.value } : s)),
                          )
                        }
                        aria-label={`Step ${idx + 1} description`}
                      />
                    </td>
                    <td className="py-1.5 pr-3">
                      <select
                        className="input w-auto"
                        value={step.step_position_label}
                        onChange={(e) =>
                          setGraphSteps((steps) =>
                            steps.map((s, i) =>
                              i === idx ? { ...s, step_position_label: e.target.value as StepPositionLabel } : s,
                            ),
                          )
                        }
                        aria-label={`Step ${idx + 1} position label`}
                      >
                        <option value="exploded">exploded</option>
                        <option value="positioning">positioning</option>
                        <option value="install">install</option>
                        <option value="torque">torque</option>
                        <option value="finishing">finishing</option>
                      </select>
                    </td>
                    <td className="py-1.5 pr-3">
                      <input
                        className="input w-full"
                        placeholder="e.g. 10mm socket"
                        value={step.tool_callout}
                        onChange={(e) =>
                          setGraphSteps((steps) =>
                            steps.map((s, i) => (i === idx ? { ...s, tool_callout: e.target.value } : s)),
                          )
                        }
                        aria-label={`Step ${idx + 1} tool callout`}
                      />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input
                        className="input w-full"
                        placeholder="e.g. Torque to 40 Nm"
                        value={step.safety_warning}
                        onChange={(e) =>
                          setGraphSteps((steps) =>
                            steps.map((s, i) => (i === idx ? { ...s, safety_warning: e.target.value } : s)),
                          )
                        }
                        aria-label={`Step ${idx + 1} safety warning`}
                      />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input
                        className="input w-full font-mono text-xs"
                        placeholder="prt_001, prt_002"
                        value={step.associated_part_ids}
                        onChange={(e) =>
                          setGraphSteps((steps) =>
                            steps.map((s, i) => (i === idx ? { ...s, associated_part_ids: e.target.value } : s)),
                          )
                        }
                        aria-label={`Step ${idx + 1} associated part IDs (comma-separated)`}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setGraphSteps((steps) => steps.filter((_, i) => i !== idx))}
                        aria-label={`Remove step ${idx + 1}`}
                        title="Remove this step"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {graphGap && (
          <div className="mt-3" data-testid="graph-degradation-wrap">
            <DegradationPanel
              preset={{
                ...DEGRADATION_PRESETS.assembly_graph(),
                primary: { label: "Export graph JSON", onClick: exportGraphJson },
              }}
              testId="degradation-assembly-graph"
            />
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Guide links</h2>
        <p className="mt-0.5 text-sm text-muted">
          Mint a token-scoped link for the bay guide. The mechanic sees only this assembly, no
          operator session.
        </p>
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mintAssembly) {
              setError("Choose an assembly to mint a link for.");
              return;
            }
            mint.mutate({ assembly_id: mintAssembly });
          }}
        >
          <div>
            <label htmlFor="mint-assembly" className="label">
              Assembly
            </label>
            <select
              id="mint-assembly"
              className="input w-auto"
              value={mintAssembly}
              onChange={(e) => setMintAssembly(e.target.value)}
            >
              <option value="">Choose…</option>
              {assemblies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={readOnly || mint.isPending || assemblies.length === 0}
            title={
              assemblies.length === 0
                ? "Derive assemblies first (manifest required)"
                : readOnly
                  ? "Unavailable while offline"
                  : undefined
            }
            data-testid="mint-token"
          >
            {mint.isPending ? "Minting…" : "Mint guide link"}
          </button>
        </form>
        {duplicateWarning && (
          <p className="mt-2 rounded-sm border-l-2 border-accent bg-accent/10 px-2 py-1 text-sm" role="status">
            {duplicateWarning}
          </p>
        )}
        {tokenRevoked && (
          <p className="mt-2 rounded-sm border-l-2 border-signal bg-signal/10 px-2 py-1 text-sm" role="status" data-testid="token-revoked-notice">
            Guide link revoked — the mechanic can no longer open it.
          </p>
        )}
        {minted && (
          <div className="mt-3 rounded-md border border-border-default bg-elevated p-3" data-testid="minted-token">
            <p className="text-sm font-medium">Guide link minted</p>
            <p className="mt-1 break-all font-mono text-xs tnum">
              {window.location.origin}/guide/{minted.token_id}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(`${window.location.origin}/guide/${minted.token_id}`)
                    .then(() => toast("info", "Guide link copied to clipboard"));
                }}
                aria-label="Copy guide link to clipboard"
              >
                Copy link
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={readOnly || extendToken.isPending}
                title={readOnly ? "Unavailable while offline" : undefined}
                onClick={() => setExtendOpen(true)}
                data-testid="extend-token"
              >
                Extend
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={readOnly || supersedeToken.isPending}
                title={readOnly ? "Unavailable while offline" : undefined}
                onClick={() => setSupersedeOpen(true)}
                data-testid="supersede-token"
              >
                Supersede
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={readOnly || revokeToken.isPending}
                title={readOnly ? "Unavailable while offline" : undefined}
                onClick={() => setRevokeOpen(true)}
                data-testid="revoke-token"
              >
                Revoke
              </button>
              {minted.expires_at && (
                <Chip label="expires" value={fmtDateTime(minted.expires_at)} tone="faint" />
              )}
            </div>
          </div>
        )}
        {supersededToken && (
          <div className="mt-3 rounded-md border border-ok/40 bg-ok/10 p-3" data-testid="superseded-token">
            <p className="text-sm font-medium">New guide link minted</p>
            <p className="mt-1 text-sm text-muted">
              The old link stays readable but shows a superseded banner. Share this new one instead.
            </p>
            <p className="mt-1 break-all font-mono text-xs tnum">
              {window.location.origin}/guide/{supersededToken.token_id}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(`${window.location.origin}/guide/${supersededToken.token_id}`)
                    .then(() => toast("info", "New guide link copied to clipboard"));
                }}
                aria-label="Copy new guide link to clipboard"
              >
                Copy new link
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setSupersededToken(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Mechanic flags</h2>
        {flags.isPending && <SkeletonRows rows={2} />}
        {flags.isError && <InlineError message={`Flags failed to load: ${flags.error.message}`} />}
        {flags.data && flags.data.length === 0 && (
          <p className="mt-1 text-sm text-muted">
            No flags from the bay. When a mechanic hits a snag on the guide, it lands here.
          </p>
        )}
        {flags.data && flags.data.length > 0 && (
          <ul className="mt-2 flex flex-col gap-2" data-testid="flag-list">
            {flags.data.map((f) => (
              <FlagRow
                key={f.flag_id}
                flag={f}
                readOnly={readOnly}
                onResolve={(notes) =>
                  resolveFlag.mutate({ flag_id: f.flag_id, notes })
                }
                pending={resolveFlag.isPending}
              />
            ))}
          </ul>
        )}
      </section>

      {(publishGap || exportGap) && (
        <section className="flex flex-col gap-3" data-testid="phase-gap-panels">
          {publishGap && (
            <DegradationPanel
              preset={DEGRADATION_PRESETS.publish(project.project_id)}
              testId="degradation-publish"
            />
          )}
          {exportGap && (
            <DegradationPanel
              preset={DEGRADATION_PRESETS.export_artifact()}
              testId="degradation-export"
            />
          )}
        </section>
      )}

      {/* Token extend modal (spec §4.8 Modal inventory: "token extend") */}
      <Modal
        open={extendOpen}
        onClose={() => {
          setError(null);
          setExtendOpen(false);
        }}
        title="Extend guide link"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const days = Number(extendDays);
            if (!Number.isFinite(days) || days < 1 || days > 365) {
              setError("Extend by 1–365 days.");
              return;
            }
            setError(null);
            extendToken.mutate();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted">
            Add days to the link's expiry. The mechanic keeps the same URL — no new link to share.
          </p>
          <div>
            <label htmlFor="extend-days" className="label">
              Days to add
            </label>
            <input
              id="extend-days"
              className="input w-28 tnum"
              inputMode="numeric"
              value={extendDays}
              onChange={(e) => setExtendDays(e.target.value)}
              aria-describedby="extend-hint"
            />
            <p id="extend-hint" className="mt-1 text-xs text-muted">
              1–365 days from the current expiry.
            </p>
          </div>
          {error && extendOpen && <InlineError message={error} />}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={extendToken.isPending}
              aria-label={extendToken.isPending ? "Extending guide link" : "Extend guide link"}
            >
              {extendToken.isPending ? "Extending…" : "Extend link"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setError(null);
                setExtendOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Token revoke confirmation (destructive — custom flow, not window.confirm) */}
      <Modal
        open={revokeOpen}
        onClose={() => {
          setError(null);
          setRevokeOpen(false);
        }}
        title="Revoke guide link"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            revokeToken.mutate();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted">
            Revoking kills the link immediately — the mechanic gets a 410 expired page on next
            open. This is recorded in the audit log.
          </p>
          {error && revokeOpen && <InlineError message={error} />}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-danger"
              disabled={revokeToken.isPending}
              aria-label={revokeToken.isPending ? "Revoking guide link" : "Revoke guide link"}
            >
              {revokeToken.isPending ? "Revoking…" : "Revoke link"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setError(null);
                setRevokeOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Token supersede confirmation (§8.6, AT-041). Not destructive — the old
          link stays readable but is marked superseded; the new link is authoritative. */}
      <Modal
        open={supersedeOpen}
        onClose={() => {
          setError(null);
          setSupersedeOpen(false);
        }}
        title="Supersede guide link"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            supersedeToken.mutate();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted">
            Mints a new link and marks this one superseded. The mechanic sees a "replaced by a newer
            one" banner on the old link — it stays readable but is no longer authoritative. The new
            link appears below once minted.
          </p>
          {error && supersedeOpen && <InlineError message={error} />}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={supersedeToken.isPending}
              aria-label={supersedeToken.isPending ? "Superseding guide link" : "Supersede guide link"}
            >
              {supersedeToken.isPending ? "Minting new link…" : "Supersede link"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setError(null);
                setSupersedeOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {error && !extendOpen && !revokeOpen && !supersedeOpen && <InlineError message={error} />}
    </div>
  );
}

function FlagRow({
  flag,
  readOnly,
  onResolve,
  pending,
}: {
  flag: MechanicFlag;
  readOnly: boolean;
  onResolve: (notes: string) => void;
  pending: boolean;
}) {
  const [notes, setNotes] = useState("");
  return (
    <li className="rounded-md border border-border-subtle bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {flag.step_index != null && (
            <span className="mr-2 font-mono text-xs text-faint tnum">step {flag.step_index + 1}</span>
          )}
          {flag.description}
        </p>
        {flag.resolved ? (
          <Chip label="flag" value="resolved" tone="ok" />
        ) : (
          <Chip label="flag" value="open" tone="accent" />
        )}
      </div>
      {!flag.resolved && (
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Resolution notes"
            className="input flex-1"
            placeholder="Resolution notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={readOnly || pending || !notes.trim()}
            title={!notes.trim() ? "Resolution notes are required" : readOnly ? "Unavailable while offline" : undefined}
            onClick={() => onResolve(notes.trim())}
          >
            Resolve
          </button>
        </div>
      )}
      {flag.resolved && flag.resolution_notes && (
        <p className="mt-1 text-xs text-muted">{flag.resolution_notes}</p>
      )}
    </li>
  );
}
