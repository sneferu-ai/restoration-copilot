// U2 — Intake Bay (spec §6.2). Create mode (#/jobs/new) and per-project mode
// (JobRoom intake tab): photo/parts-list upload with per-file receipts, seal
// gate at 6 accepted photos (AC-UI-005), identify task with 2s polling.

import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@shared/api-client";
import { keys } from "@shared/keys";
import { useAuditMutation } from "@shared/mutations";
import { useReadOnly } from "@shared/hooks";
import { Chip, InlineError, SkeletonRows } from "@shared/components";
import { sha8 } from "@shared/format";
import type {
  AsyncTask,
  IntakeReceipt,
  IntakeUploadResult,
  RestorationProject,
  SealResult,
} from "@shared/types";

interface VehicleForm {
  year: string;
  make: string;
  model: string;
  trim: string;
  engine_code: string;
  notes: string;
}

export function IntakeBay({
  mode,
  project,
}: {
  mode: "create" | "project";
  project?: RestorationProject;
}) {
  if (mode === "create") return <CreateJob />;
  if (!project) return null;
  return <ProjectIntake project={project} />;
}

function CreateJob() {
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<VehicleForm>({
    defaultValues: { year: "", make: "", model: "", trim: "", engine_code: "", notes: "" },
  });

  const create = useAuditMutation<RestorationProject, VehicleForm>({
    mutationFn: (values) =>
      api<RestorationProject>("/restoration/projects", {
        body: {
          vehicle_meta: {
            year: values.year || null,
            make: values.make || null,
            model: values.model || null,
            trim: values.trim || null,
            engine_code: values.engine_code || null,
            notes: values.notes || null,
          },
        },
      }),
    onError: (err) => setServerError(err.message),
    onSuccess: (project) => navigate(`/jobs/${project.project_id}/intake`),
  });

  return (
    <div className="page-enter max-w-2xl">
      <h1 className="text-2xl font-semibold">New job</h1>
      <p className="mt-0.5 text-sm text-muted">
        Name the vehicle. Photos and the parts list come next, on the intake bay.
      </p>
      <form
        onSubmit={handleSubmit((v) => create.mutate(v))}
        className="card mt-4 grid grid-cols-1 gap-4 p-6 sm:grid-cols-2"
        noValidate
      >
        <div>
          <label htmlFor="year" className="label">
            Year
          </label>
          <input
            id="year"
            className="input tnum"
            placeholder="1969"
            inputMode="numeric"
            aria-invalid={Boolean(errors.year)}
            aria-describedby={errors.year ? "year-error" : undefined}
            {...register("year", {
              pattern: { value: /^\d{4}$/, message: "Four-digit year, e.g. 1969" },
            })}
          />
          {errors.year && (
            <p id="year-error" className="field-error">
              {errors.year.message}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="make" className="label">
            Make
          </label>
          <input
            id="make"
            className="input"
            placeholder="Chevrolet"
            aria-invalid={Boolean(errors.make)}
            aria-describedby={errors.make ? "make-error" : undefined}
            {...register("make", { required: "Make is required" })}
          />
          {errors.make && (
            <p id="make-error" className="field-error">
              {errors.make.message}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="model" className="label">
            Model
          </label>
          <input
            id="model"
            className="input"
            placeholder="Camaro"
            aria-invalid={Boolean(errors.model)}
            aria-describedby={errors.model ? "model-error" : undefined}
            {...register("model", { required: "Model is required" })}
          />
          {errors.model && (
            <p id="model-error" className="field-error">
              {errors.model.message}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="trim" className="label">
            Trim <span className="text-faint">(optional)</span>
          </label>
          <input id="trim" className="input" placeholder="SS" {...register("trim")} />
        </div>
        <div>
          <label htmlFor="engine" className="label">
            Engine code <span className="text-faint">(optional)</span>
          </label>
          <input id="engine" className="input font-mono" placeholder="L48" {...register("engine_code")} />
        </div>
        <div>
          <label htmlFor="notes" className="label">
            Notes <span className="text-faint">(optional)</span>
          </label>
          <input id="notes" className="input" placeholder="Numbers-matching, second owner" {...register("notes")} />
        </div>
        <div className="sm:col-span-2">
          {serverError && <InlineError message={serverError} />}
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={create.isPending || readOnly}
            title={readOnly ? "Unavailable while offline" : undefined}
          >
            {create.isPending ? "Creating…" : "Create job"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => navigate("/jobs")}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function ReceiptRow({ receipt }: { receipt: IntakeReceipt }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border-subtle py-1.5 text-sm last:border-0">
      <span className="min-w-0 truncate">{receipt.filename}</span>
      <span className="flex shrink-0 items-center gap-2">
        {receipt.content_sha256 && (
          <span className="font-mono text-xs text-faint tnum">{sha8(receipt.content_sha256)}</span>
        )}
        {receipt.stored_format && <span className="text-xs text-muted">{receipt.stored_format}</span>}
        {receipt.accepted ? (
          <span className="text-xs font-medium text-ok">accepted</span>
        ) : (
          <span className="text-xs font-medium text-signal" title={receipt.rejection_reason ?? undefined}>
            rejected{receipt.rejection_reason ? ` — ${receipt.rejection_reason}` : ""}
          </span>
        )}
      </span>
    </li>
  );
}

function ProjectIntake({ project }: { project: RestorationProject }) {
  const readOnly = useReadOnly();
  const [receipts, setReceipts] = useState<IntakeReceipt[]>([]);
  const [gaps, setGaps] = useState<string[]>([]);
  const [acceptedSession, setAcceptedSession] = useState(0);
  const [photoCount, setPhotoCount] = useState(0);
  const [partsList, setPartsList] = useState<File | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useAuditMutation<IntakeUploadResult, FormData>({
    mutationFn: (fd) =>
      api<IntakeUploadResult>(`/restoration/projects/${project.project_id}/intake`, {
        formData: fd,
      }),
    onError: (err) => setError(err.message),
    onSuccess: (result) => {
      setError(null);
      setReceipts((prev) => [...prev, ...result.receipts]);
      setGaps(result.gap_list ?? []);
      setAcceptedSession((prev) => prev + result.receipts.filter((r) => r.accepted).length);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setPhotoCount(0);
      setPartsList(null);
    },
  });

  // FR-003: sealing auto-starts identification — poll the returned task.
  const seal = useAuditMutation<SealResult, void>({
    mutationFn: () =>
      api<SealResult>(`/restoration/projects/${project.project_id}/intake/seal`, { body: {} }),
    onError: (err) => setError(err.message),
    onSuccess: (res) => {
      setError(null);
      if (res.identify_task_id) setActiveTaskId(res.identify_task_id);
    },
  });

  const identify = useAuditMutation<AsyncTask, void>({
    mutationFn: () =>
      api<AsyncTask>(`/restoration/projects/${project.project_id}/identify`, { body: {} }),
    onError: (err) => setError(err.message),
    onSuccess: (task) => {
      setError(null);
      setActiveTaskId(task.task_id);
    },
  });

  const task = useQuery({
    queryKey: keys.task(activeTaskId ?? ""),
    queryFn: () => api<AsyncTask>(`/restoration/tasks/${activeTaskId}`),
    enabled: Boolean(activeTaskId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "completed" || s === "failed" || s === "cancelled" ? false : 2000;
    },
  });

  // The 6-photo floor is server-enforced; the 409 names the count. The chip
  // shows this session's accepted tally — prior-session uploads are not
  // visible to the client, so the server stays the authority.
  const canSeal = !readOnly && project.status === "intake_open";
  const sealed = !["draft", "intake_open"].includes(project.status);
  const canIdentify = !readOnly && project.status === "intake_sealed";

  function onUpload() {
    setError(null);
    const fd = new FormData();
    const files = fileInputRef.current?.files;
    if (files) for (const f of Array.from(files)) fd.append("photos", f);
    if (partsList) fd.append("parts_list", partsList);
    if (!files?.length && !partsList) {
      setError("Choose at least one photo or a parts list.");
      return;
    }
    upload.mutate(fd);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Photos &amp; parts list</h2>
        <p className="mt-0.5 text-sm text-muted">
          Shot list: front 3/4, rear 3/4, engine bay, interior, underside, VIN plate. JPEG/PNG/HEIC/WebP,
          ≤25&nbsp;MB each. Parts list: CSV, TSV, or free text.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="photos" className="label">
              Photos {photoCount > 0 && <span className="tnum">({photoCount} selected)</span>}
            </label>
            <input
              id="photos"
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.heic,.heif,.webp"
              className="input py-1.5"
              onChange={(e) => setPhotoCount(e.target.files?.length ?? 0)}
              disabled={sealed || readOnly}
            />
          </div>
          <div>
            <label htmlFor="parts-list" className="label">
              Parts list <span className="text-faint">(optional)</span>
            </label>
            <input
              id="parts-list"
              type="file"
              accept=".csv,.tsv,.txt"
              className="input py-1.5"
              onChange={(e) => setPartsList(e.target.files?.[0] ?? null)}
              disabled={sealed || readOnly}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onUpload}
            disabled={upload.isPending || sealed || readOnly}
            title={sealed ? "Intake is sealed" : readOnly ? "Unavailable while offline" : undefined}
          >
            {upload.isPending ? "Uploading…" : "Upload batch"}
          </button>
          <Chip
            label="accepted"
            value={acceptedSession === 0 ? "—" : `${acceptedSession} this session · 6 required`}
            tone={acceptedSession >= 6 ? "ok" : "muted"}
          />
        </div>
        {gaps.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5" data-testid="intake-gaps">
            {gaps.map((g, i) => (
              <li key={i} className="text-xs text-muted">
                {g}
              </li>
            ))}
          </ul>
        )}
        {receipts.length > 0 && (
          <ul className="mt-3" data-testid="upload-receipts">
            {receipts.map((r, i) => (
              <ReceiptRow key={`${r.filename}-${i}`} receipt={r} />
            ))}
          </ul>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Seal &amp; identify</h2>
        <p className="mt-0.5 text-sm text-muted">
          Sealing freezes intake and starts identification automatically — identified parts land on
          the Manifest tab for review.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => seal.mutate()}
            disabled={!canSeal || seal.isPending}
            title={
              sealed
                ? "Intake already sealed"
                : readOnly
                  ? "Unavailable while offline"
                  : "Seal needs 6 usable photos — the server enforces it and names the count"
            }
            data-testid="seal-btn"
          >
            {seal.isPending ? "Sealing…" : "Seal intake"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => identify.mutate()}
            disabled={!canIdentify || identify.isPending || Boolean(activeTaskId && task.data?.status === "running")}
            title={
              !sealed ? "Seal intake first" : readOnly ? "Unavailable while offline" : undefined
            }
          >
            {identify.isPending ? "Starting…" : "Run identification"}
          </button>
          {sealed && <Chip label="intake" value="sealed" tone="ok" />}
        </div>
        {activeTaskId && task.data && (
          <div className="mt-3" role="status" data-testid="identify-task">
            <Chip
              label="identify task"
              value={`${task.data.status}${task.data.progress_pct != null ? ` · ${task.data.progress_pct}%` : ""}`}
              tone={
                task.data.status === "completed"
                  ? "ok"
                  : task.data.status === "failed"
                    ? "signal"
                    : "accent"
              }
              title={task.data.message ?? undefined}
            />
            {task.data.status === "failed" && (
              <InlineError message={`Identification failed: ${task.data.error ?? "unknown error"}`} />
            )}
            {task.data.status === "completed" && (
              <p className="mt-2 text-sm text-ok">
                Identification complete — open the Manifest tab to review.
              </p>
            )}
          </div>
        )}
      </section>

      {error && <InlineError message={error} />}
      {!sealed && project.status === "draft" && (
        <p className="text-sm text-muted">
          This job is a draft — upload opens intake automatically on the server side. If intake is
          already open elsewhere, refresh to see the current state.
        </p>
      )}
      {upload.isPending && <SkeletonRows rows={2} />}
    </div>
  );
}
