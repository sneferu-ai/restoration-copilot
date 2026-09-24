// StepPlayer — the #/now view (spec §9.2). Mobile-first, full viewport.
// Visual pane (T4 text-only for today) + caption + chips + navigation.
// Step position persisted to IndexedDB + localStorage backup.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleMeta } from "./types";
import { saveStepIndex, loadStepIndex } from "./db";
import { Icon, ICONS } from "@/shared/ui/Icon";

interface StepPlayerProps {
  bundle: BundleMeta;
  token: string;
  onOpenFlag: () => void;
}

const POSITION_LABELS: Record<string, string> = {
  exploded: "Exploded",
  install: "Install",
  torque: "Torque",
  finishing: "Finishing",
};

// Highlight glossary terms in the caption. Renders text as React nodes only
// (OBL-34: no dangerouslySetInnerHTML).
function renderCaption(caption: string, glossary: Record<string, string>): React.ReactNode[] {
  if (Object.keys(glossary).length === 0) return [caption];
  // Build a sorted list of glossary terms by length (longest first to avoid
  // partial matches). Escape regex special chars.
  const terms = Object.keys(glossary)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [caption];

  // Build a combined regex that matches any glossary term (word-boundary-ish)
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");

  const parts = caption.split(re);
  return parts.map((part, i) => {
    if (part === "") return null;
    // Check if this part matches a glossary term (case-insensitive)
    const lower = part.toLowerCase();
    const matchKey = Object.keys(glossary).find((k) => k.toLowerCase() === lower);
    if (matchKey) {
      return (
        <mark
          key={i}
          className="guide-glossary-term"
          title={glossary[matchKey]}
          role="term"
        >
          {part}
        </mark>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function StepPlayer({ bundle, token, onOpenFlag }: StepPlayerProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const step = bundle.steps[stepIndex]!;

  // ── Restore saved position (spec §9.2: IndexedDB + localStorage) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadStepIndex(token);
      if (cancelled) return;
      if (saved != null && saved >= 0 && saved < bundle.steps.length) {
        setStepIndex(saved);
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [token, bundle.steps.length]);

  // ── Persist position ──
  const persist = useCallback(
    (idx: number) => {
      saveStepIndex(token, idx, bundle.bundle_version);
    },
    [token, bundle.bundle_version],
  );

  const goNext = useCallback(() => {
    setStepIndex((prev) => {
      const next = Math.min(prev + 1, bundle.steps.length - 1);
      if (next !== prev) persist(next);
      return next;
    });
  }, [bundle.steps.length, persist]);

  const goPrev = useCallback(() => {
    setStepIndex((prev) => {
      const next = Math.max(prev - 1, 0);
      if (next !== prev) persist(next);
      return next;
    });
  }, [persist]);

  const goTo = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(idx, bundle.steps.length - 1));
      setStepIndex(clamped);
      persist(clamped);
    },
    [bundle.steps.length, persist],
  );

  // ── Keyboard navigation (spec §9: keyboard carries you) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev]);

  // ── Audio ──
  useEffect(() => {
    setAudioPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [stepIndex]);

  const toggleAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().then(() => setAudioPlaying(true)).catch(() => setAudioPlaying(false));
    } else {
      el.pause();
      setAudioPlaying(false);
    }
  }, []);

  const replayAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    el.play().then(() => setAudioPlaying(true)).catch(() => setAudioPlaying(false));
  }, []);

  const progress = ((stepIndex + 1) / bundle.steps.length) * 100;
  const isLast = stepIndex === bundle.steps.length - 1;
  const isFirst = stepIndex === 0;

  return (
    <div className="guide-step-player" aria-live="polite">
      {/* Progress bar */}
      <div
        className="guide-progress-track"
        role="progressbar"
        aria-valuenow={stepIndex + 1}
        aria-valuemin={1}
        aria-valuemax={bundle.steps.length}
        aria-label={`Step ${stepIndex + 1} of ${bundle.steps.length}`}
      >
        <div className="guide-progress-fill" style={{ transform: `scaleX(${progress / 100})` }} />
      </div>

      {/* Visual pane — 60% height */}
      <div className="guide-visual-pane">
        {step.has_diagram && step.diagram_path ? (
          <img
            src={step.diagram_path}
            alt={`Diagram for step ${stepIndex + 1}: ${step.caption.slice(0, 80)}`}
            className="guide-diagram"
            loading="lazy"
          />
        ) : step.has_glb && step.glb_path ? (
          <div className="guide-tier-placeholder">
            <Icon d={ICONS.layers} width={28} height={28} />
            <p className="text-xs text-fg-tertiary">3D model available on supported devices.</p>
          </div>
        ) : (
          <div className="guide-text-pane">
            <span className="guide-step-number tnum">{String(stepIndex + 1).padStart(2, "0")}</span>
            <p className="guide-step-caption-large">
              {renderCaption(step.caption, bundle.glossary)}
            </p>
          </div>
        )}
        {/* Safety warning */}
        {step.safety_warning && (
          <div className="guide-safety-warning" role="alert">
            <Icon d={ICONS.alert} width={16} height={16} />
            <span className="text-sm text-fg-secondary">{step.safety_warning}</span>
          </div>
        )}
      </div>

      {/* Audio control */}
      {bundle.audio_available && step.has_audio && step.audio_path && (
        <>
          <audio
            ref={audioRef}
            src={step.audio_path}
            onEnded={() => setAudioPlaying(false)}
            preload="auto"
          />
          <div className="guide-audio-controls">
            <button
              type="button"
              className="guide-audio-btn"
              onClick={toggleAudio}
              aria-label={audioPlaying ? "Pause audio" : "Play audio for this step"}
            >
              <Icon d={audioPlaying ? ICONS.pause : ICONS.play} width={18} height={18} />
              <span className="text-sm">{audioPlaying ? "Pause" : "Play"}</span>
            </button>
            <button
              type="button"
              className="guide-audio-btn"
              onClick={replayAudio}
              aria-label="Replay audio for this step"
            >
              <Icon d={ICONS.refresh} width={18} height={18} />
              <span className="text-sm">Replay</span>
            </button>
          </div>
        </>
      )}

      {/* Caption + chips */}
      <div className="guide-caption-area">
        {/* Step position label */}
        <span className="guide-chip guide-chip-position">
          {POSITION_LABELS[step.step_position_label] ?? step.step_position_label}
        </span>

        {/* Caption (text pane already shows it if no diagram; show here for diagram steps) */}
        {(step.has_diagram || step.has_glb) && (
          <p className="guide-step-caption">
            {renderCaption(step.caption, bundle.glossary)}
          </p>
        )}

        {/* Chips: part name, required tool, duration */}
        <div className="guide-chips-row">
          {step.part_name && (
            <span className="guide-chip">
              <Icon d={ICONS.package} width={14} height={14} />
              {step.part_name}
            </span>
          )}
          {step.required_tool && (
            <span className="guide-chip">
              <Icon d={ICONS.wrench} width={14} height={14} />
              {step.required_tool}
            </span>
          )}
          <span className="guide-chip guide-chip-duration tnum">
            <Icon d={ICONS.clock} width={14} height={14} />
            {Math.round(step.duration_s)}s
          </span>
        </div>
      </div>

      {/* Step list (skip-ahead) */}
      <details className="guide-step-list">
        <summary className="guide-step-list-toggle">
          <Icon d={ICONS.chevronDown} width={14} height={14} />
          <span className="text-sm">All {bundle.steps.length} steps</span>
        </summary>
        <ol className="guide-step-list-items">
          {bundle.steps.map((s, i) => (
            <li key={s.step_index}>
              <button
                type="button"
                className={`guide-step-list-item ${i === stepIndex ? "is-current" : ""}`}
                onClick={() => goTo(i)}
                aria-label={`Go to step ${i + 1}: ${s.caption.slice(0, 60)}`}
                aria-current={i === stepIndex ? "step" : undefined}
              >
                <span className="guide-step-list-num tnum">{String(i + 1).padStart(2, "0")}</span>
                <span className="guide-step-list-text">{s.caption}</span>
              </button>
            </li>
          ))}
        </ol>
      </details>

      {/* Navigation — fixed bottom bar (spec: min 3rem touch targets) */}
      <nav className="guide-step-nav" aria-label="Step navigation">
        <button
          type="button"
          className="guide-nav-btn guide-nav-prev"
          onClick={goPrev}
          disabled={isFirst || !loaded}
          aria-label="Previous step"
        >
          <Icon d={ICONS.chevronLeft} width={20} height={20} />
          <span>Prev</span>
        </button>

        <span className="guide-nav-progress tnum" aria-hidden>
          {stepIndex + 1} / {bundle.steps.length}
        </span>

        {isLast ? (
          <button
            type="button"
            className="guide-nav-btn guide-nav-done"
            onClick={onOpenFlag}
            aria-label="Report a problem with this step"
          >
            <Icon d={ICONS.flag} width={20} height={20} />
            <span>Report</span>
          </button>
        ) : (
          <button
            type="button"
            className="guide-nav-btn guide-nav-next"
            onClick={goNext}
            disabled={!loaded}
            aria-label="Next step"
          >
            <span>Next</span>
            <Icon d={ICONS.chevronRight} width={20} height={20} />
          </button>
        )}
      </nav>
    </div>
  );
}
