// Flag-a-problem (§7.6). Posts with the guide token (server accepts operator
// session OR scoped guide token). Offline → IndexedDB queue, drained on
// reconnect (AC-UI-016).

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "@shared/api-client";
import { queueFlag } from "./db";

export function FlagForm({
  projectId,
  assemblyId,
  token,
  online,
}: {
  projectId: string;
  assemblyId: string;
  token: string;
  online: boolean;
}) {
  const navigate = useNavigate();
  const [description, setDescription] = useState("");
  const [stepIndex, setStepIndex] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "queued" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: import("react").FormEvent) {
    e.preventDefault();
    if (!description.trim()) {
      setError("Describe the problem — one sentence is enough.");
      return;
    }
    setError(null);
    const body = {
      assembly_id: assemblyId,
      description: description.trim(),
      // The mechanic reads 1-based step numbers; the system stores 0-based.
      step_index: stepIndex === "" ? null : Math.max(0, Number(stepIndex) - 1),
    };
    if (!online) {
      await queueFlag({ projectId, token, body });
      setState("queued");
      return;
    }
    setState("sending");
    try {
      await api(`/restoration/projects/${projectId}/flags`, { body, token });
      setState("sent");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.code === "network_error")) {
        await queueFlag({ projectId, token, body });
        setState("queued");
        return;
      }
      setState("error");
      setError(err instanceof ApiError ? err.message : "Flag failed to send.");
    }
  }

  if (state === "sent") {
    return (
      <div className="page-enter flex flex-1 flex-col items-start justify-center gap-3 p-8">
        <h1 className="text-xl font-semibold">Flag sent</h1>
        <p className="text-base text-muted">The shop sees it on the Assembly tab. Thank you.</p>
        <button type="button" className="btn btn-primary" onClick={() => navigate(-1)}>
          Back to the step
        </button>
      </div>
    );
  }
  if (state === "queued") {
    return (
      <div className="page-enter flex flex-1 flex-col items-start justify-center gap-3 p-8">
        <h1 className="text-xl font-semibold">Flag queued</h1>
        <p className="text-base text-muted">
          No connection right now — it sends itself when the phone is back online.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => navigate(-1)}>
          Back to the step
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="page-enter flex flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Flag a problem</h1>
        <p className="mt-1 text-sm text-muted">
          Wrong step, wrong part, unclear photo — say it in one line and the shop sees it.
        </p>
      </div>
      <div>
        <label htmlFor="flag-step" className="label">
          Step number <span className="text-faint">(optional)</span>
        </label>
        <input
          id="flag-step"
          className="input tnum"
          inputMode="numeric"
          placeholder="3"
          value={stepIndex}
          onChange={(e) => setStepIndex(e.target.value.replace(/[^0-9]/g, ""))}
        />
      </div>
      <div>
        <label htmlFor="flag-description" className="label">
          What's wrong?
        </label>
        <textarea
          id="flag-description"
          className="input min-h-32"
          placeholder="Step 3 says 10mm but the bolt is 12mm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "flag-error" : undefined}
        />
        {error && (
          <p id="flag-error" className="mt-1 text-sm text-signal" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn btn-primary flex-1"
          disabled={state === "sending"}
          aria-label={state === "sending" ? "Sending flag" : online ? "Send flag" : "Queue flag — sends when back online"}
        >
          {state === "sending" ? "Sending…" : online ? "Send flag" : "Queue flag (offline)"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
