// U5 — Model Shop. Assembly creation, token management, flag review, and the
// gated 3D / QA / publish / graph surfaces (spec §8.5).
//
// Always-available: manual assembly creation (S-7, multipart, min 1 step),
// assembly list, token manager (mint/revoke/bulk/extend), flag review drawer.
// Gated (capability manifest): 3D viewer (G-2b), QA inspector (G-2a/G-5),
// publish wizard (G-3), graph editor (G-4). Gated sections render honest
// placeholders naming the capability and what lands when it flips.

import { FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useProject,
  useAssemblies,
  useCreateManualAssembly,
  useTokens,
  useMintToken,
  useRevokeToken,
  useBulkRevokeTokens,
  useExtendToken,
  useFlags,
  useResolveFlag,
  useCapabilities,
} from "@/shared/hooks";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Modal } from "@/shared/ui/Modal";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { useToast } from "@/shared/ui/Toast";
import { vehicleTitle, shortId, datetime } from "@/shared/format";
import type { ManualAssemblyStep, StepPositionLabel, AssemblySummary, GuideToken, Flag } from "@/shared/api-types";

const POSITION_LABELS: { value: StepPositionLabel; label: string }[] = [
  { value: "exploded", label: "Exploded" },
  { value: "install", label: "Install" },
  { value: "torque", label: "Torque" },
  { value: "finishing", label: "Finishing" },
];

export function ModelShop() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const assemblies = useAssemblies(projectId);
  const tokens = useTokens(projectId);
  const flags = useFlags(projectId);
  const caps = useCapabilities();

  const [showAssemblyForm, setShowAssemblyForm] = useState(false);
  const [flagDrawerOpen, setFlagDrawerOpen] = useState(false);

  const openFlags = (flags.data ?? []).filter((f) => f.status === "open");

  if (project.isLoading) {
    return (
      <div className="flex flex-col gap-4" style={{ padding: "var(--space-6)" }} aria-live="polite" aria-busy="true">
        <Skeleton style={{ height: "3rem", width: "20rem" }} />
        <Skeleton style={{ height: "10rem" }} />
        <Skeleton style={{ height: "8rem" }} />
      </div>
    );
  }

  if (project.isError || !project.data) {
    return (
      <div style={{ padding: "var(--space-6)" }}>
        <ErrorBanner
          title="Couldn't load this job"
          message={project.error instanceof Error ? project.error.message : "The project may not exist or the server is unreachable."}
          retry={() => project.refetch()}
          retryLoading={project.isFetching}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      <header className="animate-enter">
        <div className="flex items-center gap-2 text-sm" style={{ marginBottom: "0.5rem" }}>
          <Link to={`/projects/${projectId}`} className="text-fg-tertiary hover:text-fg-secondary">
            ← {vehicleTitle(project.data.vehicle_meta)}
          </Link>
        </div>
        <h1 className="lead-rule text-2xl font-semibold tracking-tight text-fg-primary" style={{ margin: 0 }}>
          Model shop
        </h1>
        <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
          Build assemblies, mint guide tokens, and review mechanic flags.
        </p>
      </header>

      {/* Capability badges */}
      <div className="flex flex-wrap gap-2" aria-label="Model shop capabilities">
        <CapBadge label="3D generation" state={caps.generate_3d ?? "unknown"} />
        <CapBadge label="Publish" state={caps.publish ?? "unknown"} />
        <CapBadge label="Graph editor" state={caps.assembly_graph ?? "unknown"} />
        <CapBadge label="QA inspector" state={caps.assemblies_list ?? "unknown"} />
      </div>

      {/* Flag review entry */}
      {openFlags.length > 0 && (
        <Card
          hover
          interactive
          onClick={() => setFlagDrawerOpen(true)}
          aria-label={`Review ${openFlags.length} open mechanic flags`}
          className="flex items-center gap-3"
          style={{ padding: "var(--space-3) var(--space-4)", borderColor: "var(--signal-amber)" }}
        >
          <span style={{ color: "var(--signal-amber)" }} aria-hidden>
            <Icon d={ICONS.flag} width={18} height={18} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-fg-primary">{openFlags.length} open mechanic flag{openFlags.length > 1 ? "s" : ""}</p>
            <p className="text-xs text-fg-tertiary">Review problems reported from the shop floor.</p>
          </div>
          <Icon d={ICONS.chevronRight} width={16} height={16} style={{ color: "var(--fg-tertiary)" }} />
        </Card>
      )}

      {/* Manual assembly creation + assembly list */}
      <section className="flex flex-col gap-3" aria-label="Assemblies">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-fg-secondary" style={{ margin: 0 }}>Assemblies</h2>
          <Button variant="primary" size="sm" icon={ICONS.plus} onClick={() => setShowAssemblyForm(true)}>
            New manual assembly
          </Button>
        </div>
        {assemblies.isLoading ? (
          <Skeleton style={{ height: "6rem" }} />
        ) : assemblies.isError ? (
          <ErrorBanner
            inline
            message="Couldn't load assemblies. The assembly-listing endpoint may not be registered yet."
            retry={() => assemblies.refetch()}
            retryLoading={assemblies.isFetching}
          />
        ) : (assemblies.data ?? []).length === 0 ? (
          <EmptyState
            icon={ICONS.layers}
            title="No assemblies yet"
            description="Create a text-only manual assembly to mint guide tokens for the shop floor. Minimum one step."
            action={<Button variant="secondary" size="sm" icon={ICONS.plus} onClick={() => setShowAssemblyForm(true)}>Create assembly</Button>}
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {(assemblies.data ?? []).map((a) => (
              <li key={a.assembly_id}>
                <AssemblyCard assembly={a} projectId={projectId!} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Token manager */}
      <TokenManager projectId={projectId!} tokens={tokens.data ?? []} loading={tokens.isLoading} error={tokens.error} />

      {/* Gated: 3D viewer */}
      <GatedSection
        title="3D viewer"
        description="Generate and view 3D meshes with camera-path interpolation, hotspot navigation, and dimensional measurement."
        state={caps.generate_3d ?? "unknown"}
        availableNote="3D generation is available. The viewer loads GLB meshes per step."
      />

      {/* Gated: publish wizard */}
      <GatedSection
        title="Publish wizard"
        description="Review an assembly, configure token defaults, publish, and export a PDF artifact."
        state={caps.publish ?? "unknown"}
        availableNote="Publish is available. Run the checklist, configure tokens, and publish."
      />

      {/* Gated: graph editor */}
      <GatedSection
        title="Assembly graph editor"
        description="Reorder and edit assembly steps in a step-sequencer, then preview as the mechanic will see it."
        state={caps.assembly_graph ?? "unknown"}
        availableNote="The graph editor is available. Reorder, edit, and preview steps."
      />

      {showAssemblyForm && (
        <ManualAssemblyForm
          projectId={projectId!}
          onClose={() => setShowAssemblyForm(false)}
        />
      )}

      {flagDrawerOpen && (
        <FlagReviewDrawer
          flags={openFlags}
          projectId={projectId!}
          onClose={() => setFlagDrawerOpen(false)}
        />
      )}
    </div>
  );
}

function CapBadge({ label, state }: { label: string; state: string }) {
  const hue = state === "available" ? "var(--status-complete)" : state === "gated" ? "var(--fg-tertiary)" : "var(--signal-amber)";
  const soft = state === "available" ? "var(--status-complete-soft)" : state === "gated" ? "transparent" : "var(--signal-amber-soft)";
  return <Badge hue={hue} soft={soft} label={`${label}: ${state}`} />;
}

function AssemblyCard({ assembly, projectId }: { assembly: AssemblySummary; projectId: string }) {
  const overBudget = assembly.total_duration_s > 600;
  return (
    <Card hover style={{ padding: "var(--space-4)" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg-primary truncate">{shortId(assembly.assembly_id)}</p>
          <p className="text-xs text-fg-tertiary" style={{ marginTop: "0.125rem" }}>
            v{assembly.bundle_version} · {assembly.step_count} step{assembly.step_count !== 1 ? "s" : ""}
          </p>
        </div>
        <Badge hue="var(--accent)" soft="var(--accent-soft)" label={assembly.tier} />
      </div>
      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: "var(--space-3)" }}>
        <Badge hue="var(--fg-tertiary)" label={assembly.qa_status.replace(/_/g, " ")} />
        <span className="tnum text-xs text-fg-tertiary">{Math.round(assembly.total_duration_s)}s</span>
        {overBudget && (
          <Badge hue="var(--signal-amber)" soft="var(--signal-amber-soft)" icon={ICONS.alert} label=">10 min" />
        )}
        {assembly.audio_available && <Badge hue="var(--status-complete)" label="audio" />}
      </div>
      <div style={{ marginTop: "var(--space-3)", paddingTop: "var(--space-3)", borderTop: "0.0625rem solid var(--border-subtle)" }}>
        <Link to={`/projects/${projectId}`}>
          <Button variant="ghost" size="sm" iconRight={ICONS.chevronRight}>Open in job</Button>
        </Link>
      </div>
    </Card>
  );
}

function ManualAssemblyForm({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const create = useCreateManualAssembly(projectId);
  const toast = useToast();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [steps, setSteps] = useState<ManualAssemblyStep[]>([
    { caption: "", part_name: "", required_tool: "", safety_warning: "", step_position_label: "install" },
  ]);

  const nameError = nameTouched && !name.trim() ? "Give the assembly a name." : undefined;
  const stepErrors = steps.map((s) => (s.caption.trim() ? undefined : "Caption is required."));
  const hasStepError = stepErrors.some(Boolean);
  const canSubmit = Boolean(name.trim()) && !hasStepError && !create.isPending;

  function updateStep(i: number, patch: Partial<ManualAssemblyStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function addStep() {
    setSteps((prev) => [...prev, { caption: "", part_name: "", required_tool: "", safety_warning: "", step_position_label: "install" }]);
  }
  function removeStep(i: number) {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setNameTouched(true);
    if (!canSubmit) return;
    try {
      const res = await create.mutateAsync({ name: name.trim(), steps: steps.map((s) => ({ ...s, caption: s.caption.trim() })) });
      toast.push("success", `Assembly ${shortId(res.assembly_id)} created.`);
      onClose();
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't create the assembly.");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New manual assembly"
      description="Text-only assembly steps for the shop-floor guide. Minimum one step."
      blocking={create.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!canSubmit} disabledReason={!name.trim() ? "Name the assembly" : hasStepError ? "Every step needs a caption" : undefined} onClick={onSubmit}>
            Create assembly
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Input
          label="Assembly name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setNameTouched(true)}
          placeholder="e.g. Front brake caliper — left side"
          error={nameError}
          required
        />
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-fg-secondary">Steps ({steps.length})</span>
            <Button type="button" variant="ghost" size="sm" icon={ICONS.plus} onClick={addStep}>Add step</Button>
          </div>
          {steps.map((step, i) => (
            <div key={i} className="flex flex-col gap-2" style={{ padding: "var(--space-3)", background: "var(--bg-elevated)", borderRadius: "var(--radius-md)", border: "0.0625rem solid var(--border-subtle)" }}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-fg-tertiary tnum">Step {i + 1}</span>
                {steps.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => removeStep(i)}
                  >
                    <Icon d={ICONS.close} width={14} height={14} />
                  </button>
                )}
              </div>
              <Input
                label="Caption"
                value={step.caption}
                onChange={(e) => updateStep(i, { caption: e.target.value })}
                placeholder="What to do in this step"
                error={stepErrors[i]}
                required
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <Input label="Part name (optional)" value={step.part_name ?? ""} onChange={(e) => updateStep(i, { part_name: e.target.value })} />
                <Input label="Required tool (optional)" value={step.required_tool ?? ""} onChange={(e) => updateStep(i, { required_tool: e.target.value })} />
              </div>
              <Input label="Safety warning (optional)" value={step.safety_warning ?? ""} onChange={(e) => updateStep(i, { safety_warning: e.target.value })} />
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-fg-secondary">Position label</span>
                <select
                  className="input"
                  value={step.step_position_label}
                  onChange={(e) => updateStep(i, { step_position_label: e.target.value as StepPositionLabel })}
                  aria-label={`Position label for step ${i + 1}`}
                >
                  {POSITION_LABELS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
            </div>
          ))}
        </div>
      </form>
    </Modal>
  );
}

function TokenManager({ projectId, tokens, loading, error }: { projectId: string; tokens: GuideToken[]; loading: boolean; error: unknown }) {
  const mint = useMintToken(projectId);
  const revoke = useRevokeToken(projectId);
  const bulkRevoke = useBulkRevokeTokens(projectId);
  const extend = useExtendToken(projectId);
  const toast = useToast();
  const [mintAssemblyId, setMintAssemblyId] = useState("");
  const [mintDays, setMintDays] = useState(7);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [extendTarget, setExtendTarget] = useState<string | null>(null);
  const [extendDays, setExtendDays] = useState(7);

  async function doMint() {
    if (!mintAssemblyId.trim()) return;
    try {
      await mint.mutateAsync({ assembly_id: mintAssemblyId.trim(), expires_in_days: mintDays });
      toast.push("success", "Token minted.");
      setMintAssemblyId("");
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't mint token.");
    }
  }

  async function doRevoke(tokenId: string) {
    try {
      await revoke.mutateAsync(tokenId);
      toast.push("info", "Token revoked.");
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't revoke token.");
    }
  }

  async function doBulkRevoke() {
    try {
      await bulkRevoke.mutateAsync();
      toast.push("info", "All tokens revoked.");
      setConfirmBulk(false);
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't revoke tokens.");
    }
  }

  async function doExtend() {
    if (!extendTarget) return;
    try {
      await extend.mutateAsync({ tokenId: extendTarget, days: extendDays });
      toast.push("success", `Token extended by ${extendDays} days.`);
      setExtendTarget(null);
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't extend token.");
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Guide tokens">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-fg-secondary" style={{ margin: 0 }}>Guide tokens</h2>
        {tokens.length > 0 && (
          <Button variant="danger" size="sm" icon={ICONS.close} onClick={() => setConfirmBulk(true)}>
            Revoke all
          </Button>
        )}
      </div>

      {/* Mint form */}
      <Card style={{ padding: "var(--space-4)" }}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
          <label className="flex flex-col gap-1 sm:flex-1 min-w-[12rem]">
            <span className="text-sm font-medium text-fg-secondary">Assembly ID</span>
            <input
              className="input"
              value={mintAssemblyId}
              onChange={(e) => setMintAssemblyId(e.target.value)}
              placeholder="Paste an assembly_id from above"
              aria-label="Assembly ID to mint a token for"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-fg-secondary">Expires (days)</span>
            <input
              type="number"
              className="input"
              min={1}
              max={365}
              value={mintDays}
              onChange={(e) => setMintDays(Number(e.target.value) || 7)}
              aria-label="Token expiry in days"
            />
          </label>
          <Button variant="primary" icon={ICONS.key} loading={mint.isPending} disabled={!mintAssemblyId.trim()} disabledReason={!mintAssemblyId.trim() ? "Enter an assembly ID" : undefined} onClick={doMint}>
            Mint token
          </Button>
        </div>
      </Card>

      {loading ? (
        <Skeleton style={{ height: "8rem" }} />
      ) : error ? (
        <ErrorBanner inline message="Couldn't load tokens." retry={() => {}} />
      ) : tokens.length === 0 ? (
        <EmptyState
          icon={ICONS.key}
          title="No guide tokens"
          description="Mint a token from an assembly to give a mechanic shop-floor access. The token URL opens the Bay Guide."
        />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-left" aria-label="Guide tokens">
            <thead>
              <tr className="text-xs text-fg-tertiary" style={{ borderBottom: "0.0625rem solid var(--border-subtle)" }}>
                <th scope="col" style={{ padding: "var(--space-2) var(--space-4)" }}>Token</th>
                <th scope="col" style={{ padding: "var(--space-2) var(--space-4)" }}>Tier</th>
                <th scope="col" style={{ padding: "var(--space-2) var(--space-4)" }}>Expires</th>
                <th scope="col" style={{ padding: "var(--space-2) var(--space-4)" }}>Status</th>
                <th scope="col" style={{ padding: "var(--space-2) var(--space-4)", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const expired = t.expires_at ? new Date(t.expires_at) < new Date() : false;
                return (
                  <tr key={t.token_id} className="text-sm" style={{ borderBottom: "0.0625rem solid var(--border-subtle)" }}>
                    <td style={{ padding: "var(--space-3) var(--space-4)" }} className="font-mono text-xs text-fg-primary">
                      <CopyableId id={t.token_id} />
                    </td>
                    <td style={{ padding: "var(--space-3) var(--space-4)" }}><Badge hue="var(--accent)" soft="var(--accent-soft)" label={t.tier} /></td>
                    <td className="tnum text-fg-secondary" style={{ padding: "var(--space-3) var(--space-4)" }}>
                      {t.expires_at ? datetime(t.expires_at) : "—"}
                    </td>
                    <td style={{ padding: "var(--space-3) var(--space-4)" }}>
                      {t.revoked ? (
                        <Badge hue="var(--status-failed)" soft="var(--status-failed-soft)" label="Revoked" />
                      ) : t.superseded ? (
                        <Badge hue="var(--fg-tertiary)" label="Superseded" />
                      ) : expired ? (
                        <Badge hue="var(--signal-amber)" soft="var(--signal-amber-soft)" label="Expired" />
                      ) : (
                        <Badge hue="var(--status-complete)" soft="var(--status-complete-soft)" icon={ICONS.check} label="Active" />
                      )}
                    </td>
                    <td style={{ padding: "var(--space-3) var(--space-4)", textAlign: "right" }}>
                      <div className="inline-flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { setExtendTarget(t.token_id); setExtendDays(7); }} disabled={t.revoked}>
                          Extend
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => doRevoke(t.token_id)} disabled={t.revoked} loading={revoke.isPending}>
                          Revoke
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmBulk && (
        <Modal
          open
          onClose={() => setConfirmBulk(false)}
          title="Revoke all tokens?"
          description={`This revokes all ${tokens.length} guide tokens. Mechanics holding those tokens will lose access immediately.`}
          blocking={bulkRevoke.isPending}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmBulk(false)} disabled={bulkRevoke.isPending}>Cancel</Button>
              <Button variant="danger" loading={bulkRevoke.isPending} onClick={doBulkRevoke}>Revoke all</Button>
            </>
          }
        >
          <p className="text-sm text-fg-secondary">This action cannot be undone. Mint new tokens afterward to restore access.</p>
        </Modal>
      )}

      {extendTarget && (
        <Modal
          open
          onClose={() => setExtendTarget(null)}
          title="Extend token"
          description={`Add days to token ${shortId(extendTarget)}.`}
          blocking={extend.isPending}
          footer={
            <>
              <Button variant="ghost" onClick={() => setExtendTarget(null)} disabled={extend.isPending}>Cancel</Button>
              <Button variant="primary" loading={extend.isPending} onClick={doExtend}>Extend by {extendDays} days</Button>
            </>
          }
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-fg-secondary">Days to add</span>
            <input type="number" className="input" min={1} max={365} value={extendDays} onChange={(e) => setExtendDays(Number(e.target.value) || 7)} aria-label="Days to add" />
          </label>
        </Modal>
      )}
    </section>
  );
}

function FlagReviewDrawer({ flags, projectId, onClose }: { flags: Flag[]; projectId: string; onClose: () => void }) {
  const resolve = useResolveFlag(projectId);
  const toast = useToast();
  const [resolving, setResolving] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  async function doResolve(flagId: string) {
    if (!notes.trim()) return;
    try {
      await resolve.mutateAsync({ flagId, resolutionNotes: notes.trim() });
      toast.push("success", "Flag resolved.");
      setResolving(null);
      setNotes("");
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't resolve flag.");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Mechanic flags (${flags.length})`}
      description="Problems reported from the shop-floor guide. Resolve each with a note for the record."
      style={{ maxWidth: "40rem" }}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <ul className="flex flex-col gap-3">
        {flags.map((f) => (
          <li key={f.flag_id}>
            <Card style={{ padding: "var(--space-3)" }}>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge hue="var(--signal-amber)" soft="var(--signal-amber-soft)" label={f.problem_type.replace(/_/g, " ")} />
                {f.step_id && <span className="text-xs text-fg-tertiary tnum">step {f.step_id}</span>}
                <span className="text-xs text-fg-tertiary tnum" style={{ marginLeft: "auto" }}>{datetime(f.created_at)}</span>
              </div>
              <p className="text-sm text-fg-secondary" style={{ marginTop: "0.5rem" }}>{f.description}</p>
              {resolving === f.flag_id ? (
                <div className="flex flex-col gap-2" style={{ marginTop: "var(--space-3)" }}>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-fg-tertiary">Resolution note</span>
                    <textarea
                      className="input"
                      rows={2}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="What you did about it"
                      aria-label={`Resolution note for flag ${shortId(f.flag_id)}`}
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" loading={resolve.isPending} disabled={!notes.trim()} onClick={() => doResolve(f.flag_id)}>Resolve</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setResolving(null); setNotes(""); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Button variant="secondary" size="sm" icon={ICONS.check} onClick={() => { setResolving(f.flag_id); setNotes(""); }}>
                    Resolve
                  </Button>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function GatedSection({ title, description, state, availableNote }: { title: string; description: string; state: string; availableNote: string }) {
  const available = state === "available";
  return (
    <Card style={{ padding: "var(--space-4)", opacity: available ? 1 : 0.7 }}>
      <div className="flex items-start gap-3">
        <span style={{ color: available ? "var(--status-complete)" : "var(--fg-tertiary)", flexShrink: 0, marginTop: "0.125rem" }} aria-hidden>
          <Icon d={available ? ICONS.check : ICONS.bolt} width={18} height={18} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-fg-primary" style={{ margin: 0 }}>{title}</h3>
            <Badge hue={available ? "var(--status-complete)" : "var(--fg-tertiary)"} soft={available ? "var(--status-complete-soft)" : undefined} label={state} />
          </div>
          <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
            {available ? availableNote : description}
          </p>
          {!available && (
            <p className="text-xs text-fg-tertiary" style={{ marginTop: "0.5rem" }}>
              {state === "gated"
                ? "Not deployed yet. Surfaces automatically when the capability flips to available."
                : "Capability status unknown — probing the endpoint."}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — no-op
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="font-mono text-xs text-fg-primary hover:text-accent"
      title="Copy to clipboard"
      aria-label={`Copy ${id}`}
    >
      {shortId(id)} {copied ? "✓ copied" : "⧉"}
    </button>
  );
}
