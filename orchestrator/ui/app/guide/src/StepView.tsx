// StepView — one beam: one step, one tool, one warning. Text tier always
// works; still image when the bundle carries one (Bearer + blob URL, D11);
// audio with iOS-synchronous tap-to-start and replay (AC-UI-015). Speculative
// preload of next steps suspends under rate-limit (OBL-54); the current step's
// assets never suspend. Blob URLs are revoked on transition (OBL-21).

import { useEffect, useRef, useState } from "react";
import { fetchAssetBlob } from "@shared/api-client";
import { fmtDuration } from "@shared/format";
import type { BundleMeta, GuideStep } from "@shared/types";
import { loadProgress, saveProgress } from "./db";

export function StepView({
  meta,
  step,
  token,
  speculativeSuspended,
  onNavigate,
  onFlag,
  onHome,
}: {
  meta: BundleMeta;
  step: GuideStep;
  token: string;
  speculativeSuspended: boolean;
  onNavigate: (stepIndex: number) => void;
  onFlag: () => void;
  onHome: () => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [audioState, setAudioState] = useState<"idle" | "playing" | "paused" | "rejected" | "unavailable">(
    step.audio_available ? "idle" : "unavailable",
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobsRef = useRef<string[]>([]);

  // OBL-6: text-only mode toggle — persisted per-token in IndexedDB.
  useEffect(() => {
    void loadProgress(token).then((p) => {
      if (p?.textMode) setTextMode(true);
    });
  }, [token]);

  function toggleTextMode() {
    setTextMode((prev) => {
      const next = !prev;
      void loadProgress(token).then((p) => {
        void saveProgress(token, {
          step: p?.step ?? step.step_index,
          completed: p?.completed ?? [],
          updatedAt: Date.now(),
          textMode: next,
        });
      });
      return next;
    });
  }

  // Current-step assets — never suspended (OBL-54).
  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);
    setImageFailed(false);
    setAudioUrl(null);
    setAudioState(step.audio_available ? "idle" : "unavailable");

    if (step.still_image_path) {
      fetchAssetBlob(`${meta.asset_base_url}${step.still_image_path}`, token)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          blobsRef.current.push(url);
          setImageUrl(url);
        })
        .catch(() => {
          if (!cancelled) setImageFailed(true);
        });
    }
    if (step.audio_available && step.audio_path) {
      fetchAssetBlob(`${meta.asset_base_url}${step.audio_path}`, token)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          blobsRef.current.push(url);
          setAudioUrl(url);
        })
        .catch(() => {
          if (!cancelled) setAudioState("unavailable");
        });
    }
    return () => {
      cancelled = true;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      for (const url of blobsRef.current.splice(0)) URL.revokeObjectURL(url);
    };
  }, [step, meta.asset_base_url, token]);

  // Speculative preload — next steps' images + audio, suspended under 429.
  useEffect(() => {
    if (speculativeSuspended) return;
    const ahead = meta.steps.slice(step.step_index + 1, step.step_index + 4);
    const urls: string[] = [];
    let cancelled = false;
    for (const s of ahead) {
      for (const path of [s.still_image_path, s.audio_available ? s.audio_path : null]) {
        if (!path) continue;
        fetchAssetBlob(`${meta.asset_base_url}${path}`, token)
          .then((url) => {
            urls.push(url);
            if (cancelled) URL.revokeObjectURL(url);
          })
          .catch(() => undefined);
      }
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [speculativeSuspended, meta, step.step_index, token]);

  function playAudio() {
    const el = audioRef.current;
    if (!el || !audioUrl) return;
    // iOS: play() must fire synchronously inside the tap handler (AC-UI-015).
    const promise = el.play();
    if (promise) {
      promise
        .then(() => setAudioState("playing"))
        .catch(() => setAudioState("rejected"));
    }
  }

  const isLast = step.step_index >= meta.total_steps - 1;

  return (
    <div className="page-enter flex flex-1 flex-col">
      {/* Header — step position */}
      <div className="flex items-center justify-between px-4 pt-4">
        <button type="button" className="btn btn-ghost" onClick={onHome} aria-label="All steps">
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
            <path d="M1 6h10M1 6l4-4M1 6l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Steps
        </button>
        <p className="tnum text-sm text-muted" data-testid="step-position">
          Step <span className="font-semibold text-ink">{step.step_index + 1}</span> of{" "}
          <span className="tnum">{meta.total_steps}</span>
        </p>
        <button type="button" className="btn btn-ghost" onClick={onFlag}>
          Flag
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-4 pb-40 pt-4">
        {/* Safety — coral beam, always first when present */}
        {step.safety_warning && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-md border-l-2 border-signal bg-signal/10 px-4 py-3"
            data-testid="safety-warning"
          >
            <svg viewBox="0 0 12 12" className="mt-1 h-4 w-4 shrink-0 text-signal" aria-hidden="true">
              <path d="M6 1.5 11 10H1Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M6 4.6v2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="6" cy="8.6" r="0.8" fill="currentColor" />
            </svg>
            <p className="text-base">{step.safety_warning}</p>
          </div>
        )}

        {/* Visual pane — still image tier (T3). T1/T2 3D lands with the R3F viewer.
            OBL-6: hidden when text-only mode is active. */}
        {imageUrl && !imageFailed && !textMode && (
          <div className="card overflow-hidden">
            <img
              src={imageUrl}
              alt={`Step ${step.step_index + 1}: ${step.description}`}
              className="w-full object-contain"
              data-testid="step-image"
            />
          </div>
        )}
        {imageFailed && !textMode && (
          <p className="text-sm text-muted">Step image unavailable — the text below is complete.</p>
        )}

        {/* The beam — description */}
        <p className="text-lg leading-snug" data-testid="step-description">
          {step.text_fallback ?? step.description}
        </p>

        {/* Callouts — tool and part, one each, big enough for greasy hands */}
        <div className="flex flex-col gap-2">
          {step.tool_callout && (
            <div className="card flex items-center gap-3 p-3" data-testid="tool-callout">
              <span className="text-xs font-semibold uppercase tracking-wider text-faint">Tool</span>
              <span className="text-base font-medium">{step.tool_callout}</span>
            </div>
          )}
          {step.part_callout && (
            <div className="card flex items-center gap-3 p-3" data-testid="part-callout">
              <span className="text-xs font-semibold uppercase tracking-wider text-faint">Part</span>
              <span className="text-base font-medium">{step.part_callout}</span>
            </div>
          )}
        </div>

        {/* Audio */}
        {audioState !== "unavailable" && (
          <div className="card flex items-center gap-3 p-3">
            <audio
              ref={audioRef}
              src={audioUrl ?? undefined}
              onEnded={() => setAudioState("paused")}
              preload="auto"
            />
            {audioState === "idle" && (
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={playAudio}
                data-testid="audio-start"
              >
                Tap to hear this step
                {step.duration_s != null && <span className="tnum">· {fmtDuration(step.duration_s)}</span>}
              </button>
            )}
            {(audioState === "playing" || audioState === "paused" || audioState === "rejected") && (
              <button
                type="button"
                className="btn btn-secondary flex-1"
                aria-label={audioState === "rejected" ? "Audio blocked — tap to retry" : "Replay step audio"}
                onClick={() => {
                  if (audioRef.current) audioRef.current.currentTime = 0;
                  playAudio();
                }}
                data-testid="audio-replay"
              >
                {audioState === "rejected" ? "Audio blocked — tap to retry" : "Replay"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom nav — fixed, guide touch targets */}
      <nav
        className="fixed inset-x-0 bottom-0 z-sticky border-t border-border-subtle bg-surface"
        aria-label="Step navigation"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* OBL-6: text-only mode toggle — visible when a visual tier is active (T3). */}
        {imageUrl && !imageFailed && (
          <div className="flex justify-center px-3 pt-2">
            <button
              type="button"
              className={`btn btn-ghost text-sm ${textMode ? "bg-accent text-bg" : ""}`}
              onClick={toggleTextMode}
              aria-pressed={textMode}
              data-testid="text-mode-toggle"
            >
              Text mode
            </button>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 p-3">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={step.step_index === 0}
            onClick={() => onNavigate(step.step_index - 1)}
            data-testid="step-back"
          >
            Back
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (audioRef.current) audioRef.current.currentTime = 0;
              playAudio();
            }}
            disabled={audioState === "unavailable" || audioState === "idle"}
            title={audioState === "idle" ? "Start the audio first" : undefined}
          >
            Replay
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-label={isLast ? "Finish — back to all steps" : `Next — go to step ${step.step_index + 2}`}
            onClick={() => (isLast ? onHome() : onNavigate(step.step_index + 1))}
            data-testid="step-next"
          >
            {isLast ? "Finish" : "Next"}
          </button>
        </div>
      </nav>
    </div>
  );
}
