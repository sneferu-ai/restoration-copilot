// U3 — Intake Bay. Vehicle intake form + photo upload + component log.
// The operator seals the intake to start the identification scan.

import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useProject } from "@/shared/hooks";
import { useSession } from "@/shared/session";
import { Card } from "@/shared/ui/Card";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Badge } from "@/shared/ui/Badge";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { Modal } from "@/shared/ui/Modal";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { useToast } from "@/shared/ui/Toast";
import { statusOf } from "@/shared/status";
import { shortId, vehicleTitle, datetime } from "@/shared/format";

interface PhotoRef {
  name: string;
  url: string;
  size: number;
  file: File;
}

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"];
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_BATCH = 50;
const MIN_PHOTOS_TO_SEAL = 6;

export function IntakeBay() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const navigate = useNavigate();
  const toast = useToast();
  const { token } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<PhotoRef[]>([]);
  const [componentName, setComponentName] = useState("");
  const [componentCategory, setComponentCategory] = useState("");
  const [componentCondition, setComponentCondition] = useState("");
  const [components, setComponents] = useState<Array<{ name: string; category: string; condition: string }>>([]);
  const [sealOpen, setSealOpen] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);

  // Revoke all object URLs on unmount to prevent memory leaks.
  useEffect(() => {
    return () => {
      for (const photo of photos) URL.revokeObjectURL(photo.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (project.isLoading) {
    return (
      <div className="flex flex-col gap-4" style={{ padding: "var(--space-6)" }} aria-live="polite" aria-busy="true">
        <Skeleton style={{ height: "3rem", width: "16rem" }} />
        <Skeleton style={{ height: "20rem" }} />
      </div>
    );
  }

  if (project.isError || !project.data) {
    return (
      <div style={{ padding: "var(--space-6)" }}>
        <ErrorBanner title="Couldn't load intake" message="The project may not exist or the server is unreachable." retry={() => project.refetch()} retryLoading={project.isFetching} />
      </div>
    );
  }

  const p = project.data;
  const cfg = statusOf(p.status);
  const sealed = p.status !== "draft" && p.status !== "intake_open";
  const title = vehicleTitle(p.vehicle_meta);

  function onFiles(files: FileList) {
    const next: PhotoRef[] = [];
    const errors: string[] = [];
    const remaining = MAX_BATCH - photos.length;
    if (remaining <= 0) {
      toast.push("error", `Maximum ${MAX_BATCH} photos per batch. Remove some before adding more.`);
      return;
    }
    let skipped = 0;
    for (const file of Array.from(files)) {
      // Check type — accept by MIME or extension fallback (HEIC/HEIF may not have a MIME type in all browsers)
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const typeOk = ACCEPTED_TYPES.includes(file.type) || ["heic", "heif", "webp", "jpg", "jpeg", "png"].includes(ext);
      if (!typeOk) {
        errors.push(`${file.name}: unsupported format. Use JPEG, PNG, HEIC, HEIF, or WebP.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        errors.push(`${file.name}: exceeds 25 MB limit.`);
        continue;
      }
      if (next.length + photos.length >= MAX_BATCH) {
        skipped++;
        continue;
      }
      next.push({ name: file.name, url: URL.createObjectURL(file), size: file.size, file });
    }
    if (skipped > 0) {
      errors.push(`${skipped} file${skipped > 1 ? "s" : ""} skipped — batch limit of ${MAX_BATCH} reached.`);
    }
    setUploadErrors(errors);
    if (errors.length > 0 && next.length === 0) {
      toast.push("error", errors[0]);
    } else if (errors.length > 0) {
      toast.push("info", `${next.length} added, ${errors.length} rejected.`);
    }
    if (next.length > 0) setPhotos((prev) => [...prev, ...next]);
  }

  function addComponent(e: FormEvent) {
    e.preventDefault();
    if (!componentName.trim()) return;
    setComponents((prev) => [...prev, { name: componentName.trim(), category: componentCategory.trim() || "uncategorized", condition: componentCondition.trim() }]);
    setComponentName(""); setComponentCategory(""); setComponentCondition("");
  }

  async function sealIntake() {
    setSealing(true);
    setUploading(true);
    try {
      // Step 1: upload photos + components via multipart to the intake endpoint.
      if (photos.length > 0 || components.length > 0) {
        const form = new FormData();
        for (const photo of photos) {
          form.append("photos", photo.file, photo.name);
        }
        if (components.length > 0) {
          const blob = new Blob([JSON.stringify(components)], { type: "application/json" });
          form.append("parts_list", blob, "components.json");
        }
        const uploadRes = await fetch(`/restoration/projects/${projectId}/intake`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (!uploadRes.ok) {
          const body = await uploadRes.json().catch(() => null);
          throw new Error(body?.message || `Upload failed (HTTP ${uploadRes.status})`);
        }
      }
      setUploading(false);
      // Step 2: seal the intake to start the identification scan.
      const res = await fetch(`/restoration/projects/${projectId}/intake/seal`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Seal failed (HTTP ${res.status})`);
      }
      toast.push("success", "Intake sealed. Identification scan starting.");
      setSealOpen(false);

      // Poll for identification completion — the project status transitions
      // from intake_sealed → identifying → review_open when the scan finishes.
      // Auto-navigate to the manifest once the scan completes (spec §8.2).
      const pollInterval = setInterval(async () => {
        const updated = await project.refetch();
        const st = updated.data?.status;
        if (st === "review_open" || st === "manifest_locked") {
          clearInterval(pollInterval);
          toast.push("success", "Identification complete. Manifest ready for review.");
          navigate(`/projects/${projectId}/manifest`);
        }
      }, 3000);
      // Safety: stop polling after 5 minutes.
      setTimeout(() => clearInterval(pollInterval), 300_000);
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Couldn't seal the intake.");
    } finally {
      setSealing(false);
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-fg-tertiary">
        <Link to="/" className="hover:text-fg-secondary">Jobs</Link>
        <Icon d={ICONS.chevronRight} width={12} height={12} />
        <Link to={`/projects/${projectId}`} className="hover:text-fg-secondary">{title}</Link>
        <Icon d={ICONS.chevronRight} width={12} height={12} />
        <span className="text-fg-secondary">Intake bay</span>
      </nav>

      <header className="flex items-start gap-4 flex-wrap animate-enter">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Intake bay</h1>
          <p className="text-sm text-fg-tertiary">{title} · {shortId(p.project_id)}</p>
        </div>
        <Badge hue={cfg.pipColor} soft={cfg.softColor} icon={cfg.icon} label={cfg.label} />
        {sealed && (
          <span className="badge" style={{ color: "var(--status-complete)", background: "var(--status-complete-soft)", borderColor: "var(--status-complete)" }}>
            <Icon d={ICONS.check} width={11} height={11} />
            Sealed {datetime(p.updated_at)}
          </span>
        )}
      </header>

      {sealed && (
        <EmptyState
          icon={ICONS.check}
          title="Intake is sealed"
          description="The identification scan has already started. You can review the parts manifest and sourcing results from the job room."
          action={<Link to={`/projects/${projectId}/manifest`} className="btn btn-primary btn-sm"><Icon d={ICONS.package} width={15} height={15} />View manifest</Link>}
        />
      )}

      {!sealed && (
        <>
          {/* Photo upload */}
          <section className="flex flex-col gap-3 animate-enter stagger-1">
            <h2 className="lead-rule text-lg font-semibold">Vehicle photos</h2>
            <Card
              hover
              style={{
                padding: 0,
                borderStyle: "dashed",
                borderColor: dragOver ? "var(--accent)" : undefined,
                background: dragOver ? "var(--accent-soft)" : undefined,
              }}
              // The card is the drop target — the inner button handles click-to-upload.
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
              }}
            >
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex flex-col items-center justify-center text-center gap-2 w-full"
                style={{ padding: "var(--space-10) var(--space-6)", background: "transparent", border: "none", color: "inherit", font: "inherit", cursor: "pointer" }}
                aria-label="Upload vehicle photos"
              >
                <Icon d={ICONS.upload} width={28} height={28} style={{ color: "var(--fg-tertiary)" }} />
                <p className="text-sm font-medium text-fg-secondary">Drop photos or click to upload</p>
                <p className="text-xs text-fg-tertiary">JPEG, PNG, HEIC, HEIF, or WebP · max 25 MB each · up to 50 photos</p>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".jpg,.jpeg,.png,.heic,.heif,.webp,image/jpeg,image/png,image/heic,image/heif,image/webp"
                multiple
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files) onFiles(e.target.files);
                  e.target.value = "";
                }}
                aria-label="Upload vehicle photos"
              />
            </Card>

            {photos.length > 0 && (
              <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {photos.map((photo, i) => (
                  <li key={i}>
                    <Card className="relative overflow-hidden" style={{ padding: 0 }}>
                      <img src={photo.url} alt={photo.name} style={{ width: "100%", height: "8rem", objectFit: "cover", borderRadius: "var(--radius-md) var(--radius-md) 0 0" }} />
                      <div className="flex items-center justify-between" style={{ padding: "var(--space-2) var(--space-3)" }}>
                        <span className="text-xs text-fg-tertiary truncate">{photo.name}</span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          aria-label={`Remove ${photo.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            URL.revokeObjectURL(photo.url);
                            setPhotos((prev) => prev.filter((_, j) => j !== i));
                          }}
                        >
                          <Icon d={ICONS.close} width={14} height={14} />
                        </button>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
            {uploadErrors.length > 0 && (
              <ul className="flex flex-col gap-1" style={{ marginTop: "var(--space-2)" }}>
                {uploadErrors.map((err, i) => (
                  <li key={i} className="text-xs text-fg-secondary flex items-center gap-2" style={{ color: "var(--status-failed)" }}>
                    <Icon d={ICONS.alert} width={12} height={12} />
                    {err}
                  </li>
                ))}
              </ul>
            )}

            {photos.length > 0 && photos.length < MIN_PHOTOS_TO_SEAL && (
              <p className="text-xs flex items-center gap-2" style={{ color: "var(--signal-amber)" }}>
                <Icon d={ICONS.alert} width={12} height={12} />
                {MIN_PHOTOS_TO_SEAL - photos.length} more photo{MIN_PHOTOS_TO_SEAL - photos.length > 1 ? "s" : ""} needed to seal the intake.
              </p>
            )}
          </section>

          {/* Component log */}
          <section className="flex flex-col gap-3 animate-enter stagger-2">
            <h2 className="lead-rule text-lg font-semibold">Known components</h2>
            <p className="text-sm text-fg-tertiary">Log parts you already know need replacement. The scan will identify the rest.</p>
            <form onSubmit={addComponent} className="card grid gap-3 sm:grid-cols-4" style={{ padding: "var(--space-4)" }}>
              <Input label="Component name" required value={componentName} onChange={(e) => setComponentName(e.target.value)} placeholder="e.g. Left front fender" />
              <Input label="Category" value={componentCategory} onChange={(e) => setComponentCategory(e.target.value)} placeholder="e.g. Body panel" />
              <Input label="Condition" value={componentCondition} onChange={(e) => setComponentCondition(e.target.value)} placeholder="e.g. Rusted through" />
              <div className="flex items-end">
                <Button type="submit" variant="secondary" icon={ICONS.plus} disabled={!componentName.trim()}>
                  Add
                </Button>
              </div>
            </form>

            {components.length > 0 && (
              <ul className="flex flex-col gap-2">
                {components.map((c, i) => (
                  <li key={i}>
                    <Card className="flex items-center gap-3" style={{ padding: "var(--space-3) var(--space-4)" }}>
                      <Icon d={ICONS.package} width={16} height={16} style={{ color: "var(--fg-tertiary)" }} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-fg-primary">{c.name}</span>
                        <span className="text-xs text-fg-tertiary" style={{ marginLeft: "var(--space-2)" }}>{c.category}</span>
                      </div>
                      <span className="text-xs text-fg-secondary">{c.condition}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={`Remove ${c.name}`}
                        onClick={() => setComponents((prev) => prev.filter((_, j) => j !== i))}
                      >
                        <Icon d={ICONS.close} width={14} height={14} />
                      </button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Seal */}
          <div className="flex items-center justify-end gap-3" style={{ paddingTop: "var(--space-4)" }}>
            <span className="text-xs text-fg-tertiary">
              Sealing the intake starts the identification scan. You can add photos later, but the scan runs on what's sealed now.
            </span>
            <Button
              variant="primary"
              icon={ICONS.check}
              onClick={() => setSealOpen(true)}
              disabled={photos.length < MIN_PHOTOS_TO_SEAL}
              disabledReason={photos.length < MIN_PHOTOS_TO_SEAL ? `Upload at least ${MIN_PHOTOS_TO_SEAL} photos to seal (${photos.length} of ${MIN_PHOTOS_TO_SEAL}).` : undefined}
            >
              Seal intake
            </Button>
          </div>

          <Modal
            open={sealOpen}
            onClose={() => setSealOpen(false)}
            title="Seal intake?"
            description={`${photos.length} photos · ${components.length} known components`}
            blocking={sealing}
            footer={
              <>
                <Button variant="ghost" onClick={() => setSealOpen(false)} disabled={sealing}>Cancel</Button>
                <Button variant="primary" icon={ICONS.check} loading={sealing} loadingLabel={uploading ? "Uploading photos…" : "Sealing…"} onClick={sealIntake}>
                  Seal & start scan
                </Button>
              </>
            }
          >
            <p className="text-sm text-fg-secondary">
              The identification scan will analyze the photos and known components to build a parts manifest. This typically takes a few minutes.
            </p>
          </Modal>
        </>
      )}
    </div>
  );
}
